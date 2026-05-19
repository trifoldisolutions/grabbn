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

## Session — 2026-05-19

### Partnership page (`views/partnership.ejs`) — full rebuild
- Rewrote from a thin marketing page into a detailed policy and program document
- Introduced **two-tier system**: Junior Partner and Pro Partner, each with distinct eligibility thresholds and revenue share rates (Pro earns a higher cut)
- Published numeric eligibility requirements for the first time:

| Requirement | Junior | Pro |
|---|---|---|
| Public buckets | 5+, 90+ days old | 15+, 180+ days old |
| Non-archived links / qualifying bucket | 3+ | 10+ |
| Clicks per link | 250+ | 1,000+ |
| Cumulative subscribers | 1,000 | 10,000 |
| Cumulative grab count | 5,000 | 50,000 |
| Account age | 3+ months | 12+ months |
| Clean enforcement record | 60 days | 180 days |

- Full enforcement section added: points table (mild 0.5 / moderate 1 / serious 2), partner-specific thresholds (3 lifetime points = privilege removed, 3 in 30 days = ban, zero-tolerance = permanent), re-application rules (9-month wait, clean slate)
- Community standards section: not allowed / immediately removed / point infractions categories
- Detailed application steps: account verification, identity verification (in-house, no third parties), pitch, multi-account declaration
- Eligibility table footer: tier-specific CTA buttons ("Apply Now" → `/partnership/apply?tier=junior`, "Upgrade Status" → `/partnership/apply?tier=pro`)
- "Save as PDF" buttons added at hero and bottom CTA — open in new tab

### PDF export (`GET /partnership/pdf`)
- Added puppeteer-based server-side PDF route in `serve.js`
- Launches headless Chrome at A4 viewport, navigates to `/partnership`, strips all nav chrome, returns a proper vector PDF (text-selectable, not a screenshot)
- Response uses `Content-Disposition: inline` — opens in browser tab rather than downloading
- Installed `puppeteer` dependency

### Seed data cleanup
- Removed 38 fake seed transactions from `@fatshew` account
- Reset credit balance to 0

---

## Remaining work — Partnership program

### Phase 1 (unblocked — next up)
- [ ] `/partnership/apply` page — multi-step form UI (account verification check → ID + selfie upload → pitch → multi-account declaration) with status view for returning applicants
- [ ] Apply page must read `?tier=junior` / `?tier=pro` query param and pre-select the correct tier

### Phase 2 — Backend
- [ ] **Bucket owning ID** — new private field on Bucket model, visible only to the curator; blocks the multi-account verification step
- [ ] `sendPartnerApprovedEmail` + `sendPartnerRejectedEmail` in `server/utils/email.js`
- [ ] Wire approval/rejection emails into admin grant/revoke endpoints (`server/routes/admin/partners.js`)
- [ ] Consolidate duplicate partner endpoint in `server/routes/admin/users.js:169`
- [ ] Points/enforcement system — per-user point storage, rolling 30-day window, ban trigger, partner privilege revocation at 3 lifetime points
- [ ] Admin application review UI — view submitted ID/selfie/pitch, approve/reject with email notification

### Phase 3 — Monetization (deferred)
- [ ] Promote button modal flow (tier selection + payment)
- [ ] Ad revenue tracking per bucket using `authViewCount` as the basis
- [ ] Stripe Connect integration for partner payouts
- [ ] Differentiated revenue share rates per tier (Junior vs Pro) — exact percentages TBD internally

### Economic risk items (from `docs/plans/economicRisks.txt`)
These are independent of the partnership program but must land before any real money flows:
- [ ] **H1** — Layered fraud rules (chargeback prevention, purchase caps by account age tier)
- [ ] **H3** — Stripe dispute webhook + account flagging
- [ ] **M1** — Fix platform_fee logged to wrong userId
- [ ] **M2** — Platform wallet + revenue tracking endpoint

---

## Key constants
- Platform currency: **GTK**
- Conversion rate: **100 GTK = $1.00**
- Minimum top-up: **800 GTK ($8.00)**
- Creator revenue share (bucket unlocks): **80%**
- Partner ad revenue share: **not disclosed publicly; differs by tier (Junior < Pro)**
- Minimum cash out: **1,000 GTK ($10.00)**
