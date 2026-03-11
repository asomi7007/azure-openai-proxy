#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

cd "$PROJECT_DIR"

echo
echo "========================================"
echo "  Azure OpenAI Proxy - Setup"
echo "========================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed or not available in PATH."
  exit 1
fi

echo "[INFO] Node.js check completed."
echo "[INFO] Shell input validation will be applied where possible."

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
AZURE_API_KEY=
AZURE_BASE_URL=
AZURE_OPENAI_BASE_URL=
PORT=8081
PROXY_MODEL_PROFILE=default
PROXY_DEFAULT_PROFILE=default
EOF
fi

get_env_value() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)
  printf '%s' "${line#*=}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  python - "$ENV_FILE" "$key" "$value" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text(encoding='utf-8').splitlines() if path.exists() else []
prefix = key + '='
lines = [line for line in lines if not line.startswith(prefix)]
lines.append(prefix + value)
path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
PY
}

mask_api_key() {
  local value="$1"
  if [ -z "$value" ]; then
    printf '(none)'
  elif [ ${#value} -le 8 ]; then
    printf '%*s' "${#value}" '' | tr ' ' '*'
  else
    printf '%s' "${value:0:4}"
    printf '%*s' $((${#value}-8)) '' | tr ' ' '*'
    printf '%s' "${value: -4}"
  fi
}

EXISTING_API_KEY="$(get_env_value AZURE_API_KEY)"
EXISTING_AZURE_BASE_URL="$(get_env_value AZURE_BASE_URL)"
EXISTING_AZURE_OPENAI_BASE_URL="$(get_env_value AZURE_OPENAI_BASE_URL)"
EXISTING_PORT="$(get_env_value PORT)"
EXISTING_PROXY_MODEL_PROFILE="$(get_env_value PROXY_MODEL_PROFILE)"

[ -n "$EXISTING_AZURE_BASE_URL" ] || EXISTING_AZURE_BASE_URL="https://your-resource.services.ai.azure.com"
[ -n "$EXISTING_AZURE_OPENAI_BASE_URL" ] || EXISTING_AZURE_OPENAI_BASE_URL="https://your-resource.openai.azure.com"
[ -n "$EXISTING_PORT" ] || EXISTING_PORT="8081"
[ -n "$EXISTING_PROXY_MODEL_PROFILE" ] || EXISTING_PROXY_MODEL_PROFILE="default"

echo "[INFO] Current AZURE_API_KEY: $(mask_api_key "$EXISTING_API_KEY")"
read -r -p "Enter new API key (Enter=keep existing): " INPUT_API_KEY
FINAL_API_KEY="$EXISTING_API_KEY"
[ -n "$INPUT_API_KEY" ] && FINAL_API_KEY="$INPUT_API_KEY"
if [ -z "$FINAL_API_KEY" ]; then
  echo "[WARN] AZURE_API_KEY is empty. Set it later in .env if needed."
fi

echo
echo "[INFO] Azure AI Foundry Base URL example: https://your-resource.services.ai.azure.com"
echo "[INFO] Current AZURE_BASE_URL: $EXISTING_AZURE_BASE_URL"
read -r -p "Enter Azure AI Foundry Base URL (Enter=keep existing): " INPUT_AZURE_BASE_URL
FINAL_AZURE_BASE_URL="$EXISTING_AZURE_BASE_URL"
[ -n "$INPUT_AZURE_BASE_URL" ] && FINAL_AZURE_BASE_URL="$INPUT_AZURE_BASE_URL"

echo
echo "[INFO] Azure OpenAI Base URL example: https://your-resource.openai.azure.com"
echo "[INFO] Current AZURE_OPENAI_BASE_URL: $EXISTING_AZURE_OPENAI_BASE_URL"
read -r -p "Enter Azure OpenAI Base URL (Enter=keep existing): " INPUT_AZURE_OPENAI_BASE_URL
FINAL_AZURE_OPENAI_BASE_URL="$EXISTING_AZURE_OPENAI_BASE_URL"
[ -n "$INPUT_AZURE_OPENAI_BASE_URL" ] && FINAL_AZURE_OPENAI_BASE_URL="$INPUT_AZURE_OPENAI_BASE_URL"

echo
echo "[INFO] Current PORT: $EXISTING_PORT"
read -r -p "Enter proxy port (Enter=keep existing): " INPUT_PORT
FINAL_PORT="$EXISTING_PORT"
[ -n "$INPUT_PORT" ] && FINAL_PORT="$INPUT_PORT"

echo
echo "Select active model profile:"
echo "  [1] default"
echo "  [2] claude-to-gpt"
echo "  [3] model-router"
echo "[INFO] Current PROXY_MODEL_PROFILE: $EXISTING_PROXY_MODEL_PROFILE"
read -r -p "Choice (default 1): " MODE_CHOICE
MODE_CHOICE="${MODE_CHOICE:-1}"
DEFAULT_PROFILE="default"
case "$MODE_CHOICE" in
  1) DEFAULT_PROFILE="default" ;;
  2) DEFAULT_PROFILE="claude-to-gpt" ;;
  3) DEFAULT_PROFILE="model-router" ;;
  *) echo "[ERROR] Invalid profile choice."; exit 1 ;;
esac

echo
echo "[INFO] Validating input values..."
python - "$FINAL_AZURE_BASE_URL" "$FINAL_AZURE_OPENAI_BASE_URL" "$FINAL_PORT" <<'PY'
import socket
import sys
from urllib.parse import urlparse
base_url, openai_url, port = sys.argv[1:4]
for label, value in [('AZURE_BASE_URL', base_url), ('AZURE_OPENAI_BASE_URL', openai_url)]:
    parsed = urlparse(value)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        print(f'[ERROR] {label} format is invalid.')
        sys.exit(1)
if not port.isdigit():
    print('[ERROR] PORT must be numeric.')
    sys.exit(1)
port_num = int(port)
if not (1 <= port_num <= 65535):
    print('[ERROR] PORT must be in the 1-65535 range.')
    sys.exit(1)
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(('127.0.0.1', port_num))
    except OSError:
        print(f'[ERROR] PORT {port_num} is already in use or unavailable.')
        sys.exit(1)
print('[OK] Local input validation passed.')
PY

check_url() {
  local label="$1"
  local url="$2"
  local api_key="$3"
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 -I -H "api-key: $api_key" "$url" || true)
  if [ -z "$api_key" ]; then
    echo "[WARN] AZURE_API_KEY is empty, so authenticated verification is limited."
  fi
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    echo "[OK] $label response check: $code"
  else
    echo "[WARN] $label connectivity check failed."
  fi
}

check_url "AZURE_BASE_URL" "$FINAL_AZURE_BASE_URL" "$FINAL_API_KEY"
check_url "AZURE_OPENAI_BASE_URL" "$FINAL_AZURE_OPENAI_BASE_URL" "$FINAL_API_KEY"

if [ -n "$FINAL_API_KEY" ]; then
  echo "[OK] API key input is present."
fi

set_env_value AZURE_API_KEY "$FINAL_API_KEY"
set_env_value AZURE_BASE_URL "$FINAL_AZURE_BASE_URL"
set_env_value AZURE_OPENAI_BASE_URL "$FINAL_AZURE_OPENAI_BASE_URL"
set_env_value PORT "$FINAL_PORT"
set_env_value PROXY_MODEL_PROFILE "$DEFAULT_PROFILE"
set_env_value PROXY_DEFAULT_PROFILE "$DEFAULT_PROFILE"

if [ ! -d node_modules ]; then
  echo "[INFO] Installing dependencies..."
  npm install
fi

echo
echo "[SUCCESS] Setup complete"
echo "[INFO] Azure AI Foundry Base URL: $FINAL_AZURE_BASE_URL"
echo "[INFO] Azure OpenAI Base URL: $FINAL_AZURE_OPENAI_BASE_URL"
echo "[INFO] Port: $FINAL_PORT"
echo "[INFO] Active profile: $DEFAULT_PROFILE"
echo "[INFO] Run: ./scripts/start.sh"
echo