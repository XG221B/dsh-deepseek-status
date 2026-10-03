/**
 * Browser half of `dsh-deepseek-status`.
 *
 * One installed bundle, two features that share nothing but the page they render
 * in. Each is built by its own factory below, so their internals keep separate
 * scopes and separate state:
 *
 *   - **pricing** — a badge in `conversation.composer.dock` showing whether the
 *     DeepSeek API is billed at peak or off-peak rates, with a countdown and the
 *     published rate table, fed by this package's Host route.
 *   - **balance** — a badge beside it showing the account balance, read through
 *     the Harness account Remote; the plugin never touches the credential.
 *
 * The pricing feature is registered unconditionally. The balance feature mounts
 * only when the composition actually provides the account namespace, so a
 * deployment without it still gets the pricing badge.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-status',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const pricing = createPricing({ React: React, h: h });
    const balance = createBalance({ React: React, h: h });

    /** Where the last activation report is left for a developer to read. */
    const DIAG_KEY = 'dsh-deepseek-status/diagnostics';

    return {
      // Hard dependencies only, and only services every web composition has.
      // This entry MUST always activate: an inactive entry fails the whole
      // desktop web boot ("web boot: 1 entry did not activate"), so anything
      // optional is mounted through ctx.inject instead of being injected here.
      inject: ['slots', 'locale'],
      apply(ctx) {
        const report = { at: new Date().toISOString(), mounted: [], failures: [] };

        // A display plugin may never take a boot down with it: each half's
        // activation failure is recorded and reported, never rethrown.
        const runPart = (part, action) => {
          try {
            action();
            report.mounted.push(part);
          } catch (error) {
            const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
            report.failures.push({
              part,
              message,
              stack: error !== null && typeof error === 'object' && typeof error.stack === 'string' ? error.stack : null,
            });
            try {
              console.error(`[dsh-deepseek-status] the ${part} half could not adapt to this composition:`, error);
            } catch (ignored) {
              /* reporting must never be the thing that throws */
            }
          }
        };

        runPart('pricing', () => pricing.apply(ctx));

        // The account namespace is optional. ctx.inject mounts a child fiber
        // that waits for it, which keeps THIS entry active either way and makes
        // ctx.remote legal inside the balance half.
        ctx.inject(['remote', 'remote.account'], (balanceCtx) => {
          runPart('balance', () => balance.apply(balanceCtx));
          publish(report);
        });

        publish(report);
      },
    };

    /**
     * Record one activation report when something went wrong.
     *
     * A healthy activation writes nothing: an optional namespace that is simply
     * absent is by design, not a failure. When a half does fail, DSH's own boot
     * audit reports only "failed" without the reason, so this leaves the reason
     * where a maintainer can read it from the profile's Local Storage.
     */
    function publish(report) {
      if (report.failures.length === 0) return;
      try {
        window.localStorage.setItem(DIAG_KEY, JSON.stringify(report));
      } catch (error) {
        /* storage is best-effort; the console line already carried the report */
      }
    }

    /** @param {{ React: unknown, h: Function }} shared - the runtime both halves render with. */
    function createPricing({ React, h }) {


    const NS = 'dsh-deepseek-status-pricing';
    const DATA_URL = '/dsh-deepseek-status/data.json';
    const SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
    const TICK_MS = 1000;
    const POLL_MS = 15 * 60 * 1000;
    const RETRY_MS = 15000;
    const RETRY_MAX_MS = 120000;
    const VISIBILITY_GAP_MS = 5 * 60 * 1000;

    /** Beijing is a fixed UTC+8 offset with no DST, so a shift is exact. */
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const SNAPSHOT_STAMP = '2026-10-02';

    /**
     * Candidate switch instants inside one Beijing day, in minutes: the billing
     * window can only change at one of these.
     */
    const SWITCH_CANDIDATES = [0, 9 * 60, 12 * 60, 14 * 60, 18 * 60];
    const SWITCH_HORIZON_DAYS = 21;

    /**
     * Built-in fallback: the rule as published on 2026-10-02 and the State
     * Council holiday periods for 2026. Used only until the Host route answers.
     */
    const SNAPSHOT_HOLIDAY_RANGES = [
      ['2026-01-01', '2026-01-03', '元旦'],
      ['2026-02-15', '2026-02-23', '春节'],
      ['2026-04-04', '2026-04-06', '清明节'],
      ['2026-05-01', '2026-05-05', '劳动节'],
      ['2026-06-19', '2026-06-21', '端午节'],
      ['2026-09-25', '2026-09-27', '中秋节'],
      ['2026-10-01', '2026-10-07', '国庆节'],
    ];

    const DICT = {
      zh: {
        peak: '峰价',
        offpeak: '谷价',
        half: '半价',
        toPeak: '距峰价 {eta}',
        toOff: '距谷价 {eta}',
        noChange: '未来三周内无切换',
        rule: '峰价时段为规则公布的工作日高峰窗口（默认北京时间周一至周五 09:00–12:00、14:00–18:00，不含中国法定节假日）；其余时段为谷价，价格为峰价的一半。',
        reasonWeekend: '周末全天谷价',
        reasonHoliday: '{name}假期（{range}）全天谷价',
        reasonPeak: '当前处于高峰时段',
        reasonOff: '非高峰时段',
        reasonNoPeakDay: '本日非峰价计费日',
        detailTitle: 'DeepSeek API 计费时段',
        beijingNow: '北京时间 {time}（{weekday}）',
        localNow: '本机时间 {time}（{zone}）',
        nextSwitch: '下次切换：{time} 转{status}（约 {eta}）',
        priceTitle: '当前价格（{status}）· {unit} / 百万 tokens',
        colModel: '模型',
        colHit: '缓存命中',
        colMiss: '缓存未命中',
        colOut: '输出',
        holidayNote: '节假日按国务院公布的放假区间计，调休上班的周末仍按谷价。',
        source: '价格与规则来源：',
        srcRuleLive: '规则与价格：DeepSeek 官方文档（{time} 自动核对）',
        srcRuleSnapshot: '规则与价格：内置快照（{date}）',
        srcRuleUnchecked: '规则与价格：{time} 核对，但中英文页面未通过交叉校验',
        srcHolidayLive: '节假日：{source}（覆盖 {years}）',
        srcHolidaySnapshot: '节假日：内置快照（覆盖 {years}）',
        srcHolidayCrossOk: '已与独立数据源交叉校验一致',
        srcHolidayCrossBad: '节假日两个独立数据源不一致，已采用 {source}',
        srcStale: '更新源暂时不可达，正在使用上次成功读取的数据',
        srcError: '尚未连接到自动更新源，当前显示内置快照',
        unknownYear: '尚无 {year} 年节假日表，该年节假日可能被误判为峰价。',
        collapse: '收起',
        etaDayHour: '{d}天{h}小时',
        etaHourMin: '{h}小时{m}分',
        etaMinSec: '{m}分{s}秒',
        etaSoon: '不到 1 分钟',
        dateMd: '{m}月{d}日',
        dateMdHm: '{m}月{d}日 {hm}',
        wd0: '周日',
        wd1: '周一',
        wd2: '周二',
        wd3: '周三',
        wd4: '周四',
        wd5: '周五',
        wd6: '周六',
      },
      en: {
        peak: 'Peak',
        offpeak: 'Off-peak',
        half: 'half price',
        toPeak: 'peak in {eta}',
        toOff: 'off-peak in {eta}',
        noChange: 'no switch within three weeks',
        rule: 'Peak hours are the published weekday windows (Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00 by default, excluding Chinese public holidays). All other hours are off-peak, at half the peak price.',
        reasonWeekend: 'Weekend: off-peak all day',
        reasonHoliday: '{name} holiday ({range}): off-peak all day',
        reasonPeak: 'Inside a peak window',
        reasonOff: 'Outside the peak windows',
        reasonNoPeakDay: 'Not a peak-billed day',
        detailTitle: 'DeepSeek API billing window',
        beijingNow: 'Beijing {time} ({weekday})',
        localNow: 'Local {time} ({zone})',
        nextSwitch: 'Next switch: {time} to {status} (in {eta})',
        priceTitle: 'Current rates ({status}) · {unit} per 1M tokens',
        colModel: 'Model',
        colHit: 'Cache hit',
        colMiss: 'Cache miss',
        colOut: 'Output',
        holidayNote: 'Holidays use the State Council holiday periods; a weekend that is a make-up workday still bills off-peak.',
        source: 'Rates and rule: ',
        srcRuleLive: 'Rule and rates: DeepSeek API Docs (checked {time})',
        srcRuleSnapshot: 'Rule and rates: built-in snapshot ({date})',
        srcRuleUnchecked: 'Rule and rates: checked {time}, the two language pages did not cross-check',
        srcHolidayLive: 'Holidays: {source} (covers {years})',
        srcHolidaySnapshot: 'Holidays: built-in snapshot (covers {years})',
        srcHolidayCrossOk: 'cross-checked against an independent dataset',
        srcHolidayCrossBad: 'Holiday datasets disagree; using {source}',
        srcStale: 'Sources unreachable; showing the last successfully read data',
        srcError: 'Not yet connected to the update source; showing the built-in snapshot',
        unknownYear: 'No {year} holiday table yet; holidays that year may read as peak.',
        collapse: 'Collapse',
        etaDayHour: '{d}d {h}h',
        etaHourMin: '{h}h {m}m',
        etaMinSec: '{m}m {s}s',
        etaSoon: 'under a minute',
        dateMd: '{m}/{d}',
        dateMdHm: '{m}/{d} {hm}',
        wd0: 'Sun',
        wd1: 'Mon',
        wd2: 'Tue',
        wd3: 'Wed',
        wd4: 'Thu',
        wd5: 'Fri',
        wd6: 'Sat',
      },
    };

    const CSS = [
      '.dpp-badge{display:inline-flex;align-items:center;gap:6px;flex:none;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}',
      '.dpp-badge:hover,.dpp-badge[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dpp-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}',
      '.dpp-dot-off{background:var(--dsw-alias-state-success-primary)}',
      '.dpp-dot-peak{background:var(--dsw-alias-state-warn-primary)}',
      '.dpp-status{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dpp-status-off{color:var(--dsw-alias-state-success-primary)}',
      '.dpp-status-peak{color:var(--dsw-alias-state-warn-primary)}',
      '.dpp-dim{color:var(--dsw-alias-label-secondary)}',
      '.dpp-chev{flex:none;transition:transform .12s ease}',
      '.dpp-chev-open{transform:rotate(180deg)}',
      '.dpp-panel{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px));max-width:var(--dsh-composer-card-max-width,100%);margin:0 auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}',
      '.dpp-head{display:flex;align-items:center;gap:8px}',
      '.dpp-title{flex:none;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dpp-chip{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dpp-close{margin-left:auto;flex:none;padding:1px 6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
      '.dpp-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dpp-grid{display:grid;grid-template-columns:minmax(0,7fr) repeat(3,minmax(0,4fr));gap:2px 10px}',
      '.dpp-grid>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dpp-grid-head{color:var(--dsw-alias-label-secondary)}',
      '.dpp-grid-model{color:var(--dsw-alias-label-primary)}',
      '.dpp-num{text-align:right}',
      '.dpp-rule{color:var(--dsw-alias-label-secondary)}',
      '.dpp-meta{color:var(--dsw-alias-label-secondary)}',
      '.dpp-line{min-width:0;overflow-wrap:anywhere}',
      '.dpp-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dpp-link{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.dpp-link:hover{text-decoration:underline}',
    ].join('');

    /* ------------------------------------------------------------------ *
     * Snapshot and runtime dataset
     * ------------------------------------------------------------------ */

    function expandRanges(ranges) {
      const days = {};
      for (const [from, to, name] of ranges) {
        for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY_MS) {
          days[new Date(at).toISOString().slice(0, 10)] = { n: name, off: true };
        }
      }
      return days;
    }

    /**
     * The holiday datasets publish their names in Chinese. An English reader
     * gets the seven statutory holidays translated; anything unrecognized keeps
     * the name it came with rather than being dropped.
     */
    const HOLIDAY_NAMES_EN = {
      元旦: "New Year's Day",
      春节: 'Spring Festival',
      清明节: 'Qingming',
      劳动节: 'Labour Day',
      端午节: 'Dragon Boat',
      中秋节: 'Mid-Autumn',
      国庆节: 'National Day',
    };

    function localizeHolidayName(name, locale) {
      if (locale !== 'en') return name;
      return HOLIDAY_NAMES_EN[name] !== undefined ? HOLIDAY_NAMES_EN[name] : name;
    }

    const SNAPSHOT = {
      schema: 1,
      builtIn: true,
      generatedAt: `${SNAPSHOT_STAMP}T09:46:00.000Z`,
      rule: {
        peakWindows: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]],
        peakWeekdays: [1, 2, 3, 4, 5],
        offPeakRatio: 0.5,
        holidayExempt: true,
        currency: 'CNY',
        models: [
          { name: 'deepseek-flash', cacheHit: [0.04, 0.02], cacheMiss: [2, 1], output: [8, 4] },
          { name: 'deepseek-v4-pro', cacheHit: [0.3, 0.15], cacheMiss: [9, 4.5], output: [27, 13.5] },
        ],
        source: SOURCE_URL,
      },
      holidays: {
        days: expandRanges(SNAPSHOT_HOLIDAY_RANGES),
        years: [2026],
        source: '内置快照（国办发明电〔2025〕7号）',
      },
      notes: [],
    };

    const datasetStore = {
      live: null,
      error: null,
      fetchedAt: null,
      listeners: new Set(),
    };

    function notifyDataset() {
      datasetStore.listeners.forEach(function (listener) {
        listener();
      });
    }

    async function loadDataset() {
      try {
        const response = await fetch(DATA_URL, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        if (payload === null || typeof payload !== 'object') throw new Error('bad payload');
        datasetStore.live = payload;
        datasetStore.error = null;
      } catch (error) {
        datasetStore.error = error && error.message ? error.message : String(error);
      } finally {
        datasetStore.fetchedAt = Date.now();
        notifyDataset();
      }
    }

    function validRule(rule) {
      return (
        rule !== null &&
        typeof rule === 'object' &&
        Array.isArray(rule.peakWindows) &&
        rule.peakWindows.length > 0 &&
        Array.isArray(rule.peakWeekdays) &&
        rule.peakWeekdays.length > 0 &&
        Array.isArray(rule.models) &&
        rule.models.length > 0
      );
    }

    /**
     * Live data wins per part. The built-in holiday days are used only for the
     * years the live payload does not cover, so a live year is never mixed with
     * snapshot entries.
     */
    function viewOf(live) {
      const liveRule = live !== null && live !== undefined && validRule(live.rule) ? live.rule : null;
      const rule = liveRule !== null ? liveRule : SNAPSHOT.rule;
      const liveHolidays = live !== null && live !== undefined && live.holidays && live.holidays.days ? live.holidays : null;
      const liveDays = liveHolidays !== null ? liveHolidays.days : null;
      const covered = new Set(
        liveDays === null ? [] : (Array.isArray(liveHolidays.years) ? liveHolidays.years : []).map(Number),
      );
      if (liveDays !== null && covered.size === 0) {
        for (const date of Object.keys(liveDays)) covered.add(Number(date.slice(0, 4)));
      }
      const days = {};
      if (liveDays === null || covered.size === 0) {
        Object.assign(days, SNAPSHOT.holidays.days);
      } else {
        for (const [date, entry] of Object.entries(SNAPSHOT.holidays.days)) {
          if (!covered.has(Number(date.slice(0, 4)))) days[date] = entry;
        }
        for (const [date, entry] of Object.entries(liveDays)) days[date] = entry;
      }
      return {
        rule,
        days,
        ruleLive: liveRule !== null,
        ruleUnchecked: liveRule !== null && liveRule.crossChecked !== true,
        ruleFetchedAt: liveRule !== null ? liveRule.fetchedAt ?? (live ? live.generatedAt : null) : null,
        holidaysLive: liveDays !== null,
        holidaysStale: liveHolidays !== null && liveHolidays.stale === true,
        holidaysCrossChecked: liveHolidays !== null && liveHolidays.crossChecked !== undefined ? liveHolidays.crossChecked : null,
        holidaysSource: liveHolidays !== null && liveHolidays.source ? liveHolidays.source : SNAPSHOT.holidays.source,
        holidayYears: Array.from(new Set(Object.keys(days).map((date) => Number(date.slice(0, 4))))).sort((a, b) => a - b),
      };
    }

    /* ------------------------------------------------------------------ *
     * Time and billing-window math
     * ------------------------------------------------------------------ */

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** Beijing wall-clock parts for an instant, read through the UTC getters. */
    function beijingParts(ms) {
      const d = new Date(ms + BEIJING_OFFSET_MS);
      const month = d.getUTCMonth() + 1;
      const date = d.getUTCDate();
      return {
        y: d.getUTCFullYear(),
        mo: month,
        da: date,
        h: d.getUTCHours(),
        mi: d.getUTCMinutes(),
        day: d.getUTCDay(),
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        date: d.getUTCFullYear() + '-' + pad2(month) + '-' + pad2(date),
      };
    }

    /** Contiguous off-day run carrying the same holiday name as `date`. */
    function holidayRun(days, date, name) {
      const step = (value, direction) =>
        new Date(Date.parse(value + 'T00:00:00Z') + direction * DAY_MS).toISOString().slice(0, 10);
      let start = date;
      let end = date;
      for (;;) {
        const previous = step(start, -1);
        const entry = days[previous];
        if (entry === undefined || entry.off !== true || entry.n !== name) break;
        start = previous;
      }
      for (;;) {
        const next = step(end, 1);
        const entry = days[next];
        if (entry === undefined || entry.off !== true || entry.n !== name) break;
        end = next;
      }
      return [start, end];
    }

    /**
     * The billing window at one instant. A day that is not a peak weekday bills
     * off-peak in full; so does a listed holiday; otherwise only the rule's
     * published windows are peak.
     */
    function statusAt(ms, view) {
      const parts = beijingParts(ms);
      const rule = view.rule;
      if (rule.peakWeekdays.indexOf(parts.day) === -1) {
        return { peak: false, kind: parts.day === 0 || parts.day === 6 ? 'weekend' : 'nonPeakDay' };
      }
      const entry = view.days[parts.date];
      if (rule.holidayExempt !== false && entry !== undefined && entry.off === true) {
        return { peak: false, kind: 'holiday', name: entry.n, date: parts.date };
      }
      const inWindow = rule.peakWindows.some(function (window) {
        return parts.minutes >= window[0] && parts.minutes < window[1];
      });
      return { peak: inWindow, kind: inWindow ? 'peakWindow' : 'offWindow' };
    }

    /**
     * The first instant that bills differently from `ms`. The window only
     * changes at one of a few instants inside a Beijing day, so scanning those
     * candidates is exact and cheap.
     */
    function nextSwitch(ms, view) {
      const current = statusAt(ms, view).peak;
      const startOfDay = Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS;
      for (let day = 0; day <= SWITCH_HORIZON_DAYS; day += 1) {
        for (const minutes of SWITCH_CANDIDATES) {
          const at = startOfDay + day * DAY_MS + minutes * 60 * 1000;
          if (at <= ms) continue;
          const status = statusAt(at, view);
          if (status.peak !== current) return { at, toPeak: status.peak };
        }
      }
      return null;
    }

    function etaText(t, ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const d = Math.floor(total / 86400);
      const rest = total % 86400;
      const hour = Math.floor(rest / 3600);
      const minute = Math.floor((rest % 3600) / 60);
      if (d > 0) return t('etaDayHour', { d: d, h: hour });
      if (hour > 0) return t('etaHourMin', { h: hour, m: minute });
      if (minute > 0) return t('etaMinSec', { m: minute, s: total % 60 });
      return t('etaSoon');
    }

    function dateLabel(t, ms) {
      const parts = beijingParts(ms);
      return t('dateMd', { m: parts.mo, d: parts.da });
    }

    function dateTimeLabel(t, ms) {
      const parts = beijingParts(ms);
      return dateLabel(t, ms) + ' ' + pad2(parts.h) + ':' + pad2(parts.mi);
    }

    function stampLabel(t, iso) {
      if (typeof iso !== 'string') return null;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return null;
      const parts = beijingParts(ms);
      return t('dateMdHm', { m: parts.mo, d: parts.da, hm: pad2(parts.h) + ':' + pad2(parts.mi) });
    }

    function rangeLabel(t, fromIso, toIso) {
      const from = beijingParts(Date.parse(fromIso + 'T00:00:00Z') - BEIJING_OFFSET_MS);
      const to = beijingParts(Date.parse(toIso + 'T00:00:00Z') - BEIJING_OFFSET_MS);
      return t('dateMd', { m: from.mo, d: from.da }) + '–' + t('dateMd', { m: to.mo, d: to.da });
    }

    function yearsLabel(years) {
      if (years.length === 0) return '—';
      const sorted = years.slice().sort((a, b) => a - b);
      const contiguous = sorted.every((year, index) => index === 0 || year === sorted[index - 1] + 1);
      if (contiguous && sorted.length > 1) return sorted[0] + '–' + sorted[sorted.length - 1];
      return sorted.join('、');
    }

    function money(value) {
      return String(value);
    }

    function unitLabel(currency) {
      return currency === 'USD' ? 'USD' : '元';
    }

    function browserZone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch (error) {
        return null;
      }
    }

    function localTimeLabel(locale, ms) {
      try {
        return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(ms));
      } catch (error) {
        return new Date(ms).toLocaleString();
      }
    }

    /* ------------------------------------------------------------------ *
     * Translation
     * ------------------------------------------------------------------ */

    let localeService = null;
    let boundT = null;

    function interpolate(template, params) {
      if (typeof template !== 'string') return '';
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
      });
    }

    function translate(key, params) {
      if (boundT !== null) return boundT(key, params);
      const active = localeService === null ? 'zh' : localeService.getLocale().active;
      const dict = DICT[active] || DICT.zh;
      return interpolate(dict[key] !== undefined ? dict[key] : DICT.en[key], params);
    }

    function useActiveLocale() {
      const [active, setActive] = React.useState(function () {
        return localeService === null ? 'zh' : localeService.getLocale().active;
      });
      React.useEffect(function () {
        if (localeService === null) return undefined;
        return localeService.subscribe(function () {
          setActive(localeService.getLocale().active);
        });
      }, []);
      return active;
    }

    /** Ticks once a second while the consumer is on screen. */
    function useNow(enabled) {
      const [now, setNow] = React.useState(function () {
        return Date.now();
      });
      React.useEffect(
        function () {
          if (!enabled) return undefined;
          setNow(Date.now());
          const timer = setInterval(function () {
            setNow(Date.now());
          }, TICK_MS);
          return function () {
            clearInterval(timer);
          };
        },
        [enabled],
      );
      return now;
    }

    /** Re-renders when the Host route answers. */
    function useView() {
      const [version, setVersion] = React.useState(0);
      React.useEffect(function () {
        const listener = function () {
          setVersion(function (value) {
            return value + 1;
          });
        };
        datasetStore.listeners.add(listener);
        return function () {
          datasetStore.listeners.delete(listener);
        };
      }, []);
      void version;
      return viewOf(datasetStore.live);
    }

    /* ------------------------------------------------------------------ *
     * Expansion, shared by the badge and the detail card
     * ------------------------------------------------------------------ */

    const expansion = { open: false, listeners: new Set() };

    function setExpanded(next) {
      if (expansion.open === next) return;
      expansion.open = next;
      expansion.listeners.forEach(function (listener) {
        listener();
      });
    }

    function useExpanded() {
      const [open, setOpen] = React.useState(expansion.open);
      React.useEffect(function () {
        const listener = function () {
          setOpen(expansion.open);
        };
        expansion.listeners.add(listener);
        return function () {
          expansion.listeners.delete(listener);
        };
      }, []);
      return [open, setExpanded];
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function Chevron(open) {
      return h(
        'svg',
        {
          className: open ? 'dpp-chev dpp-chev-open' : 'dpp-chev',
          viewBox: '0 0 12 12',
          width: 12,
          height: 12,
          'aria-hidden': true,
        },
        h('path', {
          d: 'M2.5 4.5 L6 8 L9.5 4.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function Badge(props) {
      const t = props && typeof props.t === 'function' ? props.t : translate;
      const now = useNow(true);
      const view = useView();
      const state = statusAt(now, view);
      const next = nextSwitch(now, view);
      const expanded = useExpanded();
      const open = expanded[0];
      const statusLabel = t(state.peak ? 'peak' : 'offpeak');
      const countdown = next === null
        ? t('noChange')
        : t(next.toPeak ? 'toPeak' : 'toOff', { eta: etaText(t, next.at - now) });
      return h(
        'button',
        {
          type: 'button',
          className: 'dpp-badge',
          'aria-expanded': open,
          title: t('rule'),
          onClick: function () {
            expanded[1](!open);
          },
        },
        [
          h('span', {
            key: 'dot',
            className: state.peak ? 'dpp-dot dpp-dot-peak' : 'dpp-dot dpp-dot-off',
            'aria-hidden': true,
          }),
          h(
            'span',
            { key: 'status', className: state.peak ? 'dpp-status dpp-status-peak' : 'dpp-status dpp-status-off' },
            statusLabel,
          ),
          h('span', { key: 'sep', className: 'dpp-dim' }, '·'),
          h('span', { key: 'eta', className: 'dpp-dim' }, countdown),
          h('span', { key: 'chev' }, Chevron(open)),
        ],
      );
    }

    function gridCells(cells) {
      return cells.map(function (cell, index) {
        return h('span', { key: index, className: cell.className }, cell.text);
      });
    }

    function Detail(props) {
      const t = props && typeof props.t === 'function' ? props.t : translate;
      const active = useActiveLocale();
      const expanded = useExpanded();
      const open = expanded[0];
      const now = useNow(open);
      const view = useView();

      React.useEffect(
        function () {
          if (!open) return undefined;
          const onKeyDown = function (event) {
            if (event.key === 'Escape') setExpanded(false);
          };
          document.addEventListener('keydown', onKeyDown);
          return function () {
            document.removeEventListener('keydown', onKeyDown);
          };
        },
        [open],
      );

      if (!open) return null;

      const state = statusAt(now, view);
      const next = nextSwitch(now, view);
      const statusLabel = t(state.peak ? 'peak' : 'offpeak');
      const parts = beijingParts(now);
      const period = state.peak ? 0 : 1;
      const rule = view.rule;

      let reason;
      if (state.kind === 'weekend') reason = t('reasonWeekend');
      else if (state.kind === 'holiday') {
        const run = holidayRun(view.days, state.date, state.name);
        reason = t('reasonHoliday', { name: localizeHolidayName(state.name, active), range: rangeLabel(t, run[0], run[1]) });
      } else if (state.kind === 'peakWindow') reason = t('reasonPeak');
      else if (state.kind === 'nonPeakDay') reason = t('reasonNoPeakDay');
      else reason = t('reasonOff');

      const head = [t('colModel'), t('colHit'), t('colMiss'), t('colOut')];
      const cells = gridCells(
        head.map(function (text, index) {
          return { text, className: index === 0 ? 'dpp-grid-head' : 'dpp-grid-head dpp-num' };
        }),
      );
      for (const model of rule.models) {
        const row = [
          model.name,
          money(model.cacheHit[period]),
          money(model.cacheMiss[period]),
          money(model.output[period]),
        ];
        row.forEach(function (text, index) {
          cells.push(
            h('span', { key: 'c' + cells.length, className: index === 0 ? 'dpp-grid-model' : 'dpp-num' }, text),
          );
        });
      }

      const lines = [];
      lines.push(h('div', { key: 'reason', className: 'dpp-line' }, reason));
      lines.push(
        h(
          'div',
          { key: 'now', className: 'dpp-line' },
          t('beijingNow', { time: dateTimeLabel(t, now), weekday: t('wd' + parts.day) }),
        ),
      );
      const zone = browserZone();
      if (zone !== null && zone !== 'Asia/Shanghai') {
        lines.push(
          h('div', { key: 'local', className: 'dpp-line' }, t('localNow', { time: localTimeLabel(active, now), zone })),
        );
      }
      lines.push(
        h(
          'div',
          { key: 'next', className: 'dpp-line' },
          next === null
            ? t('noChange')
            : t('nextSwitch', {
              time: dateTimeLabel(t, next.at),
              status: t(next.toPeak ? 'peak' : 'offpeak'),
              eta: etaText(t, next.at - now),
            }),
        ),
      );
      lines.push(
        h(
          'div',
          { key: 'priceTitle', className: 'dpp-line' },
          t('priceTitle', { status: statusLabel, unit: unitLabel(rule.currency) }),
        ),
      );
      lines.push(h('div', { key: 'grid', className: 'dpp-grid' }, cells));
      lines.push(h('div', { key: 'rule', className: 'dpp-line dpp-rule' }, t('rule')));
      lines.push(h('div', { key: 'note', className: 'dpp-line dpp-rule' }, t('holidayNote')));

      // Provenance: which source each half of the answer came from, so a
      // fallback to the snapshot is visible instead of silent.
      if (view.ruleLive) {
        const checked = stampLabel(t, view.ruleFetchedAt);
        lines.push(
          h(
            'div',
            { key: 'srcRule', className: 'dpp-line dpp-meta' },
            view.ruleUnchecked
              ? t('srcRuleUnchecked', { time: checked !== null ? checked : '—' })
              : t('srcRuleLive', { time: checked !== null ? checked : '—' }),
          ),
        );
      } else {
        lines.push(h('div', { key: 'srcRule', className: 'dpp-line dpp-meta' }, t('srcRuleSnapshot', { date: SNAPSHOT_STAMP })));
      }
      lines.push(
        h(
          'div',
          { key: 'srcHoliday', className: 'dpp-line dpp-meta' },
          view.holidaysLive
            ? t('srcHolidayLive', { source: view.holidaysSource, years: yearsLabel(view.holidayYears) })
            : t('srcHolidaySnapshot', { years: yearsLabel(view.holidayYears) }),
        ),
      );
      if (view.holidaysLive && view.holidaysCrossChecked === true) {
        lines.push(h('div', { key: 'crossOk', className: 'dpp-line dpp-meta' }, t('srcHolidayCrossOk')));
      }
      if (view.holidaysLive && view.holidaysCrossChecked === false) {
        lines.push(
          h('div', { key: 'crossBad', className: 'dpp-line dpp-warn' }, t('srcHolidayCrossBad', { source: view.holidaysSource })),
        );
      }
      if (view.holidaysStale) {
        lines.push(h('div', { key: 'stale', className: 'dpp-line dpp-warn' }, t('srcStale')));
      }
      if (!view.ruleLive && !view.holidaysLive) {
        lines.push(h('div', { key: 'err', className: 'dpp-line dpp-warn' }, t('srcError')));
      }
      if (view.holidayYears.indexOf(parts.y) === -1) {
        lines.push(h('div', { key: 'warn', className: 'dpp-line dpp-warn' }, t('unknownYear', { year: parts.y })));
      }
      lines.push(
        h(
          'div',
          { key: 'source', className: 'dpp-line dpp-rule' },
          t('source'),
          h(
            'a',
            { className: 'dpp-link', href: SOURCE_URL, target: '_blank', rel: 'noreferrer' },
            'api-docs.deepseek.com',
          ),
          ' + ',
          h(
            'a',
            { className: 'dpp-link', href: 'https://github.com/NateScarlet/holiday-cn', target: '_blank', rel: 'noreferrer' },
            'holiday-cn',
          ),
        ),
      );

      return h(
        'div',
        { className: 'dpp-panel' },
        h('div', { className: 'dpp-head' }, [
          h('span', {
            key: 'dot',
            className: state.peak ? 'dpp-dot dpp-dot-peak' : 'dpp-dot dpp-dot-off',
            'aria-hidden': true,
          }),
          h('span', { key: 'title', className: 'dpp-title' }, t('detailTitle')),
          h(
            'span',
            { key: 'chip', className: 'dpp-chip' },
            state.peak ? statusLabel : statusLabel + ' · ' + t('half'),
          ),
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dpp-close',
              title: t('collapse'),
              'aria-label': t('collapse'),
              onClick: function () {
                setExpanded(false);
              },
            },
            '✕',
          ),
        ]),
        lines,
      );
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeService = ctx.locale;
        boundT = localeService.bind(NS);

        ctx.effect(function () {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-deepseek-status/pricing';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () {
            tag.remove();
          };
        }, 'dsh-deepseek-status: pricing styles');

        ctx.effect(function () {
          return localeService.register(NS, 'zh', DICT.zh);
        }, 'dsh-deepseek-status: pricing zh dictionary');

        ctx.effect(function () {
          return localeService.register(NS, 'en', DICT.en);
        }, 'dsh-deepseek-status: pricing en dictionary');

        ctx.effect(
          function () {
            let disposed = false;
            let timer = null;
            let attempts = 0;
            const schedule = function () {
              if (disposed) return;
              const delay = datasetStore.live === null
                ? Math.min(RETRY_MS * Math.pow(2, attempts), RETRY_MAX_MS)
                : POLL_MS;
              attempts = datasetStore.live === null ? attempts + 1 : 0;
              timer = setTimeout(run, delay);
            };
            const run = function () {
              loadDataset().then(function () {
                schedule();
              });
            };
            const onVisibility = function () {
              if (document.visibilityState !== 'visible') return;
              const since = Date.now() - (datasetStore.fetchedAt === null ? 0 : datasetStore.fetchedAt);
              if (since >= VISIBILITY_GAP_MS) {
                if (timer !== null) clearTimeout(timer);
                run();
              }
            };
            document.addEventListener('visibilitychange', onVisibility);
            run();
            return function () {
              disposed = true;
              if (timer !== null) clearTimeout(timer);
              document.removeEventListener('visibilitychange', onVisibility);
            };
          },
          'dsh-deepseek-status: pricing dataset polling',
        );

        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-deepseek-status-pricing',
              order: 20,
              locale: NS,
            },
            Badge,
          );
        });

        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-deepseek-status-pricing-detail',
              order: 30,
              locale: NS,
            },
            Detail,
          );
        });
      },
    };

    }

    /** @param {{ React: unknown, h: Function }} shared - the runtime both halves render with. */
    function createBalance({ React, h }) {


    const NS = 'dsh-deepseek-status-balance';

    /** How often the balance is re-read while the page is visible. */
    const POLL_MS = 60000;
    /** Floor between two reads, so clicking refresh repeatedly cannot spam. */
    const MIN_REFRESH_GAP_MS = 5000;
    /**
     * The DSH client version this build was written against. The Host forwards
     * it to Platform as "which UI asked"; it carries no authority and is only
     * informational. Bump it with a DSH upgrade.
     */
    const CLIENT_VERSION = '0.2.0-rc.2';

    /* ------------------------------------------------------------------ *
     * Amount formatting and Remote-result mapping (pure)
     * ------------------------------------------------------------------ */

    /** Currency symbol, chosen from the currency code exactly as the account page does. */
    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥';
      if (currency === 'USD') return '$';
      return currency === '' || currency === undefined ? '' : currency + ' ';
    }

    /**
     * Format one Platform amount string for display.
     *
     * Follows the account page's convention: two decimals with digit grouping,
     * positive sub-cent amounts as `<0.01`, and a negative amount never smaller
     * in magnitude than 0.01. Parsing is textual, so a long decimal is never
     * rounded by binary floating point.
     */
    function formatAmount(raw) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw);
      const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
      if (match === null) return text;
      const negative = match[1] === '-';
      const fraction = match[3] === undefined ? '' : match[3];
      const shownFraction = fraction.slice(0, 2).padEnd(2, '0');
      const zeroInteger = /^0+$/.test(match[2]);
      const zeroShown = zeroInteger && shownFraction === '00';
      const hasDeeperValue = /[1-9]/.test(fraction.slice(2));
      if (!negative && zeroShown && hasDeeperValue) return '<0.01';
      if (zeroShown && !hasDeeperValue) return '0.00';
      const integer = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      if (negative) {
        const magnitudeIsZero = zeroShown;
        return '-' + integer + '.' + (magnitudeIsZero ? '01' : shownFraction);
      }
      return integer + '.' + shownFraction;
    }

    /** One amount string in cents, for summing only. */
    function toCents(text) {
      const match = /^([+-]?)(\d+)(?:\.(\d{0,2}))?/.exec(String(text).trim());
      if (match === null) return 0;
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (Number(match[2]) * 100 + Number((match[3] === undefined ? '' : match[3]).padEnd(2, '0')));
    }

    /** Cents back to a two-decimal string. */
    function fromCents(cents) {
      const sign = cents < 0 ? '-' : '';
      const magnitude = Math.abs(cents);
      return sign + String(Math.floor(magnitude / 100)) + '.' + String(magnitude % 100).padStart(2, '0');
    }

    /** Wallet entries grouped by currency, each with its summed total. */
    function groupWallets(wallets) {
      const groups = [];
      const seen = new Map();
      for (const wallet of Array.isArray(wallets) ? wallets : []) {
        if (wallet === null || typeof wallet !== 'object') continue;
        const currency = typeof wallet.currency === 'string' ? wallet.currency : '';
        if (currency === '') continue;
        if (!seen.has(currency)) {
          seen.set(currency, groups.length);
          groups.push({ currency, cents: 0, count: 0 });
        }
        const group = groups[seen.get(currency)];
        group.cents += toCents(wallet.balance);
        group.count += 1;
      }
      return groups.map(function (group) {
        return { currency: group.currency, total: fromCents(group.cents), cents: group.cents, count: group.count };
      });
    }

    /** Total across wallets when (and only when) they share one currency. */
    function singleCurrencyTotal(wallets) {
      const groups = groupWallets(wallets);
      if (groups.length !== 1 || groups[0].count < 2) return null;
      return groups[0];
    }

    /**
     * Turn the account Remote's answer into a store patch.
     *
     * The envelope is `{ ok, value }`, where `value` is either `null` (no
     * account wallet), `{ status: 'ready', value, bonusWallets }`, or
     * `{ status: 'failed' }`. Anything else is reported as an unknown shape
     * instead of being rendered as zero.
     */
    function mapBalance(balanceResult, accountState) {
      const account = accountState === undefined ? null : accountState;
      if (balanceResult === null || typeof balanceResult !== 'object') {
        return { status: 'failed', error: 'no-result', account };
      }
      if (balanceResult.ok !== true) {
        const code = balanceResult.error !== null && typeof balanceResult.error === 'object' && typeof balanceResult.error.code === 'string'
          ? balanceResult.error.code
          : 'remote-failed';
        return { status: 'failed', error: code, account };
      }
      const value = balanceResult.value;
      if (value === null || value === undefined) {
        return { status: 'empty', wallets: [], bonusWallets: [], error: null, account };
      }
      if (value.status === 'failed') return { status: 'failed', error: 'platform-failed', account };
      if (value.status === 'ready') {
        return {
          status: 'ready',
          wallets: Array.isArray(value.value) ? value.value : [],
          bonusWallets: Array.isArray(value.bonusWallets) ? value.bonusWallets : [],
          error: null,
          account,
        };
      }
      return { status: 'failed', error: 'unknown-shape', account };
    }

    /** Positive bonus wallets, the only ones the account page shows. */
    function visibleBonusWallets(bonusWallets) {
      return groupWallets(bonusWallets).filter(function (group) {
        return group.cents > 0;
      });
    }

    /**
     * The wallets that make up what the account can actually spend.
     *
     * Platform's total balance is the topped-up balance plus the granted credit,
     * and the projected envelope keeps those in two lists. Anything that answers
     * "how much is left" must add both, or an account holding granted credit but
     * no top-up would read as zero.
     */
    function availableWallets(view) {
      const wallets = view !== null && typeof view === 'object' && Array.isArray(view.wallets) ? view.wallets : [];
      const bonus = view !== null && typeof view === 'object' && Array.isArray(view.bonusWallets) ? view.bonusWallets : [];
      return wallets.concat(bonus);
    }

    /** The badge text for one wallet set. */
    function badgeAmountText(wallets) {
      const groups = groupWallets(wallets);
      if (groups.length === 0) return null;
      return groups
        .map(function (group) {
          return currencySymbol(group.currency) + formatAmount(group.total);
        })
        .join(' ');
    }

    const DICT = {
      zh: {
        label: '余额',
        loading: '余额 …',
        unavailable: '余额 —',
        refreshing: '刷新中',
        refresh: '刷新',
        detailTitle: 'DeepSeek 账户余额',
        topUpRow: '充值余额',
        bonusRow: '赠送余额',
        totalRow: '合计',
        noWallet: '暂无可显示的余额',
        accountRow: '账户',
        signedIn: '已登录（DeepSeek 账号）',
        signedOut: '未登录',
        accountUnknown: '状态未知',
        updatedRow: '最后更新',
        justNow: '刚刚',
        secondsAgo: '{n} 秒前',
        minutesAgo: '{n} 分钟前',
        autoNote: '页面可见时每 60 秒自动刷新',
        hiddenNote: '页面不在前台时暂停请求',
        failedPlatform: '读取失败：平台未返回余额，可稍后重试',
        failedRemote: '读取失败：连接不可用（{code}）',
        failedShape: '读取失败：返回结构与预期不符',
        emptyNote: '当前 Harness 账号没有可用钱包（例如只用 API key 时），因此不显示余额',
        topUp: '去充值',
        usage: '查看用量',
        privacy: '余额由 Harness 账号服务读取；本插件不接触你的密钥，不写入磁盘，也不外发。',
        collapse: '收起',
      },
      en: {
        label: 'Balance',
        loading: 'Balance …',
        unavailable: 'Balance —',
        refreshing: 'Refreshing',
        refresh: 'Refresh',
        detailTitle: 'DeepSeek account balance',
        topUpRow: 'Topped up',
        bonusRow: 'Granted credit',
        totalRow: 'Total',
        noWallet: 'No balance to show yet',
        accountRow: 'Account',
        signedIn: 'Signed in (DeepSeek account)',
        signedOut: 'Signed out',
        accountUnknown: 'Unknown',
        updatedRow: 'Updated',
        justNow: 'just now',
        secondsAgo: '{n}s ago',
        minutesAgo: '{n}m ago',
        autoNote: 'refreshes every 60s while this page is visible',
        hiddenNote: 'requests pause while the page is in the background',
        failedPlatform: 'Read failed: the platform returned no balance; try again later',
        failedRemote: 'Read failed: connection unavailable ({code})',
        failedShape: 'Read failed: unexpected response shape',
        emptyNote: 'This Harness account has no wallet to report (an API-key-only setup looks like this), so no balance is shown',
        topUp: 'Top up',
        usage: 'Usage',
        privacy: 'Read through the Harness account service; this plugin never touches your key, writes nothing to disk, and sends nothing anywhere.',
        collapse: 'Collapse',
      },
    };

    const CSS = [
      '.dsb-badge{display:inline-flex;align-items:center;gap:6px;flex:none;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}',
      '.dsb-badge:hover,.dsb-badge[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsb-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}',
      '.dsb-dot-ready{background:var(--dsw-alias-state-success-primary)}',
      '.dsb-dot-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.dsb-amount{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsb-amount-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dsb-dim{color:var(--dsw-alias-label-secondary)}',
      '.dsb-chev{flex:none;transition:transform .12s ease}',
      '.dsb-chev-open{transform:rotate(180deg)}',
      '.dsb-panel{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px));max-width:var(--dsh-composer-card-max-width,100%);margin:0 auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}',
      '.dsb-head{display:flex;align-items:center;gap:8px}',
      '.dsb-title{flex:none;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsb-chip{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsb-action{margin-left:auto;flex:none;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
      '.dsb-action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsb-close{flex:none;padding:1px 6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
      '.dsb-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsb-rows{display:grid;grid-template-columns:minmax(0,6fr) repeat(2,minmax(0,4fr));gap:2px 10px;align-items:baseline}',
      '.dsb-rows>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dsb-rowLabel{color:var(--dsw-alias-label-secondary)}',
      '.dsb-rowValue{text-align:right;color:var(--dsw-alias-label-primary)}',
      '.dsb-total{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsb-note{color:var(--dsw-alias-label-secondary)}',
      '.dsb-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dsb-note,.dsb-warn,.dsb-rowLabel,.dsb-rowValue{min-width:0;overflow-wrap:anywhere}',
      '.dsb-links{display:flex;gap:8px}',
      '.dsb-link{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.dsb-link:hover{text-decoration:underline}',
    ].join('');

    /* ------------------------------------------------------------------ *
     * Store
     * ------------------------------------------------------------------ */

    const store = {
      status: 'idle',
      wallets: [],
      bonusWallets: [],
      account: null,
      error: null,
      fetchedAt: null,
      listeners: new Set(),
    };

    let inflight = null;
    /** Assigned in `apply`: the account namespace every read goes through. */
    let remoteAccount = null;

    /** Active UI language, carried to Platform as part of the client metadata. */
    function currentLocale() {
      try {
        return localeService === null ? 'en' : localeService.getLocale().active;
      } catch (error) {
        return 'en';
      }
    }

    /**
     * Read the balance once through the account Remote.
     *
     * Returns the in-flight promise so callers can await a completed read. A
     * non-forced call inside `MIN_REFRESH_GAP_MS` resolves immediately instead
     * of asking Platform again.
     */
    function refresh(force) {
      if (inflight !== null) return inflight;
      const started = Date.now();
      if (!force && store.fetchedAt !== null && started - store.fetchedAt < MIN_REFRESH_GAP_MS) {
        return Promise.resolve();
      }
      inflight = (async function () {
        let patch;
        try {
          const metadata = {
            version: CLIENT_VERSION,
            locale: currentLocale(),
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          };
          const account = remoteAccount;
          const [balanceResult, accountState] = await Promise.all([
            Promise.resolve(account.getBalance(metadata)),
            typeof account.getState === 'function'
              ? Promise.resolve(account.getState()).then(function (result) {
                return result !== null && typeof result === 'object' && result.ok === true ? result.value : null;
              }).catch(function () {
                return null;
              })
              : Promise.resolve(null),
          ]);
          patch = mapBalance(balanceResult, accountState);
        } catch (error) {
          patch = {
            status: 'failed',
            error: error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : 'request-threw',
            account: store.account,
          };
        }
        Object.assign(store, patch);
        store.fetchedAt = Date.now();
        notify();
      })().finally(function () {
        inflight = null;
      });
      return inflight;
    }

    function notify() {
      store.listeners.forEach(function (listener) {
        listener();
      });
    }

    function useStore() {
      const [version, setVersion] = React.useState(0);
      React.useEffect(function () {
        const listener = function () {
          setVersion(function (value) {
            return value + 1;
          });
        };
        store.listeners.add(listener);
        return function () {
          store.listeners.delete(listener);
        };
      }, []);
      void version;
      return store;
    }

    /* ------------------------------------------------------------------ *
     * Translation
     * ------------------------------------------------------------------ */

    let localeService = null;
    let boundT = null;

    function interpolate(template, params) {
      if (typeof template !== 'string') return '';
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
      });
    }

    function translate(key, params) {
      if (boundT !== null) return boundT(key, params);
      const active = localeService === null ? 'zh' : localeService.getLocale().active;
      const dict = DICT[active] || DICT.zh;
      return interpolate(dict[key] !== undefined ? dict[key] : DICT.en[key], params);
    }

    /** Ticks so "updated N seconds ago" stays honest without re-reading anything. */
    function useClock(enabled) {
      const [now, setNow] = React.useState(function () {
        return Date.now();
      });
      React.useEffect(
        function () {
          if (!enabled) return undefined;
          setNow(Date.now());
          const timer = setInterval(function () {
            setNow(Date.now());
          }, 1000);
          return function () {
            clearInterval(timer);
          };
        },
        [enabled],
      );
      return now;
    }

    /* ------------------------------------------------------------------ *
     * Expansion, shared by the badge and the detail card
     * ------------------------------------------------------------------ */

    const expansion = { open: false, listeners: new Set() };

    function setExpanded(next) {
      if (expansion.open === next) return;
      expansion.open = next;
      expansion.listeners.forEach(function (listener) {
        listener();
      });
    }

    function useExpanded() {
      const [open, setOpen] = React.useState(expansion.open);
      React.useEffect(function () {
        const listener = function () {
          setOpen(expansion.open);
        };
        expansion.listeners.add(listener);
        return function () {
          expansion.listeners.delete(listener);
        };
      }, []);
      return [open, setExpanded];
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function Chevron(open) {
      return h(
        'svg',
        {
          className: open ? 'dsb-chev dsb-chev-open' : 'dsb-chev',
          viewBox: '0 0 12 12',
          width: 12,
          height: 12,
          'aria-hidden': true,
        },
        h('path', {
          d: 'M2.5 4.5 L6 8 L9.5 4.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function Badge(props) {
      const t = props && typeof props.t === 'function' ? props.t : translate;
      const view = useStore();
      const expanded = useExpanded();
      const open = expanded[0];

      // No wallet to report: show nothing rather than a fabricated zero.
      if (view.status === 'empty') return null;

      const ready = view.status === 'ready';
      const spendable = availableWallets(view);
      const amount = ready ? badgeAmountText(spendable) : null;
      const zero = ready && groupWallets(spendable).every(function (group) {
        return group.cents === 0;
      });
      const failed = view.status === 'failed';
      const text = amount === null ? (view.status === 'idle' ? t('loading') : t('unavailable')) : amount;
      const title = failed
        ? view.error === 'platform-failed'
          ? t('failedPlatform')
          : view.error === 'unknown-shape'
            ? t('failedShape')
            : t('failedRemote', { code: view.error === null ? 'unknown' : view.error })
        : t('label');

      return h(
        'button',
        {
          type: 'button',
          className: 'dsb-badge',
          'aria-expanded': open,
          title,
          onClick: function () {
            expanded[1](!open);
          },
        },
        [
          h('span', {
            key: 'dot',
            className: 'dsb-dot' + (failed || zero ? ' dsb-dot-warn' : ' dsb-dot-ready'),
            'aria-hidden': true,
          }),
          h('span', { key: 'label', className: 'dsb-dim' }, t('label')),
          h(
            'span',
            { key: 'amount', className: failed || zero ? 'dsb-amount dsb-amount-warn' : 'dsb-amount' },
            text,
          ),
          h('span', { key: 'chev' }, Chevron(open)),
        ],
      );
    }

    function agoText(t, now, at) {
      if (at === null) return t('justNow');
      const seconds = Math.max(0, Math.round((now - at) / 1000));
      if (seconds < 5) return t('justNow');
      if (seconds < 60) return t('secondsAgo', { n: seconds });
      return t('minutesAgo', { n: Math.round(seconds / 60) });
    }

    function Detail(props) {
      const t = props && typeof props.t === 'function' ? props.t : translate;
      const expanded = useExpanded();
      const open = expanded[0];
      const view = useStore();
      const [busy, setBusy] = React.useState(false);
      const mounted = React.useRef(true);
      React.useEffect(function () {
        return function () {
          mounted.current = false;
        };
      }, []);
      const now = useClock(open);

      React.useEffect(
        function () {
          if (!open) return undefined;
          const onKeyDown = function (event) {
            if (event.key === 'Escape') setExpanded(false);
          };
          document.addEventListener('keydown', onKeyDown);
          return function () {
            document.removeEventListener('keydown', onKeyDown);
          };
        },
        [open],
      );

      // Opening the card is a read request of its own.
      React.useEffect(
        function () {
          if (!open) return undefined;
          void refresh(true);
          return undefined;
        },
        [open],
      );

      if (!open) return null;

      const ready = view.status === 'ready';
      const groups = groupWallets(view.wallets);
      const bonus = visibleBonusWallets(view.bonusWallets);
      const spendable = availableWallets(view);
      const spendableGroups = groupWallets(spendable);
      const total = singleCurrencyTotal(spendable);
      const links = view.account !== null && typeof view.account === 'object' && view.account.links !== null && typeof view.account.links === 'object'
        ? view.account.links
        : null;
      const signedIn = view.account !== null && typeof view.account === 'object' ? view.account.status === 'credential-stored' : null;

      const rows = [];
      if (ready && groups.length > 0) {
        for (const group of groups) {
          rows.push(
            h('span', { key: 'top' + group.currency, className: 'dsb-rowLabel' }, t('topUpRow') + ' (' + group.currency + ')'),
            h('span', { key: 'topv' + group.currency, className: 'dsb-rowValue' }, currencySymbol(group.currency) + formatAmount(group.total)),
            h('span', { key: 'topx' + group.currency }),
          );
        }
        for (const group of bonus) {
          rows.push(
            h('span', { key: 'bon' + group.currency, className: 'dsb-rowLabel' }, t('bonusRow') + ' (' + group.currency + ')'),
            h('span', { key: 'bonv' + group.currency, className: 'dsb-rowValue' }, currencySymbol(group.currency) + formatAmount(group.total)),
            h('span', { key: 'bonx' + group.currency }),
          );
        }
        if (total !== null) {
          rows.push(
            h('span', { key: 'tot', className: 'dsb-rowLabel dsb-total' }, t('totalRow')),
            h('span', { key: 'totv', className: 'dsb-rowValue dsb-total' }, currencySymbol(total.currency) + formatAmount(total.total)),
            h('span', { key: 'totx' }),
          );
        }
        if (rows.length === 0) {
          rows.push(h('span', { key: 'none', className: 'dsb-rowLabel' }, t('noWallet')), h('span', { key: 'nonev' }), h('span', { key: 'nonex' }));
        }
      }

      const lines = [];
      lines.push(h('div', { key: 'rows', className: 'dsb-rows' }, rows));
      lines.push(
        h('div', { key: 'account', className: 'dsb-note' }, t('accountRow') + '：' + (
          signedIn === null ? t('accountUnknown') : signedIn ? t('signedIn') : t('signedOut')
        )),
      );
      lines.push(
        h('div', { key: 'updated', className: 'dsb-note' }, t('updatedRow') + '：' + agoText(t, now, view.fetchedAt) + ' · ' + t('autoNote')),
      );
      if (view.status === 'failed') {
        lines.push(
          h('div', { key: 'failed', className: 'dsb-warn' }, view.error === 'platform-failed'
            ? t('failedPlatform')
            : view.error === 'unknown-shape'
              ? t('failedShape')
              : t('failedRemote', { code: view.error === null ? 'unknown' : view.error })),
        );
      }
      if (view.status === 'empty') {
        lines.push(h('div', { key: 'empty', className: 'dsb-note' }, t('emptyNote')));
      }
      if (links !== null) {
        const actions = [];
        if (typeof links.topUpUrl === 'string' && links.topUpUrl !== '') {
          actions.push(h('a', { key: 'topup', className: 'dsb-link', href: links.topUpUrl, target: '_blank', rel: 'noreferrer' }, t('topUp')));
        }
        if (typeof links.usageUrl === 'string' && links.usageUrl !== '') {
          actions.push(h('a', { key: 'usage', className: 'dsb-link', href: links.usageUrl, target: '_blank', rel: 'noreferrer' }, t('usage')));
        }
        if (actions.length > 0) lines.push(h('div', { key: 'links', className: 'dsb-links' }, actions));
      }
      lines.push(h('div', { key: 'privacy', className: 'dsb-note' }, t('privacy')));

      return h(
        'div',
        { className: 'dsb-panel' },
        h('div', { className: 'dsb-head' }, [
          h('span', {
            key: 'dot',
            className: 'dsb-dot' + (view.status === 'failed' ? ' dsb-dot-warn' : ' dsb-dot-ready'),
            'aria-hidden': true,
          }),
          h('span', { key: 'title', className: 'dsb-title' }, t('detailTitle')),
          ready && spendableGroups.length === 1
            ? h('span', { key: 'chip', className: 'dsb-chip' }, currencySymbol(spendableGroups[0].currency) + formatAmount(spendableGroups[0].total))
            : null,
          h(
            'button',
            {
              key: 'refresh',
              type: 'button',
              className: 'dsb-action',
              disabled: busy,
              onClick: function () {
                setBusy(true);
                void refresh(true).then(function () {
                  // The card can be collapsed (unmounted) while a read is in flight.
                  if (mounted.current) setBusy(false);
                });
              },
            },
            busy ? t('refreshing') : t('refresh'),
          ),
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dsb-close',
              title: t('collapse'),
              'aria-label': t('collapse'),
              onClick: function () {
                setExpanded(false);
              },
            },
            '✕',
          ),
        ]),
        lines,
      );
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    return {
      // The merged plugin mounts this half only through ctx.inject, so the
      // injected services below are the ones this fiber actually receives.
      apply(ctx) {
        localeService = ctx.locale;
        boundT = localeService.bind(NS);

        ctx.effect(function () {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-deepseek-status/balance';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () {
            tag.remove();
          };
        }, 'dsh-deepseek-status: balance styles');

        ctx.effect(function () {
          return localeService.register(NS, 'zh', DICT.zh);
        }, 'dsh-deepseek-status: balance zh dictionary');

        ctx.effect(function () {
          return localeService.register(NS, 'en', DICT.en);
        }, 'dsh-deepseek-status: balance en dictionary');

        remoteAccount = ctx.remote.account;

        ctx.effect(
          function () {
            let disposed = false;
            let timer = null;

            const schedule = function () {
              if (disposed) return;
              timer = setTimeout(tick, POLL_MS);
            };
            const tick = function () {
              if (disposed) return;
              // Nothing reads a balance nobody is looking at: keep the
              // heartbeat, skip the request while the page is in the background.
              if (document.visibilityState === 'hidden') {
                schedule();
                return;
              }
              refresh(false).then(schedule, schedule);
            };

            let unsubscribe = null;
            try {
              if (typeof ctx.remote.$on === 'function') {
                unsubscribe = ctx.remote.$on('credentials/reference-updated', function () {
                  void refresh(true);
                });
              }
            } catch (error) {
              /* this composition does not forward the event; polling still covers it */
            }

            const onVisibility = function () {
              if (document.visibilityState !== 'visible') return;
              void refresh(false);
            };
            document.addEventListener('visibilitychange', onVisibility);

            void refresh(true).then(schedule, schedule);

            return function () {
              disposed = true;
              if (timer !== null) clearTimeout(timer);
              if (typeof unsubscribe === 'function') unsubscribe();
              document.removeEventListener('visibilitychange', onVisibility);
            };
          },
          'dsh-deepseek-status: balance polling',
        );

        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-deepseek-status-balance',
              order: 30,
              locale: NS,
            },
            Badge,
          );
        });

        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dsh-deepseek-status-balance-detail',
              order: 40,
              locale: NS,
            },
            Detail,
          );
        });
      },
    };

    }
  },
});
