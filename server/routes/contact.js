import express from 'express';
import { Resend } from 'resend';

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const VALID_INTENTS    = new Set(['support', 'brand', 'feedback', 'other']);
const VALID_CATEGORIES = new Set(['account', 'content', 'bug', 'billing', 'safety', 'other']);
const VALID_FT         = new Set(['feature', 'bug', 'general']);
const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
const MAX_ATTACH_COUNT = 5;

function stripTags(html) {
    return String(html).replace(/<[^>]*>/g, '');
}

router.post('/', async (req, res) => {
    try {
        const {
            intent, name, email, message,
            category, subject,
            company, website,
            feedbackType,
            organization,
            attachments: rawAttachments,
        } = req.body;

        if (!VALID_INTENTS.has(intent)) return res.status(400).json({ error: 'Invalid intent' });

        const msgHtml = typeof message === 'string' ? message.trim() : '';
        const msgText = stripTags(msgHtml).trim();
        if (msgText.length < 10)   return res.status(400).json({ error: 'Message must be at least 10 characters' });
        if (msgText.length > 5000) return res.status(400).json({ error: 'Message too long (max 5 000 characters)' });

        const user       = req.user;
        const isLoggedIn = user && !user.isAnonymous;

        const fromEmail = isLoggedIn
            ? user.email
            : (typeof email === 'string' ? email.trim().toLowerCase() : '');
        const fromName = isLoggedIn
            ? (user.username || user.email)
            : (typeof name === 'string' && name.trim() ? name.trim() : 'Anonymous');

        if (!fromEmail || !fromEmail.includes('@') || fromEmail.length > 256) {
            return res.status(400).json({ error: 'A valid email address is required' });
        }

        // ── Attachments ───────────────────────────────────────────────────────
        const attachments = [];
        if (Array.isArray(rawAttachments)) {
            for (const a of rawAttachments.slice(0, MAX_ATTACH_COUNT)) {
                if (!a.filename || !a.data || typeof a.data !== 'string') continue;
                const buf = Buffer.from(a.data, 'base64');
                if (buf.byteLength > MAX_ATTACH_BYTES) continue;
                attachments.push({ filename: String(a.filename).slice(0, 255), content: buf });
            }
        }

        const intentLabels = {
            support:  'Support',
            brand:    'Brand inquiry',
            feedback: 'Feedback',
            other:    'Press / Other',
        };
        const ftLabels  = { feature: 'Feature request', bug: 'Bug report', general: 'General feedback' };
        const catLabels = {
            account: 'Account & verification',
            content: 'Content & buckets',
            bug:     'Technical bug',
            billing: 'Billing & GTK',
            safety:  'Safety & moderation',
            other:   'Other',
        };

        const subjectLine = typeof subject === 'string' && subject.trim()
            ? subject.trim().slice(0, 80)
            : msgText.slice(0, 60);
        const emailSubject = `[Grabbn Contact] [${intentLabels[intent]}] ${subjectLine}`;

        const rows = [
            ['Intent', intentLabels[intent]],
            ['From',   `${fromName} &lt;${fromEmail}&gt;`],
        ];
        if (isLoggedIn) rows.push(['User ID', String(user._id)]);
        if (intent === 'support') {
            if (category && VALID_CATEGORIES.has(category)) rows.push(['Category', catLabels[category]]);
            if (subject && typeof subject === 'string' && subject.trim()) rows.push(['Subject', subject.trim().slice(0, 200)]);
        }
        if (intent === 'brand') {
            if (company && typeof company === 'string' && company.trim()) rows.push(['Company', company.trim().slice(0, 200)]);
            if (website && typeof website === 'string' && website.trim()) rows.push(['Website', website.trim().slice(0, 500)]);
        }
        if (intent === 'feedback' && feedbackType && VALID_FT.has(feedbackType)) {
            rows.push(['Type', ftLabels[feedbackType]]);
        }
        if (intent === 'other' && organization && typeof organization === 'string' && organization.trim()) {
            rows.push(['Organization', organization.trim().slice(0, 200)]);
        }
        if (attachments.length) {
            rows.push(['Attachments', attachments.map(a => a.filename).join(', ')]);
        }

        const rowsHtml = rows.map(([k, v]) =>
            `<tr>
                <td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap;font-weight:600;">${k}</td>
                <td style="padding:4px 0;color:#1f2937;">${v}</td>
            </tr>`
        ).join('');

        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
    <h2 style="color:#1f2937;margin-bottom:20px;">New contact form submission</h2>
    <table style="border-collapse:collapse;margin-bottom:24px;">${rowsHtml}</table>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;color:#374151;line-height:1.7;">
        ${msgHtml}
    </div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="color:#9ca3af;font-size:12px;">Grabbn Contact Form</p>
</div>`;

        const to = process.env.SUPPORT_EMAIL || process.env.RESEND_FROM;
        await resend.emails.send({
            from:        process.env.RESEND_FROM,
            to,
            replyTo:     fromEmail,
            subject:     emailSubject,
            html,
            ...(attachments.length ? { attachments } : {}),
        });

        res.json({ ok: true });
    } catch (err) {
        console.error('[contact]', err);
        res.status(500).json({ error: 'Failed to send your message. Please try again.' });
    }
});

export default router;
