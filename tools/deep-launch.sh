#!/bin/sh
# tools/deep-launch.sh — boot an isolated instance for the deep matrix.
# usage: tools/deep-launch.sh <port>
set -e
PORT="${1:?port}"
CFG=/tmp/deep-cfg
mkdir -p "$CFG" /tmp/deep-cfg-tabs-sidebar-proj
cat > "$CFG/open-tabs.json" <<'JSON'
{
  "tabs": [
    {
      "path": "/Users/jackey/GitHub/chuti",
      "profile": "default",
      "sessionFile": "/Users/jackey/.omp/agent/sessions/-GitHub-chuti/2026-10-26T12-31-15-604Z_01a17831-8c94-7647-88ec-dec231e169a5.jsonl",
      "name": null
    }
  ],
  "active": 0
}
JSON
cat > "$CFG/widgets.json" <<'JSON'
{
  "version": 1,
  "plugins": [
    { "id": "git", "title": "Git", "command": ["bash", "/Users/jackey/GitHub/omp-desktop/examples/widgets/git.sh"], "triggers": ["activate"], "intervalMs": 60000 }
  ]
}
JSON
cat > "$CFG/global-hotkey.json" <<'JSON'
{ "chord": "ctrl+alt+k" }
JSON
cd "$(dirname "$0")/.."
OMP_PORT_CONFIG_DIR="$CFG" nohup "release/OMP Desktop.app/Contents/MacOS/OMP Desktop" \
  --remote-debugging-port="$PORT" > /tmp/deep-launch.log 2>&1 &
echo "launched on port $PORT (pid $!); log /tmp/deep-launch.log"
