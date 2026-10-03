/**
 * Tests for the plugin's browser half.
 *
 * Run: node tools/test-client.mjs
 *
 * The dependency-free region of `client.js` is lifted out and evaluated, so the
 * billing-window math and the live-over-snapshot merge are exercised as they
 * ship rather than as a copy. Nothing React- or DOM-shaped is emulated.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf("const NS = 'dsh-deepseek-status-pricing';");
const end = source.indexOf('* Translation', start);
if (start < 0 || end < 0) throw new Error('cannot locate the extractable region');
const region = source.slice(start, source.lastIndexOf('/*', end));

const api = new Function(
  `${region}\nreturn { SNAPSHOT, viewOf, statusAt, nextSwitch, beijingParts, etaText, holidayRun, yearsLabel, expandRanges, validRule, localizeHolidayName, HOLIDAY_NAMES_EN };`,
)();

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      actual   ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`);
}
function ok(label, condition) {
  check(label, Boolean(condition), true);
}

/** Beijing wall clock -> instant. */
const bj = (text) => Date.parse(`${text}:00+08:00`);
const utc = (ms) => new Date(ms).toISOString();

const snapshotView = { rule: api.SNAPSHOT.rule, days: api.SNAPSHOT.holidays.days };

console.log('--- built-in snapshot ---');
check('snapshot windows', api.SNAPSHOT.rule.peakWindows, [[540, 720], [840, 1080]]);
check('snapshot weekdays', api.SNAPSHOT.rule.peakWeekdays, [1, 2, 3, 4, 5]);
check('snapshot holiday day count', Object.keys(api.SNAPSHOT.holidays.days).length, 33);
check('snapshot 2026-10-01', api.SNAPSHOT.holidays.days['2026-10-01'], { n: '国庆节', off: true });
check('snapshot has no make-up workday entries (weekends cover them)', api.SNAPSHOT.holidays.days['2026-10-10'], undefined);

console.log('--- window boundaries (snapshot) ---');
const peak = (text) => api.statusAt(bj(text), snapshotView).peak;
check('2026-10-13 08:59 Tue', peak('2026-10-13T08:59'), false);
check('2026-10-13 09:00 Tue', peak('2026-10-13T09:00'), true);
check('2026-10-13 11:59 Tue', peak('2026-10-13T11:59'), true);
check('2026-10-13 12:00 Tue', peak('2026-10-13T12:00'), false);
check('2026-10-13 13:59 Tue', peak('2026-10-13T13:59'), false);
check('2026-10-13 14:00 Tue', peak('2026-10-13T14:00'), true);
check('2026-10-13 17:59 Tue', peak('2026-10-13T17:59'), true);
check('2026-10-13 18:00 Tue', peak('2026-10-13T18:00'), false);
check('2026-10-13 23:30 Tue', peak('2026-10-13T23:30'), false);
check('2026-10-10 10:00 Sat (make-up workday)', peak('2026-10-10T10:00'), false);
check('2026-10-11 10:00 Sun', peak('2026-10-11T10:00'), false);
check('2026-10-02 17:46 Fri (National Day)', peak('2026-10-02T17:46'), false);
check('2026-10-05 10:00 Mon (National Day)', peak('2026-10-05T10:00'), false);
check('2026-09-25 10:00 Fri (Mid-Autumn)', peak('2026-09-25T10:00'), false);
check('2026-02-18 10:00 Wed (Spring Festival)', peak('2026-02-18T10:00'), false);
check('2026-01-02 10:00 Fri (New Year)', peak('2026-01-02T10:00'), false);
check('2026-05-04 10:00 Mon (Labour Day)', peak('2026-05-04T10:00'), false);
check('2026-04-06 10:00 Mon (Qingming)', peak('2026-04-06T10:00'), false);
check('2026-06-19 10:00 Fri (Dragon Boat)', peak('2026-06-19T10:00'), false);
check('status kind for a holiday', api.statusAt(bj('2026-10-02T10:00'), snapshotView).kind, 'holiday');
check('status kind for a weekend', api.statusAt(bj('2026-10-10T10:00'), snapshotView).kind, 'weekend');
check('status kind inside a window', api.statusAt(bj('2026-10-13T10:00'), snapshotView).kind, 'peakWindow');

console.log('--- next switch (snapshot) ---');
check('from 2026-10-02 (Beijing 10-08 09:00)', utc(api.nextSwitch(bj('2026-10-02T17:46'), snapshotView).at), '2026-10-08T01:00:00.000Z');
check('from 2026-02-13 (11-day Spring Festival gap)', utc(api.nextSwitch(bj('2026-02-13T18:30'), snapshotView).at), '2026-02-24T01:00:00.000Z');
check('from inside a peak window', utc(api.nextSwitch(bj('2026-10-13T10:00'), snapshotView).at), '2026-10-13T04:00:00.000Z');
check('from Friday evening', utc(api.nextSwitch(bj('2026-10-16T20:00'), snapshotView).at), '2026-10-19T01:00:00.000Z');
check('switch direction out of peak', api.nextSwitch(bj('2026-10-13T10:00'), snapshotView).toPeak, false);
check('switch direction into peak', api.nextSwitch(bj('2026-10-13T18:30'), snapshotView).toPeak, true);

console.log('--- holiday run expansion ---');
check(
  'National Day run',
  api.holidayRun(api.SNAPSHOT.holidays.days, '2026-10-02', '国庆节'),
  ['2026-10-01', '2026-10-07'],
);
check(
  'Spring Festival run',
  api.holidayRun(api.SNAPSHOT.holidays.days, '2026-02-20', '春节'),
  ['2026-02-15', '2026-02-23'],
);
check('a single-day run', api.holidayRun({ '2026-03-03': { n: 'x', off: true } }, '2026-03-03', 'x'), ['2026-03-03', '2026-03-03']);

console.log('--- live-over-snapshot merge ---');
const cold = api.viewOf(null);
check('no live data: rule is the snapshot', cold.rule === api.SNAPSHOT.rule, true);
check('no live data: ruleLive', cold.ruleLive, false);
check('no live data: holidaysLive', cold.holidaysLive, false);
check('no live data: years', cold.holidayYears, [2026]);

const liveRule = {
  peakWindows: [[600, 660]],
  peakWeekdays: [1, 2, 3, 4, 5],
  offPeakRatio: 0.5,
  holidayExempt: true,
  currency: 'CNY',
  models: [{ name: 'live-model', cacheHit: [1, 0.5], cacheMiss: [2, 1], output: [4, 2] }],
  fetchedAt: '2026-10-02T10:00:00.000Z',
  crossChecked: true,
};
const liveView = api.viewOf({
  schema: 1,
  generatedAt: '2026-10-02T10:00:00.000Z',
  rule: liveRule,
  holidays: { days: { '2026-10-01': { n: '国庆节', off: true } }, years: [2026], source: 'holiday-cn@jsdelivr' },
});
check('live rule wins outright', liveView.rule === liveRule, true);
check('live rule drives the windows (10:30 peak)', api.statusAt(bj('2026-10-13T10:30'), liveView).peak, true);
check('live rule drives the windows (09:30 off)', api.statusAt(bj('2026-10-13T09:30'), liveView).peak, false);
check('live rule drives the rate table', liveView.rule.models[0].name, 'live-model');
check('live holidays win for a covered year', api.statusAt(bj('2026-10-01T10:30'), liveView).kind, 'holiday');
check('a covered year is not mixed with snapshot days', Object.keys(liveView.days).filter((date) => date.startsWith('2026')).length, 1);
check('live rule marked live', liveView.ruleLive, true);
check('live rule marked cross-checked', liveView.ruleUnchecked, false);
check('live holidays marked live', liveView.holidaysLive, true);
check('live holiday source shown', liveView.holidaysSource, 'holiday-cn@jsdelivr');
check('fetched stamp carried', liveView.ruleFetchedAt, '2026-10-02T10:00:00.000Z');

const futureOnly = api.viewOf({
  schema: 1,
  rule: liveRule,
  holidays: { days: { '2027-01-01': { n: '元旦', off: true } }, years: [2027], source: 'holiday-cn@jsdelivr' },
});
check('a year the live data does not cover keeps the snapshot days', futureOnly.holidayYears, [2026, 2027]);
check('2027 day present', futureOnly.days['2027-01-01'], { n: '元旦', off: true });
check('2026 day kept', futureOnly.days['2026-10-02'], { n: '国庆节', off: true });
check(
  'uncovered-year warning would fire for 2028',
  futureOnly.holidayYears.indexOf(2028) === -1,
  true,
);

const staleView = api.viewOf({
  schema: 1,
  rule: liveRule,
  holidays: { days: { '2026-10-01': { n: '国庆节', off: true } }, years: [2026], stale: true },
});
check('stale holiday data is flagged', staleView.holidaysStale, true);

const partialView = api.viewOf({ schema: 1, rule: null, holidays: null });
check('a dataset with neither part falls back to the snapshot', partialView.rule === api.SNAPSHOT.rule, true);
check('a dataset with neither part reports both as not live', [partialView.ruleLive, partialView.holidaysLive], [false, false]);

const badRuleView = api.viewOf({ schema: 1, rule: { peakWindows: [] }, holidays: null });
check('a structurally invalid live rule is refused', badRuleView.rule === api.SNAPSHOT.rule, true);

console.log('--- labels ---');
check('years 2026-2027 collapse', api.yearsLabel([2026, 2027]), '2026–2027');
check('non-contiguous years listed', api.yearsLabel([2026, 2028]), '2026、2028');
check('single year', api.yearsLabel([2027]), '2027');
check('no years', api.yearsLabel([]), '—');
const t = (key, params) =>
  params === undefined ? key : `${key}:${Object.keys(params).map((name) => `${name}=${params[name]}`).join(',')}`;
check('eta 5d15h', api.etaText(t, ((5 * 24 + 15) * 3600 + 30) * 1000), 'etaDayHour:d=5,h=15');
check('eta 2h13m', api.etaText(t, (2 * 3600 + 13 * 60) * 1000), 'etaHourMin:h=2,m=13');
check('eta 45s', api.etaText(t, 45 * 1000), 'etaSoon');
check('Beijing weekday of 2026-10-02', api.beijingParts(bj('2026-10-02T17:46')).day, 5);
check('Beijing year rolls at UTC 16:00', api.beijingParts(Date.parse('2026-12-31T16:30:00Z')).y, 2027);

console.log('--- holiday names ---');
check('an English reader gets a translation', api.localizeHolidayName('国庆节', 'en'), 'National Day');
check('a Chinese reader keeps the published name', api.localizeHolidayName('国庆节', 'zh'), '国庆节');
check('all seven statutory holidays are covered', Object.keys(api.HOLIDAY_NAMES_EN).length, 7);
check('an unknown name is kept as-is', api.localizeHolidayName('某节日', 'en'), '某节日');
check('an empty name survives', api.localizeHolidayName('', 'en'), '');
ok(
  'every holiday name in the built-in snapshot has an English form',
  Array.from(new Set(Object.values(api.SNAPSHOT.holidays.days).map((day) => day.n))).every(
    (name) => name === '' || api.localizeHolidayName(name, 'en') !== name,
  ),
);

console.log('--- range expansion used by the snapshot ---');
check(
  'range expansion',
  api.expandRanges([['2027-01-01', '2027-01-03', '元旦']]),
  { '2027-01-01': { n: '元旦', off: true }, '2027-01-02': { n: '元旦', off: true }, '2027-01-03': { n: '元旦', off: true } },
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
