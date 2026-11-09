// The app and its sign-in pages, mounted at /. Paths stay at the top level so existing links keep working.
import express from 'express';
import mongoose from 'mongoose';
import Block from '../models/block.js';
import Conversation from '../models/conversation.js';
import User from '../models/user.js';
import { requireNonAdmin } from '../middleware/adminAuth.js';
import { anonymousAuth, requireAuth, requireVerification } from '../middleware/anonymousAuth.js';
import { _categoriesJson } from '../services/categories.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// App routes — server-rendered with EJS
// ---------------------------------------------------------------------------
const appPages = [
    { path: '/transactions',   view: 'app/transactions',       title: 'Transactions',    page: 'transactions'  },
    // /settings is handled below (redirect + per-section routes)
    { path: '/login',          view: 'app/auth/login',         title: 'Log In',          page: 'login'         },
    { path: '/signup',         view: 'app/auth/signup',        title: 'Sign Up',         page: 'signup'        },
    { path: '/reset-password', view: 'app/auth/reset-password', title: 'Reset Password', page: 'reset-password'},
    { path: '/topup',          view: 'app/topup',              title: 'Top Up Credits',  page: 'topup'         },
];

for (const { path: routePath, view, title, page } of appPages) {
    router.get(routePath, anonymousAuth, requireNonAdmin, (req, res) => {
        res.render(view, { title, page, user: req.user ?? null });
    });
}

// Settings — redirect root + per-section routes
router.get('/settings', anonymousAuth, requireNonAdmin, (req, res) => {
    res.redirect('/settings/account');
});

const SETTINGS_SECTIONS = [
    { section: 'account',       title: 'Account'       },
    { section: 'privacy',       title: 'Privacy'       },
    // 'content' is handled separately below (needs categories data)
    { section: 'notifications', title: 'Notifications' },
    { section: 'monetization',  title: 'Monetization'  },
    { section: 'integrations',  title: 'Integrations'  },
    { section: 'danger',        title: 'Danger Zone'   },
];

for (const { section, title } of SETTINGS_SECTIONS) {
    router.get(`/settings/${section}`, anonymousAuth, requireNonAdmin, (req, res) => {
        res.render(`app/settings-${section}`, { title, page: 'settings', settingsSection: section, user: req.user ?? null });
    });
}

// Settings — content section (needs categories data, handled separately from the generic loop)
router.get('/settings/content', anonymousAuth, requireNonAdmin, (req, res) => {
    const user = req.user ?? null;
    const showAdult = user && !user.isAnonymous && user.isMatureGated === false;
    const categories = showAdult
        ? [..._categoriesJson.categories, ..._categoriesJson.adultCategories]
        : _categoriesJson.categories;
    res.render('app/settings-content', {
        title: 'Content',
        page: 'settings',
        settingsSection: 'content',
        user,
        categories,
    });
});

// Profile page — redirect /v2/profile to the logged-in user's profile route
router.get('/profile', anonymousAuth, requireAuth, (req, res) => {
    const username = req.user?.username;
    if (username) return res.redirect(`/u/${username}`);
    res.redirect('/showroom');
});

// Messages — shared template for both inbox and active conversation
const MSG_DEFAULTS = { activeConversationId: null, conversation: null, otherUser: null };

router.get('/messages', anonymousAuth, requireAuth, requireVerification, (req, res) => {
    res.render('app/messages', { title: 'Messages', page: 'messages', user: req.user, ...MSG_DEFAULTS });
});

router.get('/messages/:conversationId', anonymousAuth, requireAuth, requireVerification, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user });
        }

        const conversation = await Conversation.findById(conversationId).lean();
        if (!conversation) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user });

        const isParticipant = conversation.participants.some(p => p.toString() === req.user._id.toString());
        if (!isParticipant) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user });

        const otherId = conversation.participants.find(p => p.toString() !== req.user._id.toString());
        if (otherId) {
            const blocked = await Block.exists({ blockerId: otherId, blockedId: req.user._id });
            if (blocked) return res.status(404).render('public/404', { title: 'Not Found', page: '', user: req.user });
        }

        const otherUser = otherId ? await User.findById(otherId).select('username avatar anonymousId').lean() : null;

        res.render('app/messages', {
            title:                `Chat with @${otherUser?.username || 'User'}`,
            page:                 'messages',
            user:                 req.user,
            activeConversationId: String(conversationId),
            conversation,
            otherUser,
        });
    } catch (err) {
        console.error('Error loading conversation page:', err);
        res.status(500).send('Error loading conversation');
    }
});


router.routes = [
  { method: 'GET', path: '/transactions', label: 'Transactions page' },
  { method: 'GET', path: '/login', label: 'Log in page' },
  { method: 'GET', path: '/signup', label: 'Sign up page' },
  { method: 'GET', path: '/reset-password', label: 'Reset password page' },
  { method: 'GET', path: '/topup', label: 'Top up credits page' },
  { method: 'GET', path: '/settings', label: 'Settings: redirects to the account section' },
  { method: 'GET', path: '/settings/account', label: 'Settings: account' },
  { method: 'GET', path: '/settings/privacy', label: 'Settings: privacy' },
  { method: 'GET', path: '/settings/notifications', label: 'Settings: notifications' },
  { method: 'GET', path: '/settings/monetization', label: 'Settings: monetization' },
  { method: 'GET', path: '/settings/integrations', label: 'Settings: integrations' },
  { method: 'GET', path: '/settings/danger', label: 'Settings: danger zone' },
  { method: 'GET', path: '/settings/content', label: 'Settings: content' },
  { method: 'GET', path: '/profile', label: 'Own profile: redirects to /u/:username' },
  { method: 'GET', path: '/messages', label: 'Messages page' },
  { method: 'GET', path: '/messages/:conversationId', label: 'Messages page, one conversation' },
];

export default router;
