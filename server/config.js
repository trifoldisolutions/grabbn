// Credit system constants
export const CREDITS_PER_DOLLAR = 100; // 100 credits = $1.00
export const PLATFORM_CUT_RATIO = 0.20; // Platform keeps 20%, curator earns 80%
export const CASHOUT_MIN = 1000; // Minimum credits to cash out (= $10.00)

export const TOPUP_PACKAGES = [
    { credits: 200,  priceCents: 200,  label: '$2.00',  name: 'Starter'  },
    { credits: 500,  priceCents: 500,  label: '$5.00',  name: 'Explorer' },
    { credits: 1000, priceCents: 1000, label: '$10.00', name: 'Pro'      },
    { credits: 5000, priceCents: 5000, label: '$50.00', name: 'Power'    },
];

// Fraud prevention rules — tiered by account age
export const FRAUD_RULES = {
    tiers: [
        { minDays: 0,  maxDays: 2,        topupCap: 500,      dailyUnlockCap: 200,      maxPurchasesPerDay: 1,        cumulativeCap14d: 500    },
        { minDays: 3,  maxDays: 7,        topupCap: 1000,     dailyUnlockCap: 500,      maxPurchasesPerDay: 2,        cumulativeCap14d: 2000   },
        { minDays: 8,  maxDays: 30,       topupCap: 5000,     dailyUnlockCap: 2000,     maxPurchasesPerDay: 5,        cumulativeCap14d: 10000  },
        { minDays: 31, maxDays: Infinity, topupCap: Infinity, dailyUnlockCap: Infinity, maxPurchasesPerDay: Infinity, cumulativeCap14d: Infinity },
    ],
    firstPurchaseHoldMs: 24 * 60 * 60 * 1000, // 24h hold on first purchase
};
