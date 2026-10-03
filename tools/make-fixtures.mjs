/**
 * Regenerate the abridged parser fixtures in `tools/fixtures/`.
 *
 * Run: node tools/make-fixtures.mjs
 *
 * The pricing fixtures are NOT copies of the documentation pages. Each one is
 * rebuilt from the live page into the smallest document that still exercises
 * the parser: the pricing table plus the footnote paragraph that states the
 * rule. Keeping them abridged keeps the repository free of a wholesale copy of
 * someone else's page, and regenerating from the live source is how a
 * maintainer re-pins the tests after a page redesign.
 *
 * The holiday fixtures are the published holiday datasets themselves, kept
 * verbatim because they are small, MIT-licensed, and the parsers are written
 * against their exact shape.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { htmlToText } from '../data.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

const PRICING = [
  {
    lang: 'zh',
    url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    file: 'zh-pricing.html',
    tableAnchor: '缓存命中',
    footnote: /<p>\(2\)[\s\S]*?<\/p>/i,
  },
  {
    lang: 'en',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    file: 'en-pricing.html',
    tableAnchor: 'CACHE HIT',
    footnote: /<p>\(2\)[\s\S]*?<\/p>/i,
  },
];

const HOLIDAYS = [
  {
    url: 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json',
    file: 'holiday-2026.json',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/chinese-days/dist/years/2026.json',
    file: 'chinese-days-2026.json',
  },
];

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return await response.text();
}

await mkdir(fixtures, { recursive: true });

for (const source of PRICING) {
  const html = await get(source.url);
  const table = (html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? []).find((candidate) =>
    candidate.toUpperCase().includes(source.tableAnchor.toUpperCase()),
  );
  const footnote = source.footnote.exec(html);
  if (table === undefined || footnote === null) {
    throw new Error(`fixture extraction failed for ${source.url}; the page shape changed`);
  }
  const abridged = [
    '<!doctype html>',
    `<html lang="${source.lang}">`,
    '<head><meta charset="utf-8">',
    `<title>Abridged test fixture extracted from ${source.url}</title></head>`,
    '<body>',
    `<div><b>${table}</b></div>`,
    `<div style="font-size:14px">${footnote[0]}</div>`,
    '</body></html>',
    '',
  ].join('\n');
  await writeFile(join(fixtures, source.file), abridged, 'utf8');
  console.log(`wrote ${source.file}  (${abridged.length} bytes; rule text reads: ${htmlToText(footnote[0]).slice(0, 60)}…)`);
}

for (const source of HOLIDAYS) {
  const body = await get(source.url);
  const parsed = JSON.parse(body);
  await writeFile(join(fixtures, source.file), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  console.log(`wrote ${source.file}  (${body.length} bytes)`);
}

console.log('\nFixtures regenerated. Re-run the suites before committing:');
console.log('  node tools/test-dataset.mjs && node tools/test-client.mjs && node tools/test-host.mjs');
