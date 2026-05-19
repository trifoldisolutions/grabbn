# Financial System Milestone — End of May 2026

## What was done this session

### Platform currency renamed: JWL → GTK
- Replaced across all files: `transactions.ejs`, `topup.ejs`, `layout-end.ejs`, `serve.js`, `seed-todos.js`

### Transactions page (`views/transactions.ejs`)
- Added net change line to the balance card (reacts to period toggle)
- Chart series toggle rebuilt as proper checkboxes (Earned / Spent)
- Period selector replaced with a custom dropdown (7d / 30d / 90d / YTD / Lifetime)
- Backend extended to support YTD and Lifetime with monthly bucketing
- Transaction history rebuilt as a real table with search, filter, and sort
- Bulk selection with contextual action header (Delete, Dispute)
- Page-wide currency switcher (GTK ↔ user's fiat) affecting all amounts and chart labels
- Fixed ID collision between transactions page button and new bucket modal button (`bucketPriceCurrencyBtn`)
- Fixed `syncCurrencyBtn` to use `btn.querySelector('span')` for reliable label updates
- Fixed unknown currency codes (e.g. `EWL`) falling back to `USD`
- Fixed filter dropdown being clipped by `overflow-hidden` on the history container

### Topup page (`views/topup.ejs`)
- All `credits` display labels replaced with `GTK`
- Pricing tiers updated (Stripe fee floor):
  - Starter: $2 → $8 (200 → 800 GTK)
  - Explorer: $5 → $15 (500 → 1,500 GTK)
  - Pro: $10 → $25 (1,000 → 2,500 GTK)
  - Power: $50 unchanged (5,000 GTK)
- Custom amount minimum updated to 800 GTK ($8.00)
- `?jwl=` query param renamed to `?gtk=`

### GTK terminology rollout (completed)
- ✅ `layout-end.ejs` — full EWL→GTK rename in bucket pricing panel: button label, `EWL_TO_USD`→`GTK_TO_USD`, `currentCurrency`, `priceAsEWL()`→`priceAsGTK()`, all display strings and reset logic
- ✅ `views/partials/topbar.ejs` — `bucket_unlocked` notification: `+X cr` → `+X GTK` (no balance display in topbar)
- ✅ `views/settings-monetization.ejs` — section header and row labels updated to GTK
- ✅ `views/bucket.ejs` — price badge, unlock CTA button, JS-rendered price badge, and button reset text after failed unlock
- ✅ `views/partials/bucket-card.ejs` — feed card price badge updated to GTK
- ✅ `views/partnership.ejs` — no changes needed, already clean
- ✅ `server/routes/credits.js` — minimum raised 100 → 800 GTK, error message updated, Stripe checkout product name updated, CSV export column header updated

---

## Remaining work

None — all planned items for this milestone are complete.

If new items come up, add them here before starting work.

---

## Key constants
- Platform currency: **GTK**
- Conversion rate: **100 GTK = $1.00**
- Minimum top-up: **800 GTK ($8.00)**
- Creator revenue share: **80%**
- Minimum cash out: **1,000 GTK ($10.00)**
