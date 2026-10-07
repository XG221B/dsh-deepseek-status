# dsh-deepseek-status

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that keeps two badges beside the composer:

- **Billing window** — peak or off-peak right now, when it switches, and the current rates
- **Account balance** — how much is left (topped up plus granted credit)

Both update on their own; there is nothing to maintain.

## Install

```sh
dsh plugin --profile <profile> add github:XG221B/dsh-deepseek-status
```

Use `remove` to uninstall. In the desktop app you can also paste that address into Plugins → Add plugin.

It usually activates right away. Replacing an installed version needs one Harness restart (Host code is cached in the process).

## What it looks like

```
● Off-peak · peak in 5d 15h        ● Balance ¥110.00
```

Click the pricing badge for the rule in force, the next switch, the rate table, and where the data came from. Click the balance badge for topped-up / granted / total, plus links to top up and review usage. Colours follow the Harness theme, text follows the UI language.

## Three things to know

**The balance needs a DeepSeek account sign-in.** With API-key-only setup the account service has no wallet to report, so the balance badge simply does not appear. The pricing badge is unaffected.

**The plugin never touches your key.** The balance is read from Harness's own account service; the token stays in the Host process and the page only receives the numbers. Nothing about the balance is written to disk, logged, or sent anywhere.

**Only the pricing feature goes online.** The Host half periodically fetches the official pricing pages and holiday data, cross-checks them, caches the result in `cache/dataset.json` inside the plugin directory, and serves one read-only loopback route — `/dsh-deepseek-status/data.json` — to the page. That route only carries public data; if you deliberately bind Harness to `0.0.0.0`, others on your network can read it too.

The balance is read at most once a minute (polling pauses while the page is in the background); pricing data refreshes every six hours.

## Development

```sh
node tools/test-data.mjs      # data layer parsing and validation
node tools/test-pricing.mjs   # pricing logic
node tools/test-balance.mjs   # balance logic
node tools/test-bundle.mjs    # whole browser bundle mount smoke test
node tools/test-host.mjs      # host end to end, needs network
```

286 checks in total; the first four need no network and run on every push. Architecture notes: [DEVELOPING.md](./DEVELOPING.md).

After a Harness update, run the contract check before restarting:

```sh
node tools/preflight.mjs --live
```

One inactive entry fails the whole desktop web boot, and this catches that in advance. If something does break, remove `dsh-deepseek-status` from `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json` and start again.

## Data sources

Rates and the billing rule come from the [official DeepSeek docs](https://api-docs.deepseek.com/quick_start/pricing); holidays come from [holiday-cn](https://github.com/NateScarlet/holiday-cn) and [chinese-days](https://github.com/vsme/chinese-days) (both MIT) and are used only when the two agree.

Developed and verified against DSH `0.2.0-rc.2`.

## Licence

[MIT](./LICENSE)
