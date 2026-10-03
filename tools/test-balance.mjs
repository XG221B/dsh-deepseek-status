/**
 * Tests for the browser half's dependency-free logic.
 *
 * Run: node tools/test-client.mjs
 *
 * The pure region of `client.js` is lifted out and evaluated, so the amount
 * formatting, the wallet grouping, and the mapping from the account Remote's
 * answer onto display state are exercised exactly as they ship. Nothing React-
 * or DOM-shaped is emulated, and no live account data is involved.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf("const NS = 'dsh-deepseek-status-balance';");
const end = source.indexOf('* Translation', start);
if (start < 0 || end < 0) throw new Error('cannot locate the extractable region');
const region = source.slice(start, source.lastIndexOf('/*', end));

const api = new Function(
  `${region}\nreturn { formatAmount, currencySymbol, toCents, fromCents, groupWallets, singleCurrencyTotal, visibleBonusWallets, availableWallets, badgeAmountText, mapBalance, POLL_MS, CLIENT_VERSION };`,
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

console.log('--- amount formatting (Platform Web convention) ---');
check('whole number gains two decimals', api.formatAmount('110'), '110.00');
check('cents are kept', api.formatAmount('9.99'), '9.99');
check('four digits are grouped', api.formatAmount('1234.5'), '1,234.50');
check('millions are grouped', api.formatAmount('1234567.89'), '1,234,567.89');
check('long decimals truncate, never round up', api.formatAmount('1.999'), '1.99');
check('positive sub-cent is shown as <0.01', api.formatAmount('0.004'), '<0.01');
check('zero', api.formatAmount('0'), '0.00');
check('explicit zero', api.formatAmount('0.00'), '0.00');
check('negative zero loses its sign', api.formatAmount('-0.00'), '0.00');
check('negative sub-cent keeps a visible magnitude', api.formatAmount('-0.004'), '-0.01');
check('negative amounts are grouped too', api.formatAmount('-1234.56'), '-1,234.56');
check('an unparsable string is shown as-is', api.formatAmount('n/a'), 'n/a');
check('an empty string is shown as-is', api.formatAmount(''), '');
check('a leading plus is accepted', api.formatAmount('+5'), '5.00');

console.log('--- currency symbols ---');
check('CNY', api.currencySymbol('CNY'), '¥');
check('USD', api.currencySymbol('USD'), '$');
check('an unknown currency keeps its code', api.currencySymbol('EUR'), 'EUR ');
check('an empty currency adds nothing', api.currencySymbol(''), '');

console.log('--- cents helpers ---');
check('cents from a string', api.toCents('1.25'), 125);
check('negative cents', api.toCents('-1.25'), -125);
check('cents round-trip', api.fromCents(125), '1.25');
check('cents from a malformed string', api.toCents('x'), 0);

console.log('--- wallet grouping ---');
const wallets = [
  { currency: 'CNY', balance: '100.00' },
  { currency: 'CNY', balance: '10.50' },
  { currency: 'USD', balance: '2.00' },
];
check('two currencies stay separate', api.groupWallets(wallets).map((group) => group.currency), ['CNY', 'USD']);
check('same-currency wallets are summed', api.groupWallets(wallets)[0].total, '110.50');
check('the second currency is untouched', api.groupWallets(wallets)[1].total, '2.00');
check('wallet counts are reported', api.groupWallets(wallets).map((group) => group.count), [2, 1]);
check('malformed entries are ignored', api.groupWallets([null, 'x', { currency: '', balance: '1' }, { currency: 'CNY', balance: '1.00' }]).length, 1);
check('a non-array is tolerated', api.groupWallets(undefined), []);
check('a single-currency total needs both rows', api.singleCurrencyTotal(wallets), null);
check(
  'a single-currency total is computed',
  api.singleCurrencyTotal([{ currency: 'CNY', balance: '100.00' }, { currency: 'CNY', balance: '10.00' }]),
  { currency: 'CNY', total: '110.00', cents: 11000, count: 2 },
);
check(
  'mixed currencies produce no total',
  api.singleCurrencyTotal([{ currency: 'CNY', balance: '1.00' }, { currency: 'USD', balance: '1.00' }]),
  null,
);

console.log('--- badge text ---');
check('one currency', api.badgeAmountText([{ currency: 'CNY', balance: '110.00' }]), '¥110.00');
check('two currencies are joined', api.badgeAmountText(wallets), '¥110.50 $2.00');
check('no wallets produce no text', api.badgeAmountText([]), null);
check('bonus rows hide non-positive amounts', api.visibleBonusWallets([{ currency: 'CNY', balance: '0.00' }, { currency: 'CNY', balance: '5.00' }]).length, 1);
check('bonus rows hide zero totals', api.visibleBonusWallets([{ currency: 'CNY', balance: '0.00' }]).length, 0);

console.log('--- account Remote envelope mapping ---');
const state = { status: 'credential-stored', links: { usageUrl: 'u', topUpUrl: 't' }, attempt: null };
check(
  'ready balances map through',
  api.mapBalance({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [] } }, state),
  { status: 'ready', wallets: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [], error: null, account: state },
);
check(
  'a null value means no account wallet',
  api.mapBalance({ ok: true, value: null }, state),
  { status: 'empty', wallets: [], bonusWallets: [], error: null, account: state },
);
check(
  'a platform failure maps to a failed read',
  api.mapBalance({ ok: true, value: { status: 'failed' } }, null),
  { status: 'failed', error: 'platform-failed', account: null },
);
check(
  'a refused Remote call keeps its code',
  api.mapBalance({ ok: false, error: { code: 'remote-unavailable', message: 'x' } }, null),
  { status: 'failed', error: 'remote-unavailable', account: null },
);
check(
  'a Remote failure without a code is generic',
  api.mapBalance({ ok: false }, null),
  { status: 'failed', error: 'remote-failed', account: null },
);
check('a missing result is a failed read', api.mapBalance(null, null), { status: 'failed', error: 'no-result', account: null });
check(
  'an unknown status is refused, not rendered as zero',
  api.mapBalance({ ok: true, value: { status: 'weird' } }, null),
  { status: 'failed', error: 'unknown-shape', account: null },
);
check(
  'malformed wallet arrays become empty, not invented',
  api.mapBalance({ ok: true, value: { status: 'ready', value: 'x', bonusWallets: 7 } }, null),
  { status: 'ready', wallets: [], bonusWallets: [], error: null, account: null },
);

console.log('--- spendable wallets (topped up + granted) ---');
const grantedOnly = { wallets: [{ currency: 'CNY', balance: '0.00' }], bonusWallets: [{ currency: 'CNY', balance: '10.00' }] };
check(
  'granted credit is part of what can be spent',
  api.availableWallets(grantedOnly),
  [{ currency: 'CNY', balance: '0.00' }, { currency: 'CNY', balance: '10.00' }],
);
check(
  'the badge over spendable wallets is not a misleading zero',
  api.badgeAmountText(api.availableWallets(grantedOnly)),
  '¥10.00',
);
check(
  'the spendable total adds both lists',
  api.groupWallets(api.availableWallets(grantedOnly))[0].total,
  '10.00',
);
check(
  'a topped-up balance still counts',
  api.badgeAmountText(api.availableWallets({ wallets: [{ currency: 'CNY', balance: '100.00' }], bonusWallets: [] })),
  '¥100.00',
);
check('a missing wallet list contributes nothing', api.availableWallets({}), []);
check('a non-object view contributes nothing', api.availableWallets(null), []);
check('a non-array wallet field is ignored', api.availableWallets({ wallets: 'x', bonusWallets: 7 }), []);
check('a genuine zero still reads as zero', api.badgeAmountText(api.availableWallets(grantedOnly)), '¥10.00');

console.log('--- constants ---');
ok('the poll interval is a positive number of milliseconds', api.POLL_MS > 0 && api.POLL_MS % 1000 === 0);
ok('the client version is a non-empty string', typeof api.CLIENT_VERSION === 'string' && api.CLIENT_VERSION.length > 0);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
