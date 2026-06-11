#!/bin/bash
set -e
export PATH=$PATH:/usr/local/go/bin:/usr/local/bin:/opt/homebrew/bin

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CORE_DIR="$ROOT_DIR/core"
EXT_DIR="$ROOT_DIR/extension-vscode"

echo "🔧 Building Ricochet Core..."

# Build for current platform
cd "$CORE_DIR"

# Build for current platform only (Tree-sitter requires CGO which breaks cross-compilation)
PLATFORM_OS=$(go env GOOS)
PLATFORM_ARCH=$(go env GOARCH)

# Map to Node.js naming
NODE_OS=$PLATFORM_OS
NODE_ARCH=$PLATFORM_ARCH

if [ "$PLATFORM_OS" = "windows" ]; then
    NODE_OS="win32"
fi

if [ "$PLATFORM_ARCH" = "amd64" ]; then
    NODE_ARCH="x64"
fi

OUTPUT_DIR="$EXT_DIR/bin/${NODE_OS}-${NODE_ARCH}"
OUTPUT_NAME="ricochet-core"

if [ "$PLATFORM_OS" = "windows" ]; then
    OUTPUT_NAME="${OUTPUT_NAME}.exe"
fi

echo "  Building for Native ($PLATFORM_OS/$PLATFORM_ARCH) -> $OUTPUT_DIR..."
mkdir -p "$OUTPUT_DIR"

# CGO_ENABLED=1 is required for go-tree-sitter
CGO_ENABLED=1 go build -ldflags="-s -w" -o "$OUTPUT_DIR/$OUTPUT_NAME" ./cmd/ricochet

echo "✅ Core builds complete!"
echo ""
echo "📦 Building Webview..."
cd "$ROOT_DIR/webview"
npm run build

echo "✅ Webview build complete!"
echo ""
echo "🧩 Building VS Code Extension..."
cd "$EXT_DIR"
npm run build

echo "✅ Extension build complete!"
echo ""
echo "🎉 All builds finished. Binaries are in extension-vscode/bin/ and extension-vscode/dist/"
