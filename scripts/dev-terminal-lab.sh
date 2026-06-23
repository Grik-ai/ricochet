#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${1:-all}"
shift || true

WATCH=false
SNAPSHOT=false
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=true ;;
    --snapshot) SNAPSHOT=true; EXTRA_ARGS+=("--snapshot") ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

run_lab() {
  cd "$ROOT_DIR/core"
  if [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then
    go run ./cmd/ricochet dev terminal-lab --fixture "$FIXTURE" --no-alt-screen "${EXTRA_ARGS[@]}"
  else
    go run ./cmd/ricochet dev terminal-lab --fixture "$FIXTURE" --no-alt-screen
  fi
}

watch_signature() {
  find "$ROOT_DIR/core/internal/tui" "$ROOT_DIR/core/cmd/ricochet" -type f -name '*.go' -print0 \
    | xargs -0 stat -f '%m %N' \
    | sort \
    | shasum \
    | awk '{print $1}'
}

if [ "$WATCH" != true ]; then
  run_lab
  exit 0
fi

stop_children() {
  local parent_pid="$1"
  local watcher_pid="${2:-}"
  local child_pid
  while IFS= read -r child_pid; do
    if [ -n "$child_pid" ] && [ "$child_pid" != "$watcher_pid" ]; then
      kill -TERM "$child_pid" 2>/dev/null || true
      pkill -TERM -P "$child_pid" 2>/dev/null || true
    fi
  done < <(pgrep -P "$parent_pid" || true)
}

watcher_pid=""
cleanup() {
  if [ -n "$watcher_pid" ]; then
    kill "$watcher_pid" 2>/dev/null || true
  fi
  stop_children "$$" "$watcher_pid"
}
trap cleanup EXIT INT TERM

last_signature="$(watch_signature)"
(
  seen_signature="$last_signature"
  while true; do
    sleep 1
    next_signature="$(watch_signature)"
    if [ "$next_signature" != "$seen_signature" ]; then
      seen_signature="$next_signature"
      stop_children "$$" "$BASHPID"
    fi
  done
) &
watcher_pid="$!"

while true; do
  clear
  echo "Ricochet terminal dev lab: fixture=$FIXTURE"
  echo "Watching core TUI/CLI files. Press Ctrl+C to stop."
  echo
  run_lab || true
  sleep 0.2
done
