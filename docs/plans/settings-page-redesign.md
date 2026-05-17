# Settings Page Redesign

## Overview

Redesign the settings page from its current single-toggle state into a fully structured, multi-section experience. Navigation lives in a persistent left sidebar; each category is its own server-rendered route — no single-page bloat, no JS content-swapping between sections.

## Layout

Left nav (always visible) + right content area (section-specific). Active category is highlighted in the nav. Sub-tabs within a section (e.g. notification channels) stay in-page with JS — only cross-section navigation triggers a route change.

## Routes

```
/settings                → redirect to /settings/account
/settings/account        → avatar, username, display name, bio, category, links/socials, email, password, verification status
/settings/privacy        → DM permissions, activity status, account visibility, show grabbed buckets, blocked users
/settings/content        → muted tags, hidden categories, allow comments default, allow grabs default, mature filter
/settings/notifications  → per-type in-app + email toggles (including newsletter)
/settings/monetization   → Stripe connect, cashout, transaction history, meta-fetch quota
/settings/integrations   → bookmarklet token, browser extension setup
/settings/danger         → export data, delete account
```

## Section Breakdown

### Account
Sub-groups within the page:
- **Profile** — avatar upload / change, username change (rate-limited: 2/day, 3/week, 4/month), display name, bio (128 chars), creator category picker
- **Links** — website URL, social links (platform picker + URL, add/remove)
- **Security** — email address display with verified/unverified badge + resend OTP button, password change (current + new + confirm, show/hide toggles)

Newsletter subscription is managed in **Notifications**, not here.

### Privacy
- **Messaging** — who can message you (multi-select: no one / people I follow / people who follow me / same category / everyone); exclusive options (no one, everyone) clear the rest
- **Activity status** — show online/active status to others (toggle)
- **Profile visibility** — show grabbed buckets on public profile (toggle); account visibility (public / unlisted / private)
- **Blocked users** — list with unblock action (loaded async)

### Content
- **Muted tags** — add/remove tags (letters, numbers, `-`, `_`; max 30 chars each; up to 50 tags); buckets with these tags are hidden from feed and search
- **Hidden categories** — toggle-pill grid of creator categories; hidden categories are excluded from feed
- **Defaults** — allow comments by default (toggle), allow grabs by default (toggle), mature content filter (toggle)

Default bucket visibility and default draft mode are not currently implemented.

### Notifications
Per-type dropdowns showing current channel state (In app / Email / In app & email / Not allowed):

| Notification type         | In-app | Email |
|---------------------------|--------|-------|
| New follower              | ✓      | ✓     |
| Bucket grabbed            | ✓      | ✓     |
| Bucket unlocked           | ✓      | ✓     |
| New bucket from someone you follow | ✓ | ✓  |
| Grabbed bucket updated    | ✓      | —     |
| Comment mention           | ✓      | ✓     |
| Comment reply             | ✓      | ✓     |
| Comment agreed            | ✓      | —     |
| Bucket tagged             | ✓      | —     |
| New direct message        | ✓      | ✓     |
| Grabbn newsletter         | —      | ✓     |

In-app prefs → `PATCH /api/user/notification-prefs`. Email prefs → `PATCH /api/user/email-notification-prefs`. Newsletter → `PATCH /api/user/settings` (`newsletterSubscribed`).

### Monetization
All items are currently disabled (coming soon):
- Stripe payout account setup / connect status
- Cash out (transfer balance to bank)
- Transaction history
- Daily meta-fetch quota display + credit top-up

### Integrations
- **Bookmarklet** — token display (copy button active; regenerate button currently disabled)
- **Browser extension** — Chrome / Edge install link (disabled), Firefox install link (disabled)

### Danger Zone
- **Export your data** — triggers async export job; download link emailed to account address; rate-limited to 2 requests per 7 days
- **Delete account** — requires typing `DELETE` to confirm; soft-delete with 90-day recovery window; data retained until explicit deletion request

## Implementation Notes

- `partials/settings-nav` renders the left nav and highlights the active route via `settingsSection`. All `/settings/*` views set `settingsSection` and include this partial.
- The existing `isMatureGated` toggle moved from `/settings` into `/settings/content`.
- Each section only fetches/renders what it needs server-side; no global settings payload.
- Notification preferences use `notificationPrefs` (in-app) and `emailNotificationPrefs` (email) maps on User.
- Privacy uses `user.privacy.whoCanMessage` (array), `user.privacy.showActivityStatus`, `user.privacy.showGrabbedBuckets`, `user.privacy.accountVisibility`.
- Username changes are logged in `user.usernameChangeLog` (array of timestamps); rate limits enforced server-side and surfaced client-side with next-available date.
- Avatar upload uses `POST /api/user/avatar` (R2 storage).
- Content defaults (`allowComments`, `allowGrabs`) stored under `user.commentDefaults`.
- Muted tags stored in `user.mutedTags`; managed via `POST /api/user/muted-tags` and `DELETE /api/user/muted-tags/:tag`.
- Muted topics stored in `user.mutedTopics`; managed via `PATCH /api/user/muted-topics`.
