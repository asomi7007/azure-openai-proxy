#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROXY_PORT="${PROXY_PORT:-8081}"
PROXY_PROFILE="${1:-default}"

cd "$PROJECT_DIR"

echo
echo "=========================================="
echo "  Azure AI Foundry - Proxy Shell"
echo "=========================================="
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

export PROXY_MODEL_PROFILE="$PROXY_PROFILE"
echo "[1/2] Starting proxy with profile: $PROXY_MODEL_PROFILE"
node src/index.mjs &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
sleep 2

echo "[2/2] Exporting environment variables"
export ANTHROPIC_BASE_URL="http://localhost:${PROXY_PORT}"
export ANTHROPIC_API_KEY="azure-proxy-key"
export OPENAI_BASE_URL="http://localhost:${PROXY_PORT}/openai"
export OPENAI_API_KEY="azure-proxy-key"

echo
echo "  ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
echo "  ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
echo "  OPENAI_BASE_URL=$OPENAI_BASE_URL"
echo "  OPENAI_API_KEY=$OPENAI_API_KEY"
echo
echo "=========================================="
echo "  Run claude, roo, or other CLI tools here."
echo "  Stop with Ctrl+C or exit the shell."
echo "=========================================="
echo

exec "${SHELL:-/bin/bash}" -i
