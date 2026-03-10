import { log } from '../utils/logger.mjs';

/**
 * OpenAI Chat Completions 응답 → Anthropic 응답 변환
 * @param {object} openaiResponse - OpenAI 응답
 * @returns {object} Anthropic 형식 응답
 */
export function convertOpenAIToAnthropic(openaiResponse) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    log('CONVERT', 'No choices in OpenAI response');
    return openaiResponse;
  }

  const content = choice.message?.content || '';
  const finishReason = choice.finish_reason || 'stop';

  // finish_reason 매핑: stop → end_turn
  const stopReason = finishReason === 'stop' ? 'end_turn' : finishReason;

  const result = {
    id: openaiResponse.id || 'msg_unknown',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
    model: openaiResponse.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };

  log('CONVERT', `OpenAI → Anthropic: ${content.length} chars, stop_reason=${stopReason}`);
  return result;
}

/**
 * OpenAI 스트리m 청크 (SSE data 한 줄) → Anthropic 스트림 이벤트 변환
 * @param {string} openaiSseDataLine - OpenAI SSE data line (e.g., "data: {...}")
 * @returns {string|null} Anthropic SSE 이벤트 (또는 null if 변환 불필요)
 */
export function convertOpenAIStreamChunkToAnthropic(openaiSseDataLine) {
  // "data: [DONE]" → Anthropic "message_stop" 이벤트
  if (openaiSseDataLine.includes('[DONE]')) {
    return 'event: message_stop\ndata: {"type":"message_stop"}\n';
  }

  // "data: {...}" 파싱
  const match = openaiSseDataLine.match(/^data:\s*(.+)$/);
  if (!match) return null;

  try {
    const chunk = JSON.parse(match[1]);

    // 첫 번째 청크: message_start 이벤트 생성
    if (chunk.choices?.[0]?.delta?.role === 'assistant') {
      const msgStart = {
        type: 'message_start',
        message: {
          id: chunk.id || 'msg_unknown',
          type: 'message',
          role: 'assistant',
          content: [],
          model: chunk.model || '',
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      };
      return `event: message_start\ndata: ${JSON.stringify(msgStart)}\n`;
    }

    // content_block_start (첫 텍스트 청크)
    if (chunk.choices?.[0]?.delta?.content && !globalThis.__openaiStreamContentStarted) {
      globalThis.__openaiStreamContentStarted = true;
      const contentStart = {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      };
      const events = [`event: content_block_start\ndata: ${JSON.stringify(contentStart)}\n`];

      // content_block_delta 함께 발송
      const contentDelta = {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: chunk.choices[0].delta.content,
        },
      };
      events.push(`event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n`);
      return events.join('');
    }

    // content_block_delta (텍스트 청크)
    if (chunk.choices?.[0]?.delta?.content) {
      const contentDelta = {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: chunk.choices[0].delta.content,
        },
      };
      return `event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n`;
    }

    // finish_reason 처리
    if (chunk.choices?.[0]?.finish_reason) {
      const stopReason = chunk.choices[0].finish_reason === 'stop' ? 'end_turn' : chunk.choices[0].finish_reason;
      const messageDelta = {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
        },
        usage: {
          output_tokens: 0,
        },
      };
      return `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n`;
    }
  } catch (e) {
    log('CONVERT', `Failed to parse OpenAI stream chunk: ${e.message}`);
    return null;
  }

  return null;
}

/**
 * 스트림 변환을 위한 상태 유지 클래스
 */
export class OpenAIToAnthropicStreamTransformer {
  constructor() {
    this.contentStarted = false;
    this.buffer = '';
  }

  /**
   * 청크 데이터 변환
   * @param {Buffer} chunk - 수신한 데이터 청크
   * @returns {string} 변환된 Anthropic SSE 이벤트들
   */
  transform(chunk) {
    this.buffer += chunk.toString('utf-8');
    const lines = this.buffer.split('\n');

    // 마지막 줄이 완전하지 않을 수 있으므로 buffer에 유지
    this.buffer = lines[lines.length - 1];

    const output = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const converted = convertOpenAIStreamChunkToAnthropic(`data: ${line}`);
      if (converted) {
        output.push(converted);
      }
    }

    return output.length > 0 ? output.join('') : null;
  }

  /**
   * 스트림 종료 시 버퍼 처리
   * @returns {string|null} 남은 데이터 처리
   */
  flush() {
    if (!this.buffer.trim()) return null;

    const converted = convertOpenAIStreamChunkToAnthropic(`data: ${this.buffer}`);
    this.buffer = '';
    return converted;
  }
}
