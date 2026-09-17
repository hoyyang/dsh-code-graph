#!/bin/bash
# dsh-code-graph build: 装依赖（若缺）→ tsc 编译 host（src -> lib）。
# 自包含：用本包 node_modules 的编译器与依赖，不依赖 DSH_CHECKOUT。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Installing dependencies (prefer offline) ==="
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --prefer-offline
else
  npm install --no-audit --no-fund
fi

echo "=== Compiling host (src -> lib) ==="
node_modules/.bin/tsc -p tsconfig.json

echo "=== dsh-code-graph build complete ==="
ls -la lib/index.js
