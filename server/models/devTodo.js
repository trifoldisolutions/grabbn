import mongoose from 'mongoose';

const devTodoSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  tags:        [{ type: String, trim: true }],
  completedAt: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('DevTodo', devTodoSchema);
