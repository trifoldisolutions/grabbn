// server/routes/dm.js
import express from 'express';
import mongoose from 'mongoose';
import Conversation from '../models/conversation.js';
import DirectMessage from '../models/directMessage.js';
import Block from '../models/block.js';
import User from '../models/user.js';
import BucketComment from '../models/bucketComment.js';
import Notification from '../models/notification.js';
import { anonymousAuth, requireVerification } from '../middleware/anonymousAuth.js';
import { pushNotification, wsClients } from '../ws.js';
import { parseAndResolveEntities } from '../utils/entityParser.js';

const router = express.Router();
router.use(anonymousAuth);

function requireRegistered(req, res, next) {
    if (!req.user || req.user.isAnonymous) {
        return res.status(401).json({ error: 'Login required' });
    }
    next();
}

// Rate limit: 1 message per 3 seconds per user (in-memory, resets on restart)
const lastMessageTime = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

// Returns true if targetUserId has blocked viewerId
async function isBlockedBy(viewerId, targetUserId) {
    return !!(await Block.exists({ blockerId: targetUserId, blockedId: viewerId }));
}

// Normalise participant pair to a canonical sorted array for dedup index
function sortedParticipants(a, b) {
    return [a, b].map(String).sort();
}

// ── GET /api/dm/conversations — inbox list ───────────────────────────────────
router.get('/conversations', requireRegistered, async (req, res) => {
    try {
        const userId = req.user._id;

        // Find all conversations the user is part of
        const conversations = await Conversation.find({ participants: userId })
            .sort({ lastMessageAt: -1 })
            .limit(50)
            .lean();

        if (!conversations.length) return res.json({ conversations: [] });

        // One-time backfill: conversations created before lastMessageSenderId was added
        // have the field as null. Run a single aggregate to resolve them all at once,
        // then write the result back so this only ever happens once per conversation.
        const needsBackfill = conversations.filter(c => !c.lastMessageSenderId && c.lastMessagePreview);
        if (needsBackfill.length) {
            const lastSenders = await DirectMessage.aggregate([
                { $match: { conversationId: { $in: needsBackfill.map(c => c._id) } } },
                { $sort:  { createdAt: -1 } },
                { $group: { _id: '$conversationId', senderId: { $first: '$senderId' } } },
            ]);
            const senderMap = new Map(lastSenders.map(r => [String(r._id), r.senderId]));
            // Apply to in-memory result so this response is already correct
            for (const c of conversations) {
                if (!c.lastMessageSenderId && senderMap.has(String(c._id))) {
                    c.lastMessageSenderId = senderMap.get(String(c._id));
                }
            }
            // Persist asynchronously — fire-and-forget, runs once per affected conv
            const bulkOps = lastSenders.map(r => ({
                updateOne: {
                    filter: { _id: r._id, lastMessageSenderId: null },
                    update: { $set: { lastMessageSenderId: r.senderId } },
                },
            }));
            if (bulkOps.length) Conversation.bulkWrite(bulkOps, { timestamps: false }).catch(() => {});
        }

        // Collect other participant IDs
        const otherIds = conversations.map(c =>
            c.participants.find(p => String(p) !== String(userId))
        ).filter(Boolean);

        // Who has blocked us?
        const blockedByOthers = await Block.find({
            blockerId: { $in: otherIds },
            blockedId: userId,
        }).select('blockerId').lean();
        const blockedBySet = new Set(blockedByOthers.map(b => String(b.blockerId)));

        const otherUsers = await User.find({ _id: { $in: otherIds } })
            .select('username avatar anonymousId')
            .lean();
        const userMap = new Map(otherUsers.map(u => [String(u._id), u]));

        const result = conversations
            .filter(c => {
                const otherId = c.participants.find(p => String(p) !== String(userId));
                return !blockedBySet.has(String(otherId));
            })
            .map(c => {
                const otherId = c.participants.find(p => String(p) !== String(userId));
                const other   = userMap.get(String(otherId)) || {};
                return {
                    _id:                c._id,
                    otherUser: {
                        _id:         otherId,
                        username:    other.username    || 'Unknown',
                        avatar:      other.avatar      || null,
                        anonymousId: other.anonymousId || null,
                    },
                    lastMessageAt:       c.lastMessageAt,
                    lastMessagePreview:  c.lastMessagePreview,
                    lastMessageSenderId: c.lastMessageSenderId ? String(c.lastMessageSenderId) : null,
                    unreadCount:         c.unreadCounts?.get?.(String(userId))    ?? (c.unreadCounts?.[String(userId)]    ?? 0),
                    otherUnreadCount:    c.unreadCounts?.get?.(String(otherId))   ?? (c.unreadCounts?.[String(otherId)]   ?? 0),
                    hasContext:          !!c.contextCommentId,
                };
            });

        return res.json({ conversations: result });
    } catch (err) {
        console.error('[dm] GET /conversations:', err);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

// ── GET /api/dm/:conversationId/messages — paginated messages ────────────────
router.get('/:conversationId/messages', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ error: 'Invalid conversation ID' });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const isParticipant = conversation.participants.some(p => String(p) === String(req.user._id));
        if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

        const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 30));
        const before = req.query.before; // ISO date — load messages older than this

        const filter = { conversationId };
        if (before) filter.createdAt = { $lt: new Date(before) };

        const messages = await DirectMessage.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
            .lean();

        const hasMore = messages.length > limit;
        return res.json({
            messages: messages.slice(0, limit).reverse(), // oldest first
            hasMore,
        });
    } catch (err) {
        console.error('[dm] GET /:conversationId/messages:', err);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// ── POST /api/dm/send — send a message ──────────────────────────────────────
router.post('/send', requireRegistered, requireVerification, async (req, res) => {
    try {
        const senderId = req.user._id;
        const { recipientId, body, contextCommentId } = req.body;

        // Validate recipient
        if (!recipientId || !mongoose.Types.ObjectId.isValid(recipientId)) {
            return res.status(400).json({ error: 'Invalid recipient' });
        }
        if (String(senderId) === String(recipientId)) {
            return res.status(400).json({ error: 'Cannot message yourself' });
        }

        const recipient = await User.findById(recipientId).select('_id username avatar isAnonymous').lean();
        if (!recipient || recipient.isAnonymous) {
            return res.status(404).json({ error: 'Recipient not found' });
        }

        // Block check: has recipient blocked sender?
        if (await isBlockedBy(senderId, recipientId)) {
            return res.status(403).json({ error: 'Unable to send message' });
        }

        // Validate body
        const text = (body || '').trim();
        if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
        if (text.length > 350) return res.status(400).json({ error: 'Message too long (max 350 characters)' });

        // Rate limit: 1 message per 3 seconds
        const now = Date.now();
        const last = lastMessageTime.get(String(senderId)) || 0;
        if (now - last < 3000) {
            return res.status(429).json({ error: 'Please wait a moment before sending again' });
        }
        lastMessageTime.set(String(senderId), now);

        // Find or create conversation
        const participantPair = sortedParticipants(senderId, recipientId);
        let conversation = await Conversation.findOne({ participants: { $all: participantPair, $size: 2 } });

        let isNewConversation = false;
        if (!conversation) {
            isNewConversation = true;
            const conversationData = {
                participants: participantPair,
                lastMessageAt: new Date(),
                lastMessagePreview: text.slice(0, 60),
                lastMessageSenderId: senderId,
                unreadCounts: { [String(recipientId)]: 1, [String(senderId)]: 0 },
            };

            // Attach comment context if provided and this is the first message
            if (contextCommentId && mongoose.Types.ObjectId.isValid(contextCommentId)) {
                const comment = await BucketComment.findById(contextCommentId)
                    .select('body userId username bucketId deletedAt')
                    .populate('bucketId', 'name')
                    .lean();
                if (comment && !comment.deletedAt) {
                    conversationData.contextCommentId       = comment._id;
                    conversationData.contextCommentBody     = comment.body.slice(0, 250);
                    conversationData.contextCommentUsername = comment.username || '';
                    conversationData.contextCommentBucketId = comment.bucketId?._id || null;
                    conversationData.contextCommentBucketName = comment.bucketId?.name || null;
                }
            }

            conversation = await Conversation.create(conversationData);
        } else {
            // Update existing conversation
            const currentUnread = conversation.unreadCounts?.get?.(String(recipientId))
                ?? (conversation.unreadCounts?.[String(recipientId)] ?? 0);
            await Conversation.findByIdAndUpdate(conversation._id, {
                lastMessageAt:       new Date(),
                lastMessagePreview:  text.slice(0, 60),
                lastMessageSenderId: senderId,
                [`unreadCounts.${String(recipientId)}`]: currentUnread + 1,
            }, { timestamps: false });
        }

        // Parse entities
        const entities = await parseAndResolveEntities(text, senderId);

        // Save message
        const message = await DirectMessage.create({
            conversationId: conversation._id,
            senderId,
            body: text,
            entities,
        });

        // Push real-time to recipient
        pushNotification(String(recipientId), {
            type:           'new_dm',
            conversationId: String(conversation._id),
            senderUsername: req.user.username || '',
            senderAvatar:   req.user.avatar   || null,
            preview:        text.slice(0, 60),
            messageId:      String(message._id),
        });

        // Push back to sender (multi-tab sync)
        pushNotification(String(senderId), {
            type:           'dm_sent',
            conversationId: String(conversation._id),
            messageId:      String(message._id),
        });

        // Always persist a notification for the recipient so the messages modal
        // can display a history of DM notifications even after the chat is opened.
        // (DM notifications no longer appear in the bell — they live in their own modal.)
        Notification.create({
            userId: recipientId,
            type:   'new_dm',
            data:   {
                conversationId:  String(conversation._id),
                senderUsername:  req.user.username || '',
                senderAvatar:    req.user.avatar   || null,
                preview:         text.slice(0, 60),
            },
        }).catch(() => {});

        return res.status(201).json({
            message: {
                _id:            message._id,
                conversationId: conversation._id,
                senderId,
                body:           message.body,
                entities:       message.entities,
                createdAt:      message.createdAt,
                readAt:         message.readAt || null,
            },
            conversationId: conversation._id,
            isNewConversation,
        });
    } catch (err) {
        console.error('[dm] POST /send:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// ── POST /api/dm/:conversationId/read — mark conversation as read ────────────
router.post('/:conversationId/read', requireRegistered, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ error: 'Invalid conversation ID' });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const isParticipant = conversation.participants.some(p => String(p) === String(req.user._id));
        if (!isParticipant) return res.status(403).json({ error: 'Forbidden' });

        await Conversation.findByIdAndUpdate(conversationId, {
            [`unreadCounts.${String(req.user._id)}`]: 0,
        }, { timestamps: false });

        // Mark all unread messages in this conversation as read
        const readAt = new Date();
        await DirectMessage.updateMany(
            { conversationId, senderId: { $ne: req.user._id }, readAt: null },
            { readAt }
        );

        // Notify the sender in real-time that their messages were read
        const senderId = conversation.participants.find(p => String(p) !== String(req.user._id));
        if (senderId) {
            pushNotification(String(senderId), {
                type:           'dm_read',
                conversationId: String(conversationId),
                readAt:         readAt.toISOString(),
            });
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error('[dm] POST /:conversationId/read:', err);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// ── POST /api/dm/read-all — mark all conversations as read ───────────────────
router.post('/read-all', requireRegistered, async (req, res) => {
    try {
        const userId = String(req.user._id);
        await Conversation.updateMany(
            { participants: req.user._id },
            { $set: { [`unreadCounts.${userId}`]: 0 } },
            { timestamps: false }
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('[dm] POST /read-all:', err);
        res.status(500).json({ error: 'Failed to mark all as read' });
    }
});

// ── GET /api/dm/unread-count — total unread DMs for nav badge ────────────────
router.get('/unread-count', requireRegistered, async (req, res) => {
    try {
        const userId = String(req.user._id);
        const conversations = await Conversation.find({ participants: req.user._id })
            .select('unreadCounts participants')
            .lean();

        // Filter out conversations where the other person has blocked us
        const otherIds = conversations.map(c =>
            c.participants.find(p => String(p) !== userId)
        ).filter(Boolean);

        const blockedByOthers = await Block.find({
            blockerId: { $in: otherIds },
            blockedId: req.user._id,
        }).select('blockerId').lean();
        const blockedBySet = new Set(blockedByOthers.map(b => String(b.blockerId)));

        const total = conversations.reduce((sum, c) => {
            const otherId = c.participants.find(p => String(p) !== userId);
            if (blockedBySet.has(String(otherId))) return sum;
            const count = c.unreadCounts?.get?.(userId) ?? (c.unreadCounts?.[userId] ?? 0);
            return sum + count;
        }, 0);

        return res.json({ unread: total });
    } catch (err) {
        console.error('[dm] GET /unread-count:', err);
        res.json({ unread: 0 });
    }
});

// ── DELETE /api/dm/message/:messageId — delete own message ───────────────────
router.delete('/message/:messageId', requireRegistered, async (req, res) => {
    try {
        const { messageId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(400).json({ error: 'Invalid message ID' });
        }

        const message = await DirectMessage.findById(messageId).lean();
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Only the sender can delete their own message
        if (String(message.senderId) !== String(req.user._id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await DirectMessage.deleteOne({ _id: messageId });

        // If this was the last message, clear the preview on the conversation
        const lastMsg = await DirectMessage.findOne({ conversationId: message.conversationId })
            .sort({ createdAt: -1 }).lean();

        const conversation = await Conversation.findByIdAndUpdate(message.conversationId, {
            lastMessagePreview:  lastMsg ? lastMsg.body.slice(0, 60) : '',
            lastMessageAt:       lastMsg ? lastMsg.createdAt : null,
            lastMessageSenderId: lastMsg ? lastMsg.senderId : null,
        }, { timestamps: false, new: false }).lean();

        // Push real-time deletion event to both participants
        const payload = {
            type:           'dm_deleted',
            messageId:      String(messageId),
            conversationId: String(message.conversationId),
        };
        if (conversation) {
            for (const participantId of conversation.participants) {
                pushNotification(String(participantId), payload);
            }
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error('[dm] DELETE /message/:messageId:', err);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

export default router;
