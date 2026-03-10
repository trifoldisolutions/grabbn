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
    <title>Bucket Not Found - Grabbn</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f9fafb;
            color: #191919;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 1rem;
        }
        .header { text-align: center; margin-bottom: 2rem; }
        .header h1 { font-size: 1.875rem; font-weight: 700; color: #1f2937; margin-bottom: 0.25rem; }
        .header p { color: #6b7280; font-size: 0.875rem; }
        .card {
            background: white;
            border-radius: 0.5rem;
            box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
            padding: 2rem;
            text-align: center;
            max-width: 400px;
            width: 100%;
            margin-bottom: 1.5rem;
        }
        .card-icon { color: #9ca3af; margin-bottom: 1rem; }
        .card h2 { font-size: 1.125rem; font-weight: 700; color: #1f2937; margin-bottom: 0.5rem; }
        .card p { font-size: 0.875rem; color: #6b7280; }
        .back-link { font-size: 0.875rem; color: #6b7280; text-decoration: none; }
        .back-link:hover { color: #1f2937; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Grabbn • Link Grabber</h1>
        <p>Shared link collection</p>
    </div>
    <div class="card">
        <div class="card-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
        </div>
        <h2>Bucket Not Found</h2>
        <p>This shared bucket no longer exists or has been removed.</p>
    </div>
    <a href="/" class="back-link">← Back to Home</a>
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
                        `<div class="blurred-link">${l.text || 'Untitled Link'}</div>`
                    ).join('');
                    const moreCount = paidLinks.length > 5 ? paidLinks.length - 5 : 0;

                    const ctaHtml = isAnonymous
                        ? `<a href="/?openAuth=true" class="unlock-btn">Sign in to unlock</a>`
                        : `<button class="unlock-btn" id="unlockBtn">Unlock for ${bucket.price} credits ($${dollarPrice})</button>
                           <p class="balance-hint">Your balance: <strong>${viewerCredits} credits</strong>${viewerCredits < bucket.price ? ' — <a href="/?openCredits=true">Add credits</a>' : ''}</p>`;

                    return res.status(402).send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${bucket.name} — Unlock to View - Grabbn</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #f9fafb; color: #191919; min-height: 100vh; }
        .container { max-width: 600px; margin: 0 auto; padding: 2rem 1rem; }
        .header { text-align: center; margin-bottom: 2rem; }
        .header h1 { font-size: 1.875rem; font-weight: 700; color: #1f2937; margin-bottom: 0.25rem; }
        .header p { color: #6b7280; font-size: 0.875rem; }
        .card { background: white; border-radius: 0.5rem; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); overflow: hidden; margin-bottom: 1.5rem; }
        .bucket-header { background: #fdf6fd; padding: 1.25rem 1.5rem; border-bottom: 1px solid #f3d8f6; }
        .bucket-name { font-size: 1.625rem; font-weight: 700; color: #943792; margin-bottom: 0.5rem; }
        .bucket-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
        .badge { display: inline-flex; align-items: center; background: #dbeafe; color: #1e40af; font-size: 0.75rem; font-weight: 500; padding: 0.125rem 0.625rem; border-radius: 9999px; }
        .price-badge { background: #fef3c7; color: #92400e; }
        .thumbnail-wrapper { width: 100%; aspect-ratio: 16/9; background: #f3f4f6; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        .thumbnail-wrapper img { width: 100%; height: 100%; object-fit: cover; }
        .thumbnail-placeholder { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; color: #9ca3af; font-size: 0.875rem; }
        .links-header { display: flex; align-items: center; gap: 0.625rem; padding: 0.875rem 1.5rem; border-bottom: 1px solid #e5e7eb; }
        .links-title { font-size: 0.875rem; font-weight: 700; color: #191919; }
        .link-item { display: flex; flex-direction: column; gap: 0.125rem; padding: 0.875rem 1.5rem; border-bottom: 1px solid #f3f4f6; text-decoration: none; transition: background 0.15s; }
        .link-item:hover { background: #fdf6fd; }
        .link-title { font-size: 0.875rem; font-weight: 600; color: #191919; display: flex; align-items: center; gap: 0.375rem; }
        .link-duration { font-weight: 400; color: #6b7280; font-size: 0.8125rem; }
        .link-url { font-size: 0.75rem; color: #2563eb; word-break: break-all; }
        .blurred-link { padding: 0.75rem 1.5rem; border-bottom: 1px solid #f3f4f6; font-size: 0.875rem; color: transparent; text-shadow: 0 0 8px rgba(0,0,0,0.5); user-select: none; background: repeating-linear-gradient(90deg, #e5e7eb 0px, #e5e7eb 8px, transparent 8px, transparent 12px); border-radius: 4px; margin: 0.25rem 1rem; }
        .more-hint { padding: 0.75rem 1.5rem; font-size: 0.8125rem; color: #9ca3af; font-style: italic; }
        .cta-box { padding: 1.5rem; text-align: center; border-top: 1px solid #e5e7eb; }
        .unlock-btn { display: inline-block; background: #943792; color: white; font-weight: 600; font-size: 0.9375rem; padding: 0.75rem 2rem; border-radius: 0.5rem; border: none; cursor: pointer; text-decoration: none; }
        .unlock-btn:hover { background: #7a2e78; }
        .balance-hint { margin-top: 0.75rem; font-size: 0.8125rem; color: #6b7280; }
        .balance-hint a { color: #943792; font-weight: 600; }
        .toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); background: #1f2937; color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-size: 0.875rem; display: none; z-index: 100; }
        .back-link { font-size: 0.875rem; color: #6b7280; text-decoration: none; display: block; text-align: center; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Grabbn • Link Grabber</h1>
            <p>Shared link collection</p>
        </div>
        <div class="card">
            <div class="bucket-header">
                <div class="bucket-name">${bucket.name}</div>
                <div class="bucket-meta">
                    <span class="badge price-badge">🔒 ${bucket.price} credits ($${dollarPrice})</span>
                    <span style="font-size:0.8125rem;color:#6b7280">by ${curatorName}</span>
                </div>
            </div>
            <div class="thumbnail-wrapper">
                ${thumbnailUrl
                    ? `<img src="${thumbnailUrl}" alt="${bucket.name}">`
                    : `<div class="thumbnail-placeholder">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <path d="M21 15l-5-5L5 21"/>
                        </svg>
                        <span>No Thumbnail</span>
                    </div>`
                }
            </div>
            <div class="links-header">
                <span class="links-title">Content</span>
                ${freeLinks.length > 0
                    ? `<span class="badge">${freeLinks.length} free · ${paidLinks.length} locked</span>`
                    : `<span class="badge">${paidLinks.length} locked — unlock to view</span>`
                }
            </div>
            ${freeLinks.map(link => `
            <a href="${link.href}" class="link-item" target="_blank" rel="noopener noreferrer">
                <div class="link-title">
                    ${link.text || 'Untitled Link'}
                    ${link.duration ? `<span class="link-duration">(${link.duration})</span>` : ''}
                </div>
                <span class="link-url">${link.href}</span>
            </a>`).join('')}
            ${paidLinks.length > 0 ? `${blurredLinks}
            ${moreCount > 0 ? `<div class="more-hint">+ ${moreCount} more link${moreCount === 1 ? '' : 's'} hidden</div>` : ''}` : ''}
            <div class="cta-box">
                ${ctaHtml}
            </div>
        </div>
        <a href="/" class="back-link">← Back to Home</a>
    </div>
    <div class="toast" id="toast"></div>
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

    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f9fafb;
            color: #191919;
            line-height: 1.6;
            min-height: 100vh;
        }

        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 2rem 1rem;
        }

        /* Header */
        .header { text-align: center; margin-bottom: 2rem; }
        .header h1 { font-size: 1.875rem; font-weight: 700; color: #1f2937; margin-bottom: 0.25rem; }
        .header p { color: #6b7280; font-size: 0.875rem; }

        /* Card */
        .card {
            background: white;
            border-radius: 0.5rem;
            box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
            overflow: hidden;
            margin-bottom: 1.5rem;
        }

        /* Bucket header strip */
        .bucket-header {
            background: #fdf6fd;
            padding: 1.25rem 1.5rem;
            border-bottom: 1px solid #f3d8f6;
        }
        .bucket-name {
            font-size: 1.625rem;
            font-weight: 700;
            color: #943792;
            margin-bottom: 0.5rem;
        }
        .bucket-meta {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex-wrap: wrap;
        }
        .meta-dot { color: #6b7280; font-size: 0.875rem; }

        /* Badges — matches countBadge in index.html */
        .badge {
            display: inline-flex;
            align-items: center;
            background: #dbeafe;
            color: #1e40af;
            font-size: 0.75rem;
            font-weight: 500;
            padding: 0.125rem 0.625rem;
            border-radius: 9999px;
        }

        /* Source URL row */
        .source-box {
            display: flex;
            align-items: baseline;
            gap: 0.5rem;
            background: #fdf6fd;
            border: 1px solid #f3d8f6;
            border-radius: 0.375rem;
            padding: 0.5rem 0.75rem;
            margin-top: 0.75rem;
            font-size: 0.75rem;
        }
        .source-label { color: #6b7280; font-weight: 500; white-space: nowrap; flex-shrink: 0; }
        .source-link { color: #943792; text-decoration: none; word-break: break-all; }
        .source-link:hover { text-decoration: underline; }

        /* Thumbnail */
        .thumbnail-wrapper {
            width: 100%;
            aspect-ratio: 16/9;
            background: #f3f4f6;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .thumbnail-wrapper img { width: 100%; height: 100%; object-fit: cover; }
        .thumbnail-placeholder {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.5rem;
            color: #9ca3af;
            font-size: 0.875rem;
        }

        /* Links section header */
        .links-header {
            display: flex;
            align-items: center;
            gap: 0.625rem;
            padding: 0.875rem 1.5rem;
            border-bottom: 1px solid #e5e7eb;
        }
        .links-title { font-size: 0.875rem; font-weight: 700; color: #191919; }

        /* Link rows — clickable anchors */
        .link-item {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem 1.5rem;
            border-bottom: 1px solid #f3f4f6;
            text-decoration: none;
            transition: background 0.15s;
        }
        .link-item:last-child { border-bottom: none; }
        .link-item:hover { background: #fdf6fd; }
        .link-img {
            width: 64px;
            height: 48px;
            object-fit: cover;
            border-radius: 4px;
            flex-shrink: 0;
            background: #f3f4f6;
        }
        .link-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.125rem; }

        .link-title {
            font-size: 0.875rem;
            font-weight: 600;
            color: #191919;
            display: flex;
            align-items: center;
            gap: 0.375rem;
        }
        .link-duration { font-weight: 400; color: #6b7280; font-size: 0.8125rem; }
        .link-url { font-size: 0.75rem; color: #2563eb; word-break: break-all; }

        .empty-links {
            padding: 2.5rem;
            text-align: center;
            color: #6b7280;
            font-size: 0.875rem;
            font-style: italic;
        }

        /* CTA box — matches "Benefits" box in login.html */
        .cta-box {
            background: #fdf6fd;
            border: 1px solid #f3d8f6;
            border-radius: 0.5rem;
            padding: 1rem;
            margin-bottom: 1.5rem;
        }
        .cta-title { font-size: 0.875rem; font-weight: 600; color: #40123d; margin-bottom: 0.25rem; }
        .cta-desc { font-size: 0.8125rem; color: #943792; }
        .cta-link { color: #943792; font-weight: 600; text-decoration: none; }
        .cta-link:hover { text-decoration: underline; }

        /* Footer */
        .footer { text-align: center; padding-bottom: 1.5rem; color: #6b7280; font-size: 0.8125rem; }
        .footer a { color: #943792; font-weight: 600; text-decoration: none; }
        .footer a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="container">

        <div class="header">
            <h1>Grabbn • Link Grabber</h1>
            <p>Shared link collection</p>
        </div>

        <div class="card">

            <div class="bucket-header">
                <div class="bucket-name">${bucket.name}</div>
                <div class="bucket-meta">
                    <span class="badge">${bucket.links.length} link${bucket.links.length !== 1 ? 's' : ''}</span>
                    ${!bucket.isPublic ? '<span class="badge" style="background:#f3f4f6;color:#6b7280">Unlisted</span>' : ''}
                    <span class="meta-dot">by ${curatorName}</span>
                </div>
                ${bucket.sourceUrl ? `
                <div class="source-box">
                    <span class="source-label">Source</span>
                    <a href="${bucket.sourceUrl}" class="source-link" target="_blank" rel="noopener noreferrer">${bucket.sourceUrl}</a>
                </div>` : ''}
            </div>

            ${thumbnailUrl ? `
            <div class="thumbnail-wrapper">
                <img src="${thumbnailUrl}" alt="${bucket.name}">
            </div>` : `
            <div class="thumbnail-wrapper">
                <div class="thumbnail-placeholder">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <path d="M21 15l-5-5L5 21"/>
                    </svg>
                    <span>No thumbnail</span>
                </div>
            </div>`}

            ${bucket.links.length === 0 ? `
                <div class="empty-links">No links in this collection.</div>
            ` : bucket.links.map(link => `
                <a href="${link.href}" class="link-item" target="_blank" rel="noopener noreferrer">
                    ${link.image ? `<img class="link-img" src="${link.image}" alt="" loading="lazy">` : ''}
                    <div class="link-content">
                        <div class="link-title">
                            ${link.text || 'Untitled Link'}
                            ${link.duration ? `<span class="link-duration">(${link.duration})</span>` : ''}
                        </div>
                        <span class="link-url">${link.href}</span>
                    </div>
                </a>
            `).join('')}

        </div>

        <div class="cta-box">
            <div class="cta-title">✨ Create your own link collections</div>
            <div class="cta-desc">Use <a href="/" class="cta-link">Grabbn</a> to extract and organize links from any webpage — free to use.</div>
        </div>

        <div class="footer">
            <p>Created with <a href="/">Grabbn</a> by Whimish Tools</p>
        </div>

    </div>
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