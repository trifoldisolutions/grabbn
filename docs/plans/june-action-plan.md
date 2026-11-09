# June Action Plan
Last updated: 2026-06-09

---

## 1. Partnership Program

**Phase 1 — UI**
- [x] Running Ads toggle (partner-gated)
- [x] Monetization toggle (partner-gated)
- [x] Promote My Bucket button (greyed out for non-partners)
- [x] "Become a Grabbn Partner" link in modal
- [x] "Don't run ads in my bucket" link in modal
- [x] `/partnership` about page (`views/partnership.ejs`)
- [x] `/partnership/apply` application page + status view (`views/partnership-apply.ejs`)

**Phase 2 — Backend**
- [x] `PartnerApplication` model (`server/models/partnerApplication.js`)
- [x] Admin grant/revoke + approve/reject endpoints (`server/routes/admin/partners.js`)
- [x] `sendPartnerApprovedEmail` + `sendPartnerRejectedEmail` wired into all four endpoints
- [ ] Bucket owning ID — private field on Bucket model, visible only to owner (blocks multi-account step in application form)
- [ ] Enforcement/moderation points system — per-user violation point storage, rolling 30-day ban logic, partner privilege revocation at 3 lifetime points (distinct from guest session `points` field)

**Phase 3 — Monetization (deferred)**
- [ ] Promote button modal (tier selection + payment)
- [ ] Ad revenue tracking per bucket using `authViewCount`
- [ ] Stripe Connect payout integration

---

## 2. Admin Panel

**Backend — all built**
- [x] `adminAuth.js` middleware (`requireModerator` / `requireSuperadmin`)
- [x] Admin router mounted at `/api/admin`
- [x] `server/routes/admin/users.js` — full CRUD
- [x] `server/routes/admin/reports.js` — queue + actions
- [x] `server/routes/admin/buckets.js` — full management
- [x] `server/routes/admin/partners.js` — applications + grant/revoke
- [x] `server/routes/admin/analytics.js` — overview/content/revenue/explore
- [x] `server/routes/admin/system.js` — health/notify/jobs
- [x] `server/routes/admin/audit.js` — paginated log (null-safe, works once model exists)

**Views — fully built**
- [x] `views/admin/layout.ejs` + `layout-end.ejs`
- [x] `views/admin/login.ejs` + `reset-password.ejs`
- [x] `views/admin/users.ejs` + `user-detail.ejs`
- [x] `views/admin/partner-applications.ejs` + `partner-application-detail.ejs`
- [x] `views/admin/reports.ejs` — moderation queue UI
- [x] `views/admin/buckets.ejs` — bucket management UI
- [x] `views/admin/analytics.ejs` — dashboard with KPI cards and charts
- [x] `views/admin/system.ejs` — health indicators + job triggers + broadcast form
- [x] `views/admin/audit.ejs` — audit log table
- [x] `server/models/adminAuditLog.js`

---

## 3. Settings Page Redesign

- [x] `partials/settings-nav.ejs`
- [x] `/settings/account`
- [x] `/settings/privacy`
- [x] `/settings/content`
- [x] `/settings/notifications`
- [x] `/settings/monetization`
- [x] `/settings/integrations`
- [x] `/settings/danger`

**Fully done.**

---

## 4. Repositories Feature

- [x] `LinkClick` model (`server/models/linkClick.js`)
- [x] `POST /api/links/click` endpoint + frontend fires it on link follow
- [x] `buildRepositories.js` job (`server/jobs/buildRepositories.js`)
- [x] `Repository` model (`server/models/repository.js`)
- [x] `/api/repositories` + `/api/repositories/:domain/:tag` endpoints
- [x] `/repository/:domain` page (`views/repository.ejs`)
- [ ] Personalization — user domain affinity from `LinkClick` history, collaborative filtering, session boost, cold-start fallback

---

## 5. Explore Algorithm — Remaining Backlog

- [x] Score jitter, impression tracking, diversity caps (explore feed only)
- [x] BucketSkip filtering from explore feed candidates
- [x] `?src=explore` param on card links in explore feed
- [x] Cold start boost, recency decay, circular viewCount fix
- [ ] Apply impression tracking + diversity caps to the **showroom** feed (currently explore-only)
- [ ] Add `?src=explore` param to card links in **showroom** feed (done in explore, missing in showroom)
- [ ] Collaborative filtering — "users who grabbed X also grabbed Y"
- [ ] Session-aware freshness

---

## 6. Paywall / Economic Risk Mitigations

**Done**
- [x] Fraud fields on User: `firstPurchaseAt`, `dailyUnlockSpend`, `dailyPurchaseCount`, `pendingCredits`, `pendingCreditsUntil`
- [x] `BucketAccess` model, `Transaction` model
- [x] Fraud rules enforced in `server/routes/credits.js` — purchase caps by account age tier, 24h hold on first purchase, daily purchase limit

**Still to build**
- [ ] Stripe dispute webhook handler — zero out pending credits on `charge.dispute.created`; flag account if already spent
- [ ] Credit liability query — `/api/admin/liability` aggregating total credits in circulation
- [ ] Fix `platform_fee` transactions stored under wrong `userId` — use dedicated platform wallet account
- [ ] Platform wallet user for revenue tracking
- [ ] Bucket deletion guard — check `BucketAccess` before deletion; refund affected viewers
- [ ] Bonus credits separation — `bonusCredits` field separate from paid credits

---

## Priority Order

1. ~~**Admin missing views** — reports, buckets, analytics, system, audit + `AdminAuditLog` model~~ ✓ Done
2. **Partnership** — enforcement/moderation points system, bucket owning ID
3. **Repositories personalization**
4. **Explore/showroom** — impression tracking on showroom, `?src=explore` in showroom, collaborative filtering
5. **Economic risk mitigations** — dispute webhook, credit liability, platform wallet
