// The category list in public/data/categories.json, read once at startup.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const _categoriesJson  = JSON.parse(readFileSync(path.join(__dirname, '../public/data/categories.json'), 'utf8'));

