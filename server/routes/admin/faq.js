// server/routes/admin/faq.js
import express from 'express';
import FaqItem, { FAQ_CATEGORIES, FAQ_CATEGORY_LABELS } from '../../models/faqItem.js';

const router = express.Router();

// GET /api/admin/faq?status=pending|published|rejected|all
router.get('/', async (req, res) => {
    try {
        const { status = 'all' } = req.query;
        const filter = status !== 'all' ? { status } : {};

        const items = await FaqItem.find(filter)
            .populate('submittedBy', 'username email')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ items, categories: FAQ_CATEGORY_LABELS });
    } catch (err) {
        console.error('[admin/faq]', err);
        res.status(500).json({ error: 'Failed to fetch FAQ items' });
    }
});

// POST /api/admin/faq — create an admin-written FAQ item (published immediately)
router.post('/', async (req, res) => {
    const { question, answer, category, order = 0 } = req.body;

    if (!question || !answer || !category) {
        return res.status(400).json({ error: 'question, answer, and category are required' });
    }
    if (!FAQ_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Invalid category' });
    }

    try {
        const item = await FaqItem.create({
            question:    question.trim(),
            answer:      answer.trim(),
            category,
            source:      'admin',
            status:      'published',
            order:       Number(order) || 0,
            publishedAt: new Date(),
        });

        res.json({ ok: true, item });
    } catch (err) {
        console.error('[admin/faq/create]', err);
        res.status(500).json({ error: 'Failed to create FAQ item' });
    }
});

// PUT /api/admin/faq/:id — update question, answer, category, status, or order
router.put('/:id', async (req, res) => {
    const { question, answer, category, status, order } = req.body;

    if (category !== undefined && !FAQ_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Invalid category' });
    }

    try {
        const item = await FaqItem.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Not found' });

        if (question  !== undefined) item.question  = question.trim();
        if (answer    !== undefined) item.answer    = answer.trim();
        if (category  !== undefined) item.category  = category;
        if (order     !== undefined) item.order     = Number(order) || 0;

        if (status === 'published' && item.status !== 'published') {
            item.status      = 'published';
            item.publishedAt = new Date();
        } else if (status === 'rejected' || status === 'pending') {
            item.status = status;
        }

        await item.save();
        res.json({ ok: true, item });
    } catch (err) {
        console.error('[admin/faq/update]', err);
        res.status(500).json({ error: 'Failed to update FAQ item' });
    }
});

// DELETE /api/admin/faq/:id
router.delete('/:id', async (req, res) => {
    try {
        await FaqItem.findByIdAndDelete(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[admin/faq/delete]', err);
        res.status(500).json({ error: 'Failed to delete FAQ item' });
    }
});

export default router;
