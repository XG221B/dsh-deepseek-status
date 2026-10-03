/**
 * Integration test for the Host half, run outside the application.
 *
 * Run: node tools/test-host.mjs
 *
 * The Host module is imported as the Loader would import it and driven through
 * a stub context: the test asserts that activation registers exactly the route
 * the Client polls, and then exercises that route's handler with live sources
 * over the real network. The checks that need the network are reported as SKIP
 * when the network is unavailable, so this file stays useful offline without
 * ever pretending a network check passed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Host writes its cache inside the package by default. Point it at a unique
// owned directory instead, so running this suite can never disturb the data a
// deployed instance is serving.
const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-deepseek-status-test-'));
process.env.DSH_DEEPSEEK_STATUS_CACHE_DIR = cacheDir;

const hostModule = await import(new URL('../index.js', import.meta.url).href);
const dataModule = await import(new URL('../data.js', import.meta.url).href);
const cachePath = join(cacheDir, 'dataset.json');

let failures = 0;
let skipped = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      actual   ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`);
}
function ok(label, condition) {
  check(label, Boolean(condition), true);
}
const skip = (label, why) => {
  skipped += 1;
  console.log(`SKIP  ${label} (${why})`);
};

/** A `node:http` response stand-in that records what the handler wrote. */
function fakeResponse() {
  const state = { status: null, headers: null, body: undefined, ended: false };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? {};
    },
    end(body) {
      state.body = body;
      state.ended = true;
    },
  };
}

// ---------------------------------------------------------------------------

console.log('--- module surface ---');
check('the row entry exports apply', typeof hostModule.apply, 'function');
check('the row entry injects webServer', hostModule.inject, ['webServer']);

const routes = [];
const disposers = [];
const logs = [];
const ctx = {
  logger: { warn: (message) => logs.push(message) },
  effect: (callback) => {
    const disposer = callback();
    disposers.push(disposer);
    return disposer;
  },
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  },
};

// The cache directory is freshly created per run, so the cold path (no data to
// serve yet) is what this process starts from.
ok('a fresh cache directory starts empty', existsSync(cachePath) === false);

console.log('--- activation ---');
hostModule.apply(ctx);
check('exactly one route is registered', routes.length, 1);
check('the route is exact', routes[0].kind, 'exact');
check('the route path matches the Client poll target', routes[0].path, '/dsh-deepseek-status/data.json');
check('the route has a handler', typeof routes[0].handler, 'function');
check('both effects are registered (refresh timer + route)', disposers.length, 2);

const handler = routes[0].handler;

console.log('--- method handling ---');
const postResponse = fakeResponse();
await handler({ method: 'POST' }, postResponse);
check('POST is refused', postResponse.state.status, 405);
check('POST advertises the allowed methods', postResponse.state.headers.allow, 'GET, HEAD');

// ---------------------------------------------------------------------------

console.log('--- live refresh (network) ---');
const waitDeadline = Date.now() + 60000;
let live = null;
for (;;) {
  const response = fakeResponse();
  await handler({ method: 'GET' }, response);
  if (response.state.status === 200) {
    live = JSON.parse(response.state.body);
    break;
  }
  if (Date.now() > waitDeadline) break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

if (live === null) {
  skip('the route serves a fetched dataset', 'no source was reachable within 60s');
  const coldResponse = fakeResponse();
  await handler({ method: 'GET' }, coldResponse);
  check('with nothing fetched the route answers 503', coldResponse.state.status, 503);
  ok('the 503 body is JSON', coldResponse.state.body.includes('no-data-yet'));
} else {
  ok('the served dataset passes structural validation', dataModule.validateDataset(live).ok);
  check('the served schema version', live.schema, 1);
  ok('a rule was parsed from the live pricing pages', live.rule !== null);
  if (live.rule !== null) {
    // Live assertions cover INVARIANTS only. Exact prices are pinned by the
    // abridged fixtures instead, so a published price change does not read as
    // a broken plugin, while a restructured page or a changed rule still fails
    // here.
    check('the live rule names exactly two windows', live.rule.peakWindows.length, 2);
    ok(
      'every live window is a well-formed range',
      live.rule.peakWindows.every(([start, end]) => start >= 0 && start < end && end <= 1440),
    );
    ok('the live rule names at least one peak weekday', live.rule.peakWeekdays.length > 0);
    ok('the live off-peak ratio is a fraction', live.rule.offPeakRatio > 0 && live.rule.offPeakRatio <= 1);
    ok('the live rate table has at least one model', live.rule.models.length >= 1);
    ok('the live currency is a code', typeof live.rule.currency === 'string' && live.rule.currency.length >= 3);
    ok(
      'every live rate satisfies off-peak = peak / 2',
      live.rule.models.every((model) =>
        ['cacheHit', 'cacheMiss', 'output'].every((key) => Math.abs(model[key][0] / 2 - model[key][1]) < 1e-9),
      ),
    );
    check('the live rule cross-checked zh against en', live.rule.crossChecked, true);
    ok('the live rule is stamped', Number.isFinite(Date.parse(live.rule.fetchedAt)));
  }
  ok('holiday data was read', live.holidays !== null);
  if (live.holidays !== null) {
    ok('holiday off-day map is populated', Object.keys(live.holidays.days).length >= 20);
    ok('the current Beijing year is covered', live.holidays.years.includes(dataModule.beijingYear(Date.now())));
    ok('holiday provenance links the State Council notice', live.holidays.papers.some((paper) => paper.includes('gov.cn')));
    if (live.holidays.crossChecked === null) {
      skip('the two independent holiday datasets agreed', 'only one dataset was reachable');
    } else {
      check('the two independent holiday datasets agreed', live.holidays.crossChecked, true);
    }
  }
  ok('the dataset is stamped now', Date.now() - Date.parse(live.generatedAt) < 5 * 60 * 1000);

  const headResponse = fakeResponse();
  await handler({ method: 'HEAD' }, headResponse);
  check('HEAD answers 200', headResponse.state.status, 200);
  check('HEAD sends no body', headResponse.state.body, undefined);

  console.log('--- cache persistence ---');
  ok('the dataset was cached', existsSync(cachePath));
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    ok('the cached dataset validates', dataModule.validateDataset(cached).ok);
    check('the cache matches what was served', cached.generatedAt, live.generatedAt);
  }
}

console.log('--- teardown ---');
for (const disposer of disposers) {
  if (typeof disposer === 'function') disposer();
}
console.log(`activation log lines: ${logs.length}`);
const realFailures = logs.filter(
  (line) => line.includes('refresh failed') || line.includes('could not write cache') || line.includes('invalid dataset'),
);
check('activation logged no real failure', realFailures, []);
// A healthy canary: until the State Council publishes the next year, expecting
// one "not published yet" note is correct. It disappears once that lands.
const unpublished = logs.filter((line) => line.includes('no holiday data published yet'));
ok('the unpublished-year note is reported and not treated as an error', unpublished.length <= 1);

// Leave nothing behind: the whole per-run directory goes away.
rmSync(cacheDir, { recursive: true, force: true });
ok('the temporary cache directory was removed', existsSync(cacheDir) === false);

console.log(
  failures === 0
    ? `\nALL CHECKS PASSED${skipped > 0 ? ` (${skipped} network check(s) skipped)` : ''}`
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
