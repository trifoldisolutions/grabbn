// server/routes/bucketComments.js
import express from 'express';
import mongoose from 'mongoose';
import Bucket from '../models/bucket.js';
import User from '../models/user.js';
import BucketComment from '../models/bucketComment.js';
import CommentAgreement from '../models/commentAgreement.js';
import CommentReport from '../models/commentReport.js';
import LinkClick from '../models/linkClick.js';
import Notification from '../models/notification.js';
import Block from '../models/block.js';
import { anonymousAuth, requireVerification } from '../middleware/anonymousAuth.js';
import { pushNotification } from '../ws.js';
import { parseAndResolveEntities, fetchBucketSnapshot, buildSnapshot } from '../utils/entityParser.js';

// mergeParams: true is required so `:id` from the parent mount
// (/api/buckets/:id/comments) is visible inside this router.
const router = express.Router({ mergeParams: true });

// All routes go through anonymousAuth so req.user is always populated
router.use(anonymousAuth);

// ── Guards ───────────────────────────────────────────────────────────────────

function requireRegistered(req, res, next) {
    if (!req.user || req.user.isAnonymous) {
        return res.status(401).json({ error: 'Login required' });
    }
    next();
}

// Send in-app @mention notifications (fire-and-forget — never throws).
async function sendMentionNotifications(comment, bucket, commenter) {
    try {
        const mentions = (comment.entities || []).filter(e => e.type === 'mention');
        if (!mentions.length) return;

        for (const entity of mentions) {
            // Skip self-mention
            if (commenter.username && entity.value.toLowerCase() === commenter.username.toLowerCase()) continue;

            const mentioned = await User.findOne({ username: entity.value }).select('_id').lean();
            if (!mentioned) continue;

            await Notification.create({
                userId: mentioned._id,
                type:   'comment_mention',
                data:   {
                    commentId:         comment._id,
                    bucketId:          bucket._id,
                    bucketName:        bucket.name,
                    commenterUsername: commenter.username || '',
                    commenterAvatar:   commenter.avatar   || '',
                    snippet:           comment.body.slice(0, 100),
                },
            });

            pushNotification(String(mentioned._id), { type: 'new_notification' });
        }
    } catch (err) {
        console.error('[bucketComments] sendMentionNotifications error:', err);
    }
}

// Notify bucket owners when their bucket is tagged in a comment (fire-and-forget — never throws).
async function sendBucketTagNotifications(comment, commenter) {
    try {
        const refs = (comment.entities || []).filter(e => e.type === 'bucket_ref');
        if (!refs.length) return;

        // De-dupe by bucket ID in case the same bucket is tagged multiple times
        const seen = new Set();
        for (const entity of refs) {
            if (seen.has(entity.value)) continue;
            seen.add(entity.value);

            const taggedBucket = await Bucket.findById(entity.value)
                .select('_id name userId')
                .lean();
            if (!taggedBucket) continue;

            // Skip if commenter is the bucket owner (no self-notification)
            if (taggedBucket.userId.equals(commenter._id)) continue;

            await Notification.create({
                userId: taggedBucket.userId,
                type:   'bucket_tagged',
                data:   {
                    commentId:         comment._id,
                    bucketId:          taggedBucket._id,
                    bucketName:        taggedBucket.name,
                    commenterUsername: commenter.username || '',
                    commenterAvatar:   commenter.avatar   || '',
                    snippet:           comment.body.slice(0, 100),
                },
            });

            pushNotification(String(taggedBucket.userId), { type: 'new_notification' });
        }
    } catch (err) {
        console.error('[bucketComments] sendBucketTagNotifications error:', err);
    }
}

// Notify the parent comment author when someone replies (fire-and-forget — never throws).
async function sendReplyNotification(replyComment, parentCommentId, bucket, replier) {
    try {
        if (!parentCommentId) return;
        const parent = await BucketComment.findById(parentCommentId).select('userId username').lean();
        if (!parent) return;
        // Skip self-reply
        if (parent.userId.equals(replier._id)) return;

        await Notification.create({
            userId: parent.userId,
            type:   'comment_reply',
            data:   {
                commentId:      replyComment._id,
                bucketId:       bucket._id,
                bucketName:     bucket.name,
                replierUsername: replier.username || '',
                replierAvatar:   replier.avatar   || '',
                snippet:         replyComment.body.slice(0, 100),
            },
        });
        pushNotification(String(parent.userId), { type: 'new_notification' });
    } catch (err) {
        console.error('[bucketComments] sendReplyNotification error:', err);
    }
}

// Notify comment author when someone agrees with their comment (fire-and-forget — never throws).
async function sendAgreementNotification(comment, bucket, agreer) {
    try {
        // Skip self-agree (shouldn't happen, but guard anyway)
        if (comment.userId.equals(agreer._id)) return;

        await Notification.create({
            userId: comment.userId,
            type:   'comment_agreed',
            data:   {
                commentId:     comment._id,
                bucketId:      bucket._id,
                bucketName:    bucket.name,
                agreerUsername: agreer.username || '',
                agreerAvatar:   agreer.avatar   || '',
                snippet:        comment.body.slice(0, 100),
            },
        });
        pushNotification(String(comment.userId), { type: 'new_notification' });
    } catch (err) {
        console.error('[bucketComments] sendAgreementNotification error:', err);
    }
}

// ── GET / — Paginated comment list ───────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { id: bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const bucket = await Bucket.findById(bucketId).select('_id').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        const isAnon = !req.user || req.user.isAnonymous;
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = isAnon ? 3 : Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip   = isAnon ? 0 : (page - 1) * limit;

        const filter = { bucketId, deletedAt: null };

        // Exclude comments from users who have blocked the viewer
        if (!isAnon) {
            const blocks = await Block.find({ blockedId: req.user._id }).select('blockerId').lean();
            if (blocks.length) {
                filter.userId = { $nin: blocks.map(b => b.blockerId) };
            }
        }

        const [comments, total] = await Promise.all([
            BucketComment.find(filter)
                .sort({ isPinned: -1, agreementCount: -1, createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            BucketComment.countDocuments(filter),
        ]);

        // Batch-fetch which comments the current user has agreed on
        let agreedSet = new Set();
        if (!isAnon && comments.length) {
            const ids = comments.map(c => c._id);
            const agreements = await CommentAgreement.find({
                commentId: { $in: ids },
                userId:    req.user._id,
            }).select('commentId').lean();
            agreedSet = new Set(agreements.map(a => String(a.commentId)));
        }

        const annotated = comments.map(c => ({
            ...c,
            userAgreed: agreedSet.has(String(c._id)),
        }));

        return res.json({
            comments:          annotated,
            total,
            page,
            hasMore:           isAnon ? false : skip + comments.length < total,
            truncatedForAnon:  isAnon && total > 3,
        });
    } catch (err) {
        console.error('[bucketComments] GET /:', err);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// ── POST / — Create comment ───────────────────────────────────────────────────
router.post('/', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { id: bucketId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(bucketId)) {
            return res.status(400).json({ error: 'Invalid bucket ID' });
        }

        const bucket = await Bucket.findById(bucketId).select('_id name userId').lean();
        if (!bucket) return res.status(404).json({ error: 'Bucket not found' });

        // Gate: must have clicked at least 2 links in this bucket, unless owner
        const isOwner = bucket.userId.equals(req.user._id);
        if (!isOwner) {
            const clickCount = await LinkClick.countDocuments({ bucketId: bucket._id, userId: req.user._id });
            if (clickCount < 2) {
                return res.status(403).json({
                    code:  'NEED_MORE_CLICKS',
                    error: 'Open at least 2 links to unlock commenting',
                });
            }
        }

        // Rate limit: 1 comment per minute
        const ONE_MIN = 60 * 1000;
        if (req.user.lastCommentAt && Date.now() - new Date(req.user.lastCommentAt).getTime() < ONE_MIN) {
            return res.status(429).json({ error: 'Please wait a moment before posting again' });
        }

        // Validate body
        const body = (req.body.body || '').trim();
        if (!body)          return res.status(400).json({ error: 'Comment cannot be empty' });
        if (body.length > 250) return res.status(400).json({ error: 'Comment too long (max 250 characters)' });

        // Validate parentCommentId (if replying)
        let parentCommentId = null;
        if (req.body.parentCommentId) {
            if (!mongoose.Types.ObjectId.isValid(req.body.parentCommentId)) {
                return res.status(400).json({ error: 'Invalid parent comment ID' });
            }
            const parent = await BucketComment.findOne({
                _id:       req.body.parentCommentId,
                bucketId,
                deletedAt: null,
            }).select('_id').lean();
            if (!parent) return res.status(400).json({ error: 'Parent comment not found' });
            parentCommentId = parent._id;
        }

        // Parse + resolve entity references from the body
        const entities    = await parseAndResolveEntities(body, req.user._id);
        const editLockedAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

        const comment = await BucketComment.create({
            bucketId,
            userId:   req.user._id,
            username: req.user.username || '',
            avatar:   req.user.avatar   || '',
            body,
            parentCommentId,
            entities,
            editLockedAt,
        });

        // Update rate-limit timestamp (fire-and-forget)
        User.findByIdAndUpdate(req.user._id, { lastCommentAt: new Date() }).catch(() => {});

        // Send notifications (fire-and-forget)
        sendMentionNotifications(comment, bucket, req.user).catch(() => {});
        sendBucketTagNotifications(comment, req.user).catch(() => {});
        sendReplyNotification(comment, parentCommentId, bucket, req.user).catch(() => {});

        return res.status(201).json({ comment: { ...comment.toObject(), userAgreed: false } });
    } catch (err) {
        console.error('[bucketComments] POST /:', err);
        res.status(500).json({ error: 'Failed to post comment' });
    }
});

// ── PATCH /:commentId — Edit comment ─────────────────────────────────────────
router.patch('/:commentId', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });
        if (!comment.userId.equals(req.user._id)) return res.status(403).json({ error: 'Forbidden' });
        if (comment.isEdited)                      return res.status(409).json({ error: 'Comment has already been edited once' });
        if (new Date() > comment.editLockedAt)     return res.status(403).json({ error: 'Edit window has expired (48 hours)' });

        const body = (req.body.body || '').trim();
        if (!body)             return res.status(400).json({ error: 'Comment cannot be empty' });
        if (body.length > 250) return res.status(400).json({ error: 'Comment too long (max 250 characters)' });

        const entities = await parseAndResolveEntities(body, req.user._id);

        const updated = await BucketComment.findByIdAndUpdate(
            commentId,
            { body, entities, isEdited: true, editedAt: new Date() },
            { new: true }
        );

        // Send mention + bucket-tag notifications for edited comment (fire-and-forget)
        const { id: bucketId } = req.params;
        const editBucket = await Bucket.findById(bucketId).select('_id name').lean();
        if (editBucket) {
            sendMentionNotifications(updated, editBucket, req.user).catch(() => {});
            sendBucketTagNotifications(updated, req.user).catch(() => {});
        }

        return res.json({ comment: updated });
    } catch (err) {
        console.error('[bucketComments] PATCH /:commentId:', err);
        res.status(500).json({ error: 'Failed to edit comment' });
    }
});

// ── DELETE /:commentId — Soft delete ─────────────────────────────────────────
router.delete('/:commentId', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { id: bucketId, commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        const isOwn = comment.userId.equals(req.user._id);
        if (!isOwn) {
            const bucket = await Bucket.findById(bucketId).select('userId').lean();
            if (!bucket || !bucket.userId.equals(req.user._id)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        }

        await BucketComment.findByIdAndUpdate(commentId, { deletedAt: new Date() }, { timestamps: false });
        return res.json({ ok: true });
    } catch (err) {
        console.error('[bucketComments] DELETE /:commentId:', err);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

// ── POST /:commentId/agree — Toggle agreement ─────────────────────────────────
router.post('/:commentId/agree', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId).select('_id userId body deletedAt bucketId').lean();
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        const existing = await CommentAgreement.findOne({ commentId, userId: req.user._id });
        if (existing) {
            await Promise.all([
                CommentAgreement.deleteOne({ _id: existing._id }),
                BucketComment.findByIdAndUpdate(commentId, { $inc: { agreementCount: -1 } }, { timestamps: false }),
            ]);
            return res.json({ agreed: false });
        } else {
            await Promise.all([
                CommentAgreement.create({ commentId, userId: req.user._id }),
                BucketComment.findByIdAndUpdate(commentId, { $inc: { agreementCount: 1 } }, { timestamps: false }),
            ]);
            // Notify comment author (fire-and-forget)
            Bucket.findById(comment.bucketId).select('_id name').lean().then(b => {
                if (b) sendAgreementNotification(comment, b, req.user).catch(() => {});
            }).catch(() => {});
            return res.json({ agreed: true });
        }
    } catch (err) {
        console.error('[bucketComments] POST /:commentId/agree:', err);
        res.status(500).json({ error: 'Failed to toggle agreement' });
    }
});

// ── PATCH /:commentId/pin — Curator pin toggle ────────────────────────────────
router.patch('/:commentId/pin', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { id: bucketId, commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const bucket = await Bucket.findById(bucketId).select('userId').lean();
        if (!bucket || !bucket.userId.equals(req.user._id)) {
            return res.status(403).json({ error: 'Only the curator can pin comments' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        comment.isPinned = !comment.isPinned;
        await comment.save();

        return res.json({ isPinned: comment.isPinned });
    } catch (err) {
        console.error('[bucketComments] PATCH /:commentId/pin:', err);
        res.status(500).json({ error: 'Failed to toggle pin' });
    }
});

// ── POST /:commentId/report ───────────────────────────────────────────────────
router.post('/:commentId/report', requireRegistered, requireVerification, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }

        const comment = await BucketComment.findById(commentId).select('_id userId deletedAt').lean();
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });
        if (comment.userId.equals(req.user._id)) {
            return res.status(400).json({ error: 'Cannot report your own comment' });
        }

        const validReasons = ['spam', 'harassment', 'inappropriate', 'other'];
        const { reason } = req.body;
        if (!reason || !validReasons.includes(reason)) {
            return res.status(400).json({ error: 'Invalid reason' });
        }

        await CommentReport.create({ commentId, reporterId: req.user._id, reason });
        return res.json({ success: true });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'Already reported' });
        console.error('[bucketComments] POST /:commentId/report:', err);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// ── POST /:commentId/refresh-entity — Refresh a bucket_ref snapshot ───────────
// The client sends the entityIndex (position in comment.entities array).
// We re-fetch the bucket and update the stored snapshot.
router.post('/:commentId/refresh-entity', requireRegistered, async (req, res) => {
    try {
        const { commentId }  = req.params;
        const { entityIndex } = req.body;

        if (!mongoose.Types.ObjectId.isValid(commentId)) {
            return res.status(400).json({ error: 'Invalid comment ID' });
        }
        if (typeof entityIndex !== 'number' || entityIndex < 0) {
            return res.status(400).json({ error: 'Invalid entity index' });
        }

        const comment = await BucketComment.findById(commentId);
        if (!comment || comment.deletedAt) return res.status(404).json({ error: 'Comment not found' });

        const entity = comment.entities[entityIndex];
        if (!entity || entity.type !== 'bucket_ref') {
            return res.status(400).json({ error: 'Entity is not a bucket reference' });
        }

        const snapshot = await fetchBucketSnapshot(entity.value);
        comment.entities[entityIndex].snapshot = snapshot;
        comment.markModified('entities'); // required for Mixed-array mutation
        await comment.save();

        return res.json({ snapshot });
    } catch (err) {
        console.error('[bucketComments] POST /:commentId/refresh-entity:', err);
        res.status(500).json({ error: 'Failed to refresh entity' });
    }
});

export default router;
