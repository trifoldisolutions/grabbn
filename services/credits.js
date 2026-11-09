// Credit rules shared by the credits API and the Stripe webhook.
import { FRAUD_RULES } from '../config/config.js';
import Transaction from '../models/transaction.js';
import User from '../models/user.js';

// Returns the fraud tier for a given user based on account age
export function getAccountTier(user) {
    const ageMs = Date.now() - new Date(user.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return FRAUD_RULES.tiers.find(t => ageDays >= t.minDays && ageDays <= t.maxDays);
}

// Returns today's UTC date string for daily reset comparisons
export function utcDateString(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

// Shared helper — awards topup credits after payment confirmed, enforcing R3/R4/R5.
// Throws an Error with a .statusCode property on rule violations.
export async function awardTopupCredits(userId, credits, stripePaymentIntentId) {
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

