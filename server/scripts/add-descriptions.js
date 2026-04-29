import mongoose from 'mongoose';
import DevTodo from '../models/devTodo.js';

await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB });

const descriptions = {
  '69f0dfd30a0e72164f1527cb': 'Add a role field to the User schema with enum values: user, moderator, superadmin. Default to user. The first superadmin must be set manually in the database.',
  '69f0dfd30a0e72164f1527cc': 'Create requireModerator and requireSuperadmin middleware in server/middleware/adminSessionAuth.js. Both stack after anonymousAuth. Return 403 if the role check fails.',
  '69f0dfd30a0e72164f1527cd': 'Build the shared EJS shell for all admin pages: sidebar with nav links, topbar showing admin name and role badge, and a content slot. Keep it visually distinct from the main app.',
  '69f0dfd30a0e72164f1527ce': 'Implement all user management endpoints: list with pagination and filters (role, status, country), full user detail, role change, suspend/unsuspend, force-verify, grant/revoke partner, adjust credits, and hard delete.',
  '69f0dfd30a0e72164f1527cf': 'Build /admin/users table with search, filter dropdowns, sortable columns, and row actions. Build /admin/users/:id detail page with stats, profile summary, and action buttons.',
  '69f0dfd30a0e72164f1527d0': 'Ensure the Report model has status (pending/reviewed/actioned), reviewedBy, reviewedAt, and action fields. Evaluate whether to migrate inline report data from Bucket and BucketComment into a standalone collection.',
  '69f0dfd30a0e72164f1527d1': 'Implement the reports API: paginated list with filters, single report detail with full context, and PATCH actions for dismiss, remove content, and remove + ban.',
  '69f0dfd30a0e72164f1527d2': 'Build /admin/reports UI: tabbed queue (Pending / Reviewed / All), report cards with content preview and reporter info, inline action buttons that remove the card from the queue on action.',
  '69f0dfd30a0e72164f1527d3': 'Implement bucket management endpoints: list all buckets with filters (owner, visibility, topic, paywall), full detail, force-set visibility, feature/unfeature in Showroom, override exploreScore, and hard delete.',
  '69f0dfd30a0e72164f1527d4': 'Build /admin/buckets table page with filters, sort by views/score/date, and row actions: View, Feature, Take Down, Delete.',
  '69f0dfd30a0e72164f1527d5': 'Implement analytics endpoints: overview stats (new users, active users, buckets, links) grouped by day for 30 days; top content; revenue by day/month; explore feed stats (impressions, skips, clicks).',
  '69f0dfd30a0e72164f1527d6': 'Build /admin/analytics dashboard: KPI cards for signups, buckets, and revenue. Line chart for 30-day trends. Bar chart for top 10 topics. Revenue section gated to superadmin only.',
  '69f0dfd30a0e72164f1527d7': 'Implement system health endpoints: ping MongoDB/Stripe/Resend and return status; broadcast notifications to user segments; get background job status; manually trigger jobs.',
  '69f0dfd30a0e72164f1527d8': 'Build /admin/system page: green/red status indicators per external service, background jobs table with last run time and manual trigger button, and a broadcast notification form.',
  '69f0dfd30a0e72164f1527d9': 'Create AdminAuditLog model with fields: adminUserId, adminRole, action, targetType, targetId, metadata, createdAt. Wire it into every destructive or privileged admin action.',
  '69f0dfd30a0e72164f1527da': 'Implement GET /api/admin/audit with filters (admin, action type, date range) and build the /admin/audit table showing who did what to whom and when.',
  '69f0dfd30a0e72164f1527db': 'Build the /partnership marketing page. Must answer: what the program is, who it is for, what Grabbn expects, how approval works, and what happens on violation. Include a CTA button at top and bottom.',
  '69f0dfd30a0e72164f1527dc': 'Build /partnership/apply with the 4-step form (account verification, identity verification, pitch, financial setup placeholder). Also show the current application status if the user has already applied.',
  '69f0dfd30a0e72164f1527dd': 'Create the PartnerApplication model with fields: userId, status (pending/approved/rejected), submittedAt, reviewedAt, reviewedBy, rejectionReason, pitch, idFileRef, selfieFileRef, and claimedAccounts array.',
  '69f0dfd30a0e72164f1527de': 'Create POST /api/partnership/apply. Validate email verification, create a PartnerApplication document, and return the application status. Block re-application within the 9-month waiting period.',
  '69f0dfd30a0e72164f1527df': 'Create GET /api/partnership/status. Returns the current user application status (none/pending/approved/rejected) and rejection reason if applicable.',
  '69f0dfd30a0e72164f1527e0': 'Add sendPartnerApprovedEmail and sendPartnerRejectedEmail to server/utils/email.js using the existing Resend integration. Include the rejection reason in the rejection email.',
  '69f0dfd30a0e72164f1527e1': 'Update the admin grant and revoke partner endpoints to call the corresponding email function after updating the user isPartner flag.',
  '69f0dfd30a0e72164f1527e2': 'There is a duplicate partner grant/revoke endpoint at server/routes/admin/users.js:169. Remove it and consolidate everything into the main admin router.',
  '69f0dfd30a0e72164f1527e3': 'Add a bucketOwningId field to the Bucket model — a random private token visible only to the bucket owner. Used to prove bucket ownership during partner applications with multiple claimed accounts.',
  '69f0dfd30a0e72164f1527e4': 'Store per-user infraction points on the User model, implement a rolling 30-day window query, and trigger a ban automatically when a user hits 3+ points within the window.',
  '69f0dfd30a0e72164f1527e5': 'Build the admin UI for reviewing partner applications: display pitch, identity documents, and claimed account details. Include Approve and Reject action buttons with a reason input for rejections.',
  '69f0dfd30a0e72164f1527e6': 'Build the Promote button modal flow for partner users: tier selection (Basic / Featured / Spotlight), pricing display, and a payment step. The button currently opens nothing.',
  '69f0dfd30a0e72164f1527e7': 'Track ad revenue per bucket. Each time an ad impression or click is recorded, attribute the revenue share to the bucket owner. Store per-bucket revenue totals for payout calculation.',
  '69f0dfd30a0e72164f1527e8': 'Integrate Stripe Connect so partner payouts can be processed. Partners should be able to connect their bank account and withdraw their accumulated ad revenue share.',
  '69f0dfd30a0e72164f1527e9': 'Create the LinkClick model with fields: href, domain, bucketId, userId (nullable), createdAt. Add indexes on (domain, createdAt), (href, createdAt), and (userId, createdAt). Add a TTL index on createdAt.',
  '69f0dfd30a0e72164f1527ea': 'Create POST /api/links/click. Record a click event with href, extracted domain, source bucketId, and userId. Fire-and-forget is acceptable — do not block navigation.',
  '69f0dfd30a0e72164f1527eb': 'In the bucket view frontend, fire POST /api/links/click when a user follows any outbound link. Add the listener to all outbound link elements without blocking navigation.',
  '69f0dfd30a0e72164f1527ec': 'Write the MongoDB aggregation that groups LinkClick events by href, scores each using weighted clicks and recency decay, deduplicates across buckets, then groups the top N links by domain.',
  '69f0dfd30a0e72164f1527ed': 'Maintain a blocklist of domains that should never appear in repositories: URL shorteners (bit.ly, t.co, etc.), generic redirectors, and tracking domains. Filter them out in the aggregation pipeline.',
  '69f0dfd30a0e72164f1527ee': 'Schedule the repository rebuild to run nightly via setInterval or a cron library. Stagger it relative to buildExploreScores to avoid competing for database resources.',
  '69f0dfd30a0e72164f1527ef': 'Implement GET /api/v2/repositories. Return top repository documents from the cache collection, optionally filtered by domain or sorted by score. Used by the showroom sidebar.',
  '69f0dfd30a0e72164f1527f0': 'In showroom.js, fetch from /api/v2/repositories and render domain cards in the sidebar. Each card shows the domain favicon, name, link count, and bucket count.',
  '69f0dfd30a0e72164f1527f1': 'Create the /repository/:domain route and view. Similar layout to a bucket share page but cross-curator: shows top-ranked links for that domain with source bucket and curator attribution per link.',
  '69f0dfd30a0e72164f1527f2': 'Derive a per-user domain affinity vector from their LinkClick history over the past 30 days. Store the top N domains and engagement weights on the User document for use in feed personalization.',
  '69f0dfd30a0e72164f1527f3': 'Find users with similar grab patterns and surface domains they engage with heavily that the current user has not visited yet. Promote those domains higher in the repository sidebar.',
  '69f0dfd30a0e72164f1527f4': 'Implement 5 layered fraud rules in credits.js: R1 per-transaction cap by account age, R2 daily unlock spend cap, R3 first purchase held 24h as pending credits, R4 max N purchases per 24h, R5 cumulative cap in first 14 days.',
  '69f0dfd30a0e72164f1527f5': 'Handle the charge.dispute.created Stripe webhook. If credits are still pending, zero them out. If already spent, flag the account for manual review and log the loss. Add a flagged boolean to the User model.',
  '69f0dfd30a0e72164f1527f6': 'Add GET /api/admin/liability that sums all users credits and pendingCredits fields. This gives the total outstanding credit obligation — the platform hidden cash liability.',
  '69f0dfd30a0e72164f1527f7': 'Platform fee transactions are currently logged under the curator userId. Change the platform_fee transaction to use a dedicated platform wallet account ID. Seed the platform wallet user on startup.',
  '69f0dfd30a0e72164f1527f8': 'Create a platform wallet user that accumulates credits from every unlock fee. Add GET /api/admin/revenue returning the wallet balance and transaction history. Depends on M1 being done first.',
  '69f0dfd30a0e72164f1527f9': 'Before allowing a bucket to be deleted, check for existing BucketAccess records. Either block deletion entirely or refund affected viewers credits before proceeding.',
  '69f0dfd30a0e72164f1527fa': 'Add a bonusCredits field to the User model for promotional credits. Update the unlock flow to spend real credits first, then bonusCredits, so curators are only paid from real-money transactions.',
  '69f0dfd30a0e72164f1527fb': 'Apply the FeedImpression tracking and per-curator/per-topic diversity caps that are already live on the explore feed to the showroom feed as well.',
  '69f0dfd30a0e72164f1527fc': 'When building explore feed candidates, cross-reference the user BucketSkip records and exclude buckets they have already skipped. Currently skips are recorded but not filtered.',
  '69f0dfd30a0e72164f1527fd': 'Find users with overlapping grab patterns and surface buckets they engaged with that the current user has not seen. Use the existing grabbedBy field as the signal.',
  '69f0dfd30a0e72164f1527fe': 'Append ?src=explore to bucket card links rendered in the explore and showroom feeds. The backend already uses absence of this param to identify direct views — make the source explicit from the frontend.',
  '69f0e75b068941af47e59cb7': 'The User model has a preferences Map field that is never read or written. Define the preference keys (e.g. emailNotifications, theme) and build GET/PATCH /api/user/preferences to expose them.',
  '69f0e75b068941af47e59cb8': 'The /settings page renders but the form does nothing. Wire each settings section to the preferences API so changes are persisted to the database.',
  '69f0e75b068941af47e59cb9': 'Build GET /api/transactions with cursor-based pagination. Return the current user transaction history from the Transaction model, sorted by date descending.',
  '69f0e75b068941af47e59cba': 'The /transactions page renders an empty template. Fetch from /api/transactions and render a table: date, type, amount, description, and running balance.',
  '69f0e75b068941af47e59cbb': 'Build POST /api/contact. Validate and store the message in a Contact collection, then forward it to the support email via Resend. Return a success confirmation to the user.',
  '69f0e75b068941af47e59cbc': 'Add express-rate-limit with a MongoDB or Redis backing store so limits survive server restarts. Apply a global limiter and tighter per-route limiters on auth and payment endpoints.',
  '69f0e75b068941af47e59cbd': 'Stripe webhooks are currently processed once with no retry. Add a persistent queue in MongoDB so failed webhook handlers are retried with exponential backoff.',
  '69f0e75b068941af47e59cbe': 'Notifications are WebSocket-only. When a notification is created for a user who is not currently connected, send an email summary via Resend as a fallback.',
  '69f0e75b068941af47e59cbf': 'The extension manifest.json still uses the old product name "Save to Seckop". Update the name and description fields to reflect the Grabbn brand across manifest and popup UI.',
  '69f0e75b068941af47e59cc0': 'The extension silently fails when the server is unreachable. Add error handling in content.js and background.js, and implement a local queue that retries failed save requests when connectivity is restored.',
  '69f0e75b068941af47e59cc1': 'The search page only supports full-text matching. Add filters for date range, curator username, and rating. Update /api/v2/search to accept and apply these filter params.',
  '69f0e75b068941af47e59cc2': 'The repository page loads all links at once. Add a Load More button or infinite scroll, and add server-side pagination to the repository API endpoint.',
  '69f0e75b068941af47e59cc3': 'Once a bucket is shared and access is granted via BucketAccess, there is no way to revoke it. Add DELETE /api/buckets/:id/access/:userId so bucket owners can remove a specific user access.',
};

let updated = 0;
for (const [id, description] of Object.entries(descriptions)) {
  await DevTodo.findByIdAndUpdate(id, { description });
  updated++;
}

console.log(`Updated ${updated} todos with descriptions.`);
await mongoose.disconnect();
