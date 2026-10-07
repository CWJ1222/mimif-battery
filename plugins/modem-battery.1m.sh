#!/bin/bash
# SwiftBar plugin: show the TP-Link MiFi battery in the menu bar (only while
# connected to it). All logic lives in menu.mjs; this wrapper just finds node.
#
# Cadence 1m: menu.mjs re-checks the network every run but only logs into the
# modem at most every 5 minutes (it caches the last reading).

TOOL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

NODE=""
[ -f "$TOOL_DIR/.node-path" ] && NODE="$(cat "$TOOL_DIR/.node-path" 2>/dev/null)"
if [ ! -x "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/"*/bin/node; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  echo "🔋 —"; echo "---"; echo "node not found — run scripts/setup.sh | color=#c0392b"; exit 0
fi

exec "$NODE" "$TOOL_DIR/menu.mjs"
