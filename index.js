/**
 * Host half of `dsh-deepseek-status`.
 *
 * Owns everything the browser cannot do for itself:
 *
 *   - Outbound reads of DeepSeek's pricing pages. Those pages send no CORS
 *     headers, so a page-side `fetch` could never read them; the Host can.
 *   - A schedule. The dataset is re-read on activation and every six hours, and
 *     opportunistically when a request arrives with a dataset older than an
 *     hour, so the plugin keeps up with a changed rule or a newly published
 *     holiday year without anyone touching it.
 *   - A durable cache, so a start without a network still answers with the last
 *     data that was successfully read rather than a compiled-in table.
 *   - One exact HTTP route on the composing web server, which the Client half
 *     polls. Same-origin and public: it serves only published public pricing
 *     and holiday data.
 *
 * The route and the cache are the only outward effects. Nothing here touches
 * the Session, the agent loop, or any other plugin's state.
 *
 * Loader note: the row that activates this plugin must name the package itself
 * (`dsh-deepseek-status`), never a subpath — the browser module id is derived
 * from the row specifier by resolving `<specifier>/client`. Because the Host
 * caches an imported module by its resolved URL, *changes to this file take
 * effect only after the application restarts*; the scheduled refresh above is
 * what keeps the plugin's data current without restarts.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refresh, validateDataset } from './data.js';

export const inject = ['webServer'];

/** Exact route the Client half reads. */
const ROUTE = '/dsh-deepseek-status/data.json';
/** How often the dataset is re-read from its sources. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A dataset older than this is refreshed when a request arrives. */
const STALE_MS = 60 * 60 * 1000;
/** Floor between two refresh attempts, so restarts and tabs cannot storm. */
const RETRY_AFTER_MS = 5 * 60 * 1000;
/**
 * Floor that applies while nothing has been read yet: the badge has nothing to
 * show in that state, so a transient failure should not leave it empty for the
 * full five minutes.
 */
const FIRST_LOAD_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'dsh-deepseek-status/2.0.1 (DeepSeek Harness plugin)';

/**
 * Read one URL as text. Kept local so the timer, the route, and the data layer
 * all share one timeout and header policy.
 */
async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json, text/html;q=0.9, */*;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

/**
 * @param ctx - Host plugin context carrying the `webServer` service.
 */
export function apply(ctx) {
  const logger = ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger === 'object' ? ctx.logger : null;
  const warn = (message) => {
    try {
      if (logger !== null && typeof logger.warn === 'function') logger.warn(message);
    } catch {
      /* logging must never break a refresh */
    }
  };

  const assetDir = dirname(fileURLToPath(import.meta.url));
  // The cache lives inside the package by default. An override exists so a test
  // run never disturbs the data a deployed instance is serving.
  const configuredCacheDir = process.env.DSH_DEEPSEEK_STATUS_CACHE_DIR;
  const cacheDir = typeof configuredCacheDir === 'string' && configuredCacheDir !== ''
    ? configuredCacheDir
    : join(assetDir, 'cache');
  const cacheFile = join(cacheDir, 'dataset.json');

  let dataset = null;
  let inflight = null;
  let lastAttempt = 0;
  /** Last note text that was logged, so an unchanged state does not repeat itself. */
  let lastNotes = '';

  const persist = async () => {
    if (dataset === null) return;
    try {
      await mkdir(cacheDir, { recursive: true });
      const temporary = `${cacheFile}.tmp`;
      await writeFile(temporary, JSON.stringify(dataset), 'utf8');
      await rename(temporary, cacheFile);
    } catch (error) {
      warn(`dsh-deepseek-status: could not write cache (${error && error.message ? error.message : String(error)})`);
    }
  };

  const loadCache = async () => {
    try {
      const parsed = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (validateDataset(parsed).ok) dataset = parsed;
    } catch {
      /* no cache yet, or an unreadable one: the first refresh replaces it */
    }
  };

  /**
   * Single-flight refresh. Returns the in-flight promise, or null when the
   * retry floor suppressed this call.
   */
  const update = (force) => {
    if (inflight !== null) return inflight;
    const now = Date.now();
    const floor = dataset === null ? FIRST_LOAD_RETRY_MS : RETRY_AFTER_MS;
    if (!force && now - lastAttempt < floor) return null;
    lastAttempt = now;
    inflight = refresh({ fetchText, previous: dataset, now })
      .then(async (result) => {
        const check = validateDataset(result.dataset);
        if (!check.ok) {
          warn(`dsh-deepseek-status: refresh produced an invalid dataset (${check.problems.join(', ')}); keeping the previous one`);
          return;
        }
        // Notes are stable in a healthy state (for example, "the next year's
        // holidays are not published yet"), so log them only when they change:
        // a warning that repeats every six hours trains people to ignore it.
        const noteText = result.notes.join(' | ');
        if (noteText !== '' && noteText !== lastNotes) warn(`dsh-deepseek-status: refresh notes: ${noteText}`);
        lastNotes = noteText;
        dataset = result.dataset;
        await persist();
      })
      .catch((error) => {
        warn(`dsh-deepseek-status: refresh failed (${error && error.message ? error.message : String(error)})`);
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const ready = loadCache();

  ctx.effect(
    () => {
      const timer = setInterval(() => {
        update(true);
      }, REFRESH_INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    },
    'dsh-deepseek-status: refresh timer',
  );

  ctx.effect(
    () => {
      // A display plugin must never fail an activation: DSH treats an entry that
      // did not activate as a fatal boot error, and the Client half already
      // falls back to its own snapshot when this route is missing.
      try {
        return ctx.webServer.register({
          kind: 'exact',
          path: ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD' });
              res.end();
              return;
            }
            await ready;
            if (dataset === null) {
              // Nothing read yet: the Client falls back to its own snapshot and
              // polls again, and we try now rather than waiting for the timer.
              res.writeHead(503, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': '60',
              });
              res.end('{"schema":1,"error":"no-data-yet"}');
              update(false);
              return;
            }
            const body = JSON.stringify(dataset);
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': String(Buffer.byteLength(body)),
            });
            res.end(req.method === 'HEAD' ? undefined : body);
            const generated = Date.parse(dataset.generatedAt);
            if (!Number.isFinite(generated) || Date.now() - generated > STALE_MS) update(false);
          } catch (error) {
            warn(`dsh-deepseek-status: route handler failed (${error && error.message ? error.message : String(error)})`);
            try {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-deepseek-status: internal error');
            } catch {
              /* headers may already be out */
            }
          }
          },
        });
      } catch (error) {
        warn(`dsh-deepseek-status: could not register ${ROUTE} (${error && error.message ? error.message : String(error)}); the Client half keeps its built-in snapshot`);
        return () => {};
      }
    },
    'dsh-deepseek-status: dataset route',
  );

  ready.then(() => update(true));
}
