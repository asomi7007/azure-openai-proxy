import https from 'node:https';
import http from 'node:http';
import { log, logError } from './utils/logger.mjs';
import { convertResponseChatToResponses, createResponsesStreamTransformer } from './transformers/responses-to-chat.mjs';
import { convertOpenAIToAnthropic, OpenAIToAnthropicStreamTransformer } from './transformers/openai-to-anthropic.mjs';

/**
 * Convert an Azure-style error payload into an Anthropic-style error envelope.
 * Azure 에러 응답을 Anthropic 호환 에러 형식으로 변환합니다.
 * 일부 Anthropic-compatible 클라이언트는 Anthropic 형식 에러만 안정적으로 파싱합니다.
 */
function toAnthropicError(statusCode, bodyStr) {
  try {
    const parsed = JSON.parse(bodyStr);
    // 이미 Anthropic 형식이면 그대로 반환
    if (parsed.type === 'error' && parsed.error) {
      return bodyStr;
    }
    // Azure 형식 에러 → Anthropic 형식으로 변환
    const message = parsed.error?.message || parsed.message || bodyStr.slice(0, 200);
    const code = parsed.error?.code || parsed.error?.type || 'api_error';
    return JSON.stringify({
      type: 'error',
      error: {
        type: code,
        message: message,
      },
    });
  } catch {
    return JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: `Azure returned ${statusCode}: ${bodyStr.slice(0, 200)}`,
      },
    });
  }
}

/**
 * Parse the retry delay in seconds from a 429 error payload.
 * 429 에러 본문에서 재시도 대기 시간(초)을 추출합니다.
 * "Please wait 52 seconds before retrying" → 52
 */
function parseRetryAfterSeconds(bodyStr) {
  try {
    const parsed = JSON.parse(bodyStr);
    const msg = parsed.error?.message || parsed.message || '';
    const match = msg.match(/Please wait (\d+) seconds? before retrying/i);
    if (match) return parseInt(match[1], 10);
  } catch { /* ignore */ }
  return null;
}

/**
 * Proxy a normalized request to the final Azure upstream endpoint.
 * 정규화된 요청을 최종 Azure upstream endpoint로 전달합니다.
 * 이 계층은 재시도, 스트리밍 처리, 응답 호환 레이어 변환을 담당합니다.
 * @param {import('node:http').IncomingMessage} clientReq - Original client request
 * @param {import('node:http').ServerResponse} clientRes - Client response object
 * @param {string} targetUrl - Full target URL
 * @param {object} headers - Transformed headers
 * @param {Buffer} bodyBuffer - Request body as Buffer
 * @param {boolean} isStreaming - Whether this is a streaming request
 * @param {boolean} isAnthropicRoute - Whether target is in Anthropic format
 * @param {boolean} isResponsesApi - Whether this is a Responses API request
 * @param {string} responsesApiModel - Responses API model name
 * @param {boolean} originalClientRoute - Original client route (for response conversion)
 */
export function proxyRequest(clientReq, clientRes, targetUrl, headers, bodyBuffer, isStreaming, isAnthropicRoute = false, isResponsesApi = false, responsesApiModel = '', originalClientRoute = false, _retryCount = 0) {
  const url = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: clientReq.method,
    headers: {
      ...headers,
      'content-length': Buffer.byteLength(bodyBuffer),
    },
    timeout: 0, // No timeout
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    const statusCode = proxyRes.statusCode;
    const isStreamResponse = isStreaming && statusCode === 200;

    if (isStreamResponse) {
      log('PROXY', `← ${statusCode} (stream)`);
    } else {
      log('PROXY', `← ${statusCode} content-type=${proxyRes.headers['content-type'] || 'none'}`);
    }

    // Set all timeout values to 0 for streaming
    if (isStreamResponse) {
      proxyRes.setTimeout(0);
      clientRes.setTimeout(0);
      if (clientReq.socket) clientReq.socket.setTimeout(0);
      if (clientRes.socket) clientRes.socket.setTimeout(0);
    }

    // Non-streaming: buffer response for debugging + error/format conversion
    if (!isStreamResponse) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const fullBody = Buffer.concat(chunks);
        const bodyStr = fullBody.toString('utf-8');
        if (statusCode >= 400) {
          logError('PROXY', `Error response (${statusCode}): ${bodyStr.slice(0, 1000)}`);

          // Retry 429 responses with a parsed wait time plus a safety buffer.
          // 429 응답은 파싱한 대기 시간에 버퍼를 더해 최대 3회 재시도합니다.
          if (statusCode === 429 && _retryCount < 3) {
            const parsedSec = parseRetryAfterSeconds(bodyStr);
            const waitSec = (parsedSec != null ? parsedSec : 60) + 10;
            log('PROXY', `Rate limited. Retrying after ${waitSec}s${parsedSec != null ? ` (${parsedSec}+10)` : ' (fallback)'} (attempt ${_retryCount + 1}/3)...`);
            setTimeout(() => {
              proxyRequest(clientReq, clientRes, targetUrl, headers, bodyBuffer, isStreaming, isAnthropicRoute, isResponsesApi, responsesApiModel, originalClientRoute, _retryCount + 1);
            }, waitSec * 1000);
            return;
          }

          if (isAnthropicRoute) {
            const anthropicError = toAnthropicError(statusCode, bodyStr);
            log('PROXY', `Converted to Anthropic error format`);
            const errorBuf = Buffer.from(anthropicError, 'utf-8');
            if (!clientRes.headersSent) {
              const responseHeaders = { ...proxyRes.headers, 'content-type': 'application/json', 'content-length': String(errorBuf.length) };
              clientRes.writeHead(statusCode, responseHeaders);
            }
            clientRes.end(errorBuf);
            return;
          }
        } else {
          log('PROXY', `Response (${statusCode}, ${bodyStr.length} bytes): ${bodyStr.slice(0, 300)}`);
        }

        // Rebuild a Responses-compatible payload when the upstream answered with Chat Completions.
        // upstream가 Chat Completions로 응답한 경우 Responses 호환 payload로 다시 구성합니다.
        if (isResponsesApi && statusCode === 200) {
          try {
            const chatBody = JSON.parse(bodyStr);
            const model = chatBody.model || '';
            if (model) {
              log('PROXY', `Upstream model: ${model}`);
            }
            const converted = convertResponseChatToResponses(chatBody, model);
            const convertedStr = JSON.stringify(converted);
            log('PROXY', `Chat→Responses (non-stream) converted`);
            const convertedBuf = Buffer.from(convertedStr, 'utf-8');
            if (!clientRes.headersSent) {
              clientRes.writeHead(statusCode, { ...proxyRes.headers, 'content-type': 'application/json', 'content-length': String(convertedBuf.length) });
            }
            clientRes.end(convertedBuf);
            return;
          } catch (e) {
            logError('PROXY', `Responses conversion failed: ${e.message}`);
          }
        }

        // Preserve the original client contract when an Anthropic-style client was rerouted to OpenAI.
        // originalClientRoute가 true면 Anthropic 호환 클라이언트 계약을 유지하도록 응답도 Anthropic 형식으로 복원합니다.
        if (originalClientRoute && statusCode === 200 && !isResponsesApi) {
          try {
            const openaiBody = JSON.parse(bodyStr);
            if (openaiBody.model) {
              log('PROXY', `Selected model: ${openaiBody.model}`);
            }
            // OpenAI 응답 포맷 확인 (choices 필드)
            if (openaiBody.choices) {
              const anthropicBody = convertOpenAIToAnthropic(openaiBody);
              const convertedStr = JSON.stringify(anthropicBody);
              log('PROXY', `OpenAI→Anthropic (non-stream) converted`);
              const convertedBuf = Buffer.from(convertedStr, 'utf-8');
              if (!clientRes.headersSent) {
                clientRes.writeHead(statusCode, { ...proxyRes.headers, 'content-type': 'application/json', 'content-length': String(convertedBuf.length) });
              }
              clientRes.end(convertedBuf);
              return;
            }
          } catch (e) {
            logError('PROXY', `OpenAI→Anthropic conversion failed: ${e.message}`);
          }
        }

        if (!clientRes.headersSent) {
          clientRes.writeHead(statusCode, proxyRes.headers);
        }
        clientRes.end(fullBody);
      });
      proxyRes.on('error', (err) => {
        logError('PROXY', `Response stream error: ${err.message}`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
        }
        const errBody = isAnthropicRoute
          ? JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } })
          : JSON.stringify({ error: 'proxy_response_error', message: err.message });
        clientRes.end(errBody);
      });
      return;
    }

    // Streaming responses either go through a compatibility transformer or pass straight through.
    // 스트리밍 응답은 호환 레이어 변환을 거치거나, 필요 없으면 그대로 전달합니다.
    if (isResponsesApi) {
      log('PROXY', `Stream (Responses API SSE transform)`);
      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders['content-length'];
      clientRes.writeHead(statusCode, responseHeaders);

      const transformer = createResponsesStreamTransformer(responsesApiModel);
      proxyRes.on('data', (chunk) => {
        const transformed = transformer.transform(chunk);
        if (transformed) clientRes.write(transformed);
      });
      proxyRes.on('end', () => {
        const flushed = transformer.flush();
        if (flushed) clientRes.write(flushed);
        clientRes.end();
        log('PROXY', 'Stream done (Responses API)');
      });
      proxyRes.on('error', (err) => {
        logError('PROXY', `Response stream error: ${err.message}`);
        clientRes.end();
      });
      return;
    }

    // Streaming OpenAI → Anthropic 변환
    // originalClientRoute가 true면 client는 Anthropic 형식 요청 → response도 Anthropic 형식으로 변환
    if (originalClientRoute) {
      log('PROXY', `Stream (OpenAI→Anthropic SSE transform)`);
      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders['content-length'];
      clientRes.writeHead(statusCode, responseHeaders);

      const transformer = new OpenAIToAnthropicStreamTransformer();
      let selectedModelLogged = false;
      proxyRes.on('data', (chunk) => {
        const transformed = transformer.transform(chunk);
        if (!selectedModelLogged && transformer.model) {
          selectedModelLogged = true;
          log('PROXY', `Upstream model(s): ${transformer.model}`);
        }
        if (transformed) clientRes.write(transformed);
      });
      proxyRes.on('end', () => {
        const flushed = transformer.flush();
        if (flushed) clientRes.write(flushed);
        clientRes.end();
        log('PROXY', 'Stream done (OpenAI→Anthropic)');
      });
      proxyRes.on('error', (err) => {
        logError('PROXY', `Response stream error: ${err.message}`);
        clientRes.end();
      });
      return;
    }

    // 일반 스트리밍: forward status/headers and pipe through
    clientRes.writeHead(statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes, { end: true });

    proxyRes.on('end', () => {
      log('PROXY', 'Stream done');
    });

    proxyRes.on('error', (err) => {
      logError('PROXY', `Response stream error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
      }
      clientRes.end(JSON.stringify({ error: 'proxy_response_error', message: err.message }));
    });
  });

  // Handle proxy request errors
  proxyReq.on('error', (err) => {
    logError('PROXY', `Request error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    const errBody = isAnthropicRoute
      ? JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } })
      : JSON.stringify({ error: 'proxy_request_error', message: err.message });
    clientRes.end(errBody);
  });

  // Handle client disconnect - clean up proxy request
  clientReq.on('close', () => {
    if (!proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });

  // Set timeout to 0 on proxy request
  proxyReq.setTimeout(0);

  // Write body and send
  proxyReq.end(bodyBuffer);
}
