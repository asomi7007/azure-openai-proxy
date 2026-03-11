#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROFILE="${1:-default}"

cd "$PROJECT_DIR"
export PROXY_MODEL_PROFILE="$PROFILE"

echo
echo "========================================"
echo "  Azure OpenAI Proxy - Starting..."
echo "========================================"
echo "  Active Profile: $PROXY_MODEL_PROFILE"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed or not available in PATH."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[INFO] Installing dependencies..."
  npm install
  echo
fi

if [ ! -f config.yaml ]; then
  echo "[ERROR] config.yaml is missing."
  exit 1
fi

if [ ! -f .env ]; then
  echo "[WARN] .env is missing. AZURE_API_KEY must be provided via environment variables."
  echo
fi

echo "[INFO] Starting proxy server..."
echo "[INFO] Stop with Ctrl+C"
echo

node src/index.mjs
