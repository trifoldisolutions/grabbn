import mongoose from 'mongoose';

export const FAQ_CATEGORIES = [
    'account',
    'buckets',
    'partner-program',
    'gtk',
    'repositories',
    'moderation',
];

export const FAQ_CATEGORY_LABELS = {
    'account':         'Account & Verification',
    'buckets':         'Buckets',
    'partner-program': 'Partner Program',
    'gtk':             'GTK',
    'repositories':    'Repositories & Showrooms',
    'moderation':      'Content & Moderation',
};

const faqItemSchema = new mongoose.Schema({
    question:    { type: String, required: true, trim: true },
    answer:      { type: String, default: '' },
    category:    { type: String, enum: [...FAQ_CATEGORIES, null], default: null },
    source:      { type: String, enum: ['admin', 'user'], default: 'admin' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status:      { type: String, enum: ['pending', 'published', 'rejected'], default: 'pending', index: true },
    order:       { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('FaqItem', faqItemSchema);
