# Repositories Feature

## Problem

The showroom page currently surfaces public buckets from curators, but there is no way for a user to discover content organized around a **topic or source** rather than around a person. A user interested in, say, YouTube tutorials or GitHub repos has no way to find the best links of that type across the entire platform — they would have to browse bucket by bucket.

Additionally, there is currently no mechanism to track which individual links users actually engage with. The platform knows a bucket was viewed or grabbed, but not which links inside it were followed. This gap makes it impossible to rank content quality at the link level.

---

## Goal

Introduce a **Repositories** concept — auto-generated, domain-scoped collections of the best links found across all public buckets on the platform.

A repository for `youtube.com` would contain the most-clicked YouTube links sourced from any public bucket, curated by the algorithm rather than by a single person. It is surfaced in the showroom sidebar and has its own dedicated page, similar to a bucket page but cross-curator by nature.

Longer term, repositories should be personalized: the domains a user engages with most should float to the top of their sidebar, informed by the behavior of similar users.

---

## Core Concepts

### Repository
An auto-generated, read-only collection of top-ranked links grouped by domain. Not created by a user. Rebuilt periodically from aggregated behavioral data.

- Has a domain (`youtube.com`, `github.com`, etc.)
- Contains the top N links from that domain, sourced across all public buckets
- Each link retains a reference to its source bucket and curator
- Has its own dedicated page at `/repository/:domain`

### Link Click Event
A recorded instance of a user following a link. The foundational behavioral signal that drives all ranking and personalization.

---

## Data Model

### `LinkClick` collection

```
{
  href:      String,    // full URL clicked
  domain:    String,    // pre-extracted hostname (e.g. "youtube.com")
  bucketId:  ObjectId,  // bucket the link belonged to at time of click
  userId:    ObjectId,  // null if anonymous
  createdAt: Date       // TTL index candidate
}
```

**Indexes:**
- `{ domain, createdAt }` — domain aggregation with recency filtering
- `{ href, createdAt }` — per-link click totals
- `{ userId, createdAt }` — user affinity queries
- TTL on `createdAt` — auto-expire events older than N months (TBD)

---

## Link Ranking Algorithm

Links are scored and ranked per domain using the following signals:

### Primary signal — click weight
Not all clicks are equal. Each interaction type carries a different weight:

| Action | Weight |
|---|---|
| Link followed (click) | 1 |
| Link from a grabbed bucket | 2 |
| Repeated clicks on same link by same user | diminishing returns |

### Secondary signal — recency decay
A link's score decays over time, but is not eliminated. A link with 100 clicks from 2 years ago can still outrank a link with 5 clicks from last week if the decay factor is tuned appropriately.

```
score = clickWeight * decayFactor(lastClickedAt)
```

Decay is a multiplier between 0 and 1, not a hard cutoff. Old links with strong engagement remain visible.

### Cross-bucket deduplication
The same `href` can appear in multiple buckets. Clicks are aggregated globally by `href`, not per-bucket. This gives the true platform-wide signal for a link regardless of how many curators have added it.

---

## Repository Generation

Repositories are not computed on every request. They are pre-computed and stored in a `repositories` cache collection, rebuilt on a schedule (e.g. nightly) or triggered by significant new activity.

**Aggregation pipeline (conceptual):**

```
1. Match: LinkClick events within the relevant time window
2. Group by href: sum weighted clicks, record lastClickedAt, count distinct users
3. Score each href using the ranking formula
4. Enrich: resolve href back to its source bucket(s) and curator(s)
5. Group by domain: pick top N links by score
6. Filter: remove domains on the blocklist (url shorteners, generic redirects, etc.)
7. Write results to repositories cache collection
```

---

## Personalization (Phase 2)

Once behavioral data accumulates, repositories can be re-ranked per user.

### User affinity
Derived from `LinkClick` history per user — which domains does this user click most? This produces a per-user domain affinity vector.

### Collaborative filtering
Users with overlapping affinity profiles surface each other's preferred domains. Domains that similar users engage with heavily, but the current user has not yet explored, are promoted.

### Session boost
Domains the user interacted with in their most recent session are temporarily boosted in the sidebar. Mirrors SoundCloud's context-aware suggestions.

### Cold start
New users with no behavioral history see the global top repositories. As they interact with the platform, their sidebar gradually personalizes.

---

## Build Plan

### Phase 1 — Link click tracking
- [ ] Create `LinkClick` model with schema and indexes
- [ ] Add API endpoint `POST /api/links/click` — records a click event
- [ ] Wire up frontend: fire click event when a user follows a link from a bucket

### Phase 2 — Repository aggregation
- [ ] Write MongoDB aggregation pipeline to compute per-domain top links
- [ ] Build script to run aggregation and write to a `repositories` cache collection
- [ ] Add domain blocklist (url shorteners, redirectors, etc.)
- [ ] Schedule rebuild (cron or triggered)

### Phase 3 — API + Sidebar
- [ ] `GET /api/v2/repositories` — returns top repositories for the sidebar
- [ ] Wire up `repositories-list` in `showroom.js` to render domain cards
- [ ] Domain card: favicon, domain name, link count, bucket count

### Phase 4 — Repository page
- [ ] Route `/repository/:domain`
- [ ] View similar to bucket share page, but links are cross-curator
- [ ] Each link shows source bucket and curator attribution

### Phase 5 — Personalization
- [ ] User affinity derivation from `LinkClick` history
- [ ] Personalized repository ordering for authenticated users
- [ ] Collaborative filtering layer
- [ ] Session boost signal
