import test from 'node:test';
import assert from 'node:assert/strict';
import { convertOpenAIToAnthropic, OpenAIToAnthropicStreamTransformer } from '../src/transformers/openai-to-anthropic.mjs';
import { convertResponsesToAnthropic, ResponsesToAnthropicStreamTransformer } from '../src/transformers/responses-to-anthropic.mjs';

function sseEvent(...lines) {
  return `${lines.join('\n')}\n\n`;
}

test('OpenAI response converts to Anthropic format', () => {
  const openaiResp = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-5.4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello from OpenAI',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 15,
      total_tokens: 25,
    },
  };

  const anthropicResp = convertOpenAIToAnthropic(openaiResp);

  assert.equal(anthropicResp.type, 'message');
  assert.equal(anthropicResp.role, 'assistant');
  assert.equal(anthropicResp.content[0].type, 'text');
  assert.equal(anthropicResp.content[0].text, 'Hello from OpenAI');
  assert.equal(anthropicResp.stop_reason, 'end_turn');
  assert.equal(anthropicResp.usage.input_tokens, 10);
  assert.equal(anthropicResp.usage.output_tokens, 15);
});

test('OpenAI finish_reason maps to Anthropic stop_reason', () => {
  const openaiResp = {
    choices: [
      {
        message: { role: 'assistant', content: 'test' },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };

  const anthropicResp = convertOpenAIToAnthropic(openaiResp);
  assert.equal(anthropicResp.stop_reason, 'max_tokens');
});

test('OpenAI tool_calls converts to Anthropic tool_use blocks (non-streaming)', () => {
  const openaiResp = {
    id: 'chatcmpl-abc',
    model: 'gpt-5.4',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_xyz',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/index.mjs"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 30 },
  };

  const anthropicResp = convertOpenAIToAnthropic(openaiResp);

  assert.equal(anthropicResp.stop_reason, 'tool_use');
  assert.equal(anthropicResp.content.length, 1);
  assert.equal(anthropicResp.content[0].type, 'tool_use');
  assert.equal(anthropicResp.content[0].id, 'call_xyz');
  assert.equal(anthropicResp.content[0].name, 'read_file');
  assert.deepEqual(anthropicResp.content[0].input, { path: 'src/index.mjs' });
});

test('Streaming transformer converts text chunks correctly', () => {
  const transformer = new OpenAIToAnthropicStreamTransformer();
  const chunks = [
    `data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
    `data: [DONE]\n\n`,
  ];

  const output = chunks.map(c => transformer.transform(Buffer.from(c))).filter(Boolean).join('');

  assert.ok(output.includes('message_start'), 'should have message_start');
  assert.ok(output.includes('content_block_start'), 'should have content_block_start');
  assert.ok(output.includes('text_delta'), 'should have text_delta');
  assert.ok(output.includes('"Hello"'), 'should have Hello text');
  assert.ok(output.includes('content_block_stop'), 'should have content_block_stop');
  assert.ok(output.includes('message_delta'), 'should have message_delta');
  assert.ok(output.includes('"end_turn"'), 'should have end_turn stop_reason');
  assert.ok(output.includes('message_stop'), 'should have message_stop');
});

test('Streaming transformer converts tool_calls correctly', () => {
  const transformer = new OpenAIToAnthropicStreamTransformer();
  const chunks = [
    `data: {"id":"chatcmpl-2","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-2","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-2","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
    `data: [DONE]\n\n`,
  ];

  const output = chunks.map(c => transformer.transform(Buffer.from(c))).filter(Boolean).join('');

  assert.ok(output.includes('message_start'), 'should have message_start');
  assert.ok(output.includes('tool_use'), 'should have tool_use block');
  assert.ok(output.includes('"bash"'), 'should have tool name');
  assert.ok(output.includes('input_json_delta'), 'should have input_json_delta');
  assert.ok(output.includes('content_block_stop'), 'should have content_block_stop');
  assert.ok(output.includes('"tool_use"'), 'should have tool_use stop_reason');
  assert.ok(output.includes('message_stop'), 'should have message_stop');
});

test('Responses response converts to Anthropic format', () => {
  const responsesBody = {
    id: 'resp_123',
    object: 'response',
    model: 'gpt-5.4-pro',
    output: [
      {
        type: 'message',
        id: 'msg_123',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello from Responses', annotations: [] }],
        status: 'completed',
      },
      {
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_xyz',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
        status: 'completed',
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 18,
    },
  };

  const anthropicResp = convertResponsesToAnthropic(responsesBody);

  assert.equal(anthropicResp.type, 'message');
  assert.equal(anthropicResp.content[0].type, 'text');
  assert.equal(anthropicResp.content[0].text, 'Hello from Responses');
  assert.equal(anthropicResp.content[1].type, 'tool_use');
  assert.equal(anthropicResp.content[1].id, 'call_xyz');
  assert.equal(anthropicResp.content[1].name, 'read_file');
  assert.deepEqual(anthropicResp.content[1].input, { path: 'README.md' });
  assert.equal(anthropicResp.stop_reason, 'tool_use');
  assert.equal(anthropicResp.usage.input_tokens, 12);
  assert.equal(anthropicResp.usage.output_tokens, 18);
});

test('Responses streaming transformer converts text chunks correctly', () => {
  const transformer = new ResponsesToAnthropicStreamTransformer();
  const chunks = [
    sseEvent(
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4-pro","status":"in_progress","output":[]}}',
    ),
    sseEvent(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[],"status":"in_progress"}}',
    ),
    sseEvent(
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}',
    ),
    sseEvent(
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello"}',
    ),
    sseEvent(
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":" world"}',
    ),
    sseEvent(
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[]}],"status":"completed"}}',
    ),
    sseEvent(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4-pro","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":15}}}',
    ),
  ];

  const output = chunks.map(c => transformer.transform(Buffer.from(c))).filter(Boolean).join('') + transformer.flush();

  assert.ok(output.includes('message_start'), 'should have message_start');
  assert.ok(output.includes('content_block_start'), 'should have content_block_start');
  assert.ok(output.includes('text_delta'), 'should have text_delta');
  assert.ok(output.includes('"Hello"'), 'should have Hello text');
  assert.ok(output.includes('content_block_stop'), 'should have content_block_stop');
  assert.ok(output.includes('message_delta'), 'should have message_delta');
  assert.ok(output.includes('"end_turn"'), 'should have end_turn stop_reason');
  assert.ok(output.includes('message_stop'), 'should have message_stop');
});

test('Responses streaming transformer converts function calls correctly', () => {
  const transformer = new ResponsesToAnthropicStreamTransformer();
  const chunks = [
    sseEvent(
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_2","model":"gpt-5.4-pro","status":"in_progress","output":[]}}',
    ),
    sseEvent(
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash","arguments":"","status":"in_progress"}}',
    ),
    sseEvent(
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"call_id":"call_1","delta":"{\\"cmd\\":"}',
    ),
    sseEvent(
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"call_id":"call_1","delta":"\\"ls\\"}"}',
    ),
    sseEvent(
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}","status":"completed"}}',
    ),
    sseEvent(
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.4-pro","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":6}}}',
    ),
  ];

  const output = chunks.map(c => transformer.transform(Buffer.from(c))).filter(Boolean).join('') + transformer.flush();

  assert.ok(output.includes('message_start'), 'should have message_start');
  assert.ok(output.includes('tool_use'), 'should have tool_use block');
  assert.ok(output.includes('"bash"'), 'should have tool name');
  assert.ok(output.includes('input_json_delta'), 'should have input_json_delta');
  assert.ok(output.includes('content_block_stop'), 'should have content_block_stop');
  assert.ok(output.includes('"tool_use"'), 'should have tool_use stop_reason');
  assert.ok(output.includes('message_stop'), 'should have message_stop');
});

