import https from 'node:https';
import http from 'node:http';
import { log, logError } from './utils/logger.mjs';
import { convertResponseChatToResponses, createResponsesStreamTransformer } from './transformers/responses-to-chat.mjs';
import { convertOpenAIToAnthropic, OpenAIToAnthropicStreamTransformer } from './transformers/openai-to-anthropic.mjs';

/**
 * Anthropic 에러 형식으로 변환 (Azure → Anthropic)
 * 확장 프로그램(Claude Code, Roo Code 등)이 Anthropic 형식만 파싱할 수 있으므로
 * Azure 형식 에러를 Anthropic 형식으로 변환
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
 * 429 에러 메시지에서 대기 시간(초) 파싱
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
 * Proxy a request to the target Azure endpoint
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

          // 429: 자동 재시도 (최대 3회)
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

        // Responses API: Chat Completions 응답 → Responses API 응답 변환
        if (isResponsesApi && statusCode === 200) {
          try {
            const chatBody = JSON.parse(bodyStr);
            const model = chatBody.model || '';
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

        // OpenAI → Anthropic 응답 변환 (Claude Code에서 OpenAI 모델 요청했을 때)
        // originalClientRoute가 true면 client는 Anthropic 형식 요청 → response도 Anthropic 형식으로 변환
        if (originalClientRoute && statusCode === 200 && !isResponsesApi) {
          try {
            const openaiBody = JSON.parse(bodyStr);
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

    // Streaming: Responses API면 SSE 변환, OpenAI→Anthropic 변환, 아니면 그대로 pipe
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
      proxyRes.on('data', (chunk) => {
        const transformed = transformer.transform(chunk);
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
