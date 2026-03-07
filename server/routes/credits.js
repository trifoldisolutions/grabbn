// server/routes/credits.js
import express from 'express';
import Stripe from 'stripe';
import User from '../models/user.js';
import Bucket from '../models/bucket.js';
import BucketAccess from '../models/bucketAccess.js';
import Transaction from '../models/transaction.js';
import { requireAuth } from '../middleware/anonymousAuth.js';
import { TOPUP_PACKAGES, PLATFORM_CUT_RATIO, FRAUD_RULES } from '../config.js';

// Returns the fraud tier for a given user based on account age
function getAccountTier(user) {
    const ageMs = Date.now() - new Date(user.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return FRAUD_RULES.tiers.find(t => ageDays >= t.minDays && ageDays <= t.maxDays);
}

// Returns today's UTC date string for daily reset comparisons
function utcDateString(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

// Shared helper — awards topup credits after payment confirmed, enforcing R3/R4/R5.
// Throws an Error with a .statusCode property on rule violations.
async function awardTopupCredits(userId, credits, stripePaymentIntentId) {
    // Idempotency — already processed
    const alreadyProcessed = await Transaction.findOne({ stripePaymentIntentId });
    if (alreadyProcessed) return;

    const user = await User.findById(userId);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const tier = getAccountTier(user);
    const now = new Date();
    const todayUtc = utcDateString(now);

    // R4 — daily purchase count
    if (user.dailyPurchaseResetDate === null || utcDateString(user.dailyPurchaseResetDate) !== todayUtc) {
        user.dailyPurchaseCount = 0;
        user.dailyPurchaseResetDate = now;
    }
    if (user.dailyPurchaseCount >= tier.maxPurchasesPerDay) {
        throw Object.assign(
            new Error(`Purchase limit reached: max ${tier.maxPurchasesPerDay} credit purchase(s) per day for your account tier`),
            { statusCode: 429 }
        );
    }

    // R5 — 14-day cumulative cap (only applies while account < 14 days old)
    const accountAgeMs = now - new Date(user.createdAt);
    if (accountAgeMs < 14 * 24 * 60 * 60 * 1000 && tier.cumulativeCap14d !== Infinity) {
        const since = new Date(user.createdAt);
        const pastTopups = await Transaction.aggregate([
            { $match: { userId: user._id, type: 'topup', createdAt: { $gte: since } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const alreadySpent = pastTopups[0]?.total ?? 0;
        if (alreadySpent + credits > tier.cumulativeCap14d) {
            throw Object.assign(
                new Error(`Purchase would exceed your 14-day credit limit of ${tier.cumulativeCap14d} credits`),
                { statusCode: 403 }
            );
        }
    }

    // R3 — hold first purchase 24h
    const isFirstPurchase = user.firstPurchaseAt === null;
    if (isFirstPurchase) {
        user.pendingCredits = (user.pendingCredits ?? 0) + credits;
        user.pendingCreditsUntil = new Date(now.getTime() + FRAUD_RULES.firstPurchaseHoldMs);
        user.firstPurchaseAt = now;
    } else {
        await User.findByIdAndUpdate(userId, { $inc: { credits } });
    }

    user.dailyPurchaseCount += 1;
    await user.save();

    await Transaction.create({
        userId,
        type: 'topup',
        amount: credits,
        stripePaymentIntentId: stripePaymentIntentId || ''
    });
}

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// GET /api/credits/balance
router.get('/balance', requireAuth, async (req, res) => {
    try {
        res.json({ credits: req.user.credits ?? 0 });
    } catch (error) {
        console.error('Error fetching credits balance:', error);
        res.status(500).json({ error: 'Failed to fetch credits balance' });
    }
});

// GET /api/credits/verify?session_id=cs_xxx  — called on return from Stripe checkout
router.get('/verify', requireAuth, async (req, res) => {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status !== 'paid') {
            return res.status(402).json({ error: 'Payment not completed' });
        }
        if (session.metadata?.userId !== req.user._id.toString()) {
            return res.status(403).json({ error: 'Session does not belong to this user' });
        }

        const credits = parseInt(session.metadata?.credits, 10);
        if (!credits || isNaN(credits)) {
            return res.status(400).json({ error: 'Invalid session metadata' });
        }

        try {
            await awardTopupCredits(req.user._id, credits, session.payment_intent);
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
            throw err;
        }

        const user = await User.findById(req.user._id);
        res.json({ credits: user.credits ?? 0 });
    } catch (err) {
        console.error('Error verifying Stripe session:', err);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
});

// POST /api/credits/topup
router.post('/topup', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to purchase credits' });
        }

        const { credits } = req.body;
        if (!Number.isInteger(credits) || credits < 100 || credits > 50000) {
            return res.status(400).json({ error: 'Credits must be a whole number between 100 and 50,000' });
        }

        // R1 — per-transaction cap based on account age tier
        const tier = getAccountTier(req.user);
        if (credits > tier.topupCap) {
            return res.status(403).json({
                error: `Purchase exceeds your account tier limit of ${tier.topupCap} credits ($${(tier.topupCap / 100).toFixed(2)}) per transaction`
            });
        }

        // Preset packages use their defined price; custom amounts use 1 credit = 1 cent
        const pkg = TOPUP_PACKAGES.find(p => p.credits === credits);
        const priceCents = pkg ? pkg.priceCents : credits;

        const origin = `${req.protocol}://${req.get('host')}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `${credits} Credits`,
                            description: `Add ${credits} credits to your Grabbn account`
                        },
                        unit_amount: priceCents
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            metadata: {
                userId: req.user._id.toString(),
                credits: String(credits)
            },
            success_url: `${origin}/?credits_success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/?credits_cancelled=true`
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating Stripe checkout session:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// POST /api/credits/unlock/:bucketId
router.post('/unlock/:bucketId', requireAuth, async (req, res) => {
    try {
        if (req.user.isAnonymous) {
            return res.status(403).json({ error: 'Sign in to unlock buckets' });
        }

        const { bucketId } = req.params;
        const bucket = await Bucket.findById(bucketId);

        if (!bucket) {
            return res.status(404).json({ error: 'Bucket not found' });
        }
        if (!bucket.isPublic) {
            return res.status(403).json({ error: 'Bucket is not public' });
        }
        if (!bucket.isPaywalled) {
            return res.status(400).json({ error: 'Bucket is not paywalled' });
        }

        // Owner always has access — no charge
        if (bucket.userId.equals(req.user._id)) {
            return res.json({ success: true, alreadyOwner: true });
        }

        // Idempotency check — already unlocked
        const existingAccess = await BucketAccess.findOne({
            userId: req.user._id,
            bucketId: bucket._id
        });
        if (existingAccess) {
            return res.json({ success: true, alreadyUnlocked: true });
        }

        // Load full user doc so we can read/write fraud fields
        const viewer = await User.findById(req.user._id);

        // Pending credits release — lazily convert once hold period has passed
        if (viewer.pendingCredits > 0 && viewer.pendingCreditsUntil && viewer.pendingCreditsUntil <= new Date()) {
            viewer.credits = (viewer.credits ?? 0) + viewer.pendingCredits;
            viewer.pendingCredits = 0;
            viewer.pendingCreditsUntil = null;
            await viewer.save();
        }

        // R2 — daily unlock spend cap
        const tier = getAccountTier(viewer);
        const todayUtc = utcDateString();
        if (viewer.dailyUnlockResetDate === null || utcDateString(viewer.dailyUnlockResetDate) !== todayUtc) {
            viewer.dailyUnlockSpend = 0;
            viewer.dailyUnlockResetDate = new Date();
        }
        if (tier.dailyUnlockCap !== Infinity && viewer.dailyUnlockSpend + bucket.price > tier.dailyUnlockCap) {
            return res.status(403).json({
                error: `Daily unlock limit of ${tier.dailyUnlockCap} credits ($${(tier.dailyUnlockCap / 100).toFixed(2)}) reached for your account tier`
            });
        }

        // Check sufficient credits (pendingCredits excluded — not yet spendable)
        if ((viewer.credits ?? 0) < bucket.price) {
            return res.status(402).json({
                error: 'Insufficient credits',
                required: bucket.price,
                available: viewer.credits ?? 0
            });
        }

        const platformCut = Math.floor(bucket.price * PLATFORM_CUT_RATIO);
        const curatorEarns = bucket.price - platformCut;

        // Atomic operations
        await Promise.all([
            // Debit viewer
            User.findByIdAndUpdate(req.user._id, { $inc: { credits: -bucket.price } }),
            // Credit curator
            User.findByIdAndUpdate(bucket.userId, { $inc: { credits: curatorEarns } }),
            // Grant access
            BucketAccess.create({ userId: req.user._id, bucketId: bucket._id }),
            // Log transactions
            Transaction.create([
                { userId: req.user._id, type: 'unlock', amount: -bucket.price, relatedBucketId: bucket._id },
                { userId: bucket.userId, type: 'earn', amount: curatorEarns, relatedBucketId: bucket._id },
                { userId: bucket.userId, type: 'platform_fee', amount: platformCut, relatedBucketId: bucket._id }
            ])
        ]);

        // Track daily unlock spend for R2
        viewer.dailyUnlockSpend += bucket.price;
        await viewer.save();

        res.json({ success: true });
    } catch (error) {
        console.error('Error unlocking bucket:', error);
        res.status(500).json({ error: 'Failed to unlock bucket' });
    }
});

// GET /api/credits/history?page=1
router.get('/history', requireAuth, async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = 20;
        const skip = (page - 1) * limit;

        const [transactions, total] = await Promise.all([
            Transaction.find({ userId: req.user._id, type: { $ne: 'platform_fee' } })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('relatedBucketId', 'name')
                .lean(),
            Transaction.countDocuments({ userId: req.user._id, type: { $ne: 'platform_fee' } })
        ]);

        res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
    } catch (error) {
        console.error('Error fetching transaction history:', error);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// Exported separately — registered in serve.js BEFORE express.json() with raw body
export async function handleWebhook(req, res) {
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

export default router;
