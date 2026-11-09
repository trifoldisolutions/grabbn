// Calls from outside services, mounted at /api before express.json(), so Stripe signatures can be checked against the raw body.
import express from 'express';
import Stripe from 'stripe';
import Transaction from '../models/transaction.js';
import User from '../models/user.js';
import { awardTopupCredits } from '../services/credits.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Registered BEFORE express.json() (see server.js), so it gets the raw body
async function handleWebhook(req, res) {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const credits = parseInt(session.metadata?.credits, 10);

        if (userId && !isNaN(credits)) {
            try {
                await awardTopupCredits(userId, credits, session.payment_intent);
            } catch (err) {
                console.error('Error processing topup webhook:', err);
                return res.status(500).send('Failed to process payment');
            }
        }
    }

    // H3 — dispute claw-back
    if (event.type === 'charge.dispute.created') {
        const charge = event.data.object;
        try {
            const tx = await Transaction.findOne({ stripePaymentIntentId: charge.payment_intent });
            if (tx) {
                const user = await User.findById(tx.userId);
                if (user) {
                    if (user.pendingCreditsUntil && user.pendingCreditsUntil > new Date()) {
                        // Credits not yet released — zero them out
                        user.pendingCredits = 0;
                        user.pendingCreditsUntil = null;
                    } else {
                        // Credits already spendable — flag for manual review
                        user.flagged = true;
                    }
                    await user.save();
                }
            }
        } catch (err) {
            console.error('Error handling dispute webhook:', err);
        }
    }

    res.json({ received: true });
}

// Registered BEFORE express.json() (see server.js), so it gets the raw body
async function handleConnectWebhook(req, res) {
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

// Stripe webhooks — must be registered BEFORE express.json() to receive raw body
router.post('/credits/webhook', express.raw({ type: 'application/json' }), handleWebhook);
router.post('/connect/webhook', express.raw({ type: 'application/json' }), handleConnectWebhook);


router.routes = [
  { method: 'POST', path: '/credits/webhook', label: 'Stripe webhook: top-ups and disputes' },
  { method: 'POST', path: '/connect/webhook', label: 'Stripe Connect webhook: failed transfers' },
];

export default router;
