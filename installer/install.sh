#!/bin/sh
set -eu

MARKETPLACE_ID="grik.ricochet"
GITHUB_REPO="Grik-ai/ricochet"
EDITOR_TARGET="all"
VERSION="latest"
DRY_RUN="0"
YES="0"

usage() {
  cat <<'USAGE'
Ricochet installer

Usage:
  sh install.sh [--editor code|cursor|windsurf|all] [--version x.y.z] [--dry-run] [--yes]

Examples:
  INSTALLER="$(mktemp)" && curl -fsSL https://grik.io/ricochet/install -o "$INSTALLER" && sh "$INSTALLER"
  INSTALLER="$(mktemp)" && curl -fsSL https://grik.io/ricochet/install -o "$INSTALLER" && sh "$INSTALLER" --editor cursor
USAGE
}

require_value() {
  flag="$1"
  value="${2:-}"
  if [ -z "$value" ] || [ "${value#--}" != "$value" ]; then
    echo "Ricochet install failed: $flag requires a value." >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --editor)
      EDITOR_TARGET="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --editor=*)
      EDITOR_TARGET="${1#--editor=}"
      if [ -z "$EDITOR_TARGET" ]; then
        echo "Ricochet install failed: --editor requires a value." >&2
        exit 1
      fi
      shift
      ;;
    --version)
      VERSION="$(require_value "$1" "${2:-}")"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      if [ -z "$VERSION" ]; then
        echo "Ricochet install failed: --version requires a value." >&2
        exit 1
      fi
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --yes|-y)
      YES="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Ricochet install failed: unknown option $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$EDITOR_TARGET" in
  all|code|cursor|windsurf) ;;
  *)
    echo "Ricochet install failed: unsupported editor '$EDITOR_TARGET'. Use code, cursor, windsurf, or all." >&2
    exit 1
    ;;
esac

if [ -n "${RICOCHET_INSTALL_MANIFEST_URL:-}" ]; then
  MANIFEST_URL="$RICOCHET_INSTALL_MANIFEST_URL"
elif [ "$VERSION" = "latest" ]; then
  MANIFEST_URL="https://github.com/$GITHUB_REPO/releases/latest/download/latest.json"
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v$VERSION" ;;
  esac
  MANIFEST_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/latest.json"
fi

need_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
  else
    echo "Ricochet install failed: curl or wget is required." >&2
    exit 1
  fi
}

download_to() {
  url="$1"
  dest="$2"
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fsSL "$url" -o "$dest"
  else
    wget -q "$url" -O "$dest"
  fi
}

json_string() {
  key="$1"
  file="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "Ricochet install failed: sha256sum or shasum is required." >&2
    exit 1
  fi
}

find_editors() {
  FOUND_EDITORS=""
  for editor in code cursor windsurf; do
    if [ "$EDITOR_TARGET" != "all" ] && [ "$EDITOR_TARGET" != "$editor" ]; then
      continue
    fi
    if command -v "$editor" >/dev/null 2>&1; then
      FOUND_EDITORS="$FOUND_EDITORS $editor"
    fi
  done
}

need_downloader
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t ricochet-install)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

MANIFEST_FILE="$TMP_DIR/latest.json"
echo "Fetching Ricochet release manifest: $MANIFEST_URL"
download_to "$MANIFEST_URL" "$MANIFEST_FILE"

RELEASE_VERSION="$(json_string version "$MANIFEST_FILE")"
VSIX_URL="$(json_string vsix_url "$MANIFEST_FILE")"
SHA256="$(json_string sha256 "$MANIFEST_FILE")"
MANIFEST_MARKETPLACE_ID="$(json_string marketplace_id "$MANIFEST_FILE")"

if [ -z "$RELEASE_VERSION" ] || [ -z "$VSIX_URL" ] || [ -z "$SHA256" ]; then
  echo "Ricochet install failed: release manifest must include version, vsix_url, and sha256." >&2
  exit 1
fi

if [ -n "$MANIFEST_MARKETPLACE_ID" ] && [ "$MANIFEST_MARKETPLACE_ID" != "$MARKETPLACE_ID" ]; then
  echo "Ricochet install failed: release manifest marketplace_id must be $MARKETPLACE_ID." >&2
  exit 1
fi

find_editors
if [ -z "$FOUND_EDITORS" ]; then
  echo "Ricochet install failed: no supported editor CLI found. Install VS Code, Cursor, or Windsurf and make sure code/cursor/windsurf is on PATH." >&2
  echo "Manual install: https://marketplace.visualstudio.com/items?itemName=$MARKETPLACE_ID" >&2
  exit 1
fi

echo "Ricochet $RELEASE_VERSION will be installed into:$FOUND_EDITORS"
if [ "$DRY_RUN" = "1" ]; then
  for editor in $FOUND_EDITORS; do
    echo "[dry-run] $editor --install-extension $VSIX_URL"
  done
  exit 0
fi

VSIX_FILE="$TMP_DIR/ricochet-$RELEASE_VERSION.vsix"
echo "Downloading $VSIX_URL"
download_to "$VSIX_URL" "$VSIX_FILE"

ACTUAL_SHA256="$(sha256_file "$VSIX_FILE")"
if [ "$(printf '%s' "$ACTUAL_SHA256" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$SHA256" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "Ricochet install failed: checksum mismatch. Expected $SHA256, got $ACTUAL_SHA256." >&2
  exit 1
fi

for editor in $FOUND_EDITORS; do
  echo "Installing Ricochet into $editor"
  "$editor" --install-extension "$VSIX_FILE"
done

echo "Ricochet extension installed."
