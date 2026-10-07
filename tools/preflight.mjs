/**
 * Contract preflight: does this plugin still match the DSH it is installed into?
 *
 * Run after a DSH update, before trusting the badges:
 *
 *   node tools/preflight.mjs ['D:\path\to\app.asar'] [--live [baseUrl]]
 *
 * Why this exists: the plugin leans on a set of pre-release contracts (two slot
 * keys, four client services, the browser module-loading contract, the Host
 * route API, Cordis's injection semantics, and the account Remote envelope). DSH
 * is free to change any of them. When one disappears the plugin does not throw —
 * it degrades (badge gone, or "read failed") or, in the worst case, an inactive
 * entry fails the whole desktop web boot. This script checks the contracts
 * statically against the installed archive, so "will it still work?" becomes one
 * command instead of a guess.
 *
 * It reads `app.asar` directly: no Electron, no dependencies, nothing extracted
 * to disk.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/* ------------------------------------------------------------------ *
 * Archive reader
 * ------------------------------------------------------------------ */

/**
 * ASAR layout: [uint32 4][uint32 pickle2Total][uint32 jsonLength][JSON][data...]
 * where the JSON directory's offsets are relative to the end of the header.
 */
function openArchive(path) {
  const fd = openSync(path, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const pickle1Size = head.readUInt32LE(0);
  const pickle2Total = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  if (pickle1Size !== 4) throw new Error(`${path}: not an asar archive`);
  const headerBuf = Buffer.alloc(jsonLength);
  readSync(fd, headerBuf, 0, jsonLength, 16);
  const header = JSON.parse(headerBuf.toString('utf8'));
  const dataStart = 8 + pickle2Total;

  const entries = new Map();
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const entryPath = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.files) walk(entry, entryPath);
      else entries.set(entryPath, entry);
    }
  };
  walk(header, '');

  return {
    path,
    size: statSync(path).size,
    entries,
    /** Read one entry as UTF-8 text, or null when it is missing/unpacked. */
    read(entryPath) {
      const entry = entries.get(entryPath);
      if (entry === undefined || entry.unpacked) return null;
      const buffer = Buffer.alloc(Number(entry.size));
      readSync(fd, buffer, 0, Number(entry.size), dataStart + Number(entry.offset));
      return buffer.toString('utf8');
    },
    /** Every entry path under a directory prefix, optionally filtered by suffix. */
    list(prefix, suffix = '') {
      const out = [];
      for (const entryPath of entries.keys()) {
        if (prefix !== '' && !entryPath.startsWith(prefix)) continue;
        if (suffix !== '' && !entryPath.endsWith(suffix)) continue;
        out.push(entryPath);
      }
      return out.sort();
    },
    close() {
      closeSync(fd);
    },
  };
}

/** Locate the archive without arguments. */
function resolveArchive(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_ASAR,
    'D:\\DSH desktop\\resources\\app.asar',
    join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/* ------------------------------------------------------------------ *
 * The contracts this plugin depends on
 * ------------------------------------------------------------------ */

const CLIENT = 'dsh/node_modules/@deepseek-ai';
const FRONTEND = `${CLIENT}/dsh-web-frontend/dist/assets/`;
const REQUIREMENTS = [
  {
    id: 'slot.composer',
    label: 'slot conversation.composer.dock',
    dir: `${CLIENT}/dsh-client-ui-conversation/`,
    needle: 'conversation.composer.dock',
    impact: 'the pricing and balance badges mount here; if it is renamed they vanish silently',
  },
  {
    id: 'slot.input',
    label: 'slot conversation.input.dock',
    dir: `${CLIENT}/dsh-client-ui-conversation/`,
    needle: 'conversation.input.dock',
    impact: 'both detail cards mount here',
  },
  {
    id: 'service.slots',
    label: 'client service "slots"',
    dir: `${CLIENT}/dsh-client-ui-slots/`,
    present: true,
    impact: 'ctx.slots.inject/register stop existing; nothing renders',
  },
  {
    id: 'service.locale',
    label: 'client service "locale"',
    dir: `${CLIENT}/dsh-client-locale/`,
    present: true,
    impact: 'ctx.locale.bind/register stop existing; activation fails',
  },
  {
    id: 'service.remote',
    label: 'client service "remote" (api-remotes)',
    dir: `${CLIENT}/dsh-api-remotes/`,
    present: true,
    impact: 'the balance half is never mounted (it stays a pricing-only badge)',
  },
  {
    id: 'remote.getBalance',
    label: 'Remote endpoint account.getBalance',
    dir: `${CLIENT}/dsh-api-account-controller/`,
    needle: 'getBalance',
    impact: 'the balance read answers unknown; the badge hides itself',
  },
  {
    id: 'remote.envelope',
    label: 'balance envelope field bonusWallets',
    dir: `${CLIENT}/dsh-api-account-controller/`,
    needle: 'bonusWallets',
    impact: 'granted credit is no longer recognised; the total would understate the balance',
  },
  {
    id: 'loader.module',
    label: 'browser module contract (__ModuleLoader__)',
    dir: `${CLIENT}/dsh-client-modules/`,
    needle: '__ModuleLoader__',
    impact: 'client.js cannot register at all: the entry fails to import, which is FATAL to the web boot',
  },
  {
    id: 'manifest.client',
    label: 'manifest field dsh.client.immediately',
    dir: `${CLIENT}/dsh-client-modules/`,
    needle: 'immediately',
    impact: 'the bundle manifest fields this package declares are no longer understood',
  },
  {
    id: 'client.optionalMount',
    label: 'client ctx.inject(deps, callback) in shipped code',
    dir: FRONTEND,
    filePrefix: 'index-',
    needle: '.inject([',
    impact: 'the optional-mount pattern the balance half uses may no longer exist',
  },
  {
    id: 'host.webserver',
    label: 'Host route option "handler" (ctx.webServer.register)',
    dir: `${CLIENT}/dsh-host-webserver/`,
    needle: 'handler',
    impact: 'the dataset route is not registered; the Client half falls back to its snapshot',
  },
  {
    id: 'cordis.inject',
    label: 'Cordis injection semantics (property access needs inject)',
    dir: `${CLIENT}/cordis/`,
    needle: 'without inject',
    impact: 'the optional-service pattern this plugin is built on changed meaning',
  },
  {
    id: 'info.bootAudit',
    kind: 'info',
    label: 'web boot still treats an inactive entry as fatal',
    dir: FRONTEND,
    filePrefix: 'index-',
    needle: 'did not activate',
    impact: 'informational: while this is present, one inactive entry still takes the whole UI down, which is why this plugin must always activate',
  },
];

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const liveIndex = argv.indexOf('--live');
const liveBase = liveIndex >= 0 ? argv[liveIndex + 1] : undefined;
const asarArg = argv.find((arg, index) => arg.endsWith('.asar') && index !== liveIndex + 1);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map((line) => line.replace(/^ \* ?/, '')).join('\n'));
  process.exit(0);
}

const archivePath = resolveArchive(asarArg);
if (archivePath === null) {
  console.error('preflight: could not find app.asar.');
  console.error('  Pass it explicitly, for example:');
  console.error(`    node tools/preflight.mjs "${'D:\\DSH desktop\\resources\\app.asar'}"`);
  process.exit(2);
}

const archive = openArchive(archivePath);

if (argv.includes('--list')) {
  const prefix = argv[argv.indexOf('--list') + 1] ?? '';
  for (const entryPath of archive.list(prefix)) console.log(entryPath);
  archive.close();
  process.exit(0);
}
if (argv.includes('--dump')) {
  const text = archive.read(argv[argv.indexOf('--dump') + 1] ?? '');
  console.log(text ?? '(missing)');
  archive.close();
  process.exit(0);
}

console.log(`preflight against ${archivePath} (${(archive.size / 1024 / 1024).toFixed(1)} MB, ${archive.entries.size} entries)`);
console.log('');

let failed = 0;
for (const requirement of REQUIREMENTS) {
  const candidates = archive
    .list(requirement.dir, '.js')
    .filter((entryPath) => requirement.filePrefix === undefined || entryPath.slice(requirement.dir.length).startsWith(requirement.filePrefix));
  let verdict;
  let detail;
  if (requirement.present === true) {
    verdict = candidates.length > 0 ? 'PASS' : 'FAIL';
    detail = `${candidates.length} file(s)`;
  } else {
    const hits = candidates.filter((entryPath) => (archive.read(entryPath) ?? '').includes(requirement.needle));
    verdict = hits.length > 0 ? 'PASS' : 'FAIL';
    detail = hits.length > 0 ? hits[0].slice(requirement.dir.length) : `"${requirement.needle}" not found`;
  }
  if (requirement.kind === 'info') verdict = verdict === 'PASS' ? 'INFO yes' : 'INFO no';
  if (verdict === 'FAIL') failed += 1;
  console.log(`${verdict.padEnd(8)} ${requirement.label}`);
  console.log(`         ${detail}`);
  if (verdict === 'FAIL' || requirement.kind === 'info') console.log(`         ${requirement.impact}`);
}

if (liveBase !== undefined || argv.includes('--live')) {
  const base = liveBase ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
  console.log('');
  console.log(`live check against ${base}`);
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/dsh-deepseek-status/data.json`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.log(`FAIL  dataset route -> HTTP ${response.status}`);
      failed += 1;
    } else {
      const dataset = await response.json();
      const fresh = dataset.generatedAt;
      console.log(`PASS  dataset route -> 200, generatedAt=${fresh}`);
      console.log(`      rule cross-checked=${dataset.rule?.crossChecked}, holidays cross-checked=${dataset.holidays?.crossChecked}`);
    }
  } catch (error) {
    console.log(`FAIL  dataset route unreachable (${error && error.message ? error.message : String(error)})`);
    console.log('      impact: either DSH is not running, or the Host half did not activate');
    failed += 1;
  }
}

archive.close();
console.log('');
if (failed === 0) {
  console.log('All contracts present: this plugin matches the installed DSH.');
  process.exit(0);
}
console.log(`${failed} contract(s) missing. Before the next restart, disable this bundle so it cannot fail the boot:`);
console.log('  edit %USERPROFILE%\\.dsh\\profiles\\<profile>\\package.json and remove "dsh-deepseek-status" from dsh.profile.bundles');
console.log('  (DSH backs the profile patch up as cordis.patch.yml.bak-<epoch> when it recovers, so nothing else is lost)');
process.exit(1);
