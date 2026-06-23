#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() {
  printf 'public hygiene check failed: %s\n' "$1" >&2
  exit 1
}

tracked_existing="$(
  git ls-files | while IFS= read -r path; do
    if [ -e "$path" ]; then
      printf '%s\n' "$path"
    fi
  done
)"

tracked_private_paths="$(
  printf '%s\n' "$tracked_existing" | grep -E '(^|/)(\.agent|\.kilocode|scratch|test-analis)(/|$)|(^|/)(ricochet|ricochet-core|ricochet-cli|mcp_test)(\.exe)?$|\.log$|(^|/)\.env(\.|$)|\.keys$|\.local$' | grep -vE '\.example$' || true
)"
if [ -n "$tracked_private_paths" ]; then
  printf '%s\n' "$tracked_private_paths" >&2
  fail "tracked private/local artifacts found"
fi

internal_docs="$(
  printf '%s\n' "$tracked_existing" | grep -E '(^|/)(2026_MODERNIZATION\.md|ricochet2\.md|RICOCHET\.md|azure-pipelines\.marketplace\.yml|docs/release\.md)$' || true
)"
if [ -n "$internal_docs" ]; then
  printf '%s\n' "$internal_docs" >&2
  fail "internal docs still tracked in public surface"
fi

doc_leaks="$(
  git grep -n -I -E '(/Users/|\.kilo/plans|market leader|dominate|monetize|SOC2|Marketplace Publisher)' -- \
    '*.md' '*.yml' '*.yaml' \
    ':!конкуренты/**' \
    ':!webview/node_modules/**' \
    ':!extension-vscode/node_modules/**' || true
)"
if [ -n "$doc_leaks" ]; then
  printf '%s\n' "$doc_leaks" >&2
  fail "public docs/config contain internal or commercial planning language"
fi

source_leaks="$(
  git grep -n -I -E '/Users/[^"[:space:]]+/(GRIKAI|Ricochet)' -- \
    '*.go' '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' \
    ':!**/*_test.go' \
    ':!**/*.test.ts' \
    ':!**/*.test.tsx' \
    ':!конкуренты/**' \
    ':!webview/node_modules/**' \
    ':!extension-vscode/node_modules/**' || true
)"
if [ -n "$source_leaks" ]; then
  printf '%s\n' "$source_leaks" >&2
  fail "source contains hardcoded local developer paths"
fi

secret_like="$(
  git grep -n -I -E '(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{20,})' -- \
    ':!webview/package-lock.json' \
    ':!extension-vscode/package-lock.json' \
    ':!core/go.sum' || true
)"
if [ -n "$secret_like" ]; then
  printf '%s\n' "$secret_like" >&2
  fail "secret-like token found in tracked files"
fi

printf 'public hygiene check passed\n'
