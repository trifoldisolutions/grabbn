// server/routes/admin/users.js
// User management routes — accessible by moderators and superadmins.
// Certain destructive/privileged actions are locked to superadmin only.
import express from 'express';
import mongoose from 'mongoose';
import User from '../../models/user.js';
import { requireSuperadmin } from '../../middleware/adminAuth.js';

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

// ── GET /api/admin/users ─────────────────────────────────────────────────────
// List users with pagination and filters.
// Query params: email, username, role, isEmailVerified, isPartner, flagged,
//               suspended (bool), country, page, limit
router.get('/', async (req, res) => {
    try {
        const {
            email, username, role, isEmailVerified, isPartner,
            flagged, suspended, country,
            page = 1, limit = 30
        } = req.query;

        const filter = {};
        if (email)           filter.email       = { $regex: email, $options: 'i' };
        if (username)        filter.username    = { $regex: username, $options: 'i' };
        if (role)            filter.role        = role;
        if (isEmailVerified !== undefined) filter.isEmailVerified = isEmailVerified === 'true';
        if (isPartner !== undefined)       filter.isPartner       = isPartner === 'true';
        if (flagged !== undefined)         filter.flagged         = flagged === 'true';
        if (suspended === 'true')          filter.accountSuspendedAt = { $ne: null };
        if (suspended === 'false')         filter.accountSuspendedAt = null;
        if (country)         filter.country     = country.toUpperCase();

        // Exclude anonymous users from admin user list
        filter.isAnonymous = false;

        const skip = (Number(page) - 1) * Number(limit);

        const [users, total] = await Promise.all([
            User.find(filter)
                .select('email username role isEmailVerified isPartner flagged accountSuspendedAt credits country createdAt lastActive')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            User.countDocuments(filter)
        ]);

        res.json({
            users,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        console.error('[admin/users GET]', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ── GET /api/admin/users/:userId ─────────────────────────────────────────────
// Single user detail view.
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const user = await User.findById(userId)
            .select('-password -otpCode -otpExpires -otpSentAt -resetPasswordToken -resetPasswordExpires')
            .lean();

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ user });
    } catch (err) {
        console.error('[admin/users/:id GET]', err);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// ── PATCH /api/admin/users/:userId/suspend ───────────────────────────────────
// Suspend or unsuspend a user. Moderator+.
// Body: { suspend: true | false }
router.patch('/:userId/suspend', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const { suspend } = req.body;
        if (typeof suspend !== 'boolean') return res.status(400).json({ error: '`suspend` (boolean) is required' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot suspend a superadmin' });

        user.accountSuspendedAt = suspend ? new Date() : null;
        await user.save();

        res.json({ message: suspend ? 'User suspended' : 'User unsuspended', userId });
    } catch (err) {
        console.error('[admin/users/:id/suspend]', err);
        res.status(500).json({ error: 'Failed to update suspension status' });
    }
});

// ── PATCH /api/admin/users/:userId/verify ────────────────────────────────────
// Force-verify a user's email. Moderator+.
router.patch('/:userId/verify', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const user = await User.findByIdAndUpdate(
            userId,
            { isEmailVerified: true, accountSuspendedAt: null },
            { new: true }
        ).select('email isEmailVerified');

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ message: 'Email verified', user });
    } catch (err) {
        console.error('[admin/users/:id/verify]', err);
        res.status(500).json({ error: 'Failed to verify email' });
    }
});

// ── PATCH /api/admin/users/:userId/role ─────────────────────────────────────
// Change a user's role. Superadmin only.
// Body: { role: 'user' | 'moderator' | 'superadmin' }
router.patch('/:userId/role', requireSuperadmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const { role } = req.body;
        const validRoles = ['user', 'moderator', 'superadmin'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
        }

        // Prevent self-demotion
        if (String(req.user._id) === String(userId) && role !== 'superadmin') {
            return res.status(400).json({ error: 'You cannot demote yourself' });
        }

        const user = await User.findByIdAndUpdate(userId, { role }, { new: true }).select('email role');
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ message: 'Role updated', user });
    } catch (err) {
        console.error('[admin/users/:id/role]', err);
        res.status(500).json({ error: 'Failed to update role' });
    }
});

// ── PATCH /api/admin/users/:userId/credits ───────────────────────────────────
// Adjust credits balance. Superadmin only.
// Body: { adjustment: Number (positive to add, negative to subtract), reason: String }
router.patch('/:userId/credits', requireSuperadmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const { adjustment, reason } = req.body;
        if (typeof adjustment !== 'number' || adjustment === 0) {
            return res.status(400).json({ error: '`adjustment` must be a non-zero number' });
        }
        if (!reason || typeof reason !== 'string') {
            return res.status(400).json({ error: '`reason` string is required for audit purposes' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const newBalance = Math.max(0, user.credits + adjustment);
        user.credits = newBalance;
        await user.save();

        console.log(`[admin] credits adjusted: userId=${userId} adjustment=${adjustment} reason="${reason}" by adminId=${req.user._id}`);

        res.json({ message: 'Credits adjusted', userId, adjustment, newBalance });
    } catch (err) {
        console.error('[admin/users/:id/credits]', err);
        res.status(500).json({ error: 'Failed to adjust credits' });
    }
});

// ── DELETE /api/admin/users/:userId ─────────────────────────────────────────
// Hard-delete a user immediately, bypassing the 70-hour suspension window.
// Superadmin only.
router.delete('/:userId', requireSuperadmin, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        // Prevent self-deletion
        if (String(req.user._id) === String(userId)) {
            return res.status(400).json({ error: 'You cannot delete your own account via admin panel' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete a superadmin' });

        await User.findByIdAndDelete(userId);

        console.log(`[admin] user hard-deleted: userId=${userId} by adminId=${req.user._id}`);

        res.json({ message: 'User deleted', userId });
    } catch (err) {
        console.error('[admin/users/:id DELETE]', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

export default router;
