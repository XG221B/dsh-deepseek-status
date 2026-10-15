/**
 * Install (or remove) this plugin in a DSH profile — including `desktop`, the
 * one profile `dsh plugin` refuses to manage.
 *
 * Run:
 *
 *   node tools/install.mjs --profile web
 *   node tools/install.mjs --profile desktop --spec github:XG221B/dsh-deepseek-status
 *   node tools/install.mjs --profile web --remove
 *
 * Why this exists: `dsh plugin --profile <name> add <pkg>` is a thin pnpm
 * forwarder followed by one reconcile step, and it ends with
 *
 *   error: profile "desktop" is managed exclusively by the Electron application
 *
 * for the profile the desktop app actually boots. That leaves desktop users,
 * scripts, and agents with no command-line install path at all: the two steps
 * have to be done by hand, and the second one (registering the package in
 * `dsh.profile.bundles`) is the step people forget, which makes the plugin look
 * installed while nothing ever loads.
 *
 * This script performs exactly those two steps for any profile:
 *
 *   1. `pnpm add` / `pnpm remove` in the profile directory;
 *   2. the same `dsh.profile.bundles` reconcile DSH itself does — a dependency
 *      that resolves to a package declaring `dsh.bundle.patch` joins the layer
 *      stack, one that stops declaring it leaves — keyed on the **installed
 *      manifest**, not on the spec, so a tarball URL, a local checkout, or an
 *      alias all reconcile by their true package name.
 *
 * It is idempotent, it only writes when the bundle list actually changes, and
 * `--dry-run` shows the plan without touching anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const NAME = 'dsh-deepseek-status';
const DEFAULT_SPEC = 'github:XG221B/dsh-deepseek-status';

const HELP = `Usage: node tools/install.mjs [options]

  --profile <name>       profile under $DSH_HOME/profiles (default: web)
  --profile-dir <path>   the profile directory itself; wins over --profile
  --dsh-home <path>      DSH home (default: $DSH_HOME, else ~/.dsh)
  --spec <spec>          package to add (default: ${DEFAULT_SPEC})
                         any pnpm spec: npm name, github:owner/repo,
                         a tarball URL, or an absolute path
  --pnpm <path>          pnpm executable (default: pnpm on PATH)
  --remove               uninstall instead of install
  --dry-run              print the plan, change nothing
  -h, --help             this text

Exit codes: 0 done; 1 bad usage or profile; otherwise pnpm's own code.`;

/* ------------------------------------------------------------------ *
 * Profile lookup
 * ------------------------------------------------------------------ */

/**
 * Parse the command line into options.
 * @param args - `process.argv.slice(2)`.
 * @returns the options object.
 */
export function parseArgs(args) {
  const options = { profile: 'web', profileDir: null, dshHome: null, spec: null, pnpm: 'pnpm', remove: false, dryRun: false, help: false };
  const take = (index, flag) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--profile') options.profile = take(i++, '--profile');
    else if (arg === '--profile-dir') options.profileDir = take(i++, '--profile-dir');
    else if (arg === '--dsh-home') options.dshHome = take(i++, '--dsh-home');
    else if (arg === '--spec') options.spec = take(i++, '--spec');
    else if (arg === '--pnpm') options.pnpm = take(i++, '--pnpm');
    else if (arg === '--remove') options.remove = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  options.spec = options.spec ?? (options.remove ? NAME : DEFAULT_SPEC);
  return options;
}

/**
 * Resolve the profile directory: an explicit directory wins, then
 * `$DSH_HOME/profiles/<name>` (DSH_HOME from the flag, then the environment,
 * then `~/.dsh`).
 * @param options - see {@link parseArgs}.
 * @returns absolute profile directory.
 */
export function resolveProfileDir({ profile, profileDir, dshHome }) {
  if (profileDir !== null && profileDir !== undefined && profileDir !== '') return resolve(profileDir);
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(resolve(home), 'profiles', profile);
}

/**
 * Read a profile manifest.
 * @param profileDir - profile directory.
 * @returns the parsed manifest.
 * @throws when the profile does not exist or the manifest is not valid JSON.
 */
export function readProfileManifest(profileDir) {
  const path = join(profileDir, 'package.json');
  if (!existsSync(path)) {
    throw new Error(`no profile manifest at ${path}\n      create the profile first, for example:\n      dsh --profile <name> --from-default-profile web`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/* ------------------------------------------------------------------ *
 * Installed state
 * ------------------------------------------------------------------ */

/** Directory of the package containing `file`, found by walking up. */
function nearestPackageRoot(file) {
  let directory = dirname(file);
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Where a dependency of the profile actually resolved to, or null when it is
 * not installed. Resolution goes through the profile's own `package.json`, so
 * hoisted, linked, and aliased installs all answer correctly; a package whose
 * `exports` hides `./package.json` is still found through its entry point.
 * @param packageName - dependency name.
 * @param profileDir - profile directory.
 * @returns the package directory, or null.
 */
export function resolveInstalledPackageDir(packageName, profileDir) {
  const require = createRequire(join(profileDir, 'package.json'));
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    /* not exposed by `exports`; fall through to the entry point */
  }
  try {
    const root = nearestPackageRoot(require.resolve(packageName));
    if (root === null) return null;
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return manifest.name === packageName ? root : null;
  } catch {
    return null;
  }
}

/**
 * Whether an installed dependency is a DSH bundle, i.e. declares the profile
 * patch that makes it a layer of the profile tree. Same test DSH applies.
 * @param packageName - dependency name.
 * @param profileDir - profile directory.
 * @returns true when the installed manifest declares `dsh.bundle.patch`.
 */
export function exportsBundlePatch(packageName, profileDir) {
  const directory = resolveInstalledPackageDir(packageName, profileDir);
  if (directory === null) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return manifest?.dsh?.bundle?.patch !== undefined;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Reconcile
 * ------------------------------------------------------------------ */

/**
 * Compute the bundle list this profile should have, given the manifest read
 * before pnpm ran. Entries that came from the template and are not
 * dependencies are never touched; a dependency that stopped being a bundle
 * (removed, or a version that dropped `dsh.bundle`) leaves the stack.
 * @param profileDir - profile directory.
 * @param before - manifest as read before pnpm ran.
 * @returns plan: next manifest, resulting bundles, and what changed.
 */
export function planReconcile(profileDir, before) {
  const after = readProfileManifest(profileDir);
  const dependencies = Object.keys(after.dependencies ?? {});
  const bundles = [...(after.dsh?.profile?.bundles ?? [])];
  const beforeDependencies = new Set(Object.keys(before.dependencies ?? {}));
  const dependencySet = new Set(dependencies);
  const added = [];
  const plain = [];
  const removed = [];

  for (const packageName of dependencies) {
    if (exportsBundlePatch(packageName, profileDir)) {
      if (!bundles.includes(packageName)) {
        bundles.push(packageName);
        added.push(packageName);
      }
    } else if (!beforeDependencies.has(packageName)) {
      plain.push(packageName);
    }
  }
  for (const packageName of [...bundles]) {
    const wasDependency = beforeDependencies.has(packageName) || dependencySet.has(packageName);
    const stillBundle = dependencySet.has(packageName) && exportsBundlePatch(packageName, profileDir);
    if (wasDependency && !stillBundle) {
      bundles.splice(bundles.indexOf(packageName), 1);
      removed.push(packageName);
    }
  }

  const changed = added.length > 0 || removed.length > 0;
  const manifest = changed
    ? { ...after, dsh: { ...after.dsh, profile: { ...after.dsh?.profile, bundles } } }
    : after;
  return { manifest, bundles, added, removed, plain, changed };
}

/**
 * Write a profile manifest the way pnpm and DSH do: two-space indent, one
 * trailing newline.
 * @param profileDir - profile directory.
 * @param manifest - manifest to write.
 */
export function writeProfileManifest(profileDir, manifest) {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------------ *
 * pnpm
 * ------------------------------------------------------------------ */

/**
 * The pnpm argument list for this run.
 * @param options - see {@link parseArgs}.
 * @returns arguments to pnpm.
 */
export function pnpmArgs({ remove, spec }) {
  return remove ? ['remove', spec] : ['add', spec];
}

/**
 * Run pnpm in the profile directory, with its output going straight to the
 * terminal (the same way `dsh plugin` forwards it).
 * @param options - see {@link parseArgs}.
 * @param profileDir - profile directory.
 * @returns pnpm's exit code, or 127 when pnpm is not on PATH.
 */
export function runPnpm({ pnpm, remove, spec }, profileDir) {
  const result = spawnSync(pnpm, pnpmArgs({ remove, spec }), {
    cwd: profileDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined) {
    if (result.error.code === 'ENOENT') {
      console.error(`${NAME}: pnpm not found — install pnpm, or pass --pnpm <path>`);
      return 127;
    }
    throw result.error;
  }
  return result.status ?? 1;
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

/**
 * Run the installer.
 * @param args - `process.argv.slice(2)`.
 * @returns process exit code.
 */
export function run(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`${NAME}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(HELP);
    return 1;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const profileDir = resolveProfileDir(options);
  let before;
  try {
    before = readProfileManifest(profileDir);
  } catch (error) {
    console.error(`${NAME}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`${NAME}: profile ${profileDir}`);
  if (options.dryRun) {
    console.log(`${NAME}: dry run — would run: pnpm ${pnpmArgs(options).join(' ')}`);
  } else {
    const code = runPnpm(options, profileDir);
    if (code !== 0) {
      console.error(`${NAME}: pnpm exited ${code} — profile left as it was`);
      if (!options.remove && /^git\+|^github:|\.git(?:#|$)/.test(options.spec)) {
        console.error(`${NAME}: git-hosted specs need github.com reachable over git; when it is not, install the same commit as a tarball instead:`);
        console.error(`${NAME}:   --spec https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>`);
      }
      return code;
    }
  }

  let plan;
  try {
    plan = planReconcile(profileDir, before);
  } catch (error) {
    console.error(`${NAME}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  for (const packageName of plan.plain) {
    console.error(`${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer`);
  }
  if (plan.changed) {
    if (options.dryRun) {
      console.log(`${NAME}: dry run — bundles would become: ${plan.bundles.join(', ')}`);
    } else {
      writeProfileManifest(profileDir, plan.manifest);
      console.log(`${NAME}: bundles -> ${plan.bundles.join(', ')}`);
    }
  } else {
    console.log(`${NAME}: bundles already correct: ${(plan.bundles ?? before.dsh?.profile?.bundles ?? []).join(', ')}`);
  }
  for (const packageName of plan.added) console.log(`${NAME}: joined the profile layer stack: ${packageName}`);
  for (const packageName of plan.removed) console.log(`${NAME}: left the profile layer stack: ${packageName}`);

  if (options.dryRun) {
    console.log(`${NAME}: dry run — nothing was written`);
  } else if (options.remove) {
    console.log(`${NAME}: removed — refresh the page; a Host entry that was loaded stays loaded until Harness restarts`);
  } else {
    console.log(`${NAME}: installed — refresh the page. Replacing an already-installed version needs one Harness restart (Host code is cached in the process).`);
  }
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exit(run(process.argv.slice(2)));
