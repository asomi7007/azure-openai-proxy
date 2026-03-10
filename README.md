# Azure OpenAI Proxy

Azure AI Foundry 프록시 서버 - Roo Code / Claude Code에서 Azure 호스팅 OpenAI/Anthropic 모델을 사용하기 위한 투명한 프록시입니다.

> **참고**: 이 프로젝트는 기존 `azure-claude-proxy`(Python)의 기능을 모두 포함하는 통합 프록시입니다. `azure-claude-proxy`는 이 프로젝트로 통합되어 더 이상 필요하지 않습니다.

## 주요 기능

- **인증 변환**: Anthropic `x-api-key` → Azure `Bearer` 토큰 자동 변환
- **호환성 패치**: Azure 미지원 파라미터 자동 제거 (`prompt_cache_retention`, `cache_control` 등)
- **모델명 매핑**: 클라이언트 모델 ID → Azure 배포명 자동 매핑
- **투명한 스트리밍**: SSE 파싱 없이 `pipe()`로 직접 전달
- **듀얼 라우팅**: `/anthropic/*` → Anthropic 경로, 그 외 → OpenAI 경로
- **Anthropic→OpenAI 변환**: Anthropic 형식 요청을 OpenAI 형식으로 자동 변환 (GPT 모델 사용 시)
- **CORS 지원**: 브라우저 기반 클라이언트 지원
- **anthropic-beta 필터링**: Azure 미지원 beta 헤더 자동 제거
- **sanitizeMessages**: tool_use/tool_result 쌍 보정, 빈 input 블록 제거
- **Azure Responses API 지원**: OpenAI Responses API를 Chat Completions로 자동 변환
- **Native 모델 지원**: 특정 모델은 Azure Responses API를 네이티브로 직접 사용
- **자동 재시도**: 429 에러 시 지수 백오프로 자동 재시도 (최대 3회)
- **에러 형식 변환**: Azure 에러를 Anthropic 형식으로 자동 변환

## 설치

```bash
npm install
```

## 설정

### config.yaml

서버 포트, Azure 엔드포인트, 모델 매핑 등을 설정합니다:

```yaml
server:
  port: 8081

azure:
  baseUrl: "https://your-resource.services.ai.azure.com"
  openAIBaseUrl: "https://your-resource.openai.azure.com"
  openAIApiVersion: "2024-05-01-preview"
  openAIResponsesApiVersion: "preview"
  # apiKey는 .env에서 로드

# Azure 미지원 파라미터 자동 제거
unsupportedParams:
  - prompt_cache_retention
  - prompt_cache_key

# 모델명 매핑 (클라이언트 요청 → Azure 배포명)
modelNameMap:
  # Claude Opus
  claude-opus-4-6: claude-opus-4-6
  claude-opus-4-5-20251101: claude-opus-4-5
  claude-opus-4-5-20250929: claude-opus-4-6
  # Claude Sonnet (이제 전용 배포 있음)
  claude-sonnet-4-6: claude-sonnet-4-6
  claude-sonnet-4-5: claude-sonnet-4-5
  claude-sonnet-4-5-20250929: claude-sonnet-4-5
  claude-sonnet-4-20250514: claude-sonnet-4-5
  # Claude Haiku (→ Sonnet으로 대체)
  claude-haiku-4-5-20251001: claude-sonnet-4-5
  # GPT
  gpt-5.2-chat: gpt-5.2-chat
  gpt-5.3-codex: gpt-5.3-codex
  gpt-5.4: gpt-5.4
  gpt-5.4-pro: gpt-5.4-pro

# Azure Responses API를 네이티브로 지원하는 모델 (변환 없이 직접 전달)
# api-version: openAIResponsesApiVersion 사용
nativeResponsesModels:
  - gpt-5.3-codex

# chat/completions 대신 /completions 엔드포인트를 사용하는 모델 (Codex 계열)
completionsModels: []

# 이 모델들은 Anthropic 형식으로 들어와도 Azure OpenAI로 자동 변환·라우팅
openAIModels:
  - gpt-5.2-chat
  - gpt-5.3-codex
  - gpt-5.4
  - gpt-5.4-pro

# Azure 미지원 anthropic-beta 헤더 자동 제거
unsupportedAnthropicBetas:
  - prompt-caching-2024-07-31
  - fine-grained-tool-streaming-2025-05-14
  - output-128k-2025-02-19
  - context-1m-2025-08-07

# 모델 변환 프로필 (환경변수 PROXY_MODEL_PROFILE로 선택)
modelProfiles:
  claude-to-gpt:
    modelNameMap:
      claude-opus-4-6: gpt-5.4-pro
      claude-sonnet-4-6: gpt-5.4
    openAIModels:
      - gpt-5.4-pro
      - gpt-5.4
```

### .env

API 키 등 민감한 정보를 설정합니다:

```
AZURE_API_KEY=your-api-key-here
```

환경변수로도 오버라이드 가능:
- `AZURE_API_KEY` - Azure API 키
- `AZURE_BASE_URL` - Azure 엔드포인트 URL
- `PORT` - 서버 포트
- `PROXY_MODEL_PROFILE` - 모델 변환 프로필 (`default`, `claude-to-gpt` 등)

## 실행

### 방법 1: 포그라운드 실행 (개발/디버깅)

```cmd
scripts\start.bat
```

또는:

```bash
npm start
```

### 방법 2: Claude Code와 함께 실행

프록시를 백그라운드로 시작하고, 환경변수를 설정한 후 Claude Code를 실행합니다. Claude 종료 시 프록시도 자동으로 정리됩니다.

```cmd
scripts\claude-code.bat
```

### 방법 3: 대화형 셸 (Proxy Shell)

프록시를 백그라운드로 시작하고, 환경변수가 설정된 대화형 셸을 엽니다. 이 셸에서 `claude`, `roo` 등 원하는 도구를 자유롭게 실행할 수 있습니다.

```cmd
scripts\proxy-shell.bat
```

### 방법 4: Claude→GPT 변환 모드 실행

Claude 모델 요청을 GPT 배포로 변환하는 프로필(`claude-to-gpt`)로 실행합니다.

```cmd
scripts\start-claude-to-gpt.bat
```

또는 `start.bat`에 프로필명을 직접 지정할 수 있습니다.

```cmd
scripts\start.bat claude-to-gpt
```

### 중지

```cmd
scripts\stop.bat
```

또는 실행 중인 터미널에서 `Ctrl+C`

## 모델 매핑

클라이언트가 요청하는 모델 이름이 Azure 배포명과 다를 경우 자동으로 매핑됩니다:

| 요청 모델명 | Azure 배포명 | 비고 |
|-------------|-------------|------|
| `claude-opus-4-6` | claude-opus-4-6 | 최신 Opus |
| `claude-opus-4-5-20251101` | claude-opus-4-5 | Opus 이전 버전 |
| `claude-opus-4-5-20250929` | claude-opus-4-6 | Opus로 업그레이드 |
| `claude-sonnet-4-6` | claude-sonnet-4-6 | 최신 Sonnet |
| `claude-sonnet-4-5` | claude-sonnet-4-5 | 최신 Sonnet |
| `claude-sonnet-4-5-20250929` | claude-sonnet-4-5 | Sonnet 이전 버전 |
| `claude-sonnet-4-20250514` | claude-sonnet-4-5 | Sonnet 이전 버전 |
| `claude-haiku-4-5-20251001` | claude-sonnet-4-5 | Sonnet으로 대체 |
| `gpt-5.2-chat` | gpt-5.2-chat | GPT |
| `gpt-5.3-codex` | gpt-5.3-codex | GPT Codex |
| `gpt-5.4` | gpt-5.4 | GPT |
| `gpt-5.4-pro` | gpt-5.4-pro | GPT Pro |

### 프로필 기반 매핑 확장

- `config.yaml`의 `modelProfiles`에 새 프로필을 추가하면 하드코딩 없이 매핑 규칙 확장 가능
- 실행 시 `PROXY_MODEL_PROFILE` 환경변수 또는 `scripts\start.bat <profile>`로 선택
- 선택된 프로필은 기본 설정 위에 덮어쓰는 방식으로 적용

## Roo Code 프로필 설정

| 항목 | 값 |
|------|-----|
| API Provider | Anthropic |
| Base URL | `http://localhost:8081/anthropic` |
| API Key | (아무 값) |
| Model ID | `claude-sonnet-4-5` 또는 `claude-opus-4-6` |

## Claude Code 설정

`scripts\claude-code.bat` 또는 `scripts\proxy-shell.bat`를 사용하면 환경변수가 자동으로 설정됩니다. 수동 설정 시:

```cmd
set ANTHROPIC_BASE_URL=http://localhost:8081
set ANTHROPIC_API_KEY=azure-proxy-key
set OPENAI_BASE_URL=http://localhost:8081/openai
set OPENAI_API_KEY=azure-proxy-key
```

## 라우팅

| 경로 | 설명 |
|------|------|
| `/anthropic/*` | Anthropic API 프록시 (인증 변환, beta 필터링, cache_control 제거) |
| `/v1/messages` | Anthropic Messages API (자동으로 `/anthropic/v1/messages`로 라우팅) |
| `/openai/*` | Azure OpenAI API 프록시 (인증 주입, 미지원 파라미터 제거) |
| `/v1/responses` | OpenAI Responses API (자동으로 Chat Completions로 변환, native 모델 제외) |
| `/v1/chat/completions` | Azure OpenAI Chat API |
| `/health` | 헬스 체크 |

### 모델 기반 라우팅

- **Anthropic 형식 요청**: 모델명이 `openAIModels`에 포함되면 자동으로 OpenAI 형식으로 변환
- **Responses API**: `nativeResponsesModels`에 포함된 모델은 변환 없이 Azure Responses API로 직접 전달
- **Completions 모델**: `completionsModels`에 포함된 모델은 messages를 prompt로 자동 변환

## 빌드

esbuild로 단일 파일 번들 생성:

```bash
npm run build
```

또는:

```cmd
scripts\build-exe.bat
```

번들된 ESM 파일 실행:

```bash
node dist/proxy.mjs
```

> **참고**: 번들 실행 시 `config.yaml`과 `.env` 파일이 실행 디렉토리에 있어야 합니다.

## 프로젝트 구조

```
azure-openai-proxy/
├── package.json            # 프로젝트 메타, scripts
├── config.yaml             # 외부 설정 파일
├── .env                    # 환경변수 (API 키)
├── .gitignore
├── README.md
├── src/
│   ├── index.mjs           # 엔트리포인트
│   ├── config.mjs          # 설정 로더 (config.yaml + .env)
│   ├── server.mjs          # HTTP 서버 및 라우팅
│   ├── proxy.mjs           # 프록시 요청 전달, 재시도 로직
│   ├── transformers/
│   │   ├── body.mjs        # Body 변환, sanitizeMessages
│   │   ├── headers.mjs     # Header 변환
│   │   ├── anthropic-to-openai.mjs  # Anthropic→OpenAI 포맷 변환
│   │   └── responses-to-chat.mjs    # Responses API ↔ Chat Completions 변환
│   └── utils/
│       └── logger.mjs      # 로깅 유틸
├── scripts/
│   ├── start.bat           # 포그라운드 실행
│   ├── stop.bat            # 프록시 중지
│   ├── claude-code.bat     # Claude Code 통합 실행
│   ├── proxy-shell.bat     # 대화형 프록시 셸
│   ├── start-claude-to-gpt.bat # Claude→GPT 변환 프로필 시작
│   ├── build-exe.bat       # 번들 빌드
│   ├── create-azure-credentials.ps1  # Azure 자격증명 생성
│   ├── setup-budget.ps1    # Azure 비용 예산 설정
│   ├── apply-emergency-controls.ps1  # 비상 제어 적용
│   └── stop-costly-resources.ps1     # 비용 많은 리소스 중지
└── dist/                   # (빌드 후 생성)
```

## 고급 기능

### 자동 재시도 (429 Rate Limit)

- 429 에러 발생 시 자동으로 재시도 (최대 3회)
- Azure 응답에서 대기 시간 파싱하여 지수 백오프 적용
- 재시도 간격: 파싱된 시간 + 10초 버퍼

### 에러 형식 변환

Azure 에러 응답을 Anthropic 형식으로 자동 변환:
```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Azure returned 429: Please wait 52 seconds before retrying"
  }
}
```

### Tool Use/Result 보정

Anthropic API 요구사항에 맞게 tool_use/tool_result 쌍 자동 보정:
- 빈 input을 가진 tool_use 블록 자동 제거
- 누락된 tool_result 블록 자동 삽입
- orphan tool_result 블록 정리

## Azure 관리 스크립트

프로젝트에는 Azure 관리를 위한 PowerShell 스크립트가 포함되어 있습니다:

- `create-azure-credentials.ps1` - Azure 자격증명 생성
- `setup-budget.ps1` - 비용 예산 설정
- `apply-emergency-controls.ps1` - 비상 제어 적용
- `stop-costly-resources.ps1` - 비용 많은 리소스 중지

## 의존성

- **js-yaml** - YAML 설정 파일 파싱
- **esbuild** (dev) - 단일 파일 번들링

Node.js 내장 모듈만 사용하여 런타임 의존성을 최소화했습니다.

## 라이선스

MIT
