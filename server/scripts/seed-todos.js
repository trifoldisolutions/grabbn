import mongoose from 'mongoose';
import DevTodo from '../models/devTodo.js';

await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB });

const TODAY = new Date('2026-04-28');

const todos = [
  // ── Admin Panel ───────────────────────────────────────────────────────────────
  { name: 'Admin panel — add role field to User model (user / moderator / superadmin)',             tags: ['admin-panel', 'backend', 'model'] },
  { name: 'Admin panel — build adminAuth middleware (requireModerator, requireSuperadmin)',          tags: ['admin-panel', 'backend'] },
  { name: 'Admin panel — base layout & sidebar shell (views/admin/layout.ejs)',                     tags: ['admin-panel', 'frontend', 'ui'] },
  { name: 'Admin panel — User management API routes (GET/PATCH/DELETE /api/admin/users)',            tags: ['admin-panel', 'backend', 'api'] },
  { name: 'Admin panel — Users list + user detail UI pages',                                        tags: ['admin-panel', 'frontend', 'ui'] },
  { name: 'Admin panel — Report model review status fields (status, reviewedBy, action)',            tags: ['admin-panel', 'backend', 'model'] },
  { name: 'Admin panel — Reports moderation queue API routes (/api/admin/reports)',                  tags: ['admin-panel', 'backend', 'api'] },
  { name: 'Admin panel — Reports queue UI page',                                                    tags: ['admin-panel', 'frontend', 'ui'] },
  { name: 'Admin panel — Buckets management API routes (/api/admin/buckets)',                        tags: ['admin-panel', 'backend', 'api'] },
  { name: 'Admin panel — Buckets management UI page',                                               tags: ['admin-panel', 'frontend', 'ui'] },
  { name: 'Admin panel — Analytics API routes (/api/admin/analytics)',                              tags: ['admin-panel', 'backend', 'api'] },
  { name: 'Admin panel — Analytics dashboard UI (KPI cards + charts)',                              tags: ['admin-panel', 'frontend', 'ui'] },
  { name: 'Admin panel — System health API routes (/api/admin/system)',                             tags: ['admin-panel', 'backend', 'api'] },
  { name: 'Admin panel — System tools UI (health indicators + job triggers)',                        tags: ['admin-panel', 'frontend', 'ui'] },
  { name: 'Admin panel — Audit log model (adminAuditLog.js)',                                       tags: ['admin-panel', 'backend', 'model'] },
  { name: 'Admin panel — Audit log API route + UI page',                                            tags: ['admin-panel', 'backend', 'api', 'frontend', 'ui'] },

  // ── Partnership ───────────────────────────────────────────────────────────────
  { name: 'Partnership — build /partnership about page',                                            tags: ['partnership', 'frontend', 'ui'] },
  { name: 'Partnership — build /partnership/apply page + status view',                              tags: ['partnership', 'frontend', 'ui'] },
  { name: 'Partnership — PartnerApplication model (userId, status, pitch, idFileRef, selfieFileRef)', tags: ['partnership', 'backend', 'model'] },
  { name: 'Partnership — POST /api/partnership/apply endpoint',                                     tags: ['partnership', 'backend', 'api'] },
  { name: 'Partnership — GET /api/partnership/status endpoint',                                     tags: ['partnership', 'backend', 'api'] },
  { name: 'Partnership — sendPartnerApprovedEmail + sendPartnerRejectedEmail in email.js',           tags: ['partnership', 'backend'] },
  { name: 'Partnership — wire approval/rejection emails into admin grant/revoke endpoints',          tags: ['partnership', 'backend'] },
  { name: 'Partnership — consolidate duplicate partner endpoint in server/routes/admin/users.js',    tags: ['partnership', 'backend'] },
  { name: 'Partnership — bucket owning ID (private field on Bucket model, exposed only to owner)',   tags: ['partnership', 'backend', 'model'] },
  { name: 'Partnership — points/enforcement system (storage, rolling 30-day window, ban trigger)',   tags: ['partnership', 'backend'] },
  { name: 'Partnership — admin application review UI (view ID, selfie, pitch + approve/reject)',     tags: ['partnership', 'frontend', 'ui'] },
  { name: 'Partnership — Promote button modal flow (tier selection + payment)',                      tags: ['partnership', 'frontend', 'ui'] },
  { name: 'Partnership — ad revenue tracking per bucket',                                           tags: ['partnership', 'backend'] },
  { name: 'Partnership — Stripe Connect integration for partner payouts',                            tags: ['partnership', 'backend'] },

  // ── Repositories ──────────────────────────────────────────────────────────────
  { name: 'Repositories — create LinkClick model with indexes',                                     tags: ['repositories', 'backend', 'model'] },
  { name: 'Repositories — POST /api/links/click endpoint',                                          tags: ['repositories', 'backend', 'api'] },
  { name: 'Repositories — wire frontend link click events on bucket view',                          tags: ['repositories', 'frontend'] },
  { name: 'Repositories — MongoDB aggregation pipeline for per-domain top links',                   tags: ['repositories', 'backend'] },
  { name: 'Repositories — domain blocklist (URL shorteners, generic redirectors)',                   tags: ['repositories', 'backend'] },
  { name: 'Repositories — schedule nightly repository rebuild (cron)',                               tags: ['repositories', 'backend'] },
  { name: 'Repositories — GET /api/v2/repositories endpoint',                                       tags: ['repositories', 'backend', 'api'] },
  { name: 'Repositories — wire repositories-list sidebar in showroom.js',                           tags: ['repositories', 'frontend'] },
  { name: 'Repositories — /repository/:domain route + view',                                        tags: ['repositories', 'frontend', 'ui'] },
  { name: 'Repositories — user affinity derivation from LinkClick history',                         tags: ['repositories', 'backend'] },
  { name: 'Repositories — collaborative filtering layer',                                           tags: ['repositories', 'backend'] },

  // ── Credits ───────────────────────────────────────────────────────────────────
  { name: 'Credits — H1 layered fraud rules (per-transaction cap, daily unlock cap, 24h hold, daily purchase limit, 14-day cumulative cap)', tags: ['credits', 'backend'] },
  { name: 'Credits — H3 dispute webhook handler (charge.dispute.created) + account flagging',       tags: ['credits', 'backend'] },
  { name: 'Credits — H2 credit liability query (GET /api/admin/liability)',                         tags: ['credits', 'backend', 'api'] },
  { name: 'Credits — M1 fix platform_fee logged to wrong userId (use platform wallet ID)',           tags: ['credits', 'backend'] },
  { name: 'Credits — M2 platform wallet user + revenue tracking (GET /api/admin/revenue)',           tags: ['credits', 'backend'] },
  { name: 'Credits — L1 bucket deletion guard (check BucketAccess before delete, refund if needed)', tags: ['credits', 'backend'] },
  { name: 'Credits — L2 bonus credits separation (bonusCredits field, spend paid credits first)',    tags: ['credits', 'backend', 'model'] },

  // ── Explore ───────────────────────────────────────────────────────────────────
  { name: 'Explore — apply impression tracking + diversity caps to showroom feed',                  tags: ['explore', 'backend'] },
  { name: 'Explore — filter skipped buckets (BucketSkip) from user\'s explore feed candidates',     tags: ['explore', 'backend'] },
  { name: 'Explore — collaborative filtering ("users who grabbed X also grabbed Y")',                tags: ['explore', 'backend'] },
  { name: 'Explore — add ?src=explore to bucket card links for accurate view-source tracking',      tags: ['explore', 'frontend'] },
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
