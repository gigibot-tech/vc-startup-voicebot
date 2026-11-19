#!/usr/bin/env bash
# Start the app after checking what it needs.
# Usage:
#   ./run.sh                 # uvicorn --reload (watches *.py under src/startup_voice)
#   ./run.sh --no-watch      # no auto-reload
#   UI_PORT=9000 ./run.sh
#
# JS/CSS/HTML live under features/*/ui and static/ — they do not restart the process;
# the app sends Cache-Control: no-store so a normal refresh picks them up.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

command -v uv >/dev/null || die "uv not found. Install: https://docs.astral.sh/uv/"

# Read only the variables this script needs from .env (the app itself loads the rest).
env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//' || true; }
PROVIDER="${LLM_PROVIDER:-$(env_get LLM_PROVIDER)}"; PROVIDER="${PROVIDER:-ollama}"
MODEL="${LLM_MODEL:-$(env_get LLM_MODEL)}";          MODEL="${MODEL:-granite4.2:8b}"
BASE="${LLM_BASE_URL:-$(env_get LLM_BASE_URL)}";     BASE="${BASE:-http://127.0.0.1:11434}"
PORT="${UI_PORT:-$(env_get UI_PORT)}";               PORT="${PORT:-8140}"

WATCH=1
PASS_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-watch|--no-reload) WATCH=0 ;;
    --watch|--reload)       WATCH=1 ;;
    *) PASS_ARGS+=("$arg") ;;
  esac
done
export UVICORN_RELOAD="$WATCH"

[ -f .env ] && ok ".env found" || echo "! no .env (copy .env.example): spoken replies need ELEVENLABS_API_KEY"

if [ "$PROVIDER" = "ollama" ]; then
  tags="$(curl -fsS -m 3 "$BASE/api/tags" 2>/dev/null)" \
    || die "Ollama not reachable at $BASE. Start it with: ollama serve"
  ok "Ollama reachable at $BASE"
  echo "$tags" | grep -q "\"name\":\"$MODEL\"" \
    || die "Model '$MODEL' not installed. Run: ollama pull $MODEL   (or set LLM_MODEL)"
  ok "model $MODEL installed"
  # A model Ollama has unloaded (overnight, after idle) takes several seconds to load; the app's
  # startup ping only waits LLM_PROBE_TIMEOUT (8 s) and would refuse to start. Load it first.
  echo "… loading $MODEL into memory (the first start of the day can take a minute)"
  curl -fsS -m 180 "$BASE/api/generate" \
    -d "{\"model\":\"$MODEL\",\"prompt\":\"ok\",\"stream\":false,\"keep_alive\":\"1h\",\"options\":{\"num_predict\":1}}" \
    >/dev/null 2>&1 \
    && ok "model $MODEL loaded" || echo "! could not pre-load $MODEL (the app will try anyway)"
else
  echo "! LLM provider '$PROVIDER' at $BASE: not checked here, the app pings it on startup"
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $PORT is already in use (running instance? stop it or set UI_PORT)"
fi

# Keep the LiveKit worker's packages when LiveKit is configured. A plain `uv sync` UNINSTALLS every
# optional extra, which silently broke the running worker (ModuleNotFoundError: livekit) after each
# restart of this script. --inexact: never remove packages another process installed.
LK_URL="${LIVEKIT_URL:-$(env_get LIVEKIT_URL)}"
SYNC_ARGS=(--quiet --inexact)
[ -n "$LK_URL" ] && SYNC_ARGS+=(--extra livekit-voice)
uv sync "${SYNC_ARGS[@]}"
ok "dependencies in sync${LK_URL:+ (incl. livekit-voice)}"
if [ "$WATCH" = "1" ]; then
  ok "auto-reload on (uvicorn --reload); pass --no-watch to disable"
else
  echo "! auto-reload off"
fi
echo "→ http://127.0.0.1:$PORT/"
exec uv run startup-voice "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"