/**
 * Tests for the plugin's data layer, driven by fixtures of the real pages.
 *
 * Run: node tools/test-dataset.mjs
 *
 * The fixtures are saved copies of the live sources; they pin the parser to the
 * page shapes it was written against and let the corruption cases below prove
 * that a changed page is rejected rather than misread.
 */
import { readFileSync } from 'node:fs';
import {
  parseChineseDaysYear,
  parseHolidayYear,
  parsePricingPage,
  refresh,
  validateDataset,
  beijingYear,
  htmlToText,
  findSentence,
  extractWindows,
} from '../data.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const zhHtml = fixture('zh-pricing.html');
const enHtml = fixture('en-pricing.html');
const holiday2026 = JSON.parse(fixture('holiday-2026.json'));
/** A year the CDN answers with HTTP 200 and empty arrays for. Synthesized rather
 *  than stored, so publishing the next year cannot turn this into a stale file. */
const unpublishedStub = { year: 2027, papers: [], days: [] };
const chineseDays2026 = JSON.parse(fixture('chinese-days-2026.json'));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      actual   ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`);
}
function ok(label, condition) {
  check(label, Boolean(condition), true);
}

console.log('--- Chinese pricing page ---');
const zh = parsePricingPage(zhHtml, 'zh');
ok('zh rule parsed', zh !== null);
check('zh peak windows (Beijing minutes)', zh.peakWindows, [[540, 720], [840, 1080]]);
check('zh peak weekdays', zh.peakWeekdays, [1, 2, 3, 4, 5]);
check('zh off-peak ratio', zh.offPeakRatio, 0.5);
check('zh holiday exemption', zh.holidayExempt, true);
check('zh currency', zh.currency, 'CNY');
check('zh models', zh.models, [
  { name: 'deepseek-flash', cacheHit: [0.04, 0.02], cacheMiss: [2, 1], output: [8, 4] },
  { name: 'deepseek-v4-pro', cacheHit: [0.3, 0.15], cacheMiss: [9, 4.5], output: [27, 13.5] },
]);

console.log('--- English pricing page ---');
const en = parsePricingPage(enHtml, 'en');
ok('en rule parsed', en !== null);
check('en windows converted from UTC match zh', en.peakWindows, [[540, 720], [840, 1080]]);
check('en windows as stated (UTC minutes)', en.peakWindowsAsStated, [[60, 240], [360, 600]]);
check('en peak weekdays', en.peakWeekdays, [1, 2, 3, 4, 5]);
check('en off-peak ratio', en.offPeakRatio, 0.5);
check('en number of models', en.models.length, 2);
check('en flash output (USD)', en.models[0].output, [1.2, 0.6]);
check('en v4-pro cache miss (USD)', en.models[1].cacheMiss, [1.32, 0.66]);
ok('zh and en agree on the windows', JSON.stringify(zh.peakWindows) === JSON.stringify(en.peakWindows));

console.log('--- holiday payloads ---');
const parsed2026 = parseHolidayYear(holiday2026, 2026);
ok('2026 parsed', parsed2026 !== null);
check('2026 off-day count', Object.values(parsed2026.days).filter((day) => day.off).length, 33);
check('2026-10-01 off', parsed2026.days['2026-10-01'], { n: '国庆节', off: true });
check('2026-10-07 off', parsed2026.days['2026-10-07'].off, true);
check('2026-10-10 make-up workday', parsed2026.days['2026-10-10'], { n: '国庆节', off: false });
check('2026-09-20 make-up workday', parsed2026.days['2026-09-20'], { n: '国庆节', off: false });
check('2026-02-14 make-up workday', parsed2026.days['2026-02-14'], { n: '春节', off: false });
check('2026 cites the State Council notice', parsed2026.papers, ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm']);
check('an unpublished year (200 + empty arrays) is "no data", not "no holidays"', parseHolidayYear(unpublishedStub, 2027), null);
check('year mismatch rejected', parseHolidayYear(holiday2026, 2027), null);
check('garbage rejected', parseHolidayYear({ year: 2026, days: [{ date: 'nope', isOffDay: true }] }, 2026), null);
check('empty days rejected', parseHolidayYear({ year: 2026, days: [] }, 2026), null);
check('null rejected', parseHolidayYear(null, 2026), null);
// A truncated response must not read as a year with almost no holidays.
check(
  'a stub year below the plausibility floor is rejected',
  parseHolidayYear({ year: 2026, days: [{ date: '2026-01-01', name: '元旦', isOffDay: true }] }, 2026),
  null,
);
check(
  'a year of only workdays is rejected',
  parseHolidayYear(
    { year: 2026, days: Array.from({ length: 25 }, (unused, index) => ({ date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`, name: 'x', isOffDay: false })) },
    2026,
  ),
  null,
);

console.log('--- independent dataset (chinese-days) ---');
const independent = parseChineseDaysYear(chineseDays2026, 2026);
ok('chinese-days 2026 parsed', independent !== null);
check('chinese-days off-day count', independent.offDays, 33);
check('chinese-days 2026-10-01', independent.days['2026-10-01'], { n: '国庆节', off: true });
check('chinese-days imports a make-up workday', independent.days['2026-10-10'], { n: '国庆节', off: false });
check('chinese-days has no provenance links', independent.papers, []);
check('chinese-days rejects a foreign year', parseChineseDaysYear(chineseDays2026, 2027), null);
check('chinese-days rejects a stub', parseChineseDaysYear({ holidays: { '2026-01-01': 'x,y,1' } }, 2026), null);
// The two datasets are independent implementations; agreeing is the point.
const cnOff = Object.entries(parseHolidayYear(holiday2026, 2026).days)
  .filter(([, entry]) => entry.off)
  .map(([date]) => date)
  .sort();
const cdOff = Object.entries(independent.days)
  .filter(([, entry]) => entry.off)
  .map(([date]) => date)
  .sort();
check('the two independent datasets agree on every 2026 off-day', cnOff, cdOff);
check('2026 off-day total', cnOff.length, 33);

console.log('--- helper behaviour ---');
check('htmlToText strips markup', htmlToText('<p>a<br>b</p>').replace(/\s+/g, ' '), 'a b');
check('htmlToText drops scripts', htmlToText('<script>x=1</script>hi'), 'hi');
check('extractWindows ignores reversed ranges', extractWindows('10:00 - 09:00'), []);
check('extractWindows reads both separators', extractWindows('9:00 - 12:00、14:00 - 18:00'), [[540, 720], [840, 1080]]);
ok('findSentence needs every needle', findSentence('a。b。', ['a', 'c']) === null);
check('beijingYear at the New Year boundary (UTC 2026-12-31T16:30Z)', beijingYear(Date.parse('2026-12-31T16:30:00Z')), 2027);

console.log('--- rejection of drifted pages ---');
check('unrelated html rejected', parsePricingPage('<html><body><p>nothing here</p></body></html>', 'zh'), null);
check('empty html rejected', parsePricingPage('', 'zh'), null);
// A page that keeps the rule but loses one window must not silently drop it.
const oneWindow = zhHtml.replace('9:00 - 12:00、14:00 - 18:00 为高峰时段', '9:00 - 12:00 为高峰时段');
check('single-window rule rejected', parsePricingPage(oneWindow, 'zh'), null);
// A rate table whose off-peak column is no longer half its peak column.
const badRates = zhHtml.replaceAll('0.04元', '0.05元');
const badRule = parsePricingPage(badRates, 'zh');
ok('non-half rate table drops the models but keeps the rule', badRule !== null && badRule.models === null);
check('rule survives an unreadable rate table', badRule === null ? null : badRule.peakWindows, [[540, 720], [840, 1080]]);
// Reading the two period columns in the wrong order must not pass validation.
const swapped = zhHtml
  .replace('0.02元', 'TMP_OFF')
  .replace('0.04元', '0.02元')
  .replace('TMP_OFF', '0.04元');
check('swapped peak/off-peak columns rejected', parsePricingPage(swapped, 'zh').models, null);

console.log('--- refresh orchestration ---');
const okTransport = (map) => async (url) => {
  if (map[url] === undefined) throw new Error('offline');
  return map[url];
};
const holidayUrl = (year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`;
const fastlyUrl = (year) => `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`;
const staticallyUrl = (year) => `https://cdn.statically.io/gh/NateScarlet/holiday-cn/master/${year}.json`;
const rawUrl = (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
const chineseDaysUrl = (year) => `https://cdn.jsdelivr.net/npm/chinese-days/dist/years/${year}.json`;
const now = Date.parse('2026-10-02T09:46:00Z');
const fullMap = {
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing': zhHtml,
  'https://api-docs.deepseek.com/quick_start/pricing': enHtml,
  [holidayUrl(2026)]: fixture('holiday-2026.json'),
  [chineseDaysUrl(2026)]: fixture('chinese-days-2026.json'),
  [holidayUrl(2027)]: JSON.stringify(unpublishedStub),
};

const happy = await refresh({ fetchText: okTransport(fullMap), now });
ok('happy path dataset is valid', validateDataset(happy.dataset).ok);
check('happy path cross-checked', happy.dataset.rule.crossChecked, true);
check('happy path windows', happy.dataset.rule.peakWindows, [[540, 720], [840, 1080]]);
check('happy path holiday years', happy.dataset.holidays.years, [2026]);
check('happy path holiday source', happy.dataset.holidays.source, 'holiday-cn@jsdelivr');
check('happy path holiday primary source list', happy.dataset.holidays.sources, ['holiday-cn@jsdelivr']);
check('happy path holidays cross-checked against the independent dataset', happy.dataset.holidays.crossChecked, true);
check('happy path cross-check record', happy.dataset.holidays.crossChecks[2026], {
  agreed: true,
  sources: ['holiday-cn@jsdelivr', 'chinese-days@jsdelivr'],
  primaryOffDays: 33,
  independentOffDays: 33,
});
ok('happy path notes mention only the unpublished year', happy.notes.length > 0 && happy.notes.every((note) => note.includes('2027')));

const offline = await refresh({ fetchText: async () => { throw new Error('offline'); }, now });
check('offline with no previous rule', offline.dataset.rule, null);
check('offline with no previous holidays', offline.dataset.holidays, null);
ok('offline records fetch failures', offline.notes.filter((note) => note.startsWith('fetch failed')).length >= 4);

const carried = await refresh({ fetchText: async () => { throw new Error('offline'); }, previous: happy.dataset, now: now + 86400000 });
check('offline keeps the previous rule', carried.dataset.rule.peakWindows, [[540, 720], [840, 1080]]);
check('offline keeps the previous holiday table', carried.dataset.holidays.days['2026-10-01'], { n: '国庆节', off: true });
check('offline marks the holiday table stale', carried.dataset.holidays.stale, true);

const enOnly = { ...fullMap };
delete enOnly['https://api-docs.deepseek.com/zh-cn/quick_start/pricing'];
const enOnlyResult = await refresh({ fetchText: okTransport(enOnly), now });
check('english-only rule still lands on Beijing windows', enOnlyResult.dataset.rule.peakWindows, [[540, 720], [840, 1080]]);
check('english-only rule is flagged un-cross-checked', enOnlyResult.dataset.rule.crossChecked, false);
check('english-only rule reports USD', enOnlyResult.dataset.rule.currency, 'USD');

const disagreeing = { ...fullMap, 'https://api-docs.deepseek.com/quick_start/pricing': enHtml.replace('01:00 - 04:00', '02:00 - 04:00') };
const disagreed = await refresh({ fetchText: okTransport(disagreeing), previous: happy.dataset, now });
check('zh/en disagreement keeps the previous rule', disagreed.dataset.rule.peakWindows, [[540, 720], [840, 1080]]);
check('zh/en disagreement is flagged', disagreed.dataset.rule.crossChecked, false);
ok('zh/en disagreement is recorded', disagreed.notes.some((note) => note.includes('disagree')));

// A rate table and the currency it is published in always come from one page.
const zhTableBroken = {
  ...fullMap,
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing': zhHtml.replaceAll('0.04元', '0.05元'),
};
const borrowed = await refresh({ fetchText: okTransport(zhTableBroken), now });
check('borrowing the en table also borrows its currency', borrowed.dataset.rule.currency, 'USD');
check('the borrowed table really is the en one', borrowed.dataset.rule.models[0].output, [1.2, 0.6]);
check('the rule itself still comes from the zh page', borrowed.dataset.rule.peakWindows, [[540, 720], [840, 1080]]);
check('the windows still cross-check', borrowed.dataset.rule.crossChecked, true);
ok('the borrow is recorded', borrowed.notes.some((note) => note.includes('en table')));

// The weekday range is compared element by element, not by length.
const weekdayMismatch = await refresh({
  fetchText: okTransport({
    ...fullMap,
    'https://api-docs.deepseek.com/quick_start/pricing': enHtml.replace('Monday through Friday', 'Monday through Sunday'),
  }),
  previous: happy.dataset,
  now,
});
check('a weekday mismatch keeps the previous rule', weekdayMismatch.dataset.rule.peakWeekdays, [1, 2, 3, 4, 5]);
check('a weekday mismatch is flagged', weekdayMismatch.dataset.rule.crossChecked, false);
ok('a weekday mismatch is noted', weekdayMismatch.notes.some((note) => note.includes('peak days')));

const githubFallback = {
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing': zhHtml,
  'https://api-docs.deepseek.com/quick_start/pricing': enHtml,
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json': fixture('holiday-2026.json'),
};
const fallbackResult = await refresh({ fetchText: okTransport(githubFallback), now });
check('holiday mirror fallback used', fallbackResult.dataset.holidays.source, 'holiday-cn@github-raw');
check('fallback still covers 2026', fallbackResult.dataset.holidays.years, [2026]);
check('fallback with no independent dataset reports an unknown cross-check', fallbackResult.dataset.holidays.crossChecked, null);

// A mirror edge whose cache expired first is what picks up a fresh year.
const fastlyFirst = {
  ...fullMap,
  [holidayUrl(2026)]: JSON.stringify(unpublishedStub),
  [fastlyUrl(2026)]: fixture('holiday-2026.json'),
};
const fastlyResult = await refresh({ fetchText: okTransport(fastlyFirst), now });
check('a stale edge falls through to the next mirror', fastlyResult.dataset.holidays.source, 'holiday-cn@fastly');
check('the fallback mirror covers the year', fastlyResult.dataset.holidays.years, [2026]);
check('the fallback mirror still cross-checks', fastlyResult.dataset.holidays.crossChecked, true);

// The two datasets are independent, so a disagreement must be visible.
const rolled = JSON.parse(fixture('chinese-days-2026.json'));
delete rolled.holidays['2026-10-05'];
const disagreeingHolidays = { ...fullMap, [chineseDaysUrl(2026)]: JSON.stringify(rolled) };
const holidayDisagreement = await refresh({ fetchText: okTransport(disagreeingHolidays), now });
check('holiday disagreement keeps the primary dataset', holidayDisagreement.dataset.holidays.days['2026-10-05'], { n: '国庆节', off: true });
check('holiday disagreement is flagged', holidayDisagreement.dataset.holidays.crossChecked, false);
check('holiday disagreement is recorded per year', holidayDisagreement.dataset.holidays.crossChecks[2026].agreed, false);
ok(
  'holiday disagreement is noted',
  holidayDisagreement.notes.some((note) => note.includes('independent holiday datasets disagree')),
);
check('the primary source still serves the days', holidayDisagreement.dataset.holidays.source, 'holiday-cn@jsdelivr');

// Both jsDelivr edges down and the independent dataset unreachable: the third
// CDN still serves the year.
const staticallyFallback = {
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing': zhHtml,
  'https://api-docs.deepseek.com/quick_start/pricing': enHtml,
  [staticallyUrl(2026)]: fixture('holiday-2026.json'),
};
const staticallyResult = await refresh({ fetchText: okTransport(staticallyFallback), now });
check('the third CDN mirror also works', staticallyResult.dataset.holidays.source, 'holiday-cn@statically');
check('survives both jsDelivr edges being down', staticallyResult.dataset.holidays.years, [2026]);
void rawUrl;
// A throwing parser must not escape the refresh.
const throwingTransport = async (url) => (url.includes('api-docs') ? 'x'.repeat(10) : JSON.stringify(holiday2026));
const guarded = await refresh({ fetchText: throwingTransport, now });
ok('unparseable pages do not throw out of refresh', guarded.dataset.rule === null);

console.log('--- dataset validation ---');
ok('valid dataset accepted', validateDataset(happy.dataset).ok);
ok('null dataset rejected', validateDataset(null).ok === false);
ok('wrong schema rejected', validateDataset({ schema: 99 }).ok === false);
ok('rule without windows rejected', validateDataset({ schema: 1, rule: { peakWindows: [], peakWeekdays: [1], offPeakRatio: 0.5 } }).ok === false);
ok('bad ratio rejected', validateDataset({ schema: 1, rule: { peakWindows: [[1, 2]], peakWeekdays: [1], offPeakRatio: 2 } }).ok === false);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
