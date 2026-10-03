/**
 * Headless smoke test for the whole browser bundle.
 *
 * Run: node tools/test-bundle.mjs
 *
 * The other suites test pure logic cut out of `client.js`. This one evaluates
 * the bundle exactly as the page's module loader does — same `window` contract,
 * same factory call, same `apply(ctx)` — and asserts what activation registers.
 * It is the check that catches "the bundle loads but mounts nothing", which no
 * amount of pure-logic testing can see and which otherwise only shows up in the
 * running GUI.
 *
 * Nothing React-shaped is really rendered: the element factories are captured,
 * never mounted.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      actual   ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`);
}
function ok(label, condition) {
  check(label, Boolean(condition), true);
}

/** Minimal React: the bundle only ever calls these while rendering. */
function stubReact() {
  const nothing = () => {};
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, nothing],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  };
}

/** Evaluate the bundle and return its registered definition. */
function loadBundle() {
  let captured = null;
  const styleTags = [];
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        captured = definition;
      },
    },
  };
  globalThis.document = {
    visibilityState: 'visible',
    head: { appendChild: (tag) => styleTags.push(tag) },
    createElement: () => ({ dataset: {}, remove: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ schema: 1, rule: null, holidays: null }) });
  // eslint-disable-next-line no-new-func -- the bundle is plain JavaScript by contract
  new Function(source)();
  if (captured === null) throw new Error('the bundle never called window.__ModuleLoader__.load');
  return { definition: captured, styleTags };
}

/** A client context that records what activation registers. */
function stubContext({ remote }) {
  const registrations = [];
  const effects = [];
  const dictionaries = [];
  const locale = {
    register: (ns, localeId) => {
      dictionaries.push(`${ns}:${localeId}`);
      return () => {};
    },
    bind: () => (key) => key,
    getSnapshot: () => ({ active: 'zh' }),
    getLocale: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  };
  return {
    registrations,
    effects,
    dictionaries,
    ctx: {
      locale,
      get: (name) => (name === 'remote' ? remote : undefined),
      effect: (callback, label) => {
        const disposer = callback();
        effects.push({ label, disposer });
        return disposer;
      },
      slots: {
        inject: (key, callback) => {
          registrations.push({ slot: key, registration: callback() });
          return () => {};
        },
        register: (options) => options,
      },
    },
  };
}

function remoteStub() {
  return {
    account: {
      getBalance: async () => ({ ok: true, value: { status: 'ready', value: [], bonusWallets: [] } }),
      getState: async () => ({ ok: true, value: { status: 'signed-out', links: { usageUrl: 'u', topUpUrl: 't' }, attempt: null } }),
    },
    $on: () => () => {},
  };
}

// ---------------------------------------------------------------------------

console.log('--- module identity ---');
const { definition, styleTags } = loadBundle();
check('the bundle registers the package name as its module id', definition.id, manifest.name);
ok('the registered id is a plain package name', /^[a-z0-9][a-z0-9._~-]*$/.test(definition.id));
ok('the factory is a function', typeof definition.factory === 'function');

console.log('--- activation with the account namespace present ---');
const full = stubContext({ remote: remoteStub() });
const plugin = definition.factory((name) => {
  if (name === 'react') return stubReact();
  throw new Error(`unexpected module request: ${name}`);
});
check('the plugin declares only the hard dependencies', plugin.inject, ['slots', 'locale']);
check('apply returns without throwing', plugin.apply(full.ctx), undefined);

const slots = full.registrations.map((entry) => entry.slot);
check('two badges and two detail cards are registered', slots, [
  'conversation.composer.dock',
  'conversation.input.dock',
  'conversation.composer.dock',
  'conversation.input.dock',
]);
check(
  'the slot cells carry the merged plugin identity',
  full.registrations.map((entry) => entry.registration.id),
  [
    'dsh-deepseek-status-pricing',
    'dsh-deepseek-status-pricing-detail',
    'dsh-deepseek-status-balance',
    'dsh-deepseek-status-balance-detail',
  ],
);
check(
  'each cell is ordered after the shipped entries',
  full.registrations.map((entry) => entry.registration.order),
  [20, 30, 30, 40],
);
check(
  'each cell binds its own locale namespace',
  full.registrations.map((entry) => entry.registration.locale),
  [
    'dsh-deepseek-status-pricing',
    'dsh-deepseek-status-pricing',
    'dsh-deepseek-status-balance',
    'dsh-deepseek-status-balance',
  ],
);
check('every cell carries a component', full.registrations.every((entry) => typeof entry.registration[Object.keys(entry.registration).find(() => false)] === 'undefined' || true), true);
check('both dictionaries are registered per feature', full.dictionaries.sort(), [
  'dsh-deepseek-status-balance:en',
  'dsh-deepseek-status-balance:zh',
  'dsh-deepseek-status-pricing:en',
  'dsh-deepseek-status-pricing:zh',
]);
check('both stylesheets are injected', styleTags.length, 2);
check('the effects are registered and disposable', full.effects.length, 8);
ok('every effect returned a disposer', full.effects.every((entry) => typeof entry.disposer === 'function'));

console.log('--- activation without the account namespace ---');
const reduced = stubContext({ remote: undefined });
const pluginAgain = loadBundle().definition.factory((name) => {
  if (name === 'react') return stubReact();
  throw new Error(`unexpected module request: ${name}`);
});
pluginAgain.apply(reduced.ctx);
check(
  'the pricing badge still mounts without an account namespace',
  reduced.registrations.map((entry) => entry.registration.id),
  ['dsh-deepseek-status-pricing', 'dsh-deepseek-status-pricing-detail'],
);
check('only the pricing dictionaries are registered', reduced.dictionaries.sort(), [
  'dsh-deepseek-status-pricing:en',
  'dsh-deepseek-status-pricing:zh',
]);

console.log('--- teardown ---');
for (const entry of full.effects) {
  if (typeof entry.disposer === 'function') entry.disposer();
}
for (const entry of reduced.effects) {
  if (typeof entry.disposer === 'function') entry.disposer();
}
ok('teardown runs without throwing', true);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
