#!/bin/bash
# setup.sh — wire up the MiFi battery menu-bar tool on this Mac.
#
# What it does (all reversible with scripts/uninstall.sh):
#   1. find node and record its absolute path in .node-path
#   2. point SwiftBar's plugin folder at ./plugins (correct bundle id), turn on
#      StealthMode (no "SwiftBar" fallback item while ours is hidden), restart it
#   3. install + load a LaunchAgent so SwiftBar starts at login
#
# It does NOT store any password (that lives only in the Keychain) and never uses
# sudo. Some macOS permission prompts (Keychain access, background execution)
# cannot be pre-approved from a script; this script tells you if one is pending.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO/plugins"
AGENT_LABEL="local.modem-battery.swiftbar"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
BACKUP="$REPO/.setup-backup.env"

say() { printf '  %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }

step "1/4  node"
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/"*/bin/node; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  say "node not found. Install Node.js (e.g. 'brew install node') and re-run."
  exit 1
fi
printf '%s' "$NODE" > "$REPO/.node-path"
say "node: $NODE (recorded in .node-path)"
"$NODE" --version >/dev/null || { say "node not runnable"; exit 1; }

step "2/4  dependencies"
if [ ! -d "$REPO/node_modules/playwright-core" ]; then
  say "installing playwright-core (browser reused from cache, not downloaded)…"
  ( cd "$REPO" && npm ci --omit=dev ) || { say "npm ci failed"; exit 1; }
fi
CHROME="$(cd "$REPO" && "$NODE" --input-type=module -e 'import { resolveChromePath } from "./browser.mjs"; console.log(resolveChromePath());')"
if [ ! -x "$CHROME" ]; then
  say "Chrome for Testing not found at: $CHROME"
  say "Run 'node node_modules/playwright-core/cli.js install chromium', then re-run setup."
  exit 1
fi
say "playwright-core present"

step "3/4  SwiftBar plugin folder"
SWIFTBAR_APP="/Applications/SwiftBar.app"
if [ ! -d "$SWIFTBAR_APP" ]; then
  say "SwiftBar not found in /Applications. Install it: 'brew install --cask swiftbar'."
  exit 1
fi
BID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SWIFTBAR_APP/Contents/Info.plist" 2>/dev/null || echo com.ameba.SwiftBar)"
SWIFTBAR_BIN="$SWIFTBAR_APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$SWIFTBAR_APP/Contents/Info.plist" 2>/dev/null || echo SwiftBar)"
# Back up the previous plugin dir once, so uninstall can restore it exactly.
# Distinguish "key absent" from "key empty", and shell-escape every value with
# %q so uninstall can safely `source` this file even with spaces/UTF-8 in paths.
if [ ! -f "$BACKUP" ]; then
  if PREV="$(defaults read "$BID" PluginDirectory 2>/dev/null)"; then HADKEY=1; else HADKEY=0; PREV=""; fi
  {
    printf 'BID=%q\n' "$BID"
    printf 'HADKEY=%q\n' "$HADKEY"
    printf 'PREV_PLUGIN_DIR=%q\n' "$PREV"
    printf 'OURS=%q\n' "$PLUGIN_DIR"
  } > "$BACKUP"
fi
osascript -e 'quit app "SwiftBar"' >/dev/null 2>&1 || true
pkill -x SwiftBar >/dev/null 2>&1 || true
sleep 1
defaults write "$BID" PluginDirectory -string "$PLUGIN_DIR"
say "bundle id: $BID"
say "plugin folder set to: $PLUGIN_DIR"
# StealthMode: when our plugin hides itself (not on the paired modem), SwiftBar
# would otherwise show its own "SwiftBar" item in its place. Back up the previous
# value once (appended, so backups from older installs gain it too).
if ! grep -q '^HADSTEALTH=' "$BACKUP" 2>/dev/null; then
  if PREV_STEALTH="$(defaults read "$BID" StealthMode 2>/dev/null)"; then HADSTEALTH=1; else HADSTEALTH=0; PREV_STEALTH=""; fi
  { printf 'HADSTEALTH=%q\n' "$HADSTEALTH"; printf 'PREV_STEALTH=%q\n' "$PREV_STEALTH"; } >> "$BACKUP"
fi
defaults write "$BID" StealthMode -bool YES
say "StealthMode on (nothing in the menu bar while off the modem)"

step "4/4  start SwiftBar at login (LaunchAgent)"
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__SWIFTBAR_BIN__|$SWIFTBAR_BIN|g" "$REPO/launchd/$AGENT_LABEL.plist.in" > "$AGENT_PLIST"
plutil -lint "$AGENT_PLIST" >/dev/null
# Reload idempotently.
launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST"
launchctl kickstart -k "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
say "LaunchAgent loaded: $AGENT_LABEL"

step "keychain check"
if /usr/bin/security find-generic-password -w -s modem-battery -a admin >/dev/null 2>&1; then
  say "Keychain entry present (service modem-battery / account admin)."
  # Clear any stale wrong-password block and queue a fresh attempt (does NOT wipe
  # the cached value / pause / timing — see menu.mjs --reset-auth).
  if "$NODE" "$REPO/menu.mjs" --reset-auth >/dev/null 2>&1; then
    say "queued a fresh reading (auth retry reset)."
  else
    say "NOTE: couldn't queue an auth retry now (state busy) — click Refresh in the menu."
  fi
else
  say "No Keychain password yet. Store it (you will be prompted, hidden):"
  say "  security add-generic-password -U -a admin -s modem-battery -w"
fi

step "modem pairing"
# Never pair automatically: another router at the same IP would get the password.
if PAIRED="$("$NODE" "$REPO/menu.mjs" --pair-status 2>/dev/null)"; then
  say "$PAIRED"
else
  say "Not paired yet — the menu-bar item stays hidden until you pair."
  say "While connected to the modem's Wi-Fi, run:"
  say "  \"$NODE\" \"$REPO/menu.mjs\" --pair"
fi

cat <<EOF

Done. The 🔋 item appears in the menu bar while you are connected to the paired modem.
If macOS shows a Keychain access or background-item prompt the first time, approve it.
To verify on the modem network (after pairing):
  MODEM_HOST=192.168.0.1 "$NODE" "$REPO/battery.mjs"
To remove everything: scripts/uninstall.sh
EOF
