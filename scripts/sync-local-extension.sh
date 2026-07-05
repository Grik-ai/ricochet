#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$ROOT_DIR/extension-vscode"
INSTALL_CLI=false
STOP_RUNNING_CORE=false

for arg in "$@"; do
  case "$arg" in
    --install-cli)
      INSTALL_CLI=true
      ;;
    --stop-running-core)
      STOP_RUNNING_CORE=true
      ;;
    -h|--help)
      echo "Usage: ./scripts/sync-local-extension.sh [--install-cli] [--stop-running-core]"
      echo ""
      echo "  --install-cli        Also update ~/.local/bin/ricochet and ~/bin/ricochet"
      echo "  --stop-running-core  SIGTERM running ricochet-core --stdio processes after sync"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: ./scripts/sync-local-extension.sh [--install-cli] [--stop-running-core]"
      exit 1
      ;;
  esac
done

PLATFORM_OS="$(go env GOOS)"
PLATFORM_ARCH="$(go env GOARCH)"
NODE_OS="$PLATFORM_OS"
NODE_ARCH="$PLATFORM_ARCH"

if [ "$PLATFORM_OS" = "windows" ]; then
  NODE_OS="win32"
fi
if [ "$PLATFORM_ARCH" = "amd64" ]; then
  NODE_ARCH="x64"
fi

CORE_NAME="ricochet-core"
if [ "$PLATFORM_OS" = "windows" ]; then
  CORE_NAME="ricochet-core.exe"
fi

SOURCE_CORE="$EXT_DIR/bin/${NODE_OS}-${NODE_ARCH}/${CORE_NAME}"
if [ ! -x "$SOURCE_CORE" ]; then
  echo "Missing built core binary: $SOURCE_CORE"
  echo "Run ./scripts/build-all.sh first."
  exit 1
fi

if ! strings "$SOURCE_CORE" 2>/dev/null | grep -q 'get_session_snapshot'; then
  echo "Bundled core binary does not support required RPC: get_session_snapshot"
  "$SOURCE_CORE" version --json 2>/dev/null || "$SOURCE_CORE" version 2>/dev/null || true
  echo "Run ./scripts/build-all.sh before syncing the extension."
  exit 1
fi

timestamp() {
  date -u +"%Y%m%dT%H%M%SZ"
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

install_cli_link() {
  local target="$1"
  local target_dir
  target_dir="$(dirname "$target")"
  mkdir -p "$target_dir"

  if path_exists "$target"; then
    local current_link=""
    current_link="$(readlink "$target" 2>/dev/null || true)"
    if [ "$current_link" = "$SOURCE_CORE" ]; then
      echo "CLI already linked: $target -> $SOURCE_CORE"
      return
    fi

    local backup="${target}.old-$(timestamp)"
    echo "Backing up existing CLI: $target -> $backup"
    mv "$target" "$backup"
  fi

  ln -s "$SOURCE_CORE" "$target"
  echo "CLI linked: $target -> $SOURCE_CORE"
}

print_cli_diagnostics() {
  echo ""
  echo "CLI diagnostics:"
  command -v ricochet || true
  which -a ricochet || true
  readlink "$HOME/.local/bin/ricochet" 2>/dev/null || true
  "$HOME/.local/bin/ricochet" version --json || true
}

list_running_core_processes() {
  ps -axo pid=,command= 2>/dev/null | grep '[r]icochet-core' | grep -- '--stdio' || true
}

list_running_core_pids() {
  list_running_core_processes | awk '{print $1}'
}

warn_running_core_processes() {
  local running
  running="$(list_running_core_processes || true)"
  if [ -z "$running" ]; then
    return
  fi

  echo ""
  echo "WARNING: running ricochet-core processes are still using their in-memory binary:"
  echo "$running"
  echo "The extension files on disk are synced, but these processes must stop before Antigravity loads the new core."
}

stop_running_core_processes() {
  local pids
  pids="$(list_running_core_pids || true)"
  if [ -z "$pids" ]; then
    echo "No running ricochet-core --stdio processes found."
    return
  fi

  echo ""
  echo "Stopping running ricochet-core --stdio processes:"
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    echo "  SIGTERM $pid"
    kill -TERM "$pid" 2>/dev/null || true
  done <<< "$pids"

  for _ in 1 2 3 4 5; do
    sleep 1
    if [ -z "$(list_running_core_processes || true)" ]; then
      break
    fi
  done
  local still_running
  still_running="$(list_running_core_processes || true)"
  if [ -n "$still_running" ]; then
    echo "WARNING: some ricochet-core processes are still running:"
    echo "$still_running"
    echo "Close their Antigravity window or stop them manually before Discord verification."
  else
    echo "All ricochet-core --stdio processes stopped."
  fi
}

TARGETS=(
  "$HOME/.antigravity-ide/extensions/grik.ricochet-0.1.0-universal"
  "$HOME/.antigravity/extensions/grik.ricochet-0.1.0-universal"
)

for target in "${TARGETS[@]}"; do
  if [ ! -d "$target" ]; then
    echo "Skipping missing extension dir: $target"
    continue
  fi

  echo "Syncing Ricochet extension -> $target"
  mkdir -p "$target/bin/${NODE_OS}-${NODE_ARCH}"
  cp "$SOURCE_CORE" "$target/bin/${NODE_OS}-${NODE_ARCH}/${CORE_NAME}"
  chmod 755 "$target/bin/${NODE_OS}-${NODE_ARCH}/${CORE_NAME}"

  cp "$EXT_DIR/package.json" "$target/package.json"

  if [ -f "$EXT_DIR/dist/extension.js" ]; then
    mkdir -p "$target/dist"
    cp "$EXT_DIR/dist/extension.js" "$target/dist/extension.js"
  fi

  if [ -d "$EXT_DIR/webview-dist" ]; then
    rm -rf "$target/webview-dist"
    cp -R "$EXT_DIR/webview-dist" "$target/webview-dist"
  fi

  "$target/bin/${NODE_OS}-${NODE_ARCH}/${CORE_NAME}" version || true
done

warn_running_core_processes

if [ "$STOP_RUNNING_CORE" = true ]; then
  stop_running_core_processes
fi

if [ "$INSTALL_CLI" = true ]; then
  echo ""
  echo "Installing terminal CLI links..."
  install_cli_link "$HOME/.local/bin/ricochet"
  install_cli_link "$HOME/bin/ricochet"
  hash -r 2>/dev/null || true
  print_cli_diagnostics
fi

if [ "$STOP_RUNNING_CORE" = true ]; then
  echo "Done. Reopen Ricochet in Antigravity to start the synced core."
else
  echo "Done. Restart Antigravity or run again with --stop-running-core to unload stale ricochet-core processes."
fi
