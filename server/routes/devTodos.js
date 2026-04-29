import { Router } from 'express';
import DevTodo from '../models/devTodo.js';

const router = Router();

router.get('/', async (req, res) => {
  const todos = await DevTodo.find({ deletedAt: null }).sort({ createdAt: -1 });
  res.json(todos);
});

router.get('/trash', async (req, res) => {
  const todos = await DevTodo.find({ deletedAt: { $ne: null } }).sort({ deletedAt: -1 });
  res.json(todos);
});

router.post('/', async (req, res) => {
  const { name, description, tags } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const todo = await DevTodo.create({ name: name.trim(), description: description?.trim() ?? '', tags: normalizeTags(tags) });
  res.status(201).json(todo);
});

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
}

router.patch('/:id', async (req, res) => {
  const { name, description, completed, tags } = req.body;
  const update = {};
  if (name        !== undefined) update.name        = name.trim();
  if (description !== undefined) update.description = description.trim();
  if (tags        !== undefined) update.tags        = normalizeTags(tags);
  if (completed === true)  update.completedAt = new Date();
  if (completed === false) update.completedAt = null;
  const todo = await DevTodo.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!todo) return res.status(404).json({ error: 'Not found' });
  res.json(todo);
});

router.delete('/:id', async (req, res) => {
  const todo = await DevTodo.findByIdAndUpdate(req.params.id, { deletedAt: new Date() }, { new: true });
  if (!todo) return res.status(404).json({ error: 'Not found' });
  res.json(todo);
});

router.patch('/:id/restore', async (req, res) => {
  const todo = await DevTodo.findByIdAndUpdate(req.params.id, { deletedAt: null }, { new: true });
  if (!todo) return res.status(404).json({ error: 'Not found' });
  res.json(todo);
});

router.delete('/:id/permanent', async (req, res) => {
  await DevTodo.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

export default router;
