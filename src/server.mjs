import { createServer } from 'node:http';
import { transformBody } from './transformers/body.mjs';
import { transformHeaders } from './transformers/headers.mjs';
import { convertAnthropicToOpenAI, isOpenAIModel } from './transformers/anthropic-to-openai.mjs';
import { convertRequestResponsesToChat } from './transformers/responses-to-chat.mjs';
import { proxyRequest } from './proxy.mjs';
import { log, logError } from './utils/logger.mjs';

/**
 * Collect request body into a Buffer
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Send CORS headers
 * @param {import('node:http').ServerResponse} res
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
}

/**
 * OpenAI 표준 경로를 Azure OpenAI 배포 경로로 변환
 * /openai/v1/chat/completions → /openai/deployments/{model}/chat/completions?api-version=...
 * /openai/v1/responses        → /openai/deployments/{model}/responses?api-version=...
 */
function toAzureOpenAIPath(targetPath, model, config) {
  const apiVersion = config.azure.openAIApiVersion || '2024-05-01-preview';

  // /openai/v1/{endpoint} 패턴 매칭
  const match = targetPath.match(/^\/openai\/v1\/(.+)$/);
  if (match) {
    let endpoint = match[1]; // chat/completions, responses, etc.
    let version = apiVersion;

    const isCompletionsModel = config.completionsModels?.includes(model);

    if (isCompletionsModel) {
      log('PROXY', `Completions-only model → /completions endpoint`);
      endpoint = 'completions';
    } else if (endpoint === 'responses') {
      // Azure OpenAI는 Responses API 미지원 → chat/completions로 변환
      log('PROXY', `Responses API → chat/completions (Azure 미지원)`);
      endpoint = 'chat/completions';
    }

    const azurePath = `/openai/deployments/${model}/${endpoint}?api-version=${version}`;
    log('PROXY', `Azure OpenAI path: ${targetPath} → ${azurePath}`);
    return azurePath;
  }

  // 이미 deployments 형식이거나 매칭 안 되면 그대로
  return targetPath;
}

/**
 * Create and return the HTTP server
 * @param {object} config - Configuration object
 * @returns {import('node:http').Server}
 */
export function createProxyServer(config) {
  const server = createServer(async (req, res) => {
    // Disable all timeouts
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket) req.socket.setTimeout(0);

    // CORS
    setCorsHeaders(res);

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', proxy: 'azure-openai-proxy' }));
      return;
    }

    try {
      // URL 기반 1차 라우팅 판단
      // /anthropic/* 또는 /v1/messages → Anthropic Claude
      // /openai/*, /v1/responses, /v1/chat/completions → Azure OpenAI
      let isAnthropicRoute = req.url.startsWith('/anthropic') || req.url.startsWith('/v1/messages');
      let originalClientRoute = isAnthropicRoute; // ← 원래 client 라우트 저장 (response 변환용)
      let targetPath = req.url;

      // OpenAI 경로 정규화: /openai/responses → /openai/v1/responses
      if (!isAnthropicRoute && targetPath.startsWith('/openai/')) {
        const subPath = targetPath.slice('/openai/'.length);
        if (!subPath.startsWith('v1/')) {
          targetPath = '/openai/v1/' + subPath;
          log('PROXY', `OpenAI path normalized: ${req.url} → ${targetPath}`);
        }
      }

      // Collect body
      const rawBody = await collectBody(req);

      let bodyBuffer;
      let isStreaming = false;
      let isResponsesApi = false; // Responses API → Chat Completions 변환 여부
      let responsesApiModel = '';
      let parsedModel = ''; // 최종 모델명 (native responses 판단용)

      if (rawBody.length > 0) {
        try {
          let parsedBody = JSON.parse(rawBody.toString('utf-8'));

          // 모델명 기반 라우팅 오버라이드 (Summon 방식):
          // Anthropic 형식으로 들어왔어도 OpenAI 모델이면 → 포맷 변환 후 Azure OpenAI로
          if (isAnthropicRoute && isOpenAIModel(parsedBody.model, config)) {
            log('PROXY', `Model-based reroute: ${parsedBody.model} → Azure OpenAI (Chat Completions)`);
            parsedBody = convertAnthropicToOpenAI(parsedBody);
            isAnthropicRoute = false;
            targetPath = '/openai/v1/chat/completions';
          } else if (isAnthropicRoute && req.url.startsWith('/v1/messages')) {
            // /v1/messages → /anthropic/v1/messages (Azure Foundry prefix 보정)
            targetPath = '/anthropic' + req.url;
          }

          // Responses API 요청 감지 및 Chat Completions로 변환
          // native 모델(gpt-5.3-codex 등)은 Azure Responses API 직접 지원 → 변환 불필요
          if (!isAnthropicRoute && targetPath.includes('/v1/responses') && parsedBody.input != null) {
            const isNative = config.nativeResponsesModels?.includes(parsedBody.model);
            if (isNative) {
              log('PROXY', `Native Responses API: passing through as-is, model=${parsedBody.model}`);
            } else {
              isResponsesApi = true;
              responsesApiModel = parsedBody.model || '';
              parsedBody = convertRequestResponsesToChat(parsedBody);
              log('PROXY', `Responses API body converted: input→messages, model=${responsesApiModel}`);
            }
          }

          // Debug: 요청 핵심 정보 로깅
          log('DEBUG', `Request: model=${parsedBody.model}, stream=${parsedBody.stream}, messages=${parsedBody.messages?.length ?? 0}, system=${typeof parsedBody.system}`);

          // Transform body (모델명 매핑, cache_control 제거, sanitize 등)
          const result = transformBody(parsedBody, isAnthropicRoute, config);
          parsedBody = result.body;
          isStreaming = result.isStreaming;

          parsedModel = parsedBody.model || '';
          const isNativeResp = config.nativeResponsesModels?.includes(parsedModel) && targetPath.includes('/v1/responses');

          // OpenAI 라우트: Azure 배포 URL로 변환
          // native responses 모델은 path 변환 없이 AI Foundry로 직접 전달
          if (!isAnthropicRoute && parsedBody.model && !isNativeResp) {
            // Codex 계열: messages → prompt 변환
            if (config.completionsModels?.includes(parsedBody.model) && parsedBody.messages) {
              const prompt = parsedBody.messages.map(m => {
                if (m.role === 'system') return `System: ${m.content}\n`;
                if (m.role === 'user') return `User: ${m.content}\n`;
                if (m.role === 'assistant') return `Assistant: ${m.content}\n`;
                return `${m.content}\n`;
              }).join('') + 'Assistant:';
              const { messages: _m, ...rest } = parsedBody;
              parsedBody = { ...rest, prompt };
              log('PROXY', `Codex: messages→prompt converted`);
            }
            targetPath = toAzureOpenAIPath(targetPath, parsedBody.model, config);
          }
          bodyBuffer = Buffer.from(JSON.stringify(parsedBody), 'utf-8');
        } catch (parseErr) {
          logError('DEBUG', `Body parse/transform error: ${parseErr.message}\n${parseErr.stack}`);
          // Not JSON or transform error, pass through as-is
          if (isAnthropicRoute && req.url.startsWith('/v1/messages')) {
            targetPath = '/anthropic' + req.url;
          }
          bodyBuffer = rawBody;
        }
      } else {
        if (isAnthropicRoute && req.url.startsWith('/v1/messages')) {
          targetPath = '/anthropic' + req.url;
        }
        bodyBuffer = rawBody;
      }

      // 최종 target URL 결정
      // nativeResponsesModels: AI Foundry(services.ai.azure.com) + /openai/v1/responses 직접 전달
      const isNativeResponsesRequest = !isAnthropicRoute
        && config.nativeResponsesModels?.includes(parsedModel)
        && targetPath.includes('/v1/responses');
      let finalBaseUrl, finalPath;
      if (isNativeResponsesRequest) {
        finalBaseUrl = config.azure.baseUrl;
        const responsesApiVersion = config.azure.openAIResponsesApiVersion || 'preview';
        finalPath = `/openai/v1/responses?api-version=${responsesApiVersion}`;
        log('PROXY', `Native Responses: routing to AI Foundry (${finalBaseUrl})`);
      } else if (isAnthropicRoute) {
        finalBaseUrl = config.azure.baseUrl;
        finalPath = targetPath;
      } else {
        finalBaseUrl = config.azure.openAIBaseUrl || config.azure.baseUrl;
        finalPath = targetPath;
      }
      const targetUrl = `${finalBaseUrl}${finalPath}`;

      log('PROXY', `${req.method} ${req.url} → ${targetUrl} (${isAnthropicRoute ? 'Anthropic' : 'OpenAI'})`);

      // Transform headers
      const transformedHeaders = transformHeaders(req.headers, isAnthropicRoute, config);

      // Proxy the request
      // originalClientRoute 전달: response conversion은 원래 client route 기준으로 결정
      proxyRequest(req, res, targetUrl, transformedHeaders, bodyBuffer, isStreaming, isAnthropicRoute, isResponsesApi, responsesApiModel, originalClientRoute);
    } catch (err) {
      logError('SERVER', `Unhandled error: ${err.message}`);
      logError('SERVER', `Stack: ${err.stack}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      // Anthropic 라우트면 Anthropic 에러 형식으로 반환
      const isAnthopic = req.url?.startsWith('/anthropic') || req.url?.startsWith('/v1/messages');
      const errBody = isAnthopic
        ? JSON.stringify({ type: 'error', error: { type: 'internal_error', message: err.message } })
        : JSON.stringify({ error: 'internal_error', message: err.message });
      res.end(errBody);
    }
  });

  // Disable server timeout
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  return server;
}
