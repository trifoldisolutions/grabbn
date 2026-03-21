// server/routes/bucketShare.js
import express from 'express';
import Bucket from '../models/bucket.js';
import BucketAccess from '../models/bucketAccess.js';

const router = express.Router();

// Serve bucket thumbnail as actual image (must come BEFORE /bucket/:bucketId route)
router.get('/bucket/:bucketId/thumbnail.jpg', async (req, res) => {
    try {
        const { bucketId } = req.params;

        const bucket = await Bucket.findById(bucketId);

        if (!bucket || !bucket.thumbnail) {
            return res.status(404).send('Thumbnail not found');
        }

        // Parse base64 data
        const mimeMatch = bucket.thumbnail.match(/^data:(image\/\w+);base64,/);
        const base64Data = mimeMatch
            ? bucket.thumbnail.slice(mimeMatch[0].length)
            : bucket.thumbnail;
        const imageBuffer = Buffer.from(base64Data, 'base64');

        // Send as actual image
        res.set('Content-Type', mimeMatch ? mimeMatch[1] : 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.send(imageBuffer);
    } catch (error) {
        console.error('Error serving thumbnail:', error);
        res.status(500).send('Error loading thumbnail');
    }
});

// Get bucket by ID for sharing
router.get('/bucket/:bucketId', async (req, res) => {
    try {
        const { bucketId } = req.params;
        
        const bucket = await Bucket.findById(bucketId);
        
        if (!bucket) {
            return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bucket Not Found · Grabbn</title>
    <link rel="stylesheet" href="/tailwind/output.css">
</head>
<body class="bg-gray-50 font-sans text-woodsmoke-950 overflow-x-hidden min-h-screen">

    <!-- Navbar -->
    <header class="sticky top-0 z-50 bg-white/90 backdrop-blur-sm border-b border-gray-100">
        <div class="max-w-5xl mx-auto px-5 sm:px-6 h-14 flex items-center justify-between">
            <a href="/" class="font-bold text-base text-woodsmoke-950 tracking-tight">Grabbn</a>
            <a href="/signup.html" class="text-sm font-semibold text-white bg-orchid-700 hover:bg-orchid-800 transition-colors px-4 py-2 rounded-md">
                Get started free
            </a>
        </div>
    </header>

    <main class="max-w-2xl mx-auto px-5 sm:px-6 py-24 text-center">
        <div class="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <svg class="w-7 h-7 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
        </div>
        <h1 class="text-2xl font-bold text-woodsmoke-950 mb-2">Bucket not found</h1>
        <p class="text-gray-500 text-sm mb-8">This shared collection no longer exists or has been removed.</p>
        <a href="/" class="inline-flex items-center gap-x-1.5 text-sm font-semibold text-orchid-700 hover:text-orchid-800 transition-colors">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            Back to home
        </a>
    </main>

    <footer class="border-t border-gray-100 py-8">
        <div class="max-w-5xl mx-auto px-5 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-400">
            <p class="font-semibold text-woodsmoke-950 text-sm">Grabbn</p>
            <p>© 2026 Grabbn · Whimish Tools</p>
        </div>
    </footer>

</body>
</html>`);
        }

        // Paywall gate
        if (bucket.isPaywalled) {
            const isOwner = req.user && bucket.userId.equals(req.user._id);
            if (!isOwner) {
                const hasAccess = req.user
                    ? await BucketAccess.findOne({ userId: req.user._id, bucketId: bucket._id })
                    : null;

                if (!hasAccess) {
                    // Track view for unlock-page visitors (fire-and-forget)
                    const existingView = bucket.viewedBy.find(v => v.userId.equals(req.user._id));
                    if (!existingView) {
                        Bucket.findByIdAndUpdate(bucketId, {
                            $push: { viewedBy: { userId: req.user._id, lastViewedVersion: bucket.updatedAt } },
                            $inc: { viewCount: 1 }
                        }).catch(() => {});
                    } else if (existingView.lastViewedVersion < bucket.updatedAt) {
                        Bucket.updateOne(
                            { _id: bucketId, 'viewedBy.userId': req.user._id },
                            { $set: { 'viewedBy.$.lastViewedVersion': bucket.updatedAt }, $inc: { viewCount: 1 } }
                        ).catch(() => {});
                    }

                    const viewerCredits = req.user?.credits ?? 0;
                    const isAnonymous = !req.user || req.user.isAnonymous;
                    const dollarPrice = (bucket.price / 100).toFixed(2);
                    const curator = await import('../models/user.js').then(m =>
                        m.default.findById(bucket.userId).select('username')
                    );
                    const curatorName = curator?.username || 'Anonymous';
                    const thumbnailUrl = bucket.thumbnail
                        ? `${req.protocol}://${req.get('host')}/share/bucket/${bucketId}/thumbnail.jpg`
                        : null;
                    const freeLinks = bucket.links.filter(l => l.isFree);
                    const paidLinks = bucket.links.filter(l => !l.isFree);
                    const blurredLinks = paidLinks.slice(0, 5).map(l =>
                        `<div class="blurred-row">${l.text || 'Untitled Link'}</div>`
                    ).join('');
                    const moreCount = paidLinks.length > 5 ? paidLinks.length - 5 : 0;

                    const ctaHtml = isAnonymous
                        ? `<a href="/?openAuth=true" class="inline-flex items-center justify-center gap-x-2 w-full h-12 bg-orchid-700 hover:bg-orchid-800 text-white font-semibold text-sm rounded-md transition-colors">
                               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                               Sign in to unlock
                           </a>`
                        : `<button id="unlockBtn" class="inline-flex items-center justify-center gap-x-2 w-full h-12 bg-orchid-700 hover:bg-orchid-800 text-white font-semibold text-sm rounded-md transition-colors">
                               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                               Unlock for ${bucket.price} credits ($${dollarPrice})
                           </button>`;

                    return res.status(402).send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${bucket.name} — Unlock to View · Grabbn</title>
    <link rel="stylesheet" href="/tailwind/output.css">
    <style>
        .free-link-row:last-of-type { border-bottom: none !important; }
        .blurred-row {
            padding: 0.75rem 1.5rem;
            border-bottom: 1px solid #f3f4f6;
            font-size: 0.875rem;
            color: transparent;
            text-shadow: 0 0 10px rgba(0,0,0,0.45);
            user-select: none;
            background: linear-gradient(90deg, #f3f4f6 0%, #e5e7eb 50%, #f3f4f6 100%);
            border-radius: 6px;
            margin: 0.25rem 1.25rem;
        }
    </style>
</head>
<body class="bg-gray-50 font-sans text-woodsmoke-950 overflow-x-hidden min-h-screen">

    <!-- Navbar -->
    <header class="sticky top-0 z-50 bg-white/90 backdrop-blur-sm border-b border-gray-100">
        <div class="max-w-5xl mx-auto px-5 sm:px-6 h-14 flex items-center justify-between">
            <a href="/" class="font-bold text-base text-woodsmoke-950 tracking-tight">Grabbn</a>
            <a href="/signup.html" class="text-sm font-semibold text-white bg-orchid-700 hover:bg-orchid-800 transition-colors px-4 py-2 rounded-md">
                Get started free
            </a>
        </div>
    </header>

    <!-- Main -->
    <main class="max-w-2xl mx-auto px-5 sm:px-6 py-10">

        <!-- Bucket card -->
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden mb-6">

            ${thumbnailUrl ? `
            <div style="aspect-ratio:16/9;overflow:hidden;background:#f3f4f6;position:relative;">
                <img src="${thumbnailUrl}" alt="${bucket.name}" style="width:100%;height:100%;object-fit:cover;filter:blur(4px);transform:scale(1.05);">
                <div style="position:absolute;inset:0;background:rgba(148,55,146,0.15);display:flex;align-items:center;justify-content:center;">
                    <div style="background:white;border-radius:9999px;width:48px;height:48px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#943792" stroke-width="2">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                    </div>
                </div>
            </div>` : ''}

            <!-- Bucket info -->
            <div class="p-5 sm:p-6 border-b border-gray-100">
                <h1 class="text-2xl font-bold text-woodsmoke-950 mb-3 leading-tight">${bucket.name}</h1>
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="inline-flex items-center gap-x-1 bg-amber-50 text-amber-700 text-xs font-semibold px-3 py-1 rounded-full border border-amber-200">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        ${bucket.price} credits · $${dollarPrice}
                    </span>
                    <span class="text-sm text-gray-400">by ${curatorName}</span>
                </div>
            </div>

            <!-- Links header -->
            <div class="px-5 sm:px-6 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                <span class="text-xs font-semibold text-gray-500 uppercase tracking-widest">Content</span>
                ${freeLinks.length > 0
                    ? `<span class="ml-auto text-xs text-gray-400">${freeLinks.length} free · ${paidLinks.length} locked</span>`
                    : `<span class="ml-auto text-xs text-gray-400">${paidLinks.length} locked</span>`
                }
            </div>

            <!-- Free links (if any) -->
            ${freeLinks.map(link => `
            <a href="${link.href}" target="_blank" rel="noopener noreferrer"
               data-bucket-id="${bucketId}"
               class="free-link-row link-row flex items-center gap-3 px-5 sm:px-6 py-3.5 border-b border-gray-50 hover:bg-orchid-50 transition-colors group">
                <div style="flex:1;min-width:0;">
                    <p class="text-sm font-medium text-woodsmoke-950 group-hover:text-orchid-700 transition-colors" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${link.text || 'Untitled Link'}${link.duration ? `<span class="text-gray-400 font-normal"> · ${link.duration}</span>` : ''}
                    </p>
                </div>
                <svg style="width:16px;height:16px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-300 group-hover:text-orchid-400 transition-colors">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
            </a>`).join('')}

            <!-- Blurred locked links -->
            ${paidLinks.length > 0 ? `
            <div class="py-1">
                ${blurredLinks}
                ${moreCount > 0 ? `<p class="px-5 py-2 text-xs text-gray-400 italic">+ ${moreCount} more link${moreCount === 1 ? '' : 's'} hidden</p>` : ''}
            </div>` : ''}

            <!-- Unlock CTA -->
            <div class="p-5 sm:p-6 border-t border-gray-100 text-center">
                <p class="text-sm font-semibold text-woodsmoke-950 mb-1">Unlock this collection</p>
                <p class="text-xs text-gray-400 mb-4">One-time purchase · Access forever · Credits never expire</p>
                ${ctaHtml}
                ${!isAnonymous ? `<p class="balance-hint mt-3 text-xs text-gray-400">Your balance: <strong class="text-woodsmoke-950">${viewerCredits} credits</strong>${viewerCredits < bucket.price ? ' — <a href="/?openCredits=true" class="text-orchid-600 font-semibold hover:underline">Add credits</a>' : ''}</p>` : ''}
            </div>

        </div>

        <!-- CTA box -->
        <div class="bg-orchid-50 border border-orchid-200 rounded-2xl p-5 sm:p-6 mb-6">
            <p class="text-xs font-semibold tracking-widest uppercase text-orchid-600 mb-1">Grabbn</p>
            <p class="text-sm font-bold text-woodsmoke-950 mb-1">Build your own link collections</p>
            <p class="text-sm text-gray-500 leading-relaxed">Curate links from any webpage, share them, and earn credits when others unlock your collections.</p>
            <a href="/signup.html" class="mt-4 inline-flex items-center gap-x-1.5 text-sm font-semibold text-orchid-700 hover:text-orchid-800 transition-colors">
                Get started free
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </a>
        </div>

    </main>

    <!-- Footer -->
    <footer class="border-t border-gray-100 py-8">
        <div class="max-w-5xl mx-auto px-5 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-400">
            <p class="font-semibold text-woodsmoke-950 text-sm">Grabbn</p>
            <p>© 2026 Grabbn · Whimish Tools</p>
        </div>
    </footer>

    <!-- Toast -->
    <div id="toast" class="fixed bottom-5 left-1/2 -translate-x-1/2 bg-woodsmoke-950 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg z-50" style="display:none;"></div>

    <script>
        document.querySelectorAll('a.link-row[data-bucket-id]').forEach(function(a) {
            a.addEventListener('click', function() {
                var payload = JSON.stringify({ href: this.href, bucketId: this.dataset.bucketId });
                navigator.sendBeacon('/api/links/click', new Blob([payload], { type: 'application/json' }));
            });
        });
    </script>

    ${!isAnonymous ? `<script>
        const unlockBtn = document.getElementById('unlockBtn');
        if (unlockBtn) {
            unlockBtn.addEventListener('click', async () => {
                unlockBtn.disabled = true;
                unlockBtn.textContent = 'Unlocking…';
                try {
                    const res = await fetch('/api/credits/unlock/${bucketId}', {
                        method: 'POST',
                        credentials: 'include'
                    });
                    const data = await res.json();
                    if (res.ok) {
                        window.location.reload();
                    } else {
                        showToast(data.error || 'Failed to unlock');
                        unlockBtn.disabled = false;
                        unlockBtn.textContent = 'Unlock for ${bucket.price} credits ($${dollarPrice})';
                    }
                } catch (e) {
                    showToast('Network error — please try again');
                    unlockBtn.disabled = false;
                    unlockBtn.textContent = 'Unlock for ${bucket.price} credits ($${dollarPrice})';
                }
            });
        }
        function showToast(msg) {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.style.display = 'block';
            setTimeout(() => { t.style.display = 'none'; }, 4000);
        }
    </script>` : ''}

</body>
</html>`);
                }
            }
        }

        // Generate Open Graph metadata
        const ogTitle = `${bucket.name} - Shared Link Collection`;
        const ogDescription = `A collection of ${bucket.links.length} link(s) shared via Grabbn`;
        
        // Use thumbnail endpoint URL instead of base64 for Open Graph
        const ogImage = bucket.thumbnail 
            ? `${req.protocol}://${req.get('host')}/share/bucket/${bucketId}/thumbnail.jpg`
            : 'https://via.placeholder.com/1200x630?text=Grabbn+Shared+Collection';
        
        const shareUrl = `${req.protocol}://${req.get('host')}/share/bucket/${bucketId}`;

        const curator = await import('../models/user.js').then(m =>
            m.default.findById(bucket.userId).select('username')
        );
        const curatorName = curator?.username || 'Anonymous';
        const thumbnailUrl = bucket.thumbnail
            ? `${req.protocol}://${req.get('host')}/share/bucket/${bucketId}/thumbnail.jpg`
            : null;

        // Generate HTML page with Open Graph meta tags
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <!-- Primary Meta Tags -->
    <title>${ogTitle}</title>
    <meta name="title" content="${ogTitle}">
    <meta name="description" content="${ogDescription}">
    ${!bucket.isPublic ? '<meta name="robots" content="noindex, nofollow">' : ''}

    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${shareUrl}">
    <meta property="og:title" content="${ogTitle}">
    <meta property="og:description" content="${ogDescription}">
    <meta property="og:image" content="${ogImage}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">

    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="${shareUrl}">
    <meta property="twitter:title" content="${ogTitle}">
    <meta property="twitter:description" content="${ogDescription}">
    <meta property="twitter:image" content="${ogImage}">

    <link rel="stylesheet" href="/tailwind/output.css">
    <style>
        .link-row:last-child { border-bottom: none !important; }
    </style>
</head>
<body class="bg-gray-50 font-sans text-woodsmoke-950 overflow-x-hidden min-h-screen">

    <!-- Navbar -->
    <header class="sticky top-0 z-50 bg-white/90 backdrop-blur-sm border-b border-gray-100">
        <div class="max-w-5xl mx-auto px-5 sm:px-6 h-14 flex items-center justify-between">
            <a href="/" class="font-bold text-base text-woodsmoke-950 tracking-tight">Grabbn</a>
            <a href="/signup.html" class="text-sm font-semibold text-white bg-orchid-700 hover:bg-orchid-800 transition-colors px-4 py-2 rounded-md">
                Get started free
            </a>
        </div>
    </header>

    <!-- Main -->
    <main class="max-w-2xl mx-auto px-5 sm:px-6 py-10">

        <!-- Bucket card -->
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden mb-6">

            ${thumbnailUrl ? `
            <div style="aspect-ratio:16/9;overflow:hidden;background:#f3f4f6;">
                <img src="${thumbnailUrl}" alt="${bucket.name}" style="width:100%;height:100%;object-fit:cover;">
            </div>` : ''}

            <!-- Bucket info -->
            <div class="p-5 sm:p-6 border-b border-gray-100">
                <h1 class="text-2xl font-bold text-woodsmoke-950 mb-3 leading-tight">${bucket.name}</h1>
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="inline-flex items-center bg-orchid-50 text-orchid-700 text-xs font-semibold px-3 py-1 rounded-full border border-orchid-200">
                        ${bucket.links.length} link${bucket.links.length !== 1 ? 's' : ''}
                    </span>
                    ${!bucket.isPublic ? '<span class="inline-flex items-center bg-gray-100 text-gray-500 text-xs font-semibold px-3 py-1 rounded-full">Unlisted</span>' : ''}
                    <span class="text-sm text-gray-400">by ${curatorName}</span>
                </div>
                ${bucket.sourceUrl ? `
                <div class="mt-3 flex items-baseline gap-2 bg-gray-50 border border-gray-100 rounded-xl px-4 py-2.5 text-xs">
                    <span class="text-gray-400 font-medium shrink-0">Source</span>
                    <a href="${bucket.sourceUrl}" class="text-orchid-600 hover:underline min-w-0 break-all" target="_blank" rel="noopener noreferrer">${bucket.sourceUrl}</a>
                </div>` : ''}
            </div>

            <!-- Links header -->
            <div class="px-5 sm:px-6 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                <span class="text-xs font-semibold text-gray-500 uppercase tracking-widest">Links</span>
                <span class="ml-auto text-xs text-gray-400">${bucket.links.length} total</span>
            </div>

            <!-- Links list -->
            ${bucket.links.length === 0 ? `
            <div class="px-5 py-12 text-center text-gray-400 text-sm italic">No links in this collection.</div>
            ` : bucket.links.map(link => `
            <a href="${link.href}" target="_blank" rel="noopener noreferrer"
               data-bucket-id="${bucketId}"
               class="link-row flex items-center gap-3 px-5 sm:px-6 py-3.5 border-b border-gray-50 hover:bg-orchid-50 transition-colors group">
                ${link.image ? `<img src="${link.image}" alt="" loading="lazy" style="width:56px;height:40px;object-fit:cover;border-radius:8px;flex-shrink:0;background:#f3f4f6;">` : ''}
                <div style="flex:1;min-width:0;">
                    <p class="text-sm font-medium text-woodsmoke-950 group-hover:text-orchid-700 transition-colors" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${link.text || 'Untitled Link'}${link.duration ? `<span class="text-gray-400 font-normal"> · ${link.duration}</span>` : ''}
                    </p>
                </div>
                <svg style="width:16px;height:16px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-300 group-hover:text-orchid-400 transition-colors">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
            </a>`).join('')}

        </div>

        <!-- CTA box -->
        <div class="bg-orchid-50 border border-orchid-200 rounded-2xl p-5 sm:p-6 mb-6">
            <p class="text-xs font-semibold tracking-widest uppercase text-orchid-600 mb-1">Grabbn</p>
            <p class="text-sm font-bold text-woodsmoke-950 mb-1">Build your own link collections</p>
            <p class="text-sm text-gray-500 leading-relaxed">Extract and organize links from any webpage into shareable buckets. Free to start, no credit card required.</p>
            <a href="/signup.html" class="mt-4 inline-flex items-center gap-x-1.5 text-sm font-semibold text-orchid-700 hover:text-orchid-800 transition-colors">
                Get started free
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </a>
        </div>

    </main>

    <!-- Footer -->
    <footer class="border-t border-gray-100 py-8">
        <div class="max-w-5xl mx-auto px-5 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-400">
            <p class="font-semibold text-woodsmoke-950 text-sm">Grabbn</p>
            <p>© 2026 Grabbn · Whimish Tools</p>
        </div>
    </footer>

    <script>
        document.querySelectorAll('a.link-row[data-bucket-id]').forEach(function(a) {
            a.addEventListener('click', function() {
                var payload = JSON.stringify({ href: this.href, bucketId: this.dataset.bucketId });
                navigator.sendBeacon('/api/links/click', new Blob([payload], { type: 'application/json' }));
            });
        });
    </script>

</body>
</html>`;

        // Track view — skip owner, deduplicate for authed users, simple increment for anon
        const isOwner = req.user && bucket.userId.equals(req.user._id);
        if (!isOwner) {
            if (req.user) {
                const existing = bucket.viewedBy.find(v => v.userId.equals(req.user._id));
                if (!existing) {
                    Bucket.findByIdAndUpdate(bucketId, {
                        $push: { viewedBy: { userId: req.user._id, lastViewedVersion: bucket.updatedAt } },
                        $inc: { viewCount: 1 }
                    }).catch(() => {});
                } else if (existing.lastViewedVersion < bucket.updatedAt) {
                    Bucket.updateOne(
                        { _id: bucketId, 'viewedBy.userId': req.user._id },
                        { $set: { 'viewedBy.$.lastViewedVersion': bucket.updatedAt }, $inc: { viewCount: 1 } }
                    ).catch(() => {});
                }
            } else {
                Bucket.findByIdAndUpdate(bucketId, { $inc: { viewCount: 1 } }).catch(() => {});
            }
        }

        res.send(html);
    } catch (error) {
        console.error('Error fetching shared bucket:', error);
        res.status(500).send('Error loading shared bucket');
    }
});

export default router;