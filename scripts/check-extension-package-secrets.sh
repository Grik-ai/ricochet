#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ext_dir="${EXTENSION_PACKAGE_ROOT:-$repo_root/extension-vscode}"

fail() {
  printf 'extension package secret check failed: %s\n' "$1" >&2
  exit 1
}

if [ ! -d "$ext_dir" ]; then
  fail "extension directory not found: $ext_dir"
fi

blocked="$(
  find "$ext_dir" \
    \( -path "$ext_dir/node_modules" -o -path "$ext_dir/dist" -o -path "$ext_dir/webview-dist" \) -prune -o \
    -type f \
    \( -name '.env' -o -name '.env.*' -o -name '*.keys' -o -name '*.local' \) \
    -print |
    sed "s#^$ext_dir/##" |
    grep -vE '(^|/)(\.env\.example|\.env\.[^/]*\.example|\.env\.keys\.example)$' || true
)"

if [ -n "$blocked" ]; then
  printf '%s\n' "$blocked" >&2
  fail "local env/key files would be packageable; move them outside extension-vscode before packaging"
fi

printf 'extension package secret check passed\n'
