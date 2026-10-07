#!/bin/bash
# uninstall.sh — undo scripts/setup.sh. Keeps the Keychain password entry.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_LABEL="local.modem-battery.swiftbar"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
BACKUP="$REPO/.setup-backup.env"

say() { printf '  %s\n' "$1"; }

# Delete key $2 from domain $1; succeed only if it is confirmed gone afterwards.
# `defaults delete` fails when the key is already absent, so on failure we read
# the whole domain (a missing domain exports as an empty dict) and require the
# plist to be valid and the key to be absent — a failed read is not "absent".
delete_key() {
  local plist
  defaults delete "$1" "$2" >/dev/null 2>&1 && return 0
  plist="$(defaults export "$1" - 2>/dev/null)" || return 1
  printf '%s' "$plist" | plutil -lint - >/dev/null 2>&1 || return 1
  ! printf '%s' "$plist" | plutil -type "$2" - >/dev/null 2>&1
}

# 1. LaunchAgent
launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
rm -f "$AGENT_PLIST"
say "LaunchAgent removed"

# 2. Restore SwiftBar plugin folder — ONLY if we have a backup (i.e. we set it),
#    and ONLY if the current value is still the one we installed (don't clobber a
#    value the user changed afterwards). No backup => never installed by us => leave it.
if [ -f "$BACKUP" ]; then
  # Defaults for both the current %q format and any older backup missing OURS/HADKEY.
  BID="com.ameba.SwiftBar"; HADKEY=0; PREV_PLUGIN_DIR=""; OURS=""; HADSTEALTH=""; PREV_STEALTH=""
  # shellcheck disable=SC1090
  . "$BACKUP" 2>/dev/null || true
  # Our plugin dir is deterministic from the repo, so fall back to it when an
  # older backup didn't record OURS (avoids mis-reading our own value as a user change).
  [ -z "$OURS" ] && OURS="$REPO/plugins"
  osascript -e 'quit app "SwiftBar"' >/dev/null 2>&1 || true
  pkill -x SwiftBar >/dev/null 2>&1 || true
  sleep 1
  # StealthMode (set by setup so SwiftBar's own item doesn't replace our hidden one).
  # Empty HADSTEALTH = older backup from before setup touched it -> leave it alone.
  # On failure stop here, before the backup can be deleted, so a re-run can retry.
  if [ "$HADSTEALTH" = "1" ]; then
    if defaults write "$BID" StealthMode -bool "$([ "$PREV_STEALTH" = "1" ] && echo YES || echo NO)"; then
      say "SwiftBar StealthMode restored"
    else
      say "FAILED to restore SwiftBar StealthMode; backup kept at $BACKUP"; exit 1
    fi
  elif [ "$HADSTEALTH" = "0" ]; then
    if delete_key "$BID" StealthMode; then
      say "SwiftBar StealthMode key cleared (there was none before install)"
    else
      say "FAILED to clear SwiftBar StealthMode; backup kept at $BACKUP"; exit 1
    fi
  fi
  CUR="$(defaults read "$BID" PluginDirectory 2>/dev/null || echo)"
  if [ "$CUR" != "$OURS" ]; then
    say "SwiftBar plugin folder was changed after install ($CUR); leaving it. Backup kept."
  elif [ "$HADKEY" = "1" ]; then
    if defaults write "$BID" PluginDirectory -string "$PREV_PLUGIN_DIR"; then
      say "SwiftBar plugin folder restored to: $PREV_PLUGIN_DIR"; rm -f "$BACKUP"
    else
      say "FAILED to restore SwiftBar plugin folder; backup kept at $BACKUP"; exit 1
    fi
  else
    if delete_key "$BID" PluginDirectory; then
      say "SwiftBar plugin folder key cleared (there was none before install)"; rm -f "$BACKUP"
    else
      say "FAILED to clear SwiftBar plugin folder key; backup kept at $BACKUP"; exit 1
    fi
  fi
else
  say "No install backup found; leaving SwiftBar settings untouched."
fi

# 3. Local machine artifacts. Remove only the cached value; leave the lock files
#    so a battery.mjs/debug.mjs still running in a terminal keeps its login lock.
rm -f "$REPO/.node-path"
rm -f "$HOME/Library/Caches/modem-battery/state.json"
say "cached value and .node-path removed (lock files left for any running probe)"

say "Kept: the Keychain entry (service modem-battery). Remove it yourself if wanted:"
say "  security delete-generic-password -s modem-battery -a admin"
