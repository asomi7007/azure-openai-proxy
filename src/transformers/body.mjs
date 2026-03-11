import { log, logError } from '../utils/logger.mjs';

/**
 * Normalize Anthropic message sequences before forwarding them upstream.
 * upstream으로 보내기 전에 Anthropic 메시지 시퀀스를 정규화합니다.
 * 1. tool_use 다음에는 대응하는 tool_result가 있어야 하며, 없으면 자동 삽입합니다.
 * 2. input이 없거나 비어 있는 tool_use 블록은 제거합니다.
 */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  messages = JSON.parse(JSON.stringify(messages)); // deep copy

  // Pass 1: input이 null/undefined/빈 객체인 tool_use 블록 제거
  // + 제거된 tool_use에 대응하는 tool_result도 함께 제거
  const removedToolUseIds = new Set();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content = msg.content.filter(block => {
        if (block.type === 'tool_use' && (block.input == null || Object.keys(block.input).length === 0)) {
          log('SANITIZE', `removing empty-input tool_use: ${block.name} (${block.id})`);
          removedToolUseIds.add(block.id);
          return false;
        }
        return true;
      });
    }
  }

  // Pass 1.5: 제거된 tool_use에 대응하는 orphan tool_result 블록 제거
  if (removedToolUseIds.size > 0) {
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content = msg.content.filter(block => {
          if (block.type === 'tool_result' && removedToolUseIds.has(block.tool_use_id)) {
            log('SANITIZE', `removing orphan tool_result for: ${block.tool_use_id}`);
            return false;
          }
          return true;
        });
        // user 메시지의 content가 비면 텍스트 플레이스홀더 삽입
        if (msg.content.length === 0) {
          msg.content = [{ type: 'text', text: '[이전 도구 결과가 제거되었습니다.]' }];
        }
      }
    }
  }

  // Pass 2: tool_use → tool_result 쌍 보정
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role !== 'assistant') { i++; continue; }

    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUseIds = content
      .filter(b => b.type === 'tool_use' && b.id)
      .map(b => b.id);

    if (toolUseIds.length === 0) { i++; continue; }

    const nextIdx = i + 1;
    if (nextIdx < messages.length && messages[nextIdx].role === 'user') {
      const nextMsg = messages[nextIdx];
      if (typeof nextMsg.content === 'string') {
        nextMsg.content = nextMsg.content ? [{ type: 'text', text: nextMsg.content }] : [];
      }
      if (Array.isArray(nextMsg.content)) {
        const existingIds = new Set(
          nextMsg.content
            .filter(b => b.type === 'tool_result' && b.tool_use_id)
            .map(b => b.tool_use_id)
        );
        const missing = toolUseIds.filter(id => !existingIds.has(id));
        if (missing.length > 0) {
          log('SANITIZE', `msg[${i}] missing tool_results: ${missing.join(', ')} → inserting`);
          const inserts = missing.map(id => ({
            type: 'tool_result',
            tool_use_id: id,
            content: '[도구 실행이 중단되었습니다. 이전 결과를 사용할 수 없습니다.]',
          }));
          nextMsg.content.unshift(...inserts);
        }
      }
    } else {
      log('SANITIZE', `msg[${i}] no next user msg → inserting tool_result user msg`);
      const toolResults = toolUseIds.map(id => ({
        type: 'tool_result',
        tool_use_id: id,
        content: '[도구 실행이 중단되었습니다. 이전 결과를 사용할 수 없습니다.]',
      }));
      messages.splice(nextIdx, 0, { role: 'user', content: toolResults });
    }
    i++;
  }

  return messages;
}

/**
 * Recursively remove all `cache_control` keys from an object/array
 * @param {any} obj
 * @returns {any}
 */
function removeCacheControl(obj) {
  if (Array.isArray(obj)) {
    return obj.map(removeCacheControl);
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'cache_control') continue;
      result[key] = removeCacheControl(value);
    }
    return result;
  }
  return obj;
}

/**
 * Transform a parsed request body according to the selected compatibility route.
 * 선택된 호환 라우트에 맞춰 파싱된 요청 본문을 변환합니다.
 * @param {object} body - Parsed JSON body
 * @param {boolean} isAnthropicRoute - Whether this is an Anthropic route
 * @param {object} config - Configuration object
 * @returns {{ body: object, isStreaming: boolean }} Transformed body and streaming flag
 */
export function transformBody(body, isAnthropicRoute, config) {
  // Remove unsupported parameters (방어: config.unsupportedParams가 배열인지 확인)
  const unsupportedParams = Array.isArray(config.unsupportedParams) ? config.unsupportedParams : [];
  for (const param of unsupportedParams) {
    if (param in body) {
      delete body[param];
    }
  }

  // Model name mapping (Anthropic + OpenAI 공통)
  if (body.model && config.modelNameMap[body.model]) {
    const originalModel = body.model;
    body.model = config.modelNameMap[body.model];
    log('PROXY', `Model: ${originalModel} → ${body.model}`);
  } else if (body.model) {
    log('PROXY', `Model: ${body.model} (no mapping)`);
  }

  if (isAnthropicRoute) {
    // Recursively remove cache_control
    body = removeCacheControl(body);

    // tool_use/tool_result 쌍 보정 + 빈 input tool_use 제거
    if (body.messages) {
      body.messages = sanitizeMessages(body.messages);
    }
  } else {
    // OpenAI 라우트: max_tokens → max_completion_tokens 변환
    // Azure OpenAI API는 max_tokens 대신 max_completion_tokens 사용
    if (body.max_tokens != null && body.max_completion_tokens == null) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
      log('PROXY', `Converted max_tokens → max_completion_tokens: ${body.max_completion_tokens}`);
    }
  }

  const isStreaming = !!body.stream;

  return { body, isStreaming };
}
