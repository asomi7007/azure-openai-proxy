import { log } from '../utils/logger.mjs';

/**
 * 고유 메시지 ID 생성 (Anthropic 형식 따라 msg_xxx)
 */
function generateMessageId() {
  return 'msg_' + Math.random().toString(36).substr(2, 24);
}

/**
 * finish_reason → Anthropic stop_reason 매핑
 */
function mapStopReason(finishReason) {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls') return 'tool_use';
  return 'end_turn'; // stop, content_filter, etc.
}

/**
 * OpenAI Chat Completions 응답 → Anthropic 응답 변환 (non-streaming)
 * tool_calls 포함 처리
 * @param {object} openaiResponse - OpenAI 응답
 * @returns {object} Anthropic 형식 응답
 */
export function convertOpenAIToAnthropic(openaiResponse) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    log('CONVERT', 'No choices in OpenAI response');
    return openaiResponse;
  }

  const finishReason = choice.finish_reason || 'stop';
  const stopReason = mapStopReason(finishReason);

  // content 블록 빌드 (text + tool_use 혼합 가능)
  const contentBlocks = [];

  const textContent = choice.message?.content;
  if (textContent) {
    contentBlocks.push({ type: 'text', text: textContent });
  }

  const toolCalls = choice.message?.tool_calls;
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = {};
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id || `call_${Math.random().toString(36).substr(2, 8)}`,
        name: tc.function?.name || '',
        input,
      });
    }
  }

  const result = {
    id: openaiResponse.id || generateMessageId(),
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: openaiResponse.model || 'gpt-4',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };

  const toolCount = toolCalls?.length || 0;
  log('CONVERT', `OpenAI → Anthropic: text=${textContent?.length || 0} chars, tools=${toolCount}, stop_reason=${stopReason}`);
  return result;
}

/**
 * 스트림 변환을 위한 상태 유지 클래스
 * 각 요청마다 독립적인 인스턴스 생성 (전역 상태 공유 X)
 * text + tool_calls 혼합 스트림 모두 처리
 */
export class OpenAIToAnthropicStreamTransformer {
  constructor() {
    this.buffer = '';
    this.messageStartSent = false;
    this.nextBlockIndex = 0; // 다음 content block 인덱스
    this.textBlockIndex = -1; // text block index (-1: 미시작)
    this.textBlockStarted = false;
    // Map<openaiToolCallIndex, {blockIndex, id, name}>
    this.toolCallBlocks = new Map();
    this.messageId = null;
    this.model = null;
  }

  /**
   * SSE 한 줄 처리 → Anthropic 이벤트 문자열 반환
   */
  _processLine(line) {
    // 빈 줄, SSE 주석, event: 줄 무시 (OpenAI는 event: 없이 data: 만 사용)
    if (!line || line.startsWith(':') || line.startsWith('event: ')) return null;

    let jsonStr = line;
    if (line.startsWith('data: ')) {
      jsonStr = line.substring(6);
    }

    // [DONE] 마커 → message_stop
    if (jsonStr.trim() === '[DONE]') {
      return 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    }

    let chunk;
    try {
      chunk = JSON.parse(jsonStr);
    } catch {
      return null;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return null;

    const delta = choice.delta || {};
    const events = [];

    // ── message_start (첫 번째 role=assistant 청크) ──────────────────────────
    if (!this.messageStartSent && delta.role === 'assistant') {
      this.messageStartSent = true;
      this.messageId = chunk.id || generateMessageId();
      this.model = chunk.model || 'gpt-4';

      events.push(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: chunk.usage?.prompt_tokens || 0, output_tokens: 0 },
        },
      })}\n\n`);
    }

    // ── 텍스트 콘텐츠 ────────────────────────────────────────────────────────
    if (delta.content) {
      // 첫 텍스트: content_block_start
      if (!this.textBlockStarted) {
        this.textBlockStarted = true;
        this.textBlockIndex = this.nextBlockIndex++;
        events.push(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: this.textBlockIndex,
          content_block: { type: 'text', text: '' },
        })}\n\n`);
      }

      events.push(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: this.textBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      })}\n\n`);
    }

    // ── tool_calls 콘텐츠 ────────────────────────────────────────────────────
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = typeof tc.index === 'number' ? tc.index : 0;

        if (!this.toolCallBlocks.has(tcIndex)) {
          // 새 tool call 시작: content_block_start (tool_use)
          const blockIndex = this.nextBlockIndex++;
          this.toolCallBlocks.set(tcIndex, {
            blockIndex,
            id: tc.id || `call_${tcIndex}`,
            name: tc.function?.name || '',
          });

          events.push(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.id || `call_${tcIndex}`,
              name: tc.function?.name || '',
              input: {},
            },
          })}\n\n`);
        }

        // 인자(arguments) 스트리밍 → input_json_delta
        const args = tc.function?.arguments;
        if (args) {
          const block = this.toolCallBlocks.get(tcIndex);
          events.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: block.blockIndex,
            delta: { type: 'input_json_delta', partial_json: args },
          })}\n\n`);
        }
      }
    }

    // ── finish_reason → 블록 종료 + message_delta ────────────────────────────
    if (choice.finish_reason) {
      // text 블록 닫기
      if (this.textBlockStarted) {
        events.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: this.textBlockIndex,
        })}\n\n`);
      }

      // tool call 블록 닫기 (인덱스 순서대로)
      const sortedBlocks = [...this.toolCallBlocks.values()].sort((a, b) => a.blockIndex - b.blockIndex);
      for (const block of sortedBlocks) {
        events.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: block.blockIndex,
        })}\n\n`);
      }

      const stopReason = mapStopReason(choice.finish_reason);
      events.push(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: chunk.usage?.completion_tokens || 0 },
      })}\n\n`);
    }

    return events.length > 0 ? events.join('') : null;
  }

  /**
   * 청크 데이터 변환
   * @param {Buffer} chunk - 수신한 데이터 청크
   * @returns {string|null} 변환된 Anthropic SSE 이벤트들
   */
  transform(chunk) {
    this.buffer += chunk.toString('utf-8');
    const lines = this.buffer.split('\n');

    // 마지막 줄이 완전하지 않을 수 있으므로 buffer에 유지
    this.buffer = lines[lines.length - 1];

    const output = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const converted = this._processLine(lines[i].trim());
      if (converted) output.push(converted);
    }

    return output.length > 0 ? output.join('') : null;
  }

  /**
   * 스트림 종료 시 버퍼 처리
   * @returns {string|null} 남은 데이터 처리
   */
  flush() {
    if (!this.buffer.trim()) return null;
    const converted = this._processLine(this.buffer.trim());
    this.buffer = '';
    return converted;
  }
}
