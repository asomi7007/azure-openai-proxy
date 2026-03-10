import { log } from '../utils/logger.mjs';

/**
 * Anthropic Messages API 형식 → OpenAI Chat Completions 형식 변환
 *
 * 모델명 기반 라우팅: /v1/messages 로 들어온 요청이지만
 * 모델이 OpenAI 계열이면 이 변환기를 거쳐 Azure OpenAI로 전송
 */
export function convertAnthropicToOpenAI(body) {
  const messages = [];

  // system 필드 → OpenAI system 메시지
  if (body.system) {
    let text;
    if (typeof body.system === 'string') {
      text = body.system;
    } else if (Array.isArray(body.system)) {
      text = body.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    if (text) {
      messages.push({ role: 'system', content: text });
    }
  }

  // messages 변환
  for (const msg of body.messages || []) {
    let role = msg.role;
    let content;

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // tool_use 블록은 assistant 메시지의 tool_calls로
      const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
      const textBlocks = msg.content.filter(b => b.type === 'text');
      const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');

      if (toolResultBlocks.length > 0) {
        // tool_result → role: "tool" 메시지들로 분리
        for (const tr of toolResultBlocks) {
          messages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string'
              ? tr.content
              : (tr.content?.[0]?.text ?? ''),
          });
        }
        // 나머지 텍스트는 user 메시지로
        if (textBlocks.length > 0) {
          messages.push({ role: 'user', content: textBlocks.map(b => b.text).join('\n') });
        }
        continue;
      }

      if (toolUseBlocks.length > 0 && role === 'assistant') {
        // tool_use → tool_calls
        const oaiMsg = {
          role: 'assistant',
          content: textBlocks.map(b => b.text).join('\n') || null,
          tool_calls: toolUseBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input || {}),
            },
          })),
        };
        messages.push(oaiMsg);
        continue;
      }

      content = textBlocks.map(b => b.text).join('\n');
    } else {
      content = '';
    }

    messages.push({ role, content });
  }

  const result = {
    model: body.model,
    messages,
    stream: body.stream || false,
  };

  if (body.max_tokens != null) result.max_tokens = body.max_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stop != null) result.stop = body.stop;

  // tools 변환 (Anthropic tools → OpenAI functions)
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    }));
  }

  log('CONVERT', `Anthropic → OpenAI: ${body.messages?.length ?? 0} msgs, model=${body.model}`);
  return result;
}

/**
 * 이 모델이 OpenAI 라우팅 대상인지 확인
 * modelNameMap 적용 후의 모델명으로 비교
 */
export function isOpenAIModel(modelName, config) {
  if (!modelName) return false;
  const resolved = config.modelNameMap?.[modelName] ?? modelName;
  return config.openAIModels?.includes(resolved) || config.openAIModels?.includes(modelName);
}
