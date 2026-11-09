import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const locales = {};
for (const lang of ['en', 'fr']) {
  locales[lang] = JSON.parse(
    readFileSync(join(__dirname, '../config/locales', `${lang}.json`), 'utf8')
  );
}

export function translate(lang, key) {
  const locale = locales[lang] || locales.en;
  return locale[key] ?? locales.en[key] ?? key;
}
