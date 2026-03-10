import { log } from '../utils/logger.mjs';

/**
 * 고유 메시지 ID 생성 (Anthropic 형식 따라 msg_xxx)
 */
function generateMessageId() {
  return 'msg_' + Math.random().toString(36).substr(2, 24);
}

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

  // finish_reason 매핑: stop → end_turn, length → max_tokens
  let stopReason = 'end_turn';
  if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'content_filter') stopReason = 'end_turn';

  const result = {
    id: openaiResponse.id || generateMessageId(),
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
    model: openaiResponse.model || 'gpt-4',
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
 * OpenAI 스트림 청크 (SSE data 한 줄) → Anthropic 스트림 이벤트 변환
 * @param {string} openaiJsonStr - JSON 문자열만 (data: 제거됨)
 * @param {object} state - 상태 객체 (messageId, model, contentStarted 등)
 * @returns {string|null} Anthropic SSE 이벤트들 (또는 null if 불필요)
 */
function convertOpenAIStreamChunkToAnthropic(openaiJsonStr, state) {
  // [DONE] 마커 처리
  if (openaiJsonStr.includes('[DONE]')) {
    // message_stop 이벤트 발생
    return 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  }

  let chunk;
  try {
    chunk = JSON.parse(openaiJsonStr);
  } catch (e) {
    log('CONVERT', `Failed to parse OpenAI chunk: ${e.message}`);
    return null;
  }

  const events = [];

  // 첫 번째 청크 (message_start 이벤트 생성)
  if (!state.messageStartSent && chunk.choices?.[0]?.delta?.role === 'assistant') {
    state.messageStartSent = true;
    state.messageId = chunk.id || generateMessageId();
    state.model = chunk.model || 'gpt-4';

    const msgStart = {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    };
    events.push(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);
  }

  // content_block_start (첫 텍스트 청크에서 한 번만)
  if (state.messageStartSent && !state.contentBlockStartSent && chunk.choices?.[0]?.delta?.content) {
    state.contentBlockStartSent = true;
    const contentStart = {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    };
    events.push(`event: content_block_start\ndata: ${JSON.stringify(contentStart)}\n\n`);
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
    events.push(`event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n\n`);
  }

  // finish_reason 처리 → content_block_stop + message_delta
  if (chunk.choices?.[0]?.finish_reason) {
    const finishReason = chunk.choices[0].finish_reason;

    // content_block_stop (content block 종료)
    if (state.contentBlockStartSent) {
      const contentStop = {
        type: 'content_block_stop',
        index: 0,
      };
      events.push(`event: content_block_stop\ndata: ${JSON.stringify(contentStop)}\n\n`);
    }

    // finish_reason 매핑
    let stopReason = 'end_turn';
    if (finishReason === 'length') stopReason = 'max_tokens';
    else if (finishReason === 'tool_calls') stopReason = 'tool_use';
    else if (finishReason === 'content_filter') stopReason = 'end_turn';

    // message_delta (stop_reason 포함)
    const messageDelta = {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
      },
      usage: {
        output_tokens: 0,
      },
    };
    events.push(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);
  }

  return events.length > 0 ? events.join('') : null;
}



/**
 * 스트림 변환을 위한 상태 유지 클래스
 * 각 요청마다 독립적인 인스턴스 생성 (전역 상태 공유 X)
 */
export class OpenAIToAnthropicStreamTransformer {
  constructor() {
    this.buffer = '';
    this.messageStartSent = false;
    this.contentBlockStartSent = false;
    this.messageId = null;
    this.model = null;
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
      if (!line || line.startsWith(':')) continue; // 빈 줄, 주석 무시

      // "data: " 접두어 제거
      let jsonStr = line;
      if (line.startsWith('data: ')) {
        jsonStr = line.substring(6);
      }

      const converted = convertOpenAIStreamChunkToAnthropic(jsonStr, {
        messageStartSent: this.messageStartSent,
        contentBlockStartSent: this.contentBlockStartSent,
        messageId: this.messageId,
        model: this.model,
      });

      if (converted) {
        // 상태 동기화 (변환 함수가 상태를 업데이트하지 않으므로 여기서 추적)
        if (converted.includes('message_start')) {
          this.messageStartSent = true;
        }
        if (converted.includes('content_block_start')) {
          this.contentBlockStartSent = true;
        }
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

    const line = this.buffer.trim();
    if (line.startsWith(':')) return null; // 주석 무시

    let jsonStr = line;
    if (line.startsWith('data: ')) {
      jsonStr = line.substring(6);
    }

    const converted = convertOpenAIStreamChunkToAnthropic(jsonStr, {
      messageStartSent: this.messageStartSent,
      contentBlockStartSent: this.contentBlockStartSent,
      messageId: this.messageId,
      model: this.model,
    });

    this.buffer = '';
    return converted;
  }
}
