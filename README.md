# fomo-wallet-exporter

A browser console script that exports the Solana and EVM wallets of [fomo.family](https://fomo.family) traders into the `{ address, rename, emoji }` JSON format that GMGN and Terminal wallet trackers import.

You can export only the leaderboard top earners, or crawl the social graph to reach as many traders as possible.

## Usage

1. Log in at [fomo.family](https://fomo.family) in a desktop browser and open the leaderboard.
2. Open DevTools (`F12`, or `Cmd+Opt+J` on macOS) and go to the **Console** tab.
3. Paste the full contents of [`fomo-wallets.js`](fomo-wallets.js) and press Enter. Chrome may ask you to type `allow pasting` first.
4. Progress is logged every 25 users. When the run finishes, five files download and a top-25 table prints.

The script reads your own session token from the page, so you need to be logged in. It sends nothing anywhere except to fomo's API.

## Output

| File | Contents |
|---|---|
| `fomo-solana-leaderboard.json` | Solana wallets of traders on any leaderboard (all-time, 30d, 7d, 24h) |
| `fomo-evm-leaderboard.json` | EVM wallets of the same traders |
| `fomo-solana-all.json` | Solana wallets of every trader the crawl reached |
| `fomo-evm-all.json` | EVM wallets of every trader the crawl reached |
| `fomo-full.json` | Everything: id, handle, display name, Twitter, both wallets, PnL for every window, leaderboard flag, and where each user was found |

Every list is sorted by all-time PnL, highest first. Tracker files look like this:

```json
[
    {
        "address": "0x1260f54d4da28152de8760858e4fca15e89a3456",
        "rename": "somehandle",
        "emoji": ""
    }
]
```

`rename` is the trader's fomo handle. Solana and EVM wallets are in separate files because trackers import one chain at a time.

The same data is also left in `window.fomoExport` in the console, in case you want to filter it further before saving.

## Configuration

Edit the `CFG` block at the top of the script before pasting:

| Option | Default | Effect |
|---|---|---|
| `crawlAll` | `true` | `false` exports leaderboard traders only, which is fast. `true` also walks followers and recommended users to reach everyone connected to them. |
| `maxUsers` | `5000` | Stop the crawl after this many unique users. |
| `concurrency` | `4` | Parallel requests. |
| `delayMs` | `150` | Pause between requests on each worker. Rate limits (HTTP 429) back off automatically. |
| `minPnl` | `null` | Drop anyone whose all-time PnL is below this dollar amount, for example `1000`. |
| `renameMax` | `24` | Maximum label length, since trackers truncate long names. |

## How it works

fomo's web app talks to `https://prod-api.fomo.family` with a Privy bearer token that the page keeps in `localStorage["privy:token"]`. The script reuses that token and calls the same endpoints the app does:

1. `GET /v2/leaderboard` and `GET /v2/leaderboard/{30d,7d,24h}` to seed the list with the top earners.
2. `GET /v2/users/{id}` for any user whose wallet or PnL was missing from the row it came from.
3. With `crawlAll` on, `GET /v2/users/{id}/followers` and `GET /v2/users/{id}/recommendedUsers` to discover more traders, breadth first.

On a user record, `address` is the Solana wallet and `evmAddress` is the EVM wallet. If fomo renames those fields, the script falls back to scanning each record for any value shaped like a Solana or EVM address.

fomo has no endpoint that lists every user, so "all" means every trader reachable from the leaderboards through follower and recommendation links. Raise `maxUsers` for a wider crawl.

## Troubleshooting

- **`no Privy token found`**: you are not logged in, or the session expired. Reload fomo.family, log in, and run it again.
- **Empty or tiny files**: check the `sample row keys` line in the console. It shows the fields fomo returned on the first leaderboard row. If the wallet fields have moved, open an issue with that line.
- **Lots of `429` warnings**: lower `concurrency` or raise `delayMs`.

## Disclaimer

This is an unofficial tool with no affiliation to fomo. It relies on fomo's undocumented private API, which can change without notice, and it only reads data your logged-in account can already see. Respect fomo's terms of service and use it responsibly.
