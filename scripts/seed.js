/**
 * scripts/seed.js
 *
 * Generates a diversified catalog for testing the explore & showroom
 * recommendation system.
 *
 * Run:
 *   node --env-file=.env scripts/seed.js
 *
 * Options (env vars):
 *   SEED_WIPE=true   – drop all existing buckets, users (non-admin), link clicks,
 *                      topic scores before seeding (default: false, additive)
 */

import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// ── Models ────────────────────────────────────────────────────────────────────
import User        from '../server/models/user.js';
import Bucket      from '../server/models/bucket.js';
import LinkClick   from '../server/models/linkClick.js';
import Subscription from '../server/models/subscription.js';
import TopicScore  from '../server/models/topicScore.js';
import { buildExploreScores } from '../server/jobs/buildExploreScores.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(n) {
    return new Date(Date.now() - n * 86_400_000);
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Curator profiles ──────────────────────────────────────────────────────────

const CURATORS = [
    {
        username: 'devhunter',
        email: 'devhunter@seed.local',
        specialty: 'github.com',
        avatar: null,
    },
    {
        username: 'readinglist',
        email: 'readinglist@seed.local',
        specialty: 'medium.com',
        avatar: null,
    },
    {
        username: 'tubemaster',
        email: 'tubemaster@seed.local',
        specialty: 'youtube.com',
        avatar: null,
    },
    {
        username: 'hackerdigest',
        email: 'hackerdigest@seed.local',
        specialty: 'news.ycombinator.com',
        avatar: null,
    },
    {
        username: 'designpicker',
        email: 'designpicker@seed.local',
        specialty: 'figma.com',
        avatar: null,
    },
    {
        username: 'substacker',
        email: 'substacker@seed.local',
        specialty: 'substack.com',
        avatar: null,
    },
    {
        username: 'redditcurator',
        email: 'redditcurator@seed.local',
        specialty: 'reddit.com',
        avatar: null,
    },
    {
        username: 'productpicker',
        email: 'productpicker@seed.local',
        specialty: 'producthunt.com',
        avatar: null,
    },
    {
        username: 'stackwatcher',
        email: 'stackwatcher@seed.local',
        specialty: 'stackoverflow.com',
        avatar: null,
    },
    {
        username: 'twittercurator',
        email: 'twittercurator@seed.local',
        specialty: 'twitter.com',
        avatar: null,
    },
];

// ── Bucket catalog ─────────────────────────────────────────────────────────────
// Each entry: { name, description, hashtags, sourceUrl, links[], createdDaysAgo,
//               viewCount, shareCount, grabs, isPaywalled?, price? }
//
// `grabs` is just a number – the seeder will spread them across random users.

const BUCKET_CATALOG = [
    // ── GitHub ──────────────────────────────────────────────────────────────
    {
        name: 'Awesome OSS Tools 2024',
        description: 'The best open-source developer tools I found this year.',
        hashtags: ['opensource', 'devtools', 'productivity'],
        sourceUrl: 'https://github.com',
        links: [
            { href: 'https://github.com/microsoft/vscode', text: 'VS Code', clickCount: 42 },
            { href: 'https://github.com/neovim/neovim', text: 'Neovim', clickCount: 28 },
            { href: 'https://github.com/casey/just', text: 'just – a command runner', clickCount: 17 },
            { href: 'https://github.com/sharkdp/bat', text: 'bat – a better cat', clickCount: 35, isPinned: true },
            { href: 'https://github.com/BurntSushi/ripgrep', text: 'ripgrep', clickCount: 22 },
        ],
        createdDaysAgo: 5,
        viewCount: 320,
        shareCount: 12,
        grabs: 8,
        specialty: 'github.com',
    },
    {
        name: 'Rust Crates Worth Knowing',
        description: 'Curated Rust crates every serious Rustacean should know.',
        hashtags: ['rust', 'systems', 'performance'],
        sourceUrl: 'https://github.com',
        links: [
            { href: 'https://github.com/tokio-rs/tokio', text: 'Tokio async runtime', clickCount: 55, isPinned: true },
            { href: 'https://github.com/serde-rs/serde', text: 'Serde serialization', clickCount: 49 },
            { href: 'https://github.com/clap-rs/clap', text: 'Clap CLI framework', clickCount: 30 },
            { href: 'https://github.com/rayon-rs/rayon', text: 'Rayon data-parallelism', clickCount: 21 },
        ],
        createdDaysAgo: 12,
        viewCount: 210,
        shareCount: 9,
        grabs: 5,
        specialty: 'github.com',
    },
    {
        name: 'AI Infra on GitHub',
        description: "Repos powering today's AI infrastructure.",
        hashtags: ['ai', 'mlops', 'infrastructure'],
        sourceUrl: 'https://github.com',
        links: [
            { href: 'https://github.com/vllm-project/vllm', text: 'vLLM inference engine', clickCount: 80, isPinned: true },
            { href: 'https://github.com/ray-project/ray', text: 'Ray distributed compute', clickCount: 65 },
            { href: 'https://github.com/huggingface/transformers', text: 'HuggingFace Transformers', clickCount: 91 },
            { href: 'https://github.com/ggerganov/llama.cpp', text: 'llama.cpp', clickCount: 110 },
            { href: 'https://github.com/langchain-ai/langchain', text: 'LangChain', clickCount: 75 },
        ],
        createdDaysAgo: 3,
        viewCount: 580,
        shareCount: 28,
        grabs: 18,
        specialty: 'github.com',
    },
    {
        name: 'Frontend Frameworks Compared',
        description: "Side-by-side repos for today's major frontend frameworks.",
        hashtags: ['frontend', 'javascript', 'webdev'],
        sourceUrl: 'https://github.com',
        links: [
            { href: 'https://github.com/facebook/react', text: 'React', clickCount: 70 },
            { href: 'https://github.com/vuejs/core', text: 'Vue 3 core', clickCount: 45 },
            { href: 'https://github.com/sveltejs/svelte', text: 'Svelte', clickCount: 62, isPinned: true },
            { href: 'https://github.com/solidjs/solid', text: 'SolidJS', clickCount: 38 },
        ],
        createdDaysAgo: 20,
        viewCount: 180,
        shareCount: 7,
        grabs: 4,
        specialty: 'github.com',
    },

    // ── Medium ───────────────────────────────────────────────────────────────
    {
        name: 'System Design Must-Reads',
        description: 'The Medium articles I keep sending to junior engineers.',
        hashtags: ['systemdesign', 'architecture', 'engineering'],
        sourceUrl: 'https://medium.com',
        links: [
            { href: 'https://medium.com/system-design/cap-theorem-explained', text: 'CAP Theorem Explained', clickCount: 34, isPinned: true },
            { href: 'https://medium.com/better-programming/designing-for-scale', text: 'Designing for Scale', clickCount: 28 },
            { href: 'https://medium.com/free-code-camp/database-sharding', text: 'Database Sharding 101', clickCount: 19 },
            { href: 'https://medium.com/dev-genius/event-driven-architecture', text: 'Event-Driven Architecture', clickCount: 22 },
        ],
        createdDaysAgo: 8,
        viewCount: 240,
        shareCount: 14,
        grabs: 10,
        specialty: 'medium.com',
    },
    {
        name: 'Startup Lessons from Founders',
        description: "Honest reflections from founders who've been in the trenches.",
        hashtags: ['startup', 'entrepreneurship', 'founder'],
        sourceUrl: 'https://medium.com',
        links: [
            { href: 'https://medium.com/startup-grind/lessons-from-failing', text: 'Lessons from Failing Fast', clickCount: 51, isPinned: true },
            { href: 'https://medium.com/swlh/pmf-the-hard-way', text: 'Finding PMF the Hard Way', clickCount: 47 },
            { href: 'https://medium.com/entrepreneurship/hiring-mistake-1', text: 'My Biggest Hiring Mistake', clickCount: 33 },
        ],
        createdDaysAgo: 15,
        viewCount: 190,
        shareCount: 8,
        grabs: 6,
        specialty: 'medium.com',
    },
    {
        name: 'Deep Learning Explainers',
        description: 'Accessible deep dives into ML concepts without the jargon overload.',
        hashtags: ['machinelearning', 'deeplearning', 'ai'],
        sourceUrl: 'https://medium.com',
        links: [
            { href: 'https://medium.com/towards-data-science/attention-is-all-you-need-explained', text: 'Attention Explained', clickCount: 88, isPinned: true },
            { href: 'https://medium.com/towards-data-science/diffusion-models-explained', text: 'Diffusion Models Explained', clickCount: 72 },
            { href: 'https://medium.com/ml-research/transformers-from-scratch', text: 'Transformers from Scratch', clickCount: 60 },
            { href: 'https://medium.com/ai-in-plain-english/rlhf-explained', text: 'RLHF Explained', clickCount: 55 },
        ],
        createdDaysAgo: 6,
        viewCount: 420,
        shareCount: 22,
        grabs: 14,
        specialty: 'medium.com',
    },

    // ── YouTube ───────────────────────────────────────────────────────────────
    {
        name: 'Best CS Lectures on YouTube',
        description: 'University-level computer science lectures, all free.',
        hashtags: ['cs', 'education', 'algorithms'],
        sourceUrl: 'https://youtube.com',
        links: [
            { href: 'https://youtube.com/watch?v=HtSuA80QTyo', text: 'Harvard CS50 2023', clickCount: 95, isPinned: true },
            { href: 'https://youtube.com/watch?v=8mAITcNt710', text: 'MIT 6.006 Algorithms', clickCount: 67 },
            { href: 'https://youtube.com/watch?v=zLnJcAt1aKs', text: 'Stanford ML (Andrew Ng)', clickCount: 82 },
            { href: 'https://youtube.com/watch?v=9TFnjJkfqmA', text: 'CMU Operating Systems', clickCount: 44 },
        ],
        createdDaysAgo: 30,
        viewCount: 520,
        shareCount: 31,
        grabs: 22,
        specialty: 'youtube.com',
    },
    {
        name: 'React Deep Dives',
        description: 'YouTube channels and videos that actually explain React internals.',
        hashtags: ['react', 'frontend', 'javascript'],
        sourceUrl: 'https://youtube.com',
        links: [
            { href: 'https://youtube.com/watch?v=TNhaISOUy6Q', text: 'React Fiber Explained', clickCount: 48 },
            { href: 'https://youtube.com/watch?v=0RznMO75tcU', text: 'useEffect Deep Dive', clickCount: 39, isPinned: true },
            { href: 'https://youtube.com/watch?v=dpw9EHDh2bM', text: 'React 19 Explained', clickCount: 61 },
        ],
        createdDaysAgo: 10,
        viewCount: 280,
        shareCount: 10,
        grabs: 7,
        specialty: 'youtube.com',
    },
    {
        name: 'Indie Hacker Vlogs',
        description: 'Builders sharing their journey to ramen profitability.',
        hashtags: ['indiehacker', 'buildinpublic', 'saas'],
        sourceUrl: 'https://youtube.com',
        links: [
            { href: 'https://youtube.com/watch?v=oFtjKbXKqbg', text: '$0 to $10k MRR in 6 months', clickCount: 74, isPinned: true },
            { href: 'https://youtube.com/watch?v=m9HteSroB1Q', text: 'Solo Founder Reality Check', clickCount: 58 },
            { href: 'https://youtube.com/watch?v=rHiHegas9dk', text: 'How I Built a $50k/mo Tool', clickCount: 83 },
        ],
        createdDaysAgo: 7,
        viewCount: 310,
        shareCount: 18,
        grabs: 12,
        specialty: 'youtube.com',
    },

    // ── Hacker News ───────────────────────────────────────────────────────────
    {
        name: 'HN Threads Worth Saving',
        description: 'Ask HN / Show HN threads with exceptional signal-to-noise.',
        hashtags: ['hackernews', 'tech', 'discussion'],
        sourceUrl: 'https://news.ycombinator.com',
        links: [
            { href: 'https://news.ycombinator.com/item?id=38119606', text: 'Ask HN: How do you focus?', clickCount: 40 },
            { href: 'https://news.ycombinator.com/item?id=37359987', text: 'Show HN: I built X in a weekend', clickCount: 28 },
            { href: 'https://news.ycombinator.com/item?id=36769558', text: 'Ask HN: Best books 2023?', clickCount: 52, isPinned: true },
            { href: 'https://news.ycombinator.com/item?id=39894820', text: 'Ask HN: Burnout recovery', clickCount: 35 },
        ],
        createdDaysAgo: 14,
        viewCount: 160,
        shareCount: 6,
        grabs: 5,
        specialty: 'news.ycombinator.com',
    },
    {
        name: 'HN – AI Papers & Discussions',
        description: 'HN threads where the comment section is worth more than the article.',
        hashtags: ['ai', 'llm', 'research'],
        sourceUrl: 'https://news.ycombinator.com',
        links: [
            { href: 'https://news.ycombinator.com/item?id=39442027', text: 'Sora released by OpenAI', clickCount: 90, isPinned: true },
            { href: 'https://news.ycombinator.com/item?id=38741005', text: 'Mistral 7B drops', clickCount: 65 },
            { href: 'https://news.ycombinator.com/item?id=37676446', text: 'Claude 3 discussion thread', clickCount: 78 },
        ],
        createdDaysAgo: 4,
        viewCount: 380,
        shareCount: 19,
        grabs: 13,
        specialty: 'news.ycombinator.com',
    },

    // ── Figma ─────────────────────────────────────────────────────────────────
    {
        name: 'Design System Resources',
        description: 'The best Figma community files and design system references.',
        hashtags: ['design', 'designsystem', 'ui'],
        sourceUrl: 'https://figma.com',
        links: [
            { href: 'https://figma.com/community/file/768365747273056340', text: 'Material Design 3 Kit', clickCount: 55, isPinned: true },
            { href: 'https://figma.com/community/file/831698976089873405', text: 'Apple iOS 17 UI Kit', clickCount: 48 },
            { href: 'https://figma.com/community/file/1105581399682158555', text: 'Untitled UI – Free kit', clickCount: 63 },
            { href: 'https://figma.com/community/file/1138073646025726154', text: 'Radix UI components', clickCount: 29 },
        ],
        createdDaysAgo: 18,
        viewCount: 290,
        shareCount: 15,
        grabs: 11,
        specialty: 'figma.com',
    },
    {
        name: 'Mobile UX Patterns',
        description: 'Figma files showcasing great mobile UX patterns worth stealing.',
        hashtags: ['mobile', 'ux', 'patterns'],
        sourceUrl: 'https://figma.com',
        links: [
            { href: 'https://figma.com/community/file/1220236620275823024', text: 'Bottom Sheet Patterns', clickCount: 32 },
            { href: 'https://figma.com/community/file/1053247597574764364', text: 'Onboarding Flow Examples', clickCount: 44, isPinned: true },
            { href: 'https://figma.com/community/file/1099843982501875818', text: 'Dark Mode UI Kit', clickCount: 27 },
        ],
        createdDaysAgo: 22,
        viewCount: 200,
        shareCount: 9,
        grabs: 6,
        specialty: 'figma.com',
    },

    // ── Substack ──────────────────────────────────────────────────────────────
    {
        name: 'Tech Newsletters I Actually Read',
        description: 'Substack newsletters that land in my inbox and I never skip.',
        hashtags: ['newsletter', 'tech', 'writing'],
        sourceUrl: 'https://substack.com',
        links: [
            { href: 'https://lenny.substack.com', text: "Lenny's Newsletter", clickCount: 58, isPinned: true },
            { href: 'https://stratechery.substack.com', text: 'Stratechery', clickCount: 45 },
            { href: 'https://bytebytego.substack.com', text: 'ByteByteGo', clickCount: 62 },
            { href: 'https://www.therundown.ai', text: 'The Rundown AI', clickCount: 71 },
        ],
        createdDaysAgo: 9,
        viewCount: 350,
        shareCount: 20,
        grabs: 15,
        specialty: 'substack.com',
    },
    {
        name: 'Founder Substacks',
        description: 'Founders writing honestly about building companies.',
        hashtags: ['founder', 'startup', 'newsletter'],
        sourceUrl: 'https://substack.com',
        links: [
            { href: 'https://paulgraham.substack.com', text: 'Paul Graham Essays', clickCount: 82, isPinned: true },
            { href: 'https://nivo.substack.com', text: 'No-Code Exits', clickCount: 31 },
            { href: 'https://growth.substack.com', text: 'Growth Memo', clickCount: 40 },
        ],
        createdDaysAgo: 25,
        viewCount: 270,
        shareCount: 11,
        grabs: 8,
        specialty: 'substack.com',
    },

    // ── Reddit ─────────────────────────────────────────────────────────────────
    {
        name: 'Best of r/programming',
        description: 'Threads from r/programming that generated the most valuable discussions.',
        hashtags: ['programming', 'reddit', 'community'],
        sourceUrl: 'https://reddit.com',
        links: [
            { href: 'https://reddit.com/r/programming/comments/zx1pt0', text: 'Why I switched from Go to Rust', clickCount: 45 },
            { href: 'https://reddit.com/r/programming/comments/zab012', text: 'The senior engineer checklist', clickCount: 37, isPinned: true },
            { href: 'https://reddit.com/r/programming/comments/ycj2t8', text: '10 years of programming lessons', clickCount: 53 },
        ],
        createdDaysAgo: 16,
        viewCount: 220,
        shareCount: 8,
        grabs: 5,
        specialty: 'reddit.com',
    },
    {
        name: 'r/MachineLearning Highlights',
        description: 'Top threads from the ML subreddit worth bookmarking.',
        hashtags: ['machinelearning', 'reddit', 'ai'],
        sourceUrl: 'https://reddit.com',
        links: [
            { href: 'https://reddit.com/r/MachineLearning/comments/abc123', text: 'Attention paper explained by community', clickCount: 67, isPinned: true },
            { href: 'https://reddit.com/r/MachineLearning/comments/def456', text: 'Best intro resources for NLP', clickCount: 48 },
            { href: 'https://reddit.com/r/MachineLearning/comments/ghi789', text: 'AMA with Andrej Karpathy', clickCount: 94 },
        ],
        createdDaysAgo: 11,
        viewCount: 360,
        shareCount: 17,
        grabs: 12,
        specialty: 'reddit.com',
    },

    // ── Product Hunt ─────────────────────────────────────────────────────────
    {
        name: 'Top PH Launches – Dev Tools',
        description: 'Product Hunt launches that dev teams are actually adopting.',
        hashtags: ['producthunt', 'devtools', 'saas'],
        sourceUrl: 'https://producthunt.com',
        links: [
            { href: 'https://producthunt.com/posts/cursor-2', text: 'Cursor AI IDE', clickCount: 88, isPinned: true },
            { href: 'https://producthunt.com/posts/warp-2', text: 'Warp Terminal', clickCount: 55 },
            { href: 'https://producthunt.com/posts/linear', text: 'Linear – Issue Tracker', clickCount: 62 },
            { href: 'https://producthunt.com/posts/retool', text: 'Retool Internal Tools', clickCount: 40 },
        ],
        createdDaysAgo: 13,
        viewCount: 310,
        shareCount: 16,
        grabs: 11,
        specialty: 'producthunt.com',
    },
    {
        name: 'AI Product Hunt Gems',
        description: 'PH launches in the AI space that flew under the radar.',
        hashtags: ['ai', 'producthunt', 'tools'],
        sourceUrl: 'https://producthunt.com',
        links: [
            { href: 'https://producthunt.com/posts/perplexity-ai', text: 'Perplexity AI', clickCount: 75, isPinned: true },
            { href: 'https://producthunt.com/posts/v0-dev', text: 'v0 by Vercel', clickCount: 68 },
            { href: 'https://producthunt.com/posts/bolt-new', text: 'Bolt.new', clickCount: 82 },
            { href: 'https://producthunt.com/posts/lovable', text: 'Lovable', clickCount: 59 },
        ],
        createdDaysAgo: 2,
        viewCount: 490,
        shareCount: 26,
        grabs: 19,
        specialty: 'producthunt.com',
    },

    // ── Stack Overflow ────────────────────────────────────────────────────────
    {
        name: 'SQL Gotchas & Best Answers',
        description: 'The SO answers I link to at least once a month.',
        hashtags: ['sql', 'database', 'stackoverflow'],
        sourceUrl: 'https://stackoverflow.com',
        links: [
            { href: 'https://stackoverflow.com/questions/1346209', text: 'SQL NULL comparisons', clickCount: 30, isPinned: true },
            { href: 'https://stackoverflow.com/questions/9605173', text: 'EXPLAIN ANALYZE guide', clickCount: 26 },
            { href: 'https://stackoverflow.com/questions/17655429', text: 'Recursive CTEs explained', clickCount: 21 },
            { href: 'https://stackoverflow.com/questions/60174', text: 'JOIN types visualized', clickCount: 44 },
        ],
        createdDaysAgo: 40,
        viewCount: 150,
        shareCount: 5,
        grabs: 3,
        specialty: 'stackoverflow.com',
    },
    {
        name: 'JavaScript Gotchas on SO',
        description: 'Questions where the JS behaviour surprised even experienced devs.',
        hashtags: ['javascript', 'stackoverflow', 'quirks'],
        sourceUrl: 'https://stackoverflow.com',
        links: [
            { href: 'https://stackoverflow.com/questions/503093', text: 'How do JS closures work?', clickCount: 72, isPinned: true },
            { href: 'https://stackoverflow.com/questions/111102', text: 'How do function.prototype work?', clickCount: 34 },
            { href: 'https://stackoverflow.com/questions/359494', text: 'Double vs triple equals', clickCount: 48 },
        ],
        createdDaysAgo: 35,
        viewCount: 175,
        shareCount: 7,
        grabs: 4,
        specialty: 'stackoverflow.com',
    },

    // ── Twitter / X ──────────────────────────────────────────────────────────
    {
        name: 'Dev Twitter Threads Worth Saving',
        description: 'Twitter threads I keep sharing with my team.',
        hashtags: ['twitter', 'devtools', 'threads'],
        sourceUrl: 'https://twitter.com',
        links: [
            { href: 'https://twitter.com/dan_abramov/status/1620966621076078592', text: "Dan Abramov on React's future", clickCount: 55, isPinned: true },
            { href: 'https://twitter.com/sama/status/1625539180992634880', text: 'Sam Altman on AGI', clickCount: 70 },
            { href: 'https://twitter.com/karpathy/status/1623371074160214017', text: 'Karpathy on LLM training', clickCount: 84 },
        ],
        createdDaysAgo: 21,
        viewCount: 310,
        shareCount: 14,
        grabs: 9,
        specialty: 'twitter.com',
    },
    {
        name: 'Startup Wisdom Threads',
        description: 'The best startup and VC wisdom condensed into Twitter threads.',
        hashtags: ['startup', 'vc', 'twitter'],
        sourceUrl: 'https://twitter.com',
        links: [
            { href: 'https://twitter.com/paulg/status/1611043327949721601', text: 'Paul Graham on focus', clickCount: 63, isPinned: true },
            { href: 'https://twitter.com/naval/status/1002103360646823936', text: 'Naval on wealth creation', clickCount: 95 },
            { href: 'https://twitter.com/pmarca/status/1234567890', text: 'Marc Andreessen on PMF', clickCount: 47 },
        ],
        createdDaysAgo: 19,
        viewCount: 390,
        shareCount: 21,
        grabs: 16,
        specialty: 'twitter.com',
    },

    // ── Cross-topic – high grab counts (will score well) ─────────────────────
    {
        name: 'Must-Read Links for 2024',
        description: 'The most-shared links in my network this year, across all topics.',
        hashtags: ['curated', 'bestof', 'links'],
        sourceUrl: 'https://github.com',
        links: [
            { href: 'https://github.com/trimstray/the-book-of-secret-knowledge', text: 'The Book of Secret Knowledge', clickCount: 120, isPinned: true },
            { href: 'https://medium.com/towards-data-science/gpt4-deep-dive', text: 'GPT-4 Deep Dive', clickCount: 98 },
            { href: 'https://youtube.com/watch?v=5C_HPTJg5ek', text: 'The Last Lecture (Pausch)', clickCount: 87 },
            { href: 'https://news.ycombinator.com/item?id=30583764', text: 'Ask HN: What would you do differently?', clickCount: 76 },
        ],
        createdDaysAgo: 1,
        viewCount: 640,
        shareCount: 35,
        grabs: 25,
        specialty: 'github.com',
    },
    {
        name: 'AI Reading List 2025',
        description: 'The canonical reading list if you want to understand modern AI.',
        hashtags: ['ai', 'llm', 'reading'],
        sourceUrl: 'https://medium.com',
        links: [
            { href: 'https://medium.com/towards-data-science/attention-transformers', text: 'Attention Is All You Need – Guide', clickCount: 105, isPinned: true },
            { href: 'https://github.com/openai/openai-cookbook', text: 'OpenAI Cookbook', clickCount: 88 },
            { href: 'https://youtube.com/watch?v=bZQun8Y4L2A', text: '3Blue1Brown on Neural Networks', clickCount: 130 },
            { href: 'https://substack.com/therundown', text: 'The Rundown AI Newsletter', clickCount: 60 },
        ],
        createdDaysAgo: 2,
        viewCount: 720,
        shareCount: 42,
        grabs: 30,
        specialty: 'medium.com',
    },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const uri    = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB || 'grabbn';

    if (!uri) {
        console.error('MONGODB_URI is not set. Run with --env-file=.env or set the variable.');
        process.exit(1);
    }

    await mongoose.connect(uri, { dbName });
    console.log(`[seed] Connected to MongoDB (${dbName})`);

    // ── Wipe mode ─────────────────────────────────────────────────────────────
    if (process.env.SEED_WIPE === 'true') {
        console.log('[seed] SEED_WIPE=true — clearing existing seed data…');
        await Bucket.deleteMany({ 'links.0': { $exists: true } });
        await User.deleteMany({ email: { $regex: '@seed.local$' } });
        await LinkClick.deleteMany({});
        await TopicScore.deleteMany({});
        await Subscription.deleteMany({});
        console.log('[seed] Cleared.');
    }

    // ── Create curators ───────────────────────────────────────────────────────
    console.log('[seed] Creating curator accounts…');
    const hashedPassword = await bcrypt.hash('Seed1234!', 10);

    const userDocs = await Promise.all(
        CURATORS.map(c =>
            User.findOneAndUpdate(
                { email: c.email },
                {
                    $setOnInsert: {
                        anonymousId: randomUUID(),
                        isAnonymous: false,
                        email: c.email,
                        username: c.username,
                        password: hashedPassword,
                        avatar: c.avatar,
                        createdAt: new Date(),
                        lastActive: new Date(),
                    }
                },
                { upsert: true, new: true }
            )
        )
    );

    const userMap = {};
    for (const u of userDocs) userMap[u.username] = u;
    console.log(`[seed] ${userDocs.length} curators ready.`);

    // ── Create subscriptions (each curator follows 3 random others) ───────────
    console.log('[seed] Creating follow relationships…');
    for (const curator of userDocs) {
        const others = userDocs.filter(u => !u._id.equals(curator._id));
        const toFollow = pickN(others, 3);
        for (const target of toFollow) {
            await Subscription.findOneAndUpdate(
                { followerId: curator._id, followeeId: target._id },
                { followerId: curator._id, followeeId: target._id },
                { upsert: true }
            );
        }
    }
    console.log('[seed] Subscriptions created.');

    // ── Create buckets ────────────────────────────────────────────────────────
    console.log('[seed] Creating buckets…');
    const allBuckets = [];

    for (const def of BUCKET_CATALOG) {
        // Assign to the curator whose specialty matches, or a random one.
        const matchingCurators = userDocs.filter(u => {
            const c = CURATORS.find(c => c.username === u.username);
            return c?.specialty === def.specialty;
        });
        const owner = matchingCurators.length ? pick(matchingCurators) : pick(userDocs);

        // Build grab list from random users (excluding owner).
        const potentialGrabbers = userDocs.filter(u => !u._id.equals(owner._id));
        const grabbers = pickN(potentialGrabbers, Math.min(def.grabs, potentialGrabbers.length));

        const links = def.links.map(l => ({
            href: l.href,
            text: l.text,
            clickCount: l.clickCount ?? 0,
            isPinned: l.isPinned ?? false,
            isFree: true,
            addedAt: new Date(),
        }));

        const existingBucket = await Bucket.findOne({ userId: owner._id, name: def.name });
        if (existingBucket) {
            allBuckets.push(existingBucket);
            continue;
        }

        const bucket = await Bucket.create({
            userId: owner._id,
            name: def.name,
            description: def.description,
            hashtags: def.hashtags,
            sourceUrl: def.sourceUrl,
            links,
            visibility: 'public',
            isPublic: true,
            isDraft: false,
            viewCount: def.viewCount,
            shareCount: def.shareCount,
            grabbedBy: grabbers.map(u => ({
                userId: u._id,
                username: u.username,
                avatar: u.avatar || null,
            })),
            createdAt: daysAgo(def.createdDaysAgo),
            updatedAt: daysAgo(Math.max(0, def.createdDaysAgo - randInt(0, 3))),
        });

        allBuckets.push(bucket);
    }

    console.log(`[seed] ${allBuckets.length} buckets created.`);

    // ── Create link clicks ─────────────────────────────────────────────────────
    console.log('[seed] Inserting link click events…');
    const clickDocs = [];

    for (const bucket of allBuckets) {
        for (const link of bucket.links) {
            if (!link.clickCount) continue;

            let domain;
            try { domain = new URL(link.href).hostname.replace(/^www\./, ''); }
            catch { continue; }

            // Spread clicks across random users & time periods.
            const numEvents = Math.min(link.clickCount, 20); // cap per link to avoid bulk
            for (let i = 0; i < numEvents; i++) {
                clickDocs.push({
                    href: link.href,
                    domain,
                    bucketId: bucket._id,
                    userId: Math.random() > 0.4 ? pick(userDocs)._id : null,
                    createdAt: daysAgo(randInt(0, 60)),
                });
            }
        }
    }

    if (clickDocs.length) {
        await LinkClick.insertMany(clickDocs, { ordered: false });
    }
    console.log(`[seed] ${clickDocs.length} link click events inserted.`);

    // ── Compute explore scores & topic scores ─────────────────────────────────
    console.log('[seed] Running buildExploreScores…');
    await buildExploreScores();

    console.log('[seed] Done. Your explore & showroom feeds are ready to test.');
    await mongoose.disconnect();
}

main().catch(err => {
    console.error('[seed] Fatal error:', err);
    process.exit(1);
});
