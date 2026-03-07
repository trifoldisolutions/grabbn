// server/routes/stripeConnect.js
import express from 'express';
import Stripe from 'stripe';
import User from '../models/user.js';
import Transaction from '../models/transaction.js';
import { requireAuth } from '../middleware/anonymousAuth.js';
import { CREDITS_PER_DOLLAR, CASHOUT_MIN } from '../config.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// GET /api/connect/status
router.get('/status', requireAuth, async (req, res) => {
    try {
        res.json({
            stripeAccountStatus: req.user.stripeAccountStatus ?? 'none',
            credits: req.user.credits ?? 0
        });
    } catch (error) {
        console.error('Error fetching connect status:', error);
        res.status(500).json({ error: 'Failed to fetch connect status' });
    }
});

// POST /api/connect/onboard
router.post('/onboard', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to connect a bank account' });
        }

        const origin = `${req.protocol}://${req.get('host')}`;
        let accountId = req.user.stripeAccountId;

        // Create a new Express account if one doesn't exist yet
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                metadata: { userId: req.user._id.toString() }
            });
            accountId = account.id;
            await User.findByIdAndUpdate(req.user._id, {
                stripeAccountId: accountId,
                stripeAccountStatus: 'pending'
            });
        }

        // Generate (or resume) the onboarding link
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${origin}/api/connect/return?userId=${req.user._id}&refresh=true`,
            return_url: `${origin}/api/connect/return?userId=${req.user._id}`,
            type: 'account_onboarding'
        });

        res.json({ url: accountLink.url });
    } catch (error) {
        console.error('Error creating Stripe Connect onboarding link:', error);
        res.status(500).json({ error: 'Failed to start onboarding' });
    }
});

// GET /api/connect/return  — Stripe redirects here after onboarding
// No session cookie available in this redirect, so userId is passed via query param
router.get('/return', async (req, res) => {
    const { userId, refresh } = req.query;
    const origin = `${req.protocol}://${req.get('host')}`;

    if (!userId) {
        return res.redirect(`${origin}/?connect_pending=true`);
    }

    try {
        const user = await User.findById(userId);
        if (!user || !user.stripeAccountId) {
            return res.redirect(`${origin}/?connect_pending=true`);
        }

        // If Stripe sent us back due to a refresh (link expired), regenerate the link
        if (refresh === 'true') {
            const accountLink = await stripe.accountLinks.create({
                account: user.stripeAccountId,
                refresh_url: `${origin}/api/connect/return?userId=${userId}&refresh=true`,
                return_url: `${origin}/api/connect/return?userId=${userId}`,
                type: 'account_onboarding'
            });
            return res.redirect(accountLink.url);
        }

        // Check if onboarding completed successfully
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        if (account.charges_enabled) {
            await User.findByIdAndUpdate(userId, { stripeAccountStatus: 'active' });
            return res.redirect(`${origin}/?connect_success=true`);
        } else {
            return res.redirect(`${origin}/?connect_pending=true`);
        }
    } catch (error) {
        console.error('Error handling Stripe Connect return:', error);
        return res.redirect(`${origin}/?connect_pending=true`);
    }
});

// POST /api/connect/cashout
router.post('/cashout', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to cash out' });
        }
        if (req.user.stripeAccountStatus !== 'active') {
            return res.status(403).json({ error: 'Connect a bank account before cashing out' });
        }

        const credits = req.user.credits ?? 0;
        if (credits < CASHOUT_MIN) {
            return res.status(402).json({
                error: `Minimum cashout is ${CASHOUT_MIN} credits ($${(CASHOUT_MIN / CREDITS_PER_DOLLAR).toFixed(2)})`,
                required: CASHOUT_MIN,
                available: credits
            });
        }

        const centsToTransfer = Math.floor(credits / CREDITS_PER_DOLLAR * 100);

        // Debit credits first
        await User.findByIdAndUpdate(req.user._id, { $inc: { credits: -credits } });

        let transfer;
        try {
            transfer = await stripe.transfers.create({
                amount: centsToTransfer,
                currency: 'usd',
                destination: req.user.stripeAccountId
            });
        } catch (stripeError) {
            // Stripe failed — refund the credits immediately
            await User.findByIdAndUpdate(req.user._id, { $inc: { credits: credits } });
            console.error('Stripe transfer failed:', stripeError);
            return res.status(502).json({ error: 'Transfer failed. Your credits were not deducted.' });
        }

        // Log the cashout transaction
        await Transaction.create({
            userId: req.user._id,
            type: 'cashout',
            amount: -credits,
            stripePaymentIntentId: transfer.id
        });

        res.json({ success: true, transferred: centsToTransfer });
    } catch (error) {
        console.error('Error processing cashout:', error);
        res.status(500).json({ error: 'Failed to process cashout' });
    }
});

// Exported separately — registered in serve.js BEFORE express.json() with raw body
export async function handleConnectWebhook(req, res) {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_CONNECT_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Stripe Connect webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'transfer.failed') {
        const transfer = event.data.object;
        try {
            // Find the cashout transaction by transfer ID
            const transaction = await Transaction.findOne({
                stripePaymentIntentId: transfer.id,
                type: 'cashout'
            });

            if (transaction) {
                // Refund the credits (amount is negative, so negate it to get the positive value)
                await User.findByIdAndUpdate(transaction.userId, {
                    $inc: { credits: Math.abs(transaction.amount) }
                });
                console.log(`Refunded ${Math.abs(transaction.amount)} credits to user ${transaction.userId} after transfer.failed`);
            }
        } catch (err) {
            console.error('Error handling transfer.failed webhook:', err);
            return res.status(500).send('Failed to process webhook');
        }
    }

    res.json({ received: true });
}

export default router;
