#!/usr/bin/env bash
# One-command local editor for macOS (and Linux).
#
#   npm run local            or   bash scripts/start-local.sh
#
# Installs missing prerequisites (Node 22 and FFmpeg via Homebrew on macOS),
# installs npm dependencies, builds the browser editor and server, then starts
# the server and the render worker together against one on-disk database.
# Your login token is generated once and kept in output/local/token (gitignored).
# Everything you upload and render stays under output/ on this machine.
# Press Ctrl+C to stop both processes.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT="${OVE_SERVER_PORT:-8722}"
STATE="$ROOT/output/local"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'
}

# 1. Prerequisites.
if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
  if ! node_ok; then
    say "Installing Node 22 with Homebrew"
    brew install node@22
  fi
  if ! node_ok && [ -d "$(brew --prefix)/opt/node@22/bin" ]; then
    # node@22 is keg-only, so put it first on PATH for this run.
    PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
    export PATH
  fi
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    say "Installing FFmpeg with Homebrew"
    brew install ffmpeg
  fi
elif [ "$(uname -s)" = "Darwin" ]; then
  node_ok && command -v ffmpeg >/dev/null 2>&1 || die "Install Homebrew first (https://brew.sh), then run this again."
fi
node_ok || die "Node 22.5 or newer is required. Found: $(node -v 2>/dev/null || echo none)."
command -v ffmpeg >/dev/null 2>&1 || die "FFmpeg is required. Install it and run this again."
command -v ffprobe >/dev/null 2>&1 || die "FFprobe is required (it ships with FFmpeg)."

# 2. Dependencies and build.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  say "Installing npm dependencies"
  npm ci
  touch node_modules
fi
say "Building the editor"
npm run build

# 3. Local user and shared database.
mkdir -p "$STATE"
if [ ! -s "$STATE/token" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24 > "$STATE/token"
  else
    node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$STATE/token"
  fi
  chmod 600 "$STATE/token"
fi
TOKEN="$(tr -d '[:space:]' < "$STATE/token")"

export OVE_SERVER_HOST="127.0.0.1"
export OVE_SERVER_PORT="$PORT"
export OVE_SERVER_DB="$STATE/ove.db"
export OVE_SERVER_STORAGE="$STATE/storage"
export OVE_SERVER_USERS="[{\"id\":\"local-admin\",\"tenantId\":\"local\",\"username\":\"admin\",\"role\":\"admin\",\"token\":\"$TOKEN\"}]"
export REMOTION_DISABLE_TELEMETRY=1

# 4. Start the server and the worker; stop both on exit.
PIDS=""
cleanup() {
  trap - INT TERM EXIT
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

say "Starting the server and the render worker"
node dist/cli.js serve &
SERVER_PID=$!
PIDS="$PIDS $SERVER_PID"

# Start the worker only after the server has created and migrated the database,
# so the two processes never race on first-run schema setup.
URL="http://127.0.0.1:$PORT/"
READY=0
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "$URL" 2>/dev/null; then READY=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done
[ "$READY" = 1 ] || die "The server did not start. See the messages above."

node dist/cli.js worker &
PIDS="$PIDS $!"

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$TOKEN" | pbcopy
  COPIED=" (copied to your clipboard)"
else
  COPIED=""
fi

cat <<EOF

  Octupie Video Editor is running.

    Open:   $URL
    Token:  $TOKEN$COPIED

  Paste the token on the sign-in screen. Projects, uploads, and renders are
  saved in output/local/ and survive restarts. Press Ctrl+C to stop.

EOF

if command -v open >/dev/null 2>&1; then
  open "$URL" || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi

wait
