# Grabbn Partnership Program — Implementation Plan
Last updated: 2026-04-22

---

## 1. What the /v2/partnership page needs to communicate

For a curious visitor, in this order:

1. **Hook / value prop** — one headline that answers "what's in it for me?"
   - Earn from your buckets, control your ad experience, promote your work.

2. **Benefits (concrete)**
   - Ad revenue share — ads enabled per-bucket → partner earns a cut (share % not disclosed publicly)
   - Ads toggle control — opt out of ads per bucket
   - Access to "Promote this Bucket" (paid promotion tiers)
   - Future perks as the program grows

3. **Who it's for**
   - Curators with consistent, quality, values-aligned content
   - Not open to everyone — exclusivity is part of the value
   - No published numeric eligibility threshold for v1; manual review with internal guidelines

4. **How approval works**
   - Apply → one-time human review → approved or rejected via email notification
   - No committed review SLA — "as soon as possible"
   - Once approved, partners act freely within policy

5. **What Grabbn expects (obligations)**
   - Content standards: no harmful, misleading, or low-quality buckets
   - Partner privilege can be revoked for violations (see enforcement system)
   - Payout begins from approval date — no retroactive share for pre-approval period

6. **FAQ section**
   - How long does review take? → As soon as possible, no fixed timeline
   - Can I lose partner status? → Yes, via the points enforcement system
   - Is there a cost to apply? → No
   - When and how do payouts work? → Revenue share starts from approval date; payout mechanism coming in a future update

7. **CTA** — Apply button, visible at top and bottom of page

---

## 2. Policy decisions (all locked)

### Revenue
- Revenue share starts from **approval date**, not account creation. No retroactive share.
- Internal baseline: **60% platform / 40% curator**. Not disclosed publicly. At platform's discretion, subject to change.
- Page copy says "you earn a share of ad revenue" — no percentage stated.
- Payout/cashout mechanism **deferred to v2**. Partners accumulate earnings from approval date; withdrawal ships later via Stripe Connect.

### Eligibility
- **No published numeric threshold for v1.** Manual review only, guided by internal soft criteria (meaningful track record, values-aligned content).
- Thresholds (e.g. subscriber count, lifetime grabs) will be calibrated and published once real applicant data exists.

### Enforcement system (platform-wide — applies to all curators)

**Points system (soft infractions)**
- Only verified/actioned reports generate points. Unverified reports have no consequence.
- Points are weighted by severity and never reset.
- Threshold: **3+ points within a rolling 30-day window → platform ban.**
- Users can see their own point standing (surfaced in the docs/policy page).

| Category | Examples | Points |
|---|---|---|
| Mild | Spam, off-topic content, minor guideline breach | 0.5 |
| Moderate | Misleading content, repeated spam | 1 |
| Serious | Harassment, hate speech, targeted abuse, coordinated bad behavior | 2 |
| Hard infractions | Bypass the points system — immediate action | — |

**Hard/severe infractions (zero-tolerance — 1 verified report)**
- Content or profile immediately blacklisted pending admin review.
- If verified: content taken down or account permanently banned.
- Hard infractions list:
  - Malicious links (phishing, malware) — bucket removed + 1 point to curator
  - CSAM — immediate permanent account ban
  - Non-consensual intimate imagery — content removed + account ban
  - Doxxing (publishing private info without consent) — content removed + account ban
  - Credible threats of violence — account ban
  - Impersonation to deceive — account ban
  - Terrorism / content promoting mass violence — account ban
  - Coordinated spam / bot-driven fake engagement — account ban
  - Copyright infringement at scale — content removed + account ban
- Deceptive monetization is **not** on the hard list — mitigated by vetting; handled as a soft infraction via reports.

**Partnership-specific consequences (layered on top)**
- **3 lifetime points** → partner privilege removed, account stays, curator can re-apply.
- **3 points in a rolling 30-day window** → platform ban + privilege lost.
- **Hard infraction** → privilege and account permanently lost. Cannot re-apply.
- Partners are held to a higher standard: privilege is lost at 3 lifetime points vs. 3-in-a-month for a regular ban.

**Re-application after privilege loss**
- Points do **not** carry over on re-application. Clean slate.
- A **9-month waiting period** applies before a former partner can re-apply.
- Re-application is only possible for soft-path revocations. Hard infraction = permanent.

---

## 3. Product decisions (all locked)

### Application — four steps
1. **Account verification** — email + phone number must be verified before applying.
2. **Identity verification** — government-issued ID + selfie submitted and reviewed manually by an admin. No third-party identity services — data stays in-house.
   - If claiming multiple accounts: must submit email + phone for each, plus 3 bucket owner IDs from each claimed account.
3. **Pitch** — open text field: why the user wants to be a partner.
4. **Financial setup** — handled entirely by Stripe Connect at payout time (v2). Bank details are **not** collected at application.

### Other product decisions
- **Partner badge** — none. No visible badge on profile or bucket cards.
- **Promote button flow** — opens a new modal from within the bucket modal. No page navigation.
- **Bucket owning ID** — new feature required. Buckets will have two IDs:
  - Public shareable ID (existing) — used to share/link buckets
  - Private owning ID (new) — visible only to the curator, used to prove bucket ownership during partner application
- **Monetized buckets on revocation** — ads toggle and monetization toggle revert to non-partner defaults immediately (ads on, no toggle control, monetization disabled).

---

## 4. Technical readiness

### Already in place
- `user.isPartner` field exists on the User model (Boolean, default: false)
- Admin grant/revoke endpoints exist at `server/routes/admin/partners.js` — functional but missing email notifications
- Email system live via **Resend** (`server/utils/email.js`) — OTP, password reset, account lifecycle emails all implemented
- Partner-gated UI controls built: ads toggle, monetization toggle, promote button

### Still to build
- **`PartnerApplication` model** — fields: `userId`, `status` (pending/approved/rejected), `submittedAt`, `reviewedAt`, `reviewedBy`, `rejectionReason`, `pitch`, `idFileRef`, `selfieFileRef`, `claimedAccounts[]` (`{ email, phone, bucketOwnerIds[3] }`)
- **Email functions** — `sendPartnerApprovedEmail(toEmail)` and `sendPartnerRejectedEmail(toEmail, reason)` in `server/utils/email.js`
- **Wire emails** into admin grant/revoke endpoints
- **Consolidate** duplicate partner endpoint in `server/routes/admin/users.js:169`
- **Bucket owning ID** — new field on the Bucket model, exposed only to the bucket owner
- **Points/enforcement system** — store points per user, rolling 30-day window logic, ban trigger
- **Routes** — `/v2/partnership` and `/v2/partnership/apply` (server routes + views)
- **Admin application review UI** — view submitted ID, selfie, pitch, claimed accounts; approve/reject action

---

## 5. Build order

### Phase 1 — UI scaffolding (partially done)
- [x] Running Ads toggle (partner-gated)
- [x] Monetization toggle (partner-gated)
- [x] Promote My Bucket button (greyed out for non-partners)
- [x] "Become a Grabbn Partner" link in modal
- [x] "Don't run ads in my bucket" link in modal
- [ ] `/v2/partnership` about page
- [ ] `/v2/partnership/apply` application page + status view

### Phase 2 — Backend
- [ ] Bucket owning ID feature
- [ ] `PartnerApplication` model
- [ ] `POST /api/partnership/apply`
- [ ] `GET /api/partnership/status`
- [ ] `sendPartnerApprovedEmail` + `sendPartnerRejectedEmail` in email.js
- [ ] Wire emails into admin grant/revoke endpoints
- [ ] Consolidate duplicate partner endpoint in admin/users.js
- [ ] Points/enforcement system (storage + rolling window + ban logic)
- [ ] Admin application review UI

### Phase 3 — Monetization (deferred)
- [ ] Promote button modal flow (tier selection + payment)
- [ ] Ad revenue tracking per bucket
- [ ] Stripe Connect integration for partner payouts

---

## 6. Hardest blockers

1. **Bucket owning ID** — blocks the multi-account step of the application form
2. **`PartnerApplication` model** — blocks the apply endpoint and the admin review UI
3. **Admin endpoints missing email hooks** — decisions are currently silent to the user
