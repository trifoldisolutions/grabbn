# Settings Page Redesign

## Overview

Redesign the settings page from its current single-toggle state into a fully structured, multi-section experience. Navigation lives in a persistent left sidebar; each category is its own server-rendered route — no single-page bloat, no JS content-swapping between sections.

## Layout

Left nav (always visible) + right content area (section-specific). Active category is highlighted in the nav. Sub-tabs within a section (e.g. notification channels) stay in-page with JS — only cross-section navigation triggers a route change.

## Routes

```
/settings                → redirect to /settings/account
/settings/account        → avatar, username, email, password, verification status, newsletter
/settings/privacy        → DM permissions, grabbed visibility, blocked users
/settings/content        → mature filter, default bucket visibility, default draft mode
/settings/notifications  → per-type in-app (+ future email) toggles
/settings/monetization   → Stripe connect, cashout, meta-fetch quota
/settings/integrations   → bookmarklet token, browser extension setup
/settings/danger         → export data, delete account
```

## Section Breakdown

### Account (merged Profile + Account)
Sub-groups within the page:
- **Profile** — avatar upload / change, username change
- **Security** — email address change, password change, email verification status badge + resend OTP
- **Preferences** — newsletter subscription toggle

### Privacy
- Who can DM you (everyone / following only / nobody)
- Show grabbed buckets on public profile (on/off)
- Blocked users list (view + unblock)

### Content
- Mature content filter (exists today — move here)
- Default visibility for new buckets (public / unlisted / private)
- Default new buckets as draft (on/off)

### Notifications
Per-type toggles (in-app, and email when ready):
- New follower
- Your bucket was grabbed
- Your bucket was unlocked (paid)
- New bucket from someone you follow
- Comment mention / reply / agreement
- New direct message

### Monetization
- Stripe payout account setup / connect status
- Cashout (link to flow)
- Link to transaction history
- Daily meta-fetch quota display + credit top-up

### Integrations
- Bookmarklet token (display + regenerate)
- Browser extension setup instructions / status

### Danger Zone
- Export your data
- Delete account (double-confirm flow)

## Implementation Notes

- Create a `settings-layout` partial that renders the left nav and highlights the active route. All `/settings/*` views include this partial.
- The existing `isMatureGated` toggle moves from `/settings` into `/settings/content` — the root `/settings` just redirects.
- Each section only fetches/renders what it needs server-side; no global settings payload.
- Notification preferences will need a new schema field (e.g. `notificationPrefs` map on User) and a `PATCH /api/user/notification-prefs` endpoint.
- Privacy DM permissions will need a new field (e.g. `dmPermission: 'everyone' | 'following' | 'none'`) and enforcement in the DM send route.
- Avatar upload needs a `POST /api/user/avatar` endpoint (R2 storage, same pipeline as bucket thumbnails).
- Username/email change endpoints need to exist (`PATCH /api/user/profile`, `PATCH /api/user/email`).

## Open Questions

- Do we want username changes to be rate-limited or one-time only?
- For notifications, do we start with in-app only or build the email toggle scaffold now?
- Export data: what format and what data is included?
