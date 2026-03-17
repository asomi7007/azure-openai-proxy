import { log } from '../utils/logger.mjs';

function generateMessageId() {
  return 'msg_' + Math.random().toString(36).substr(2, 24);
}

function safeParseJson(value) {
  if (typeof value !== 'string' || value === '') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function extractTextBlocks(messageItem) {
  const blocks = [];

  for (const part of messageItem?.content || []) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'output_text' || part.type === 'text') && part.text != null && part.text !== '') {
      blocks.push({ type: 'text', text: String(part.text) });
    }
  }

  return blocks;
}

function mapResponsesStopReason(responseBody, sawToolUse = false) {
  if (sawToolUse) return 'tool_use';

  const reason = responseBody?.incomplete_details?.reason || responseBody?.status_details?.reason || '';
  if (/max_(output_)?tokens/i.test(String(reason))) {
    return 'max_tokens';
  }

  return 'end_turn';
}

/**
 * Convert a Responses API response body into an Anthropic message response.
 * Responses API 응답 본문을 Anthropic 메시지 응답으로 변환합니다.
 */
export function convertResponsesToAnthropic(responseBody) {
  const contentBlocks = [];
  let sawToolUse = false;
  let toolCount = 0;
  let textChars = 0;

  for (const item of responseBody?.output || []) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      const textBlocks = extractTextBlocks(item);
      for (const block of textBlocks) {
        textChars += block.text.length;
        contentBlocks.push(block);
      }
      continue;
    }

    if (item.type === 'function_call') {
      sawToolUse = true;
      toolCount += 1;
      contentBlocks.push({
        type: 'tool_use',
        id: item.call_id || item.id || `call_${toolCount}`,
        name: item.name || '',
        input: safeParseJson(item.arguments),
      });
    }
  }

  const stopReason = mapResponsesStopReason(responseBody, sawToolUse);
  log('CONVERT', `Responses → Anthropic: text=${textChars} chars, tools=${toolCount}, stop_reason=${stopReason}`);

  return {
    id: responseBody?.id || generateMessageId(),
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: responseBody?.model || 'gpt-4',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: responseBody?.usage?.input_tokens || 0,
      output_tokens: responseBody?.usage?.output_tokens || 0,
    },
  };
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let eventType = '';
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6));
    }
  }

  return {
    eventType,
    data: dataLines.join('\n').trim(),
  };
}

function createMessageStartPayload(messageId, model, inputTokens) {
  return {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
      },
    },
  };
}

function serializeAnthropicEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Transform Responses API SSE events into Anthropic-compatible SSE events.
 * Responses API SSE를 Anthropic 호환 SSE로 변환합니다.
 */
export class ResponsesToAnthropicStreamTransformer {
  constructor(modelHint = '') {
    this.buffer = '';
    this.messageStartSent = false;
    this.messageStopped = false;
    this.messageId = generateMessageId();
    this.model = modelHint || '';
    this.nextBlockIndex = 0;
    this.textBlocks = new Map();
    this.toolBlocks = new Map();
    this.sawToolUse = false;
  }

  ensureMessageStart(response = {}) {
    if (this.messageStartSent) return '';

    this.messageStartSent = true;
    this.messageId = response.id || this.messageId;
    this.model = response.model || this.model || 'gpt-4';
    return serializeAnthropicEvent(
      'message_start',
      createMessageStartPayload(this.messageId, this.model, response.usage?.input_tokens),
    );
  }

  ensureTextBlock(itemId, contentIndex = 0) {
    const key = `${itemId}:${contentIndex}`;
    const existing = this.textBlocks.get(key);
    if (existing) return { block: existing, event: '' };

    const block = {
      key,
      itemId,
      contentIndex,
      index: this.nextBlockIndex++,
      closed: false,
      hasDelta: false,
    };
    this.textBlocks.set(key, block);

    return {
      block,
      event: serializeAnthropicEvent('content_block_start', {
        type: 'content_block_start',
        index: block.index,
        content_block: { type: 'text', text: '' },
      }),
    };
  }

  ensureToolBlock(item = {}) {
    const key = item.id || item.item_id || item.call_id || `tool_${this.nextBlockIndex}`;
    const existing = this.toolBlocks.get(key);
    if (existing) {
      if (!existing.name && item.name) existing.name = item.name;
      if (!existing.callId && item.call_id) existing.callId = item.call_id;
      return { block: existing, event: '' };
    }

    const block = {
      key,
      index: this.nextBlockIndex++,
      closed: false,
      hasDelta: false,
      name: item.name || '',
      callId: item.call_id || item.id || key,
    };
    this.toolBlocks.set(key, block);

    return {
      block,
      event: serializeAnthropicEvent('content_block_start', {
        type: 'content_block_start',
        index: block.index,
        content_block: {
          type: 'tool_use',
          id: block.callId,
          name: block.name,
          input: {},
        },
      }),
    };
  }

  closeBlock(block) {
    if (!block || block.closed) return '';
    block.closed = true;
    return serializeAnthropicEvent('content_block_stop', {
      type: 'content_block_stop',
      index: block.index,
    });
  }

  emitMessageStop(response = {}) {
    if (this.messageStopped) return '';
    this.messageStopped = true;

    const stopReason = mapResponsesStopReason(response, this.sawToolUse);
    const usage = response.usage?.output_tokens || 0;

    return [
      serializeAnthropicEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage },
      }),
      serializeAnthropicEvent('message_stop', { type: 'message_stop' }),
    ].join('');
  }

  processParsedEvent(eventType, payload) {
    let output = '';

    if (eventType === 'response.created') {
      output += this.ensureMessageStart(payload.response || {});
      return output;
    }

    if (eventType === 'response.output_item.added') {
      output += this.ensureMessageStart();
      if (payload.item?.type === 'function_call') {
        this.sawToolUse = true;
        output += this.ensureToolBlock(payload.item).event;
      }
      return output;
    }

    if (eventType === 'response.content_part.added' && payload.part?.type === 'output_text') {
      output += this.ensureMessageStart();
      output += this.ensureTextBlock(payload.item_id || this.messageId, payload.content_index || 0).event;
      return output;
    }

    if (eventType === 'response.output_text.delta') {
      output += this.ensureMessageStart();
      const { block, event } = this.ensureTextBlock(payload.item_id || this.messageId, payload.content_index || 0);
      output += event;
      block.hasDelta = true;
      output += serializeAnthropicEvent('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'text_delta', text: payload.delta || '' },
      });
      return output;
    }

    if (eventType === 'response.function_call_arguments.delta') {
      output += this.ensureMessageStart();
      this.sawToolUse = true;
      const { block, event } = this.ensureToolBlock({
        id: payload.item_id,
        call_id: payload.call_id,
      });
      output += event;
      block.hasDelta = true;
      output += serializeAnthropicEvent('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'input_json_delta', partial_json: payload.delta || '' },
      });
      return output;
    }

    if (eventType === 'response.output_item.done') {
      output += this.ensureMessageStart();
      const item = payload.item || {};

      if (item.type === 'message') {
        const textParts = Array.isArray(item.content) ? item.content : [];
        for (let i = 0; i < textParts.length; i += 1) {
          const part = textParts[i];
          if (part?.type !== 'output_text') continue;

          const { block, event } = this.ensureTextBlock(item.id || this.messageId, i);
          output += event;
          if (!block.hasDelta && part.text) {
            output += serializeAnthropicEvent('content_block_delta', {
              type: 'content_block_delta',
              index: block.index,
              delta: { type: 'text_delta', text: part.text },
            });
          }
          output += this.closeBlock(block);
        }
      }

      if (item.type === 'function_call') {
        this.sawToolUse = true;
        const { block, event } = this.ensureToolBlock(item);
        output += event;
        if (!block.hasDelta && item.arguments) {
          output += serializeAnthropicEvent('content_block_delta', {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: item.arguments },
          });
        }
        output += this.closeBlock(block);
      }
      return output;
    }

    if (eventType === 'response.completed') {
      if (payload.response?.model) this.model = payload.response.model;
      output += this.ensureMessageStart(payload.response || {});
      output += this.emitMessageStop(payload.response || {});
      return output;
    }

    return output;
  }

  processEvent(rawEvent) {
    const { eventType, data } = parseSseEvent(rawEvent);
    if (!data) return '';

    if (data === '[DONE]') {
      return this.emitMessageStop();
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return '';
    }

    const type = eventType || payload.type;
    return this.processParsedEvent(type, payload);
  }

  transform(chunk) {
    this.buffer += chunk.toString('utf-8');
    const events = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = events.pop() || '';

    return events
      .map(event => this.processEvent(event.trim()))
      .filter(Boolean)
      .join('');
  }

  flush() {
    if (!this.buffer.trim()) return '';
    const output = this.processEvent(this.buffer.trim());
    this.buffer = '';
    return output;
  }
}
