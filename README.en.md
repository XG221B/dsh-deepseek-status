# dsh-deepseek-status

One [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that keeps the two things that decide what you spend visible beside the composer:

| Feature | Shows | Source |
|---|---|---|
| **Billing window** | `● Off-peak · peak in 5d 15h` | DeepSeek's published pricing pages plus two independent holiday datasets, cross-checked |
| **Account balance** | `● Balance ¥110.00` | The Harness account service (`ctx.remote.account`) — the plugin never touches your key |

Both are read-only displays: no agent tool, no session event, no change to any other plugin. **No dependencies, no build step** (plain JavaScript, Node built-ins, and services the host already provides).

## What it looks like

```
● Off-peak · peak in 5d 15h        ● Balance ¥110.00
```

Clicking the pricing badge expands a card with the current window, the countdown to the next switch, the rates in force, the rule, and the provenance of every number (which source, when it was checked, whether the cross-checks passed). Clicking the balance badge expands topped-up / granted / total, the account state, the last update, a Refresh button, and links to top up or review usage.

(The badges are the whole UI; there is no dialog, no page, no settings surface.)

## Install

```sh
dsh plugin --profile <profile> add github:XG221B/dsh-deepseek-status
pnpm pack && dsh plugin --profile <profile> add ./dsh-deepseek-status-2.0.0.tgz
dsh plugin --profile <profile> remove dsh-deepseek-status
```

In the desktop app the equivalent is the sidebar **Plugins → Add plugin** dialog. No `install`/`prepare` script is shipped, so no build authorisation is involved. A first install usually activates immediately; replacing an installed version needs one Harness restart.

## Where the numbers come from

**Billing window.** The published rule is not hardcoded. Each refresh separately parses the Chinese and English pricing pages (the English page states UTC windows, the Chinese page Beijing time, and the two must agree after conversion, weekday by weekday); parses the rate table and requires off-peak = peak ÷ 2, keeping the table and its currency from the same page; and reads two independent Chinese holiday datasets that must agree on every off-day. Any failing step keeps the previous good value and says so. Windows and holidays degrade independently: live → last good disk cache → built-in snapshot.

**Balance.** The plugin does not call `api.deepseek.com/user/balance` and does not read your API key. It calls the account Remote the Harness Account settings page already uses:

```js
ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })
// → { ok: true, value: null }                    // no account wallet (e.g. API-key-only)
// → { ok: true, value: { status: 'ready', value: [...topped up], bonusWallets: [...granted] } }
// → { ok: true, value: { status: 'failed' } }    // platform read failed
```

The account token stays inside the Host; the renderer receives only the projected amounts. The badge shows the **spendable total** (topped up + granted), because Platform returns those as two lists and counting only the first would read `¥0.00` for an account holding granted credit only.

## Privacy and security

**It does not**: touch a credential; cache, log, or report the balance (it lives in page memory for as long as the page does); write session events; register agent tools; or send telemetry.

**It does**:

1. Make outbound requests from the Host half for the pricing feature only — `api-docs.deepseek.com` for the rule and rates in both languages, and `cdn.jsdelivr.net` / `fastly.jsdelivr.net` / `cdn.statically.io` / `raw.githubusercontent.com` for the holiday datasets (including the independent `chinese-days` one). 20 s timeout, public data, no credential.
2. Register one unauthenticated local route, `GET /dsh-deepseek-status/data.json`, serving that **public** dataset to the browser half. The Harness web server binds `127.0.0.1` by default; if you deliberately expose Harness on `0.0.0.0`, others on your network could read it too — the content is still only public data.
3. Write one file, `cache/dataset.json` inside the plugin directory (public data; safe to delete). **The balance is never written to disk.**
4. Read the balance over the existing host connection — no third-party request is involved.

**Host behaviour worth knowing**: the account Remote reports the requesting UI's version, language, and timezone offset to Platform as part of the read, and DSH attaches installed plugin names and versions to official API requests as diagnostic metadata.

## Data sources and licences

| Data | Source | Licence |
|---|---|---|
| Account balance | Harness account service | Host capability, not redistributed |
| Billing rule and rate table | [DeepSeek API Docs](https://api-docs.deepseek.com/quick_start/pricing) | Official public docs, read at runtime |
| Chinese public holidays (primary, links the State Council notice) | [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) | MIT |
| Chinese public holidays (independent cross-check) | [vsme/chinese-days](https://github.com/vsme/chinese-days) | MIT |

The plugin bundles no holiday data; `tools/fixtures/` keeps only the abridged samples the parser tests need. MIT licensed.

## Known limits

- **The balance needs an account sign-in with a wallet.** An API-key-only setup gets `null` from the account service, and the plugin then shows **no balance badge** rather than a fake zero. Supporting that case would mean host-side credential handling plus a direct `/user/balance` call, which this plugin deliberately does not do.
- **Not per-request real time**: the balance is read at best once a minute (plus on-demand triggers), and Platform settlement lags.
- **The pricing feature needs the Web UI and outbound network**: a deployment without a web carrier falls back to the built-in snapshot and says so; unreachable sources degrade to cache, then snapshot, each labelled.
- **Replacing an installed version needs one Harness restart** (the Host caches an imported module by URL). Data refresh is unaffected.
- **Compatibility**: verified on DSH `0.2.0-rc.2`; the two slots, `ctx.webServer`, and the account Remote are pre-release APIs.

## Development

```bash
node tools/test-data.mjs      # host data layer: parsing, validation, degradation, cross-checks (100)
node tools/test-pricing.mjs   # pricing browser logic: window edges, next-switch, merge semantics (75)
node tools/test-balance.mjs   # balance browser logic: formatting, grouping, envelope mapping (54)
node tools/test-host.mjs      # host end to end: route, live fetch, cache persistence (36)
node tools/test-bundle.mjs    # whole-bundle smoke: module id, four slots, optional-dependency fallback (17)
```

282 checks across the five suites. `test-host.mjs` uses its own temporary cache directory and never touches deployed data; `test-bundle.mjs` evaluates the bundle the way the page's loader does and drives `apply`, which is what catches a bundle that loads but mounts nothing. See [DEVELOPING.md](./DEVELOPING.md) for the architecture and the two hard constraints, and [CHANGELOG.md](./CHANGELOG.md) for history.

中文说明：[README.md](./README.md)
