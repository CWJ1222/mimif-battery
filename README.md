# mimif-battery

TP-Link M7000 battery percentage in the macOS menu bar, powered by SwiftBar.

Shows the battery % of a TP-Link **M7000** MiFi (portable LTE router) in the macOS
menu bar — but only while this Mac is connected to *that* modem's Wi-Fi (another
router that also uses `192.168.0.1` does not count). No need to open the tpMiFi
app to check the charge.

```
🔋 77%      ← discharging
🔌 82%      ← charging
🔋 77% ·    ← value is a few minutes old (couldn't refresh yet)
🔋 —        ← no fresh reading (older than 15 min)
(hidden)    ← not connected to the paired modem (or not paired yet)
```

## How it works

The M7000 web UI has no unauthenticated battery endpoint, and its login uses
per-request AES/RSA encryption. Rather than reimplement that (fragile, firmware
specific), the tool drives the device's **own login page** with headless Chromium,
so the page performs its own crypto; then it reads the Status model's battery
value and logs out. The device reports battery as `voltage` on a 0–100 scale (a
naming quirk) — that number is the percentage the app shows.

Layers:

| File | Role |
|---|---|
| `identity.mjs` | Is the gateway the paired modem? Wi-Fi's router is `MODEM_HOST`, reached over Wi-Fi, and its MAC (ARP) equals the pinned one. |
| `probe.mjs` | Log into the web UI headlessly, read the battery, log out. Checks the paired-modem identity before reading the password and again before typing it. Reads the password from the Keychain inside the process (never argv/env). Typed errors (`not-paired`, `not-modem`, `session-busy`, `wrong-password`, …). |
| `battery.mjs` | Thin JSON CLI over `probe.mjs` — the smoke-test command. |
| `menu.mjs` | SwiftBar controller: paired-modem gate, cache, cross-process lock, 5-min login throttle, failure backoff, Refresh / Pause, `--pair`. |
| `plugins/modem-battery.1m.sh` | SwiftBar plugin wrapper; just finds node and calls `menu.mjs`. |
| `scripts/setup.sh`, `scripts/uninstall.sh` | Install / remove. |

The menu-bar plugin runs every minute (cheap network check + cached render), but
the tool logs into the modem **at most once every 5 minutes**, because the M7000
allows only one admin session at a time.

## Prerequisites

- macOS with [SwiftBar](https://github.com/swiftbar/SwiftBar): `brew install --cask swiftbar`
- Node.js **20 or newer** (`brew install node`)
- Chrome for Testing, as described below. An existing executable
  `chromium-1228` Apple Silicon cache is reused first; otherwise the browser
  matching the installed Playwright package is selected automatically.
- The modem's web-UI password stored in the Keychain (hidden prompt):

  ```
  security add-generic-password -U -a admin -s modem-battery -w
  ```

## Install

Clone this repository (or download and extract its source), then open a terminal
in that directory. Keep the directory in a permanent location: SwiftBar runs the
plugin directly from it.

Install the locked dependency version:

```sh
npm ci
```

If you do not already have the reused browser cache or the browser expected by
this package, install Chromium with the project's own CLI:

```sh
node node_modules/playwright-core/cli.js install chromium
```

Then run:

```
scripts/setup.sh
```

This records your node path, points SwiftBar's plugin folder at `./plugins`,
turns on SwiftBar's `StealthMode` (otherwise SwiftBar shows its own "SwiftBar"
item whenever this plugin hides itself), and loads a LaunchAgent so SwiftBar
starts at login. To see SwiftBar's own item again:
`defaults write com.ameba.SwiftBar StealthMode -bool NO` and restart SwiftBar
(`scripts/uninstall.sh` restores the previous value). macOS may prompt once for
Keychain access or to allow the background item — approve it.

Then **pair** once, while connected to the modem's Wi-Fi:

```
node menu.mjs --pair                      # or: --pair aa:bb:cc:dd:ee:ff to double-check the MAC
# paired with M7000 at 192.168.0.1 (MAC …), battery 77%
```

Pairing logs in once, checks the device reports model M7000, and pins the
modem's gateway MAC. From then on the item shows — and the tool logs in — only
when the gateway at `192.168.0.1` has that MAC; a router with a different MAC at
the same IP is ignored (hidden, and the password is never sent to it). Until you pair, the
item stays hidden everywhere. Setup never pairs automatically.

- `node menu.mjs --pair-status` — show the pinned MAC (exit 1 if unpaired).
- `node menu.mjs --unpair` — forget it (e.g. before pairing a replacement modem;
  running `--pair` on a new modem also replaces the pin).

Verify on the modem's network (after pairing):

```
MODEM_HOST=192.168.0.1 node battery.mjs
# {"ok":true,"percent":77,"charging":false,"connected":true,"signal":3,"model":"M7000"}
```

## Menu actions

- **Refresh now** — request a reading (still obeys the 5-minute login limit,
  pause, paired-network gate, and single-session lock).
- **Pause 30 min** — stop auto-login for 30 minutes (use while you're logged into
  the modem's web UI or the app yourself), then **Resume**.
- **Open web UI** — open `https://192.168.0.1`.

## Troubleshooting

- **Blank / hidden:** you're not on the paired modem's Wi-Fi (Wi-Fi's router is
  `192.168.0.1`, the route to it goes over Wi-Fi, and its MAC is the pinned one).
  Expected off-network, including on other routers that use `192.168.0.1`.
  On the modem but still hidden? Check `node menu.mjs --pair-status`; if it says
  "not paired" (e.g. after `scripts/uninstall.sh`, which deletes the state), run
  `node menu.mjs --pair`. `battery.mjs` fails with `not-paired` / `not-modem` in
  the same situations.
  A wired LAN connected at the same time is fine, as long as it isn't also on
  `192.168.0.x` (then the modem is reached over the wire and the item hides).
- **`🔋 —` or a stale `·`:** couldn't refresh recently. Often `session-busy` —
  the app or web UI holds the single admin session. Close it or wait; it recovers.
- **"Wrong password":** the Keychain entry is wrong. Re-add it (command above),
  then run `node menu.mjs --reset-auth` to allow background retries again.
- **`--pair` fails:** `[not-on-wifi]` says which check failed — Wi-Fi's router
  isn't `192.168.0.1`; the route to it couldn't be read (retry); or it goes via
  another interface (a wired LAN on the same subnet; disconnect it).
  `[wrong-password]` on the modem that is already paired also stops the
  background retries, like a failed poll would — fix the Keychain entry, then
  `--pair` again. If the message adds "the retry block could not be saved", the
  background poller may retry that password; Pause it from the menu until fixed.
- **Uninstall says FAILED:** a SwiftBar setting couldn't be restored; the backup
  (`.setup-backup.env`) is kept — fix the cause and re-run `scripts/uninstall.sh`.
- **"node not found":** run `scripts/setup.sh` again to re-record the node path.

## Uninstall

```
scripts/uninstall.sh   # keeps the Keychain entry; deletes the cache incl. the pairing
```

## Config

- `MODEM_HOST` — modem IP (default `192.168.0.1`).
- `CHROME_PATH` — optional Chromium/Chrome executable override. This variable
  must be available to the process running the plugin. An export in a terminal
  alone does not configure a SwiftBar instance started at login. The automatic
  cache lookup needs no environment configuration.

## Compatibility and privacy

- Tested with a TP-Link M7000(EU) v4.0 on macOS with Apple Silicon. Other models,
  firmware versions, and Intel Macs have not been verified with a real device.
- The web UI uses a self-signed HTTPS certificate, so certificate validation is
  disabled for the modem browser context. MAC pairing prevents accidental login
  to ordinary same-IP routers; it does not defend against deliberate MAC
  spoofing. Pair only while connected to a modem you trust.
- The password stays in macOS Keychain. Local state (including the paired MAC)
  stays under `~/Library/Caches/modem-battery/`. It is not part of this repository.
- `node debug.mjs` prints selected battery fields or an error code, without
  dumping the full device status. Pairing commands print the gateway MAC, and
  other errors may include local paths: review terminal output before posting
  an issue. Do not attach Keychain data, state files, or raw device dumps.
- Setup changes SwiftBar's plugin directory and StealthMode globally, so it can
  affect other SwiftBar plugins. Uninstall restores the saved settings.

## Development

```sh
npm test
for f in *.mjs tests/*.mjs; do node --check "$f"; done
for f in plugins/*.sh scripts/*.sh; do bash -n "$f"; done
```

The tests use temporary state and do not require the modem password or a modem
connection. For a real-device check, connect to your paired modem and run
`MODEM_HOST=192.168.0.1 node battery.mjs`.

## License

ISC — see [LICENSE](LICENSE). This is an independent project, unaffiliated with
TP-Link or SwiftBar.
