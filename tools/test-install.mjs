/**
 * Offline tests for the profile installer.
 *
 * Run: node tools/test-install.mjs [--e2e]
 *
 * `tools/install.mjs` exists because `dsh plugin` refuses the `desktop` profile,
 * which leaves the bundle registration to be done by hand — the step whose
 * failure mode is silent: the package is installed, the plugin never loads. So
 * the reconcile is what gets tested here, against fake profiles in temp
 * directories: what joins the layer stack, what leaves it, what is left alone,
 * and what the file looks like afterwards.
 *
 * The last section drives real pnpm end to end (`--e2e`), installing this
 * checkout into a throwaway profile. It reports SKIP when pnpm is not on PATH
 * rather than failing, so the suite stays usable on a machine that only has the
 * app's own pnpm runtime.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportsBundlePatch,
  parseArgs,
  planReconcile,
  pnpmArgs,
  readProfileManifest,
  resolveInstalledPackageDir,
  resolveProfileDir,
  run,
  writeProfileManifest,
} from './install.mjs';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      actual   ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`);
}
function ok(label, condition) {
  check(label, Boolean(condition), true);
}
function throws(label, body) {
  let message = null;
  try {
    body();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  ok(label, typeof message === 'string' && message.length > 0);
}
function skip(label, why) {
  console.log(`SKIP  ${label} (${why})`);
}

/** A throwaway profile directory with installed packages. */
const made = [];
function scaffold(manifest, packages = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-install-'));
  made.push(dir);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const [name, pkg] of Object.entries(packages)) {
    const packageDir = join(dir, 'node_modules', name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    for (const file of ['index.js', 'cordis.patch.yml']) writeFileSync(join(packageDir, file), '', 'utf8');
  }
  return dir;
}
const bundlePackage = (name) => ({
  name,
  version: '1.0.0',
  exports: { '.': './index.js', './package.json': './package.json' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
});
const plainPackage = (name) => ({ name, version: '1.0.0', exports: { '.': './index.js', './package.json': './package.json' } });
const profileManifest = (dependencies, bundles) => ({ name: 'dsh-profile-test', private: true, dsh: { profile: { bundles } }, dependencies });

/* ------------------------------------------------------------------ *
 * Command line
 * ------------------------------------------------------------------ */

console.log('--- arguments ---');
const defaults = parseArgs([]);
check('default profile is web', defaults.profile, 'web');
check('default spec is the repository', defaults.spec, 'github:XG221B/dsh-deepseek-status');
check('default pnpm is the one on PATH', defaults.pnpm, 'pnpm');
check('install is the default action', [defaults.remove, defaults.dryRun], [false, false]);
check('removal defaults to this package name', parseArgs(['--remove']).spec, 'dsh-deepseek-status');
check(
  'flags collect',
  (({ profile, profileDir, dshHome, spec, pnpm, remove, dryRun }) => ({ profile, profileDir, dshHome, spec, pnpm, remove, dryRun }))(parseArgs([
    '--profile', 'desktop', '--profile-dir', 'D:/p', '--dsh-home', 'D:/h', '--spec', 'x.tgz', '--pnpm', 'D:/pnpm.cmd', '--remove', '--dry-run',
  ])),
  { profile: 'desktop', profileDir: 'D:/p', dshHome: 'D:/h', spec: 'x.tgz', pnpm: 'D:/pnpm.cmd', remove: true, dryRun: true },
);
throws('an unknown option is rejected', () => parseArgs(['--nope']));
throws('an option without its value is rejected', () => parseArgs(['--profile']));
throws('an option cannot swallow the next flag', () => parseArgs(['--profile', '--remove']));
check('add builds pnpm add', pnpmArgs({ remove: false, spec: 'github:X/Y' }), ['add', 'github:X/Y']);
check('remove builds pnpm remove', pnpmArgs({ remove: true, spec: 'dsh-deepseek-status' }), ['remove', 'dsh-deepseek-status']);

/* ------------------------------------------------------------------ *
 * Profile lookup
 * ------------------------------------------------------------------ */

console.log('--- profile lookup ---');
// Paths are asserted through `resolve`/suffixes, never as literals: the suites
// run on Linux CI as well as on the machine this was developed on.
check('an explicit directory wins over the profile name', resolveProfileDir({ profile: 'web', profileDir: 'D:/some/profile' }), resolve('D:/some/profile'));
ok('a profile name lands under <dsh home>/profiles', resolveProfileDir({ profile: 'desktop', dshHome: 'D:/dsh-home' }).replace(/\\/g, '/').endsWith('D:/dsh-home/profiles/desktop'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = 'D:/env-home';
ok('DSH_HOME is honoured', resolveProfileDir({ profile: 'tui' }).replace(/\\/g, '/').endsWith('D:/env-home/profiles/tui'));
if (previousHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousHome;
process.env.DSH_HOME = 'D:/env-home';
ok('the flag beats DSH_HOME', resolveProfileDir({ profile: 'tui', dshHome: 'D:/flag-home' }).replace(/\\/g, '/').endsWith('D:/flag-home/profiles/tui'));
if (previousHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousHome;
ok('with nothing configured it falls back to ~/.dsh', /[\\/]\.dsh[\\/]profiles[\\/]web$/.test(resolveProfileDir({ profile: 'web' })));

/* ------------------------------------------------------------------ *
 * Reconcile
 * ------------------------------------------------------------------ */

console.log('--- what joins the layer stack ---');
const joinDir = scaffold(
  profileManifest({ 'plugin-a': '^1.0.0', 'plain-lib': '^1.0.0' }, ['@deepseek-ai/dsh-base']),
  { 'plugin-a': bundlePackage('plugin-a'), 'plain-lib': plainPackage('plain-lib') },
);
// `before` is the manifest as it was before pnpm ran: neither dependency existed yet.
const joinPlan = planReconcile(joinDir, { dependencies: {} });
check('a bundle dependency joins the stack', joinPlan.bundles, ['@deepseek-ai/dsh-base', 'plugin-a']);
check('the join is reported', joinPlan.added, ['plugin-a']);
check('a dependency without dsh.bundle is reported, not added', joinPlan.plain, ['plain-lib']);
ok('the plan is marked as changed', joinPlan.changed);
const templateBefore = joinPlan.manifest.dsh.profile.bundles;
check('template bundles that are not dependencies are left alone', templateBefore[0], '@deepseek-ai/dsh-base');

console.log('--- idempotence ---');
writeProfileManifest(joinDir, joinPlan.manifest);
const secondPlan = planReconcile(joinDir, joinPlan.manifest);
check('a second pass adds nothing', secondPlan.added, []);
check('a second pass removes nothing', secondPlan.removed, []);
check('a second pass writes nothing', secondPlan.changed, false);
check('the manifest file is two-space indented with one trailing newline', readFileSync(join(joinDir, 'package.json'), 'utf8'), `${JSON.stringify(JSON.parse(readFileSync(join(joinDir, 'package.json'), 'utf8')), null, 2)}\n`);

console.log('--- what leaves the layer stack ---');
const goneDir = scaffold(profileManifest({ 'plugin-a': '^1.0.0' }, ['@deepseek-ai/dsh-base', 'plugin-a']), {});
const gonePlan = planReconcile(goneDir, { dependencies: { 'plugin-a': '^1.0.0' } });
check('an uninstalled dependency leaves the stack', gonePlan.bundles, ['@deepseek-ai/dsh-base']);
check('the removal is reported', gonePlan.removed, ['plugin-a']);
const demotedDir = scaffold(
  profileManifest({ 'plugin-a': '^1.0.0' }, ['@deepseek-ai/dsh-base', 'plugin-a']),
  { 'plugin-a': plainPackage('plugin-a') },
);
const demotedPlan = planReconcile(demotedDir, { dependencies: { 'plugin-a': '^1.0.0' } });
check('a package that dropped dsh.bundle leaves the stack too', demotedPlan.bundles, ['@deepseek-ai/dsh-base']);
ok('the "declares no dsh.bundle" warning fires for a newly added plain dependency only', JSON.stringify(demotedPlan.plain) === '[]');

console.log('--- manifests and resolution edge cases ---');
const noDshDir = scaffold({ name: 'dsh-profile-test', private: true, dependencies: { 'plugin-a': '^1.0.0' } }, { 'plugin-a': bundlePackage('plugin-a') });
check('a manifest without a dsh key still reconciles', planReconcile(noDshDir, { dependencies: {} }).bundles, ['plugin-a']);
const hiddenDir = scaffold(profileManifest({ 'plugin-hidden': '^1.0.0' }, []), {
  'plugin-hidden': { name: 'plugin-hidden', version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } },
});
ok('a package wrapping its entry point is still found', exportsBundlePatch('plugin-hidden', hiddenDir));
ok('resolution goes through the profile manifest', resolveInstalledPackageDir('plugin-hidden', hiddenDir)?.endsWith(`${join('node_modules', 'plugin-hidden')}`));
check('an absent dependency is not a bundle', exportsBundlePatch('not-installed', hiddenDir), false);
throws('a broken profile manifest is a clear error', () => {
  const broken = scaffold({ name: 'dsh-profile-test', private: true }, {});
  writeFileSync(join(broken, 'package.json'), '{ nope', 'utf8');
  readProfileManifest(broken);
});
throws('a missing profile points at how to create one', () => readProfileManifest(join(tmpdir(), `dsh-install-missing-${process.pid}`)));
ok('the missing-profile error names the flag that creates one', /--from-default-profile/.test((() => {
  try {
    readProfileManifest(join(tmpdir(), `dsh-install-missing-${process.pid}`));
    return '';
  } catch (error) {
    return error.message;
  }
})()));

console.log('--- dry run touches nothing ---');
const dryDir = scaffold(profileManifest({ 'plugin-a': '^1.0.0' }, []), { 'plugin-a': bundlePackage('plugin-a') });
const dryBefore = readFileSync(join(dryDir, 'package.json'), 'utf8');
const dryCode = run(['--profile-dir', dryDir, '--dry-run', '--spec', 'github:XG221B/dsh-deepseek-status']);
check('dry run exits 0', dryCode, 0);
check('dry run leaves the manifest byte-identical', readFileSync(join(dryDir, 'package.json'), 'utf8'), dryBefore);
ok('dry run would have joined the bundle', planReconcile(dryDir, { dependencies: { 'plugin-a': '^1.0.0' } }).changed);
check('a bad profile directory is a usage error', run(['--profile-dir', join(tmpdir(), `dsh-install-absent-${process.pid}`)]), 1);

/* ------------------------------------------------------------------ *
 * End to end, real pnpm
 * ------------------------------------------------------------------ */

console.log('--- end to end (real pnpm) ---');
const e2e = process.argv.includes('--e2e') || spawnSync('pnpm', ['--version'], { shell: process.platform === 'win32' }).status === 0;
if (!e2e) {
  skip('install this checkout into a throwaway profile', 'pnpm is not on PATH; rerun with --e2e and pnpm installed');
} else {
  const e2eDir = scaffold(profileManifest({}, ['@deepseek-ai/dsh-base']));
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  const code = run(['--profile-dir', e2eDir, '--pnpm', 'pnpm', '--spec', checkout]);
  check('the installer exits 0', code, 0);
  const manifest = readProfileManifest(e2eDir);
  ok('pnpm recorded the dependency', typeof manifest.dependencies?.['dsh-deepseek-status'] === 'string');
  check('the bundle joined the layer stack', manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-deepseek-status']);
  ok('the installed manifest is the one this repository declares', readFileSync(join(e2eDir, 'node_modules', 'dsh-deepseek-status', 'package.json'), 'utf8').includes('"dsh-deepseek-status"'));
  const again = run(['--profile-dir', e2eDir, '--pnpm', 'pnpm', '--spec', checkout]);
  check('installing twice is a no-op', [again, readProfileManifest(e2eDir).dsh.profile.bundles.length], [0, 2]);
  const removal = run(['--profile-dir', e2eDir, '--pnpm', 'pnpm', '--remove']);
  check('removal exits 0', removal, 0);
  const after = readProfileManifest(e2eDir);
  check('removal drops the bundle again', after.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
  ok('removal drops the dependency too', after.dependencies?.['dsh-deepseek-status'] === undefined);
  ok('the package is gone from node_modules', !existsSync(join(e2eDir, 'node_modules', 'dsh-deepseek-status', 'package.json')));
}

for (const dir of made) rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
