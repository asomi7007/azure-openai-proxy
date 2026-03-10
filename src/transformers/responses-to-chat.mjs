import { log } from '../utils/logger.mjs';

/**
 * OpenAI Responses API ↔ Chat Completions API 변환
 * Azure OpenAI는 Responses API 미지원이므로 chat/completions로 변환
 */

/**
 * Responses API 요청 body → Chat Completions 요청 body 변환
 */
export function convertRequestResponsesToChat(body) {
  const result = {};

  if (body.model) result.model = body.model;
  if (body.stream != null) result.stream = body.stream;

  // messages 구성
  const messages = [];

  // instructions → system message
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // input → messages
  if (body.input) {
    if (typeof body.input === 'string') {
      messages.push({ role: 'user', content: body.input });
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        const role = item.role || 'user';
        let content = item.content;
        if (Array.isArray(content)) {
          // multi-part content: input_text, output_text 등 → 텍스트만 추출
          content = content
            .filter(c => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
            .map(c => c.text)
            .join('');
        }
        if (content != null) {
          messages.push({ role, content: String(content) });
        }
      }
    }
  }

  result.messages = messages;

  // max_output_tokens → max_completion_tokens (Responses API는 신규 모델 전용)
  if (body.max_output_tokens != null) result.max_completion_tokens = body.max_output_tokens;

  // 공통 파라미터
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stop != null) result.stop = body.stop;

  // reasoning.effort → reasoning_effort (o-series 모델용)
  if (body.reasoning?.effort) {
    result.reasoning_effort = body.reasoning.effort;
  }

  // tools 변환
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools
      .filter(t => t.type === 'function')
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || {},
        },
      }));
    if (result.tools.length === 0) delete result.tools;
  }
  if (body.tool_choice != null) result.tool_choice = body.tool_choice;

  log('CONVERT', `Responses→Chat: ${messages.length} msgs, model=${body.model}`);
  return result;
}

/**
 * Chat Completions 응답 → Responses API 응답 변환 (non-streaming)
 */
export function convertResponseChatToResponses(chatBody, originalModel) {
  const choice = chatBody.choices?.[0];
  const message = choice?.message;
  // /completions 엔드포인트는 choice.text, chat/completions는 choice.message.content
  const content = message?.content || choice?.text || '';
  const toolCalls = message?.tool_calls;

  const output = [];

  // tool_calls → function_call items
  if (toolCalls?.length > 0) {
    for (const tc of toolCalls) {
      output.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments || '{}',
        status: 'completed',
      });
    }
  }

  // text content
  if (content) {
    output.push({
      type: 'message',
      id: `msg_${chatBody.id || Date.now()}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
      status: 'completed',
    });
  }

  const resp = {
    id: `resp_${chatBody.id || Date.now()}`,
    object: 'response',
    created_at: chatBody.created || Math.floor(Date.now() / 1000),
    model: chatBody.model || originalModel,
    output,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    status: 'completed',
    error: null,
  };

  if (chatBody.usage) {
    resp.usage = {
      input_tokens: chatBody.usage.prompt_tokens || 0,
      output_tokens: chatBody.usage.completion_tokens || 0,
      total_tokens: chatBody.usage.total_tokens || 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: {
        reasoning_tokens: chatBody.usage.completion_tokens_details?.reasoning_tokens || 0,
      },
    };
  }

  log('CONVERT', `Chat→Responses (non-stream): ${output.length} output items`);
  return resp;
}

/**
 * Streaming: Chat Completions SSE 이벤트 → Responses API SSE 이벤트 변환
 * Node.js Transform stream 스타일로 동작
 */
export function createResponsesStreamTransformer(originalModel) {
  let responseId = null;
  let initialized = false;
  let accumulatedContent = '';
  let sseBuffer = '';

  // 텍스트 메시지용
  let textItemId = null;
  let textItemAdded = false;

  // tool call 추적: index → { callId, name, accArgs, itemId, outputIndex }
  const toolCalls = {};
  let nextOutputIndex = 0;

  function getOrInitToolCall(tc) {
    const idx = tc.index;
    if (!toolCalls[idx]) {
      toolCalls[idx] = {
        callId: tc.id || `call_${Date.now()}_${idx}`,
        name: tc.function?.name || '',
        accArgs: '',
        itemId: `fc_${Date.now()}_${idx}`,
        outputIndex: nextOutputIndex++,
      };
    }
    return toolCalls[idx];
  }

  function processLine(line) {
    if (!line.startsWith('data: ')) return [];
    const data = line.slice(6).trim();
    const events = [];

    if (data === '[DONE]') {
      const outputItems = [];

      // tool call 완료 이벤트
      for (const tc of Object.values(toolCalls)) {
        events.push({ type: 'response.function_call_arguments.done', item_id: tc.itemId, output_index: tc.outputIndex, call_id: tc.callId, arguments: tc.accArgs });
        const doneItem = { type: 'function_call', id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: tc.accArgs, status: 'completed' };
        events.push({ type: 'response.output_item.done', output_index: tc.outputIndex, item: doneItem });
        outputItems.push(doneItem);
      }

      // 텍스트 완료 이벤트
      if (textItemAdded) {
        events.push({ type: 'response.output_text.done', item_id: textItemId, output_index: nextOutputIndex - 1, content_index: 0, text: accumulatedContent });
        const doneItem = { type: 'message', id: textItemId, role: 'assistant', content: [{ type: 'output_text', text: accumulatedContent, annotations: [] }], status: 'completed' };
        events.push({ type: 'response.output_item.done', output_index: nextOutputIndex - 1, item: doneItem });
        outputItems.push(doneItem);
      }

      events.push({
        type: 'response.completed',
        response: { id: responseId, object: 'response', model: originalModel, status: 'completed', output: outputItems },
      });
      events.push('__DONE__');
      return events;
    }

    let parsed;
    try { parsed = JSON.parse(data); } catch { return []; }

    // choices[]가 비어있는 첫 번째 필터 결과 청크는 건너뜀
    if (!parsed.choices?.length) {
      if (!initialized) {
        initialized = true;
        responseId = parsed.id ? `resp_${parsed.id}` : `resp_${Date.now()}`;
        events.push({ type: 'response.created', response: { id: responseId, object: 'response', model: parsed.model || originalModel, status: 'in_progress', output: [] } });
      }
      return events;
    }

    if (!initialized) {
      initialized = true;
      responseId = parsed.id ? `resp_${parsed.id}` : `resp_${Date.now()}`;
      events.push({ type: 'response.created', response: { id: responseId, object: 'response', model: parsed.model || originalModel, status: 'in_progress', output: [] } });
    }

    const choice = parsed.choices[0];
    const delta = choice?.delta;
    // completions 엔드포인트는 delta 없이 choice.text로 바로 옴
    if (!delta && !choice?.text) return events;

    // tool_calls 처리
    if (delta?.tool_calls?.length) {
      for (const tc of delta.tool_calls) {
        const entry = getOrInitToolCall(tc);

        // 처음 등장: function_call 아이템 추가
        if (tc.function?.name && tc.function.name !== '') {
          entry.name = tc.function.name;
          events.push({
            type: 'response.output_item.added',
            output_index: entry.outputIndex,
            item: { type: 'function_call', id: entry.itemId, call_id: entry.callId, name: entry.name, arguments: '', status: 'in_progress' },
          });
        }

        // arguments delta
        if (tc.function?.arguments) {
          entry.accArgs += tc.function.arguments;
          events.push({ type: 'response.function_call_arguments.delta', item_id: entry.itemId, output_index: entry.outputIndex, call_id: entry.callId, delta: tc.function.arguments });
        }
      }
    }

    // 텍스트 delta 처리 (chat/completions: delta.content, completions: choice.text)
    const textDelta = delta?.content ?? choice?.text;
    if (textDelta) {
      if (!textItemAdded) {
        textItemAdded = true;
        textItemId = `msg_${parsed.id || Date.now()}`;
        const outputIndex = nextOutputIndex++;
        events.push({ type: 'response.output_item.added', output_index: outputIndex, item: { type: 'message', id: textItemId, role: 'assistant', content: [], status: 'in_progress' } });
        events.push({ type: 'response.content_part.added', item_id: textItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      accumulatedContent += textDelta;
      events.push({ type: 'response.output_text.delta', item_id: textItemId, output_index: nextOutputIndex - 1, content_index: 0, delta: textDelta });
    }

    return events;
  }

  return {
    // Buffer에서 SSE 줄 파싱 후 변환된 SSE 문자열 반환
    transform(chunk) {
      sseBuffer += chunk.toString('utf-8');
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // 마지막 불완전 줄 보관

      let output = '';
      for (const line of lines) {
        const events = processLine(line.trim());
        for (const event of events) {
          if (event === '__DONE__') {
            output += 'data: [DONE]\n\n';
          } else {
            output += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          }
        }
      }
      return output;
    },
    flush() {
      // 남은 버퍼 처리
      if (sseBuffer.trim()) {
        const events = processLine(sseBuffer.trim());
        let output = '';
        for (const event of events) {
          if (event === '__DONE__') output += 'data: [DONE]\n\n';
          else output += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        }
        return output;
      }
      return '';
    },
  };
}
