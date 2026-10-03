/**
 * Data layer for `dsh-deepseek-status` (Host side, Node ESM).
 *
 * The plugin's accuracy comes from two published sources that are re-read on a
 * schedule instead of being hardcoded:
 *
 *   1. DeepSeek's own pricing page states the billing rule (peak windows,
 *      weekday range, holiday exemption, off-peak ratio) and the rate table.
 *      The Chinese and English pages are parsed independently and cross-checked
 *      against each other, because the English page states its windows in UTC
 *      while the Chinese page states them in Beijing time.
 *   2. The Chinese public-holiday arrangement (放假区间) is read as JSON from
 *      the `holiday-cn` dataset, which is generated from the State Council
 *      notice and cites that notice in its `papers` field.
 *
 * Every parse is validated before it is accepted: a rule that does not describe
 * exactly two windows, a rate table whose off-peak column is not half its peak
 * column, or a holiday payload whose year does not match the request is
 * rejected, and the caller keeps its previous value. Nothing is guessed, and a
 * source that changes shape degrades to the last known-good data instead of
 * silently reporting a wrong price window.
 *
 * All functions here are pure except `refresh`, which takes its transport as a
 * parameter so tests can drive it without a network.
 */

/** Pricing pages, parsed independently and cross-checked. */
export const PRICING_SOURCES = [
  {
    lang: 'zh',
    url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    zone: 'Asia/Shanghai',
    zoneOffsetMinutes: 480,
    currency: 'CNY',
    anchor: '北京时间',
  },
  {
    lang: 'en',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    zone: 'UTC',
    zoneOffsetMinutes: 0,
    currency: 'USD',
    anchor: 'Peak hours',
  },
];

/**
 * Holiday sources, tried in order per year.
 *
 * Two *independent* datasets are involved, which is what makes disagreement
 * detectable: `holiday-cn` is a transcription of the State Council notice (and
 * cites that notice in its `papers` field), while `chinese-days` is a separate
 * project with its own parser and file layout. Mirror subdomains of the same
 * dataset are listed because cache expiry differs per CDN edge: a year that has
 * just been published can still look unpublished on one edge and published on
 * another, and trying the next mirror is what picks it up early.
 *
 * `raw.githubusercontent.com` is last: it is frequently unreachable from
 * mainland networks and is not needed while a jsDelivr edge works.
 */
export const HOLIDAY_SOURCES = [
  {
    id: 'holiday-cn@jsdelivr',
    family: 'holiday-cn',
    url: (year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
    parse: parseHolidayYear,
  },
  {
    id: 'holiday-cn@fastly',
    family: 'holiday-cn',
    url: (year) => `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
    parse: parseHolidayYear,
  },
  {
    id: 'chinese-days@jsdelivr',
    family: 'chinese-days',
    url: (year) => `https://cdn.jsdelivr.net/npm/chinese-days/dist/years/${year}.json`,
    parse: parseChineseDaysYear,
  },
  {
    id: 'holiday-cn@statically',
    family: 'holiday-cn',
    url: (year) => `https://cdn.statically.io/gh/NateScarlet/holiday-cn/master/${year}.json`,
    parse: parseHolidayYear,
  },
  {
    id: 'holiday-cn@github-raw',
    family: 'holiday-cn',
    url: (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
    parse: parseHolidayYear,
  },
];

/**
 * A published year carries roughly thirty holiday-adjacent days (2026 has 39 in
 * `holiday-cn`). A payload far below that is a stub or a truncated response,
 * not a year with no holidays, so it must not be accepted as one.
 */
const MIN_HOLIDAY_DAYS = 20;

export const SCHEMA_VERSION = 1;

/** Beijing is a fixed UTC+8 offset with no DST, so a shift is exact. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_NAMES = { 0: '日', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

/** The Beijing calendar year of an instant. */
export function beijingYear(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).getUTCFullYear();
}

function isoWeekdayOf(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).getUTCDay();
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)));
}

/** Visible text of an HTML fragment, with tags removed and runs collapsed. */
export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sentence containing every one of `needles`, or null. */
export function findSentence(text, needles) {
  const parts = text.split(/(?<=[。．.!?？])\s*/);
  for (const part of parts) {
    if (needles.every((needle) => part.includes(needle))) return part;
  }
  return null;
}

/** Clock windows (`H:MM - H:MM`) in a sentence, as minutes after midnight. */
export function extractWindows(text) {
  const windows = [];
  const re = /(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (end > start) windows.push([start, end]);
  }
  return windows;
}

function shiftWindowsToBeijing(windows, offsetMinutes) {
  if (offsetMinutes === 0) return windows;
  return windows
    .map(([start, end]) => [
      ((start + offsetMinutes) % 1440 + 1440) % 1440,
      ((end + offsetMinutes) % 1440 + 1440) % 1440,
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
}

function sameWindows(a, b) {
  if (a.length !== b.length) return false;
  return a.every(([start, end], index) => start === b[index][0] && end === b[index][1]);
}

/** Element-wise comparison, so a page that renames or reorders days is caught. */
function sameWeekdays(a, b) {
  if (a.length !== b.length) return false;
  return a.every((day, index) => day === b[index]);
}

/* -------------------------------------------------------------------------- */
/* Rule parsing (pricing page)                                                */
/* -------------------------------------------------------------------------- */

function parseWeekdays(sentence, lang) {
  if (lang === 'zh') {
    if (/周一至周五|周一至週五/.test(sentence)) return [1, 2, 3, 4, 5];
    if (/周一至周日|每天|每日/.test(sentence)) return [0, 1, 2, 3, 4, 5, 6];
    return null;
  }
  if (/Monday\s*(?:through|thru|to|-|–)\s*Friday/i.test(sentence)) return [1, 2, 3, 4, 5];
  if (/Monday\s*(?:through|thru|to|-|–)\s*Sunday|every day|each day/i.test(sentence)) {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  return null;
}

function parseRatio(text, lang) {
  if (lang === 'zh') {
    if (/空闲时段价格为高峰时段价格的一半|半价/.test(text)) return 0.5;
    const discount = /空闲时段价格为高峰时段价格的(\d+(?:\.\d+)?)折/.exec(text);
    if (discount !== null) return Number(discount[1]) / 10;
    return null;
  }
  if (/half of the peak rates|half the peak rates|50%\s*off/i.test(text)) return 0.5;
  const percent = /(\d{1,3})%\s*of the peak rates/i.exec(text);
  if (percent !== null) return Number(percent[1]) / 100;
  return null;
}

function periodOf(text, lang) {
  const value = text.toUpperCase();
  if (lang === 'zh') {
    if (text.includes('空闲时段')) return 'off';
    if (text.includes('高峰时段')) return 'peak';
    return null;
  }
  if (value.includes('OFF-PEAK') || value.includes('OFF PEAK')) return 'off';
  if (value.includes('PEAK')) return 'peak';
  return null;
}

function metricOf(text, lang) {
  const value = text.toUpperCase();
  if (lang === 'zh') {
    if (text.includes('未命中')) return 'cacheMiss';
    if (text.includes('缓存命中') || text.includes('命中')) return 'cacheHit';
    if (text.includes('输出')) return 'output';
    return null;
  }
  if (value.includes('CACHE MISS')) return 'cacheMiss';
  if (value.includes('CACHE HIT')) return 'cacheHit';
  if (value.includes('OUTPUT')) return 'output';
  return null;
}

function numberOf(text) {
  const match = /(\d+(?:\.\d+)?)/.exec(text.replace(/,/g, ''));
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** One `<tr>` as cells: `text`, `colspan`, `rowspan`. */
function tableCells(rowHtml) {
  const cells = [];
  const re = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(rowHtml)) !== null) {
    const attrs = match[2];
    const colspan = /colspan\s*=\s*"?(\d+)/i.exec(attrs);
    const rowspan = /rowspan\s*=\s*"?(\d+)/i.exec(attrs);
    cells.push({
      text: htmlToText(match[3]),
      colspan: colspan === null ? 1 : Number(colspan[1]),
      rowspan: rowspan === null ? 1 : Number(rowspan[1]),
    });
  }
  return cells;
}

/**
 * Lay rows out on a column grid, honouring `colspan` and `rowspan`, so a cell
 * can be addressed by its column no matter how many rows or columns it covers.
 * Rows are returned in document order and may be shorter than the widest row.
 */
function buildGrid(rows) {
  const grid = [];
  /** column -> a cell that still owes coverage to later rows. */
  const carried = new Map();
  for (const cells of rows) {
    const row = [];
    let column = 0;
    const placeCarried = () => {
      while (carried.has(column)) {
        const held = carried.get(column);
        row[column] = held.cell;
        held.remaining -= 1;
        if (held.remaining <= 0) carried.delete(column);
        column += 1;
      }
    };
    for (const cell of cells) {
      placeCarried();
      for (let offset = 0; offset < cell.colspan; offset += 1) {
        row[column + offset] = cell;
        if (cell.rowspan > 1) carried.set(column + offset, { cell, remaining: cell.rowspan - 1 });
      }
      column += cell.colspan;
    }
    placeCarried();
    grid.push(row);
  }
  return grid;
}

function parseModels(html, lang, currency) {
  const tables = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) ?? [];
  const anchor = lang === 'zh' ? '缓存命中' : 'CACHE HIT';
  const table = tables.find((candidate) => candidate.toUpperCase().includes(anchor.toUpperCase()));
  if (table === undefined) return null;

  const rows = (table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []).map(tableCells);
  if (rows.length < 2) return null;

  // Expand the table into a grid: a cell with `rowspan` occupies its column in
  // every row it spans, and a cell with `colspan` occupies several columns.
  // The pricing table labels its rows through two such spanning columns
  // ("价格" over six rows, then the metric over two), so cell *counts* per row
  // vary and only column positions are stable.
  const grid = buildGrid(rows);
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);

  // The header row is the model roster: its first cell is the "MODEL" label
  // (spanning the label columns) and the rest name the models.
  const names = rows[0]
    .slice(1)
    .filter((cell) => cell.colspan < 2)
    .map((cell) => cell.text.replace(/\(\d+\)/g, '').trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;

  const modelColumn = width - names.length;
  const periodColumn = modelColumn - 1;
  const metricColumn = periodColumn - 1;
  if (metricColumn < 0) return null;

  const models = names.map((name) => ({ name, cacheHit: [null, null], cacheMiss: [null, null], output: [null, null] }));
  for (const row of grid.slice(1)) {
    const metricCell = row[metricColumn];
    const periodCell = row[periodColumn];
    if (metricCell === undefined || periodCell === undefined) continue;
    const metric = metricOf(metricCell.text, lang);
    const period = periodOf(periodCell.text, lang);
    if (metric === null || period === null) continue;

    const values = [];
    for (let index = 0; index < names.length; index += 1) {
      const cell = row[modelColumn + index];
      const value = cell === undefined ? null : numberOf(cell.text);
      if (value === null) break;
      values.push(value);
    }
    if (values.length !== names.length) continue;
    models.forEach((model, index) => {
      model[metric][period === 'peak' ? 0 : 1] = values[index];
    });
  }

  for (const model of models) {
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      const [peak, off] = model[key];
      if (peak === null || off === null || peak <= 0) return null;
      // The published rule is exactly half; a mismatch means the page shape
      // changed or the two columns were read in the wrong order.
      if (Math.abs(peak / 2 - off) > 1e-9) return null;
    }
  }
  return { models, currency };
}

/**
 * Parse one pricing page into a rule, or null when the page no longer states
 * what this plugin knows how to read. Windows are returned in Beijing minutes.
 */
export function parsePricingPage(html, lang) {
  const source = PRICING_SOURCES.find((entry) => entry.lang === lang);
  if (source === undefined) return null;
  const text = htmlToText(html);

  const sentence = findSentence(text, [source.anchor, lang === 'zh' ? '高峰时段' : 'Peak hours']);
  if (sentence === null) return null;

  const windows = extractWindows(sentence);
  if (windows.length !== 2) return null;

  const weekdays = parseWeekdays(sentence, lang);
  if (weekdays === null) return null;

  const ratio = parseRatio(text, lang);
  if (ratio === null) return null;

  const holidayExempt = lang === 'zh' ? /法定节假日/.test(sentence) : /public holidays/i.test(sentence);
  const table = parseModels(html, lang, source.currency);

  return {
    timezone: source.zone,
    zoneOffsetMinutes: source.zoneOffsetMinutes,
    peakWindows: source.zoneOffsetMinutes === 0 ? shiftWindowsToBeijing(windows, 480) : windows.slice().sort((a, b) => a[0] - b[0]),
    peakWindowsAsStated: windows,
    peakWeekdays: weekdays,
    offPeakRatio: ratio,
    holidayExempt,
    currency: table === null ? source.currency : table.currency,
    models: table === null ? null : table.models,
    source: source.url,
  };
}

/* -------------------------------------------------------------------------- */
/* Holiday parsing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one `holiday-cn` payload into `{ 'YYYY-MM-DD': { n, off } }`.
 * Returns null when the payload is for another year, is not yet published, or
 * is too small to be a full year — all of which mean "no data for this year",
 * never "no holidays this year".
 */
export function parseHolidayYear(payload, year) {
  if (payload === null || typeof payload !== 'object') return null;
  if (Number(payload.year) !== Number(year)) return null;
  if (!Array.isArray(payload.days) || payload.days.length < MIN_HOLIDAY_DAYS) return null;
  const days = {};
  let off = 0;
  for (const entry of payload.days) {
    if (entry === null || typeof entry !== 'object') return null;
    const date = entry.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (date.slice(0, 4) !== String(year)) return null;
    // `isOffDay: false` marks a make-up workday on a weekend. Weekends bill
    // off-peak in full, so those entries need no separate treatment here.
    const isOff = entry.isOffDay === true;
    days[date] = { n: typeof entry.name === 'string' ? entry.name : '', off: isOff };
    if (isOff) off += 1;
  }
  if (off === 0) return null;
  return {
    days,
    offDays: off,
    papers: Array.isArray(payload.papers) ? payload.papers.filter((paper) => typeof paper === 'string') : [],
  };
}

/**
 * Normalize one `chinese-days` year payload, an independent dataset with a
 * different shape: three flat maps whose values are `"EN,中文,weight"`.
 * `holidays` are the off-days, `workdays` the make-up workdays.
 */
export function parseChineseDaysYear(payload, year) {
  if (payload === null || typeof payload !== 'object') return null;
  const holidays = payload.holidays;
  if (holidays === null || typeof holidays !== 'object') return null;
  const nameOf = (value) => (typeof value === 'string' ? (value.split(',')[1] ?? '').trim() : '');
  const days = {};
  let off = 0;
  for (const [date, value] of Object.entries(holidays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 4) !== String(year)) continue;
    days[date] = { n: nameOf(value), off: true };
    off += 1;
  }
  if (off < MIN_HOLIDAY_DAYS) return null;
  const workdays = payload.workdays;
  if (workdays !== null && typeof workdays === 'object') {
    for (const [date, value] of Object.entries(workdays)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 4) !== String(year)) continue;
      if (days[date] === undefined) days[date] = { n: nameOf(value), off: false };
    }
  }
  // This dataset carries no provenance links, unlike holiday-cn's `papers`.
  return { days, offDays: off, papers: [] };
}

function offDaySet(days) {
  const set = new Set();
  for (const [date, entry] of Object.entries(days)) {
    if (entry.off === true) set.add(date);
  }
  return set;
}

function sameDateSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Refresh orchestration                                                      */
/* -------------------------------------------------------------------------- */

async function tryFetchText(fetchText, url, notes) {
  try {
    const text = await fetchText(url);
    return typeof text === 'string' && text.length > 0 ? text : null;
  } catch (error) {
    notes.push(`fetch failed: ${url} (${error && error.message ? error.message : String(error)})`);
    return null;
  }
}

/**
 * Read every source and assemble one dataset.
 *
 * Each part fails independently: a rule that cannot be parsed keeps the
 * previous rule, a year whose holiday JSON is unpublished is simply absent, and
 * the dataset always records what happened in `notes` for the panel to show.
 *
 * @param options.fetchText - `(url) => Promise<string>` transport.
 * @param options.previous - last good dataset, used for per-part fallback.
 * @param options.now - current epoch milliseconds.
 * @param options.horizonYears - how many years ahead of the Beijing year to read.
 */
export async function refresh({ fetchText, previous = null, now = Date.now(), horizonYears = 1 }) {
  const notes = [];
  const year = beijingYear(now);

  const rule = await readRule({ fetchText, previous, now, notes });
  const holidays = await readHolidays({ fetchText, previous, now, year, horizonYears, notes });

  return {
    dataset: {
      schema: SCHEMA_VERSION,
      generatedAt: new Date(now).toISOString(),
      rule,
      holidays,
      notes,
    },
    notes,
  };
}

async function readRule({ fetchText, previous, now, notes }) {
  const html = {};
  for (const source of PRICING_SOURCES) {
    html[source.lang] = await tryFetchText(fetchText, source.url, notes);
  }

  const parsed = {};
  for (const source of PRICING_SOURCES) {
    const page = html[source.lang];
    if (page === null) continue;
    try {
      parsed[source.lang] = parsePricingPage(page, source.lang);
    } catch (error) {
      notes.push(`rule parse threw for ${source.lang}: ${error && error.message ? error.message : String(error)}`);
      parsed[source.lang] = null;
    }
    if (parsed[source.lang] === null) notes.push(`rule: the ${source.lang} pricing page no longer states a readable rule`);
  }

  const zh = parsed.zh ?? null;
  const en = parsed.en ?? null;
  const previousRule = previous !== null && previous.rule ? previous.rule : null;

  if (zh !== null && en !== null) {
    if (sameWindows(zh.peakWindows, en.peakWindows) && sameWeekdays(zh.peakWeekdays, en.peakWeekdays)) {
      // The rate table and the currency it is published in must come from the
      // SAME page. Borrowing a table across languages while keeping the other
      // page's currency label would print, say, USD amounts under a CNY heading
      // — wrong by the exchange rate, and silently so.
      let table;
      if (zh.models !== null) {
        table = { models: zh.models, currency: zh.currency };
      } else if (en.models !== null) {
        table = { models: en.models, currency: en.currency };
        notes.push('the zh rate table was unreadable; using the en table and its currency');
      } else {
        table = { models: null, currency: zh.currency };
      }
      return {
        ...zh,
        ...table,
        crossChecked: true,
        fetchedAt: new Date(now).toISOString(),
        problems: [],
      };
    }
    notes.push('zh and en pricing pages disagree on the peak windows or peak days; keeping the previous rule');
    if (previousRule !== null) return { ...previousRule, crossChecked: false, problems: previousRule.problems ?? ['zh/en mismatch'] };
    return { ...zh, crossChecked: false, problems: ['zh/en mismatch'] };
  }

  for (const entry of [zh, en]) {
    if (entry !== null) {
      notes.push(`rule parsed from ${entry.source} only`);
      // Same rule as above: a borrowed table carries the currency it was
      // published in, never the borrowing page's label.
      let table;
      if (entry.models !== null) {
        table = { models: entry.models, currency: entry.currency };
      } else if (previousRule !== null && previousRule.models !== null) {
        table = { models: previousRule.models, currency: previousRule.currency };
        notes.push('the rate table came from the previous rule, with its own currency');
      } else {
        table = { models: null, currency: entry.currency };
      }
      return {
        ...entry,
        ...table,
        crossChecked: false,
        fetchedAt: new Date(now).toISOString(),
        problems: [`${entry.timezone}-only`],
      };
    }
  }

  if (previousRule !== null) {
    notes.push('no pricing page could be read; keeping the previous rule');
    return { ...previousRule, crossChecked: false, problems: ['stale: pricing page unreadable'] };
  }
  return null;
}

async function readHolidays({ fetchText, previous, now, year, horizonYears, notes }) {
  const wanted = [];
  for (let offset = 0; offset <= horizonYears; offset += 1) wanted.push(year + offset);

  const days = {};
  const years = [];
  const papers = [];
  const sources = [];
  const crossChecks = {};
  let fetchedAny = false;

  const previousDays = previous !== null && previous.holidays && previous.holidays.days ? previous.holidays.days : {};

  for (const wantedYear of wanted) {
    let primary = null;
    let independent = null;
    for (const candidate of HOLIDAY_SOURCES) {
      if (primary !== null && independent !== null) break;
      // Once a dataset is accepted, its other mirrors add nothing.
      if (primary !== null && candidate.family === primary.family) continue;
      const page = await tryFetchText(fetchText, candidate.url(wantedYear), notes);
      if (page === null) continue;
      let payload;
      try {
        payload = JSON.parse(page);
      } catch {
        notes.push(`holiday JSON did not parse: ${candidate.id} ${wantedYear}`);
        continue;
      }
      const parsedYear = candidate.parse(payload, wantedYear);
      if (parsedYear === null) continue;
      if (primary === null) {
        primary = { ...parsedYear, source: candidate.id, family: candidate.family };
      } else {
        independent = { ...parsedYear, source: candidate.id, family: candidate.family };
      }
    }

    if (primary === null) {
      notes.push(`no holiday data published yet for ${wantedYear}`);
      continue;
    }

    if (independent !== null) {
      const agreed = sameDateSet(offDaySet(primary.days), offDaySet(independent.days));
      crossChecks[wantedYear] = {
        agreed,
        sources: [primary.source, independent.source],
        primaryOffDays: primary.offDays,
        independentOffDays: independent.offDays,
      };
      if (!agreed) {
        notes.push(
          `${wantedYear}: independent holiday datasets disagree (${primary.source} vs ${independent.source}); using ${primary.source}`,
        );
      }
    }

    Object.assign(days, primary.days);
    years.push(wantedYear);
    papers.push(...primary.papers);
    sources.push(primary.source);
    fetchedAny = true;
  }

  if (!fetchedAny) {
    if (previous !== null && previous.holidays) {
      notes.push('no holiday source reachable; keeping the previous holiday table');
      return { ...previous.holidays, stale: true };
    }
    return null;
  }

  // Carry over years the sources no longer serve (an older year stays useful
  // when the clock is briefly wrong) without letting stale days win.
  for (const date of Object.keys(previousDays)) {
    if (days[date] === undefined && years.indexOf(Number(date.slice(0, 4))) === -1) days[date] = previousDays[date];
  }
  const covered = Array.from(new Set(Object.keys(days).map((date) => Number(date.slice(0, 4))))).sort();
  const checks = Object.values(crossChecks);
  const crossChecked = checks.length > 0 ? checks.every((check) => check.agreed) : null;

  return {
    days,
    years: covered,
    source: sources[0] ?? null,
    sources,
    crossChecked,
    crossChecks,
    papers: Array.from(new Set(papers)),
    fetchedAt: new Date(now).toISOString(),
    stale: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Self-check                                                                 */
/* -------------------------------------------------------------------------- */

/** The weekday of a peak-capable day list, for diagnostics. */
export function describeWeekdays(weekdays) {
  return weekdays.map((day) => WEEKDAY_NAMES[day] ?? String(day)).join('');
}

/** Structural check a dataset must pass before the client is served it. */
export function validateDataset(dataset) {
  const problems = [];
  if (dataset === null || typeof dataset !== 'object') return { ok: false, problems: ['not an object'] };
  if (Number(dataset.schema) !== SCHEMA_VERSION) problems.push('schema mismatch');
  const rule = dataset.rule;
  if (rule !== null && rule !== undefined) {
    if (!Array.isArray(rule.peakWindows) || rule.peakWindows.length === 0) problems.push('rule.peakWindows missing');
    if (!Array.isArray(rule.peakWeekdays) || rule.peakWeekdays.length === 0) problems.push('rule.peakWeekdays missing');
    if (!(typeof rule.offPeakRatio === 'number' && rule.offPeakRatio > 0 && rule.offPeakRatio <= 1)) {
      problems.push('rule.offPeakRatio invalid');
    }
  }
  return { ok: problems.length === 0, problems };
}

export { BEIJING_OFFSET_MS, DAY_MS, isoWeekdayOf, pad2 };
