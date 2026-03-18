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

export function estimatePromptTokens(body, charPerToken = 4) {
  let chars = 0;
  const divisor = Math.max(1, Number(charPerToken) || 4);

  const visit = (value) => {
    if (value == null) return;
    if (typeof value === 'string') {
      chars += value.length;
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      chars += String(value).length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value)) visit(v);
    }
  };

  // Count only request-shaping fields that contribute to prompt/context load.
  visit(body.messages);
  visit(body.system);
  visit(body.input);
  visit(body.prompt);
  visit(body.instructions);
  visit(body.tools);
  visit(body.response_format);

  return Math.max(1, Math.ceil(chars / divisor));
}

function collectRequestText(body) {
  const chunks = [];

  const visit = (value) => {
    if (value == null) return;
    if (typeof value === 'string') {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value)) visit(v);
    }
  };

  visit(body.system);
  visit(body.messages);
  visit(body.input);
  visit(body.prompt);
  visit(body.instructions);

  return chunks.join('\n').toLowerCase();
}

function selectRequestTypeRule(body, estimatedInputTokens, adaptive) {
  const rules = Array.isArray(adaptive.requestTypeProfiles) ? adaptive.requestTypeProfiles : [];
  if (rules.length === 0) return null;

  const requestText = collectRequestText(body);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (rule.enabled === false) continue;

    const minInputTokens = Number(rule.minInputTokens ?? 0);
    if (Number.isFinite(minInputTokens) && estimatedInputTokens < minInputTokens) continue;

    const requiresTools = rule.requiresTools;
    if (typeof requiresTools === 'boolean' && requiresTools !== hasTools) continue;

    const keywords = Array.isArray(rule.keywords) ? rule.keywords.filter(Boolean) : [];
    if (keywords.length > 0) {
      const matched = keywords.some((k) => requestText.includes(String(k).toLowerCase()));
      if (!matched) continue;
    }

    return rule;
  }

  return null;
}

function applyAdaptiveMaxTokens(body, config, outputTokenField = 'max_completion_tokens') {
  const adaptive = config.dynamicMaxCompletionTokens;
  if (!adaptive || adaptive.enabled === false) return;

  const model = body.model || '';
  const modelWindows = adaptive.modelContextWindows || {};
  const contextWindow = Number(modelWindows[model] ?? adaptive.defaultContextWindow ?? 1000000);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;

  const baseMinOutputTokens = Math.max(1, Number(adaptive.minOutputTokens ?? 1024));
  const baseMaxOutputTokens = Math.max(baseMinOutputTokens, Number(adaptive.maxOutputTokens ?? 64000));
  const baseOutputToInputRatio = Math.max(0.1, Number(adaptive.outputToInputRatio ?? 1.2));
  const baseMaxOutputShare = Math.min(1, Math.max(0.01, Number(adaptive.maxOutputShareOfContext ?? 0.15)));
  const baseSafetyBufferTokens = Math.max(0, Number(adaptive.safetyBufferTokens ?? 2048));
  const charPerToken = Math.max(1, Number(adaptive.charPerToken ?? 4));
  const applyWhenMissing = adaptive.applyWhenMissing !== false;

  const estimatedInputTokens = estimatePromptTokens(body, charPerToken);
  const matchedRule = selectRequestTypeRule(body, estimatedInputTokens, adaptive);

  const minOutputTokens = Math.max(1, Number(matchedRule?.minOutputTokens ?? baseMinOutputTokens));
  const maxOutputTokens = Math.max(minOutputTokens, Number(matchedRule?.maxOutputTokens ?? baseMaxOutputTokens));
  const outputToInputRatio = Math.max(0.1, Number(matchedRule?.outputToInputRatio ?? baseOutputToInputRatio));
  const maxOutputShare = Math.min(1, Math.max(0.01, Number(matchedRule?.maxOutputShareOfContext ?? baseMaxOutputShare)));
  const safetyBufferTokens = Math.max(0, Number(matchedRule?.safetyBufferTokens ?? baseSafetyBufferTokens));

  const upperByShare = Math.floor(contextWindow * maxOutputShare);
  const upperByAvailable = Math.floor(contextWindow - estimatedInputTokens - safetyBufferTokens);
  const hardUpperBound = Math.max(1, Math.min(maxOutputTokens, upperByShare, upperByAvailable));

  const ratioTarget = Math.ceil(estimatedInputTokens * outputToInputRatio);
  const recommended = Math.min(hardUpperBound, Math.max(minOutputTokens, ratioTarget));

  const requested = Number(body[outputTokenField]);
  let nextValue = null;

  if (Number.isFinite(requested) && requested > 0) {
    nextValue = Math.min(requested, recommended);
  } else if (applyWhenMissing) {
    nextValue = recommended;
  }

  if (!Number.isFinite(nextValue) || nextValue <= 0) return;
  if (Number.isFinite(requested) && requested === nextValue) return;

  body[outputTokenField] = nextValue;
  const ruleLabel = matchedRule?.name ? `, rule=${matchedRule.name}` : '';
  if (Number.isFinite(requested) && requested > 0) {
    log('PROXY', `Adaptive ${outputTokenField}: ${requested} -> ${nextValue} (input~${estimatedInputTokens}t, model=${model || 'unknown'}${ruleLabel})`);
  } else {
    log('PROXY', `Adaptive ${outputTokenField} set: ${nextValue} (input~${estimatedInputTokens}t, model=${model || 'unknown'}${ruleLabel})`);
  }
}

function normalizeOutputTokenField(body, outputTokenField) {
  const alternateField = outputTokenField === 'max_output_tokens'
    ? 'max_completion_tokens'
    : 'max_output_tokens';

  if (body.max_tokens != null && body[outputTokenField] == null) {
    body[outputTokenField] = body.max_tokens;
    delete body.max_tokens;
    log('PROXY', `Converted max_tokens → ${outputTokenField}: ${body[outputTokenField]}`);
  }

  if (body[alternateField] != null && body[outputTokenField] == null) {
    body[outputTokenField] = body[alternateField];
    log('PROXY', `Converted ${alternateField} → ${outputTokenField}: ${body[outputTokenField]}`);
  }

  if (body[alternateField] != null) {
    delete body[alternateField];
  }
}

/**
 * Transform a parsed request body according to the selected compatibility route.
 * 선택된 호환 라우트에 맞춰 파싱된 요청 본문을 변환합니다.
 * @param {object} body - Parsed JSON body
 * @param {boolean} isAnthropicRoute - Whether this is an Anthropic route
 * @param {object} config - Configuration object
 * @param {{ outputTokenField?: 'max_completion_tokens'|'max_output_tokens' }} [options]
 * @returns {{ body: object, isStreaming: boolean }} Transformed body and streaming flag
 */
export function transformBody(body, isAnthropicRoute, config, options = {}) {
  const outputTokenField = options.outputTokenField || 'max_completion_tokens';

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
    normalizeOutputTokenField(body, outputTokenField);
    applyAdaptiveMaxTokens(body, config, outputTokenField);
  }

  const isStreaming = !!body.stream;

  return { body, isStreaming };
}
