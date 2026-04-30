import mongoose from 'mongoose';
import DevTodo from '../models/devTodo.js';

await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB });

const TODAY = new Date('2026-04-28');

const todos = [
  // ── Admin Panel ───────────────────────────────────────────────────────────────
  {
    name: 'Admin panel — add role field to User model (user / moderator / superadmin)',
    description: 'Extend the User schema with a role enum field defaulting to "user". Ensure existing documents migrate cleanly and indexes are updated.',
    tags: ['admin-panel', 'backend', 'model'],
  },
  {
    name: 'Admin panel — build adminAuth middleware (requireModerator, requireSuperadmin)',
    description: 'Two Express middleware functions that check req.user.role and return 403 if the role is insufficient. Attach to all /api/admin/* routes.',
    tags: ['admin-panel', 'backend'],
  },
  {
    name: 'Admin panel — base layout & sidebar shell (views/admin/layout.ejs)',
    description: 'Shared EJS layout for all admin pages: top nav, collapsible sidebar with section links (Users, Reports, Buckets, Analytics, System, Audit Log), and a main content slot.',
    tags: ['admin-panel', 'frontend', 'ui'],
  },
  {
    name: 'Admin panel — User management API routes (GET/PATCH/DELETE /api/admin/users)',
    description: 'Paginated user list with search/filter, single-user detail fetch, role change, suspension toggle, and hard-delete endpoints. All mutations write to the audit log.',
    tags: ['admin-panel', 'backend', 'api'],
  },
  {
    name: 'Admin panel — Users list + user detail UI pages',
    description: 'Searchable, filterable table of all users with inline role badges. User detail page shows profile, activity stats, linked buckets, and action buttons (suspend, change role, delete).',
    tags: ['admin-panel', 'frontend', 'ui'],
  },
  {
    name: 'Admin panel — Report model review status fields (status, reviewedBy, action)',
    description: 'Add status (pending / reviewed / dismissed), reviewedBy (admin userId), reviewedAt, and action (warn / remove / ban) fields to the Report schema.',
    tags: ['admin-panel', 'backend', 'model'],
  },
  {
    name: 'Admin panel — Reports moderation queue API routes (/api/admin/reports)',
    description: 'List pending reports sorted by age, mark as reviewed with an action, and bulk-dismiss. Each action triggers the appropriate downstream effect (content removal, user warning, ban).',
    tags: ['admin-panel', 'backend', 'api'],
  },
  {
    name: 'Admin panel — Reports queue UI page',
    description: 'Chronological queue of open reports showing reporter, reported content preview, and reason. Each row has Dismiss / Warn / Remove / Ban actions that update in place.',
    tags: ['admin-panel', 'frontend', 'ui'],
  },
  {
    name: 'Admin panel — Buckets management API routes (/api/admin/buckets)',
    description: 'List all buckets with owner info and stats, force-unpublish, transfer ownership, and delete. Deletions must respect the credit refund guard (see Credits — L1).',
    tags: ['admin-panel', 'backend', 'api'],
  },
  {
    name: 'Admin panel — Buckets management UI page',
    description: 'Searchable bucket table with owner column, visibility badge, grab count, and credit value. Row actions: view, unpublish, transfer, delete.',
    tags: ['admin-panel', 'frontend', 'ui'],
  },
  {
    name: 'Admin panel — Analytics API routes (/api/admin/analytics)',
    description: 'Endpoints returning daily signups, active users, grab events, top buckets, and revenue over configurable time windows. Responses should be cache-friendly (short TTL).',
    tags: ['admin-panel', 'backend', 'api'],
  },
  {
    name: 'Admin panel — Analytics dashboard UI (KPI cards + charts)',
    description: 'Overview page with KPI cards (total users, DAU, grabs today, revenue MTD) and line/bar charts for trends. Use Chart.js or a lightweight equivalent; no heavy dependencies.',
    tags: ['admin-panel', 'frontend', 'ui'],
  },
  {
    name: 'Admin panel — System health API routes (/api/admin/system)',
    description: 'Endpoints reporting DB connection state, queue depths, last cron run timestamps, and memory/uptime. Also expose manual job trigger endpoints (e.g. force repository rebuild).',
    tags: ['admin-panel', 'backend', 'api'],
  },
  {
    name: 'Admin panel — System tools UI (health indicators + job triggers)',
    description: 'Dashboard with green/red health indicators per subsystem and buttons to manually trigger background jobs. Show last-run time and result for each job.',
    tags: ['admin-panel', 'frontend', 'ui'],
  },
  {
    name: 'Admin panel — Audit log model (adminAuditLog.js)',
    description: 'Schema capturing: actorId, actorRole, action (string enum), targetType, targetId, payload (mixed), and createdAt. Index on actorId and createdAt for fast admin queries.',
    tags: ['admin-panel', 'backend', 'model'],
  },
  {
    name: 'Admin panel — Audit log API route + UI page',
    description: 'Paginated, filterable log of all admin actions. UI shows actor, action, target, and timestamp in a table with filters by actor and action type. Read-only — no mutations.',
    tags: ['admin-panel', 'backend', 'api', 'frontend', 'ui'],
  },

  // ── Partnership ───────────────────────────────────────────────────────────────
  {
    name: 'Partnership — build /partnership about page',
    description: 'Marketing-style page explaining the partner program: benefits, eligibility criteria, revenue share rates, and a CTA button linking to /partnership/apply.',
    tags: ['partnership', 'frontend', 'ui'],
  },
  {
    name: 'Partnership — build /partnership/apply page + status view',
    description: 'Multi-step application form (pitch text, ID upload, selfie upload). After submission, the same URL shows the current application status (pending / approved / rejected) with a reason if rejected.',
    tags: ['partnership', 'frontend', 'ui'],
  },
  {
    name: 'Partnership — PartnerApplication model (userId, status, pitch, idFileRef, selfieFileRef)',
    description: 'Mongoose schema for partner applications. One application per user (unique index on userId). Status enum: pending / approved / rejected. File refs point to uploaded assets in storage.',
    tags: ['partnership', 'backend', 'model'],
  },
  {
    name: 'Partnership — POST /api/partnership/apply endpoint',
    description: 'Accept multipart form with pitch text, ID image, and selfie. Validate file types and sizes, store files, create PartnerApplication document, and return the created record.',
    tags: ['partnership', 'backend', 'api'],
  },
  {
    name: 'Partnership — GET /api/partnership/status endpoint',
    description: 'Return the authenticated user\'s current PartnerApplication (status, submittedAt, reviewedAt, rejectionReason). Return 404 if no application exists yet.',
    tags: ['partnership', 'backend', 'api'],
  },
  {
    name: 'Partnership — sendPartnerApprovedEmail + sendPartnerRejectedEmail in email.js',
    description: 'Two transactional email templates. Approved email includes onboarding steps and dashboard link. Rejected email includes the reviewer\'s reason and a link to re-apply after 30 days.',
    tags: ['partnership', 'backend'],
  },
  {
    name: 'Partnership — wire approval/rejection emails into admin grant/revoke endpoints',
    description: 'When an admin approves or rejects a partner application via the admin panel, automatically trigger the corresponding email. Failure to send should not block the status update.',
    tags: ['partnership', 'backend'],
  },
  {
    name: 'Partnership — consolidate duplicate partner endpoint in server/routes/admin/users.js',
    description: 'There are currently two separate endpoints that toggle partner status. Merge them into a single PATCH /api/admin/users/:id/role endpoint that handles all role changes uniformly.',
    tags: ['partnership', 'backend'],
  },
  {
    name: 'Partnership — bucket owning ID (private field on Bucket model, exposed only to owner)',
    description: 'Add an ownerId field to Bucket. Exclude it from public API responses and include it only when the requesting user matches the owner, so partner analytics can be scoped correctly.',
    tags: ['partnership', 'backend', 'model'],
  },
  {
    name: 'Partnership — points/enforcement system (storage, rolling 30-day window, ban trigger)',
    description: 'Partners accumulate violation points per infraction. Store points with timestamps, calculate the rolling 30-day total on each check, and auto-trigger a ban + notification when the threshold is exceeded.',
    tags: ['partnership', 'backend'],
  },
  {
    name: 'Partnership — admin application review UI (view ID, selfie, pitch + approve/reject)',
    description: 'Admin page listing pending partner applications. Clicking an application opens a detail view with the uploaded ID photo, selfie, and pitch text, plus Approve / Reject buttons with an optional reason field.',
    tags: ['partnership', 'frontend', 'ui'],
  },
  {
    name: 'Partnership — Promote button modal flow (tier selection + payment)',
    description: 'A "Promote" button on the partner dashboard opens a modal with available promotion tiers, pricing, and reach estimates. Selecting a tier flows into the existing credit payment UX.',
    tags: ['partnership', 'frontend', 'ui'],
  },
  {
    name: 'Partnership — ad revenue tracking per bucket',
    description: 'Record ad impression and click events against a bucketId. Aggregate daily revenue per bucket so partners can see earnings breakdowns in their dashboard.',
    tags: ['partnership', 'backend'],
  },
  {
    name: 'Partnership — Stripe Connect integration for partner payouts',
    description: 'Onboard partners via Stripe Connect (Express accounts). Schedule monthly payout transfers based on accrued ad revenue minus platform fee. Handle onboarding webhooks and payout failure notifications.',
    tags: ['partnership', 'backend'],
  },

  // ── Repositories ──────────────────────────────────────────────────────────────
  {
    name: 'Repositories — create LinkClick model with indexes',
    description: 'Schema: userId (nullable), bucketId, url, domain, clickedAt. Compound indexes on (domain, clickedAt) for aggregation performance and (userId, clickedAt) for affinity queries.',
    tags: ['repositories', 'backend', 'model'],
  },
  {
    name: 'Repositories — POST /api/links/click endpoint',
    description: 'Fire-and-forget endpoint called client-side when a user clicks a link inside a bucket. Extracts the domain from the URL, records the event, and responds immediately with 204.',
    tags: ['repositories', 'backend', 'api'],
  },
  {
    name: 'Repositories — wire frontend link click events on bucket view',
    description: 'Attach a click listener to all external links rendered in the bucket view. On click, POST to /api/links/click in the background without blocking navigation.',
    tags: ['repositories', 'frontend'],
  },
  {
    name: 'Repositories — MongoDB aggregation pipeline for per-domain top links',
    description: 'Aggregation that groups LinkClicks by domain, counts clicks in the last N days, and returns a ranked list. Used nightly by the cron to rebuild repository documents.',
    tags: ['repositories', 'backend'],
  },
  {
    name: 'Repositories — domain blocklist (URL shorteners, generic redirectors)',
    description: 'Maintain a static list of domains to exclude from repository ranking (bit.ly, t.co, linktr.ee, etc.). Filter these out before inserting LinkClick records and during aggregation.',
    tags: ['repositories', 'backend'],
  },
  {
    name: 'Repositories — schedule nightly repository rebuild (cron)',
    description: 'A cron job (runs at 02:00 UTC) that runs the aggregation pipeline and upserts Repository documents. Log run duration and document count. Alert if the job fails or produces 0 results.',
    tags: ['repositories', 'backend'],
  },
  {
    name: 'Repositories — GET /api/v2/repositories endpoint',
    description: 'Return a paginated, filterable list of Repository documents sorted by click volume. Support ?domain= search and ?tag= filter. Cache responses for 5 minutes.',
    tags: ['repositories', 'backend', 'api'],
  },
  {
    name: 'Repositories — wire repositories-list sidebar in showroom.js',
    description: 'Fetch /api/v2/repositories on showroom page load and populate the sidebar list. Clicking a repository entry filters the main feed to buckets containing links from that domain.',
    tags: ['repositories', 'frontend'],
  },
  {
    name: 'Repositories — /repository/:domain route + view',
    description: 'Dedicated page for a single repository showing domain metadata, top links, click trend chart, and a grid of buckets that reference this domain. SEO-friendly with server-side rendering.',
    tags: ['repositories', 'frontend', 'ui'],
  },
  {
    name: 'Repositories — user affinity derivation from LinkClick history',
    description: 'For a given userId, aggregate their LinkClick history to produce a ranked list of domains and tags they engage with most. Store as a UserAffinity document, refreshed daily.',
    tags: ['repositories', 'backend'],
  },
  {
    name: 'Repositories — collaborative filtering layer',
    description: 'Find users with overlapping LinkClick history (Jaccard similarity on domain sets) and surface repositories popular among those users as "people like you also clicked" recommendations.',
    tags: ['repositories', 'backend'],
  },

  // ── Credits ───────────────────────────────────────────────────────────────────
  {
    name: 'Credits — H1 layered fraud rules (per-transaction cap, daily unlock cap, 24h hold, daily purchase limit, 14-day cumulative cap)',
    description: 'Implement five stacked guards on credit purchases: max per transaction, max credits unlocked per day, 24-hour hold before credits are spendable, daily purchase count limit, and a 14-day rolling spend cap. Each rule should be a composable check function.',
    tags: ['credits', 'backend'],
  },
  {
    name: 'Credits — H3 dispute webhook handler (charge.dispute.created) + account flagging',
    description: 'Handle Stripe charge.dispute.created webhooks: freeze the associated user account, reverse the credited JWL, and create an internal dispute record for admin review.',
    tags: ['credits', 'backend'],
  },
  {
    name: 'Credits — H2 credit liability query (GET /api/admin/liability)',
    description: 'Aggregate the total outstanding spendable JWL across all user wallets to calculate platform liability. Result should be queryable by date range and segmented by paid vs bonus credits.',
    tags: ['credits', 'backend', 'api'],
  },
  {
    name: 'Credits — M1 fix platform_fee logged to wrong userId (use platform wallet ID)',
    description: 'Currently the platform fee transaction is recorded against the buyer\'s userId. Change it to write to a dedicated platform wallet user ID so revenue reports reflect actual platform earnings.',
    tags: ['credits', 'backend'],
  },
  {
    name: 'Credits — M2 platform wallet user + revenue tracking (GET /api/admin/revenue)',
    description: 'Create a system user that acts as the platform wallet. All platform fees, penalties, and promo costs are credited here. Expose a /api/admin/revenue endpoint that aggregates this wallet\'s inflows by period.',
    tags: ['credits', 'backend'],
  },
  {
    name: 'Credits — L1 bucket deletion guard (check BucketAccess before delete, refund if needed)',
    description: 'Before deleting a bucket, check if any users have purchased access. If so, calculate the pro-rata refund, issue JWL refunds to affected wallets, and log the refund transactions before proceeding with deletion.',
    tags: ['credits', 'backend'],
  },
  {
    name: 'Credits — L2 bonus credits separation (bonusCredits field, spend paid credits first)',
    description: 'Add a bonusCredits field to the wallet model separate from paid credits. Deductions should exhaust paid credits first. Bonus credits cannot be withdrawn or converted to cash.',
    tags: ['credits', 'backend', 'model'],
  },

  // ── Explore ───────────────────────────────────────────────────────────────────
  {
    name: 'Explore — apply impression tracking + diversity caps to showroom feed',
    description: 'Record each bucket impression per user session. Use impression counts to de-prioritize buckets a user has seen repeatedly and enforce a per-creator cap so no single creator dominates the feed.',
    tags: ['explore', 'backend'],
  },
  {
    name: 'Explore — filter skipped buckets (BucketSkip) from user\'s explore feed candidates',
    description: 'When a user explicitly skips a bucket, write a BucketSkip record. Exclude all skipped buckets from that user\'s future feed candidates. Provide an option in settings to clear skip history.',
    tags: ['explore', 'backend'],
  },
  {
    name: 'Explore — collaborative filtering ("users who grabbed X also grabbed Y")',
    description: 'Build an item-based collaborative filter using grab co-occurrence. For each bucket in the feed, attach a "users also grabbed" recommendation row. Rebuild the co-occurrence matrix nightly.',
    tags: ['explore', 'backend'],
  },
  {
    name: 'Explore — add ?src=explore to bucket card links for accurate view-source tracking',
    description: 'Append ?src=explore to all bucket card hrefs rendered in the showroom/explore feed. The bucket view page reads this param and logs it to the analytics event so we can distinguish explore-driven views from direct traffic.',
    tags: ['explore', 'frontend'],
  },
];

await DevTodo.deleteMany({});
await DevTodo.insertMany(todos.map(t => ({
  ...t,
  name: t.name.replace(/^.+? — /, ''),
  createdAt: TODAY,
  completedAt: null,
})));

console.log(`Seeded ${todos.length} todos.`);
await mongoose.disconnect();
