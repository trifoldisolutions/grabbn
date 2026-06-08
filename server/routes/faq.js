// server/routes/faq.js
import express from 'express';
import FaqItem, { FAQ_CATEGORY_LABELS } from '../models/faqItem.js';

const router = express.Router();

// GET /api/faq — published items grouped by category
router.get('/', async (req, res) => {
    try {
        const items = await FaqItem.find({ status: 'published' })
            .sort({ order: 1, publishedAt: 1 })
            .lean();

        const grouped = {};
        for (const item of items) {
            const cat = item.category || 'uncategorized';
            if (!grouped[cat]) {
                grouped[cat] = {
                    slug:  cat,
                    label: FAQ_CATEGORY_LABELS[cat] || cat,
                    items: [],
                };
            }
            grouped[cat].items.push({ _id: item._id, question: item.question, answer: item.answer });
        }

        res.json({ grouped });
    } catch (err) {
        console.error('[faq]', err);
        res.status(500).json({ error: 'Failed to fetch FAQ' });
    }
});

// GET /api/faq/pending — recent unanswered user submissions (public)
router.get('/pending', async (req, res) => {
    try {
        const questions = await FaqItem.find({ source: 'user', status: 'pending' })
            .sort({ createdAt: -1 })
            .limit(10)
            .select('question createdAt')
            .lean();

        res.json({ questions });
    } catch (err) {
        console.error('[faq/pending]', err);
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// POST /api/faq/questions — submit a question (logged-in, non-anonymous users only)
router.post('/questions', async (req, res) => {
    const user = req.user;
    if (!user || user.isAnonymous) {
        return res.status(401).json({ error: 'Sign in to submit a question' });
    }

    const { question } = req.body;
    if (!question || typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ error: 'Question is required' });
    }
    const trimmed = question.trim();
    if (trimmed.length > 500) {
        return res.status(400).json({ error: 'Question must be 500 characters or fewer' });
    }

    try {
        const item = await FaqItem.create({
            question:    trimmed,
            source:      'user',
            submittedBy: user._id,
            status:      'pending',
        });

        res.json({ ok: true, id: item._id });
    } catch (err) {
        console.error('[faq/questions]', err);
        res.status(500).json({ error: 'Failed to submit question' });
    }
});

export default router;
