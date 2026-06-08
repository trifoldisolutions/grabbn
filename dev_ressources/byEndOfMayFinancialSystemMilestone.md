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
- Both "Save as PDF" buttons (hero + bottom CTA) confirmed to open in new tab via `target="_blank"`

### Seed data cleanup
- Removed 38 fake seed transactions from `@fatshew` account
- Reset credit balance to 0

---

## Session — 2026-05-20

### Bucket panel — Monetization & Promote (`views/partials/layout-end.ejs`)
- **Monetization row**: for non-partner users, the "Disabled" label now includes an inline "Become a Grabbn Partner" anchor link (`/partnership`) on the same line (`Disabled · Become a Grabbn Partner`), matching the `text-sm` size of the "Don't run ads in my bucket" link; the link is hidden for partners via JS
- **Promote this Bucket button**: replaced the broadcast icon with a trending/chart-up arrow SVG; moved the block to sit directly below the Monetization row (previously it was at the bottom of the settings list, now order is: Monetization → Promote → Mature audience → Comments → Grabs)

### Partnership page — tier-aware CTAs (`views/partnership.ejs`)
- Added server-side `isJuniorPartner` flag (derived from `user.isPartner`) at the top of the template
- **Non-partners**: only "Apply Now" is shown — "Upgrade to Pro" / "Upgrade Status" buttons are hidden at all three locations (hero, eligibility table footer, bottom CTA)
- **Junior partners**: "Upgrade to Pro" button appears alongside "Apply Now" at all three locations, pointing to `/partnership/apply?tier=pro`
- Fixed bottom CTA "Save as PDF" missing `target="_blank"`

### Ads & monetization model — clarified
- **All public buckets carry ads by default**, regardless of user status — there is no opt-in
- **Partners only** get the per-bucket "Platform Ran Ads" toggle, which lets them turn ads *off* on specific buckets; opting out of ads on a bucket means no ad revenue share for that bucket
- **Per-link monetization (paywall)** is a separate, orthogonal concept: the bucket owner sets a price, and any link flagged as monetized falls behind that paywall — users must pay once to access all paywalled links in the bucket; it is not a per-link ad injection
- Ads and paywalls can coexist: free-access links in a paywalled bucket can still carry ads

### Enforcement — docs section (planned)
- A dedicated section in the docs page will surface each user's enforcement point total, rolling 30-day window status, and partner privilege standing — to be built as a separate task

---

## Session — 2026-05-21 → 2026-06-07

### Partnership apply page (`views/partnership-apply.ejs`) — full build
- Multi-step application form: eligibility check screen → Step 1 (pitch + linked accounts) → Step 2 (ID + selfie upload + US residency confirmation) → Step 3 (review & submit) → success state
- Eligibility screen loads `/api/partnership/eligibility` and builds per-tier stat cards with pass/fail indicators
- `?tier=junior` / `?tier=pro` query param pre-selects the tier and jumps to the form section
- Gated states: already a partner, not logged in, email unverified, application pending
- File upload dropzones for ID and selfie with drag-and-drop + preview
- Linked accounts section (up to 10 accounts, each with email, phone, and up to 3 bucket owner IDs)
- Profile completeness warning (avatar + display name + bio required before applying)

### Partnership API (`server/routes/partnership.js`)
- `GET /api/partnership/status` — returns current user's application status / approved tier
- `GET /api/partnership/eligibility` — computes hard gates + per-stat values for Junior and Pro tiers
- `POST /api/partnership/apply` — validates and stores application; uploads ID + selfie to R2 via `uploadImageToR2`; validates pitch length, tier, residency & age confirmations, file size; blocks duplicate pending applications

### PartnerApplication model (`server/models/partnerApplication.js`)
- Fields: userId, status, tier, pitch, idFileRef (R2 URL), selfieFileRef (R2 URL), claimedAccounts, usResidentConfirmed, ageConfirmed, submittedAt, reviewedAt, reviewedBy, rejectionReason

### UserDocument model + route (`server/models/userDocument.js`, `server/routes/documents.js`)
- Model stores gov-id / selfie R2 URLs per user (unique per type)
- `GET /api/documents` — returns upload status (no file content)
- `POST /api/documents` — upload or replace a verification document; decodes base64 data URL and pushes to R2

### Admin partner management (`server/routes/admin/partners.js`)
- `GET /api/admin/partners` — paginated list of all current partners
- `GET /api/admin/partners/applications` — paginated application queue, filterable by `?status=pending|approved|rejected`
- `GET /api/admin/partners/applications/:appId` — single application detail (full ID/selfie URLs)
- `PATCH /api/admin/partners/applications/:appId/approve` — sets status=approved, grants `user.isPartner=true`, sends approval email
- `PATCH /api/admin/partners/applications/:appId/reject` — sets status=rejected with optional reason, sends rejection email
- `PATCH /api/admin/partners/:userId/grant` — grant partner status directly (bypasses application queue), sends approval email
- `PATCH /api/admin/partners/:userId/revoke` — revoke partner status, sends rejection email as notification
- `sendPartnerApprovedEmail` + `sendPartnerRejectedEmail` implemented in `server/utils/email.js`

### Admin partner application views
- `views/admin/partner-applications.ejs` — applications list table with pending/approved/rejected filter tabs + pagination
- `views/admin/partner-application-detail.ejs` — full application detail: applicant info, pitch, ID/selfie images, claimed accounts list, approve/reject action panel with optional rejection reason textarea

### FAQ system
- `FaqItem` model (`server/models/faqItem.js`) — question, answer, category (6 defined categories), source (admin/user), status (pending/published/rejected), order, submittedBy
- `GET /api/faq` — published items grouped by category
- `GET /api/faq/pending` — recent unanswered user submissions (public, last 10)
- `POST /api/faq/questions` — logged-in users can submit questions
- `GET /api/admin/faq` — admin: all items by status
- Admin FAQ CRUD via `server/routes/admin/faq.js` (create/publish/reject/reorder)
- `views/admin/faq.ejs` — admin FAQ management page (pending/published/rejected tabs, add modal)
- `views/faq.ejs` — public FAQ page backed by `/api/faq`

### Contact system
- `server/routes/contact.js` — `POST /api/contact` — supports 4 intents (support, brand, feedback, other) with per-intent fields (category, subject, company/website, feedbackType, organization); strips HTML from message body; sends formatted email via Resend with `replyTo` set to the sender; supports up to 5 file attachments (max 5 MB each)
- `views/contact.ejs` — public contact page backed by `/api/contact`

### Admin reset password (`views/admin/reset-password.ejs`)
- Admin-side password reset page added

---

## Remaining work — Partnership program

### Phase 1 (unblocked — next up)
- [x] `/partnership/apply` page — multi-step form UI (eligibility check → pitch + multi-account declaration → ID + selfie upload → review & submit) with status view for returning applicants
- [x] Apply page reads `?tier=junior` / `?tier=pro` query param and pre-selects the correct tier

### Phase 2 — Backend
- [ ] **Bucket owning ID** — new private field on Bucket model, visible only to the curator; blocks the multi-account verification step (not yet in bucket schema)
- [x] `sendPartnerApprovedEmail` + `sendPartnerRejectedEmail` in `server/utils/email.js`
- [x] Wire approval/rejection emails into admin grant/revoke endpoints (`server/routes/admin/partners.js`)
- [x] Consolidate duplicate partner endpoint — legacy endpoint removed from `server/routes/admin/users.js`; all partner management now lives in `server/routes/admin/partners.js`
- [ ] Points/enforcement system — per-user point storage, rolling 30-day window, ban trigger, partner privilege revocation at 3 lifetime points (no model or route yet)
- [x] Admin application review UI — view submitted ID/selfie/pitch, approve/reject with email notification

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
