import test from 'node:test';
import assert from 'node:assert/strict';

import { convertAnthropicToOpenAI } from '../src/transformers/anthropic-to-openai.mjs';
import { convertRequestChatToResponses } from '../src/transformers/responses-to-chat.mjs';

test('Anthropic stop_sequences, tool_choice any, metadata.user_id, thinking, and top_k are normalized for OpenAI', () => {
  const converted = convertAnthropicToOpenAI({
    model: 'claude-sonnet-4-6',
    system: [
      { type: 'text', text: 'Follow the policy.' },
      { type: 'thinking', thinking: 'internal' },
    ],
    thinking: { type: 'enabled', budget_tokens: 2048 },
    top_k: 40,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Summarize this.' }],
      },
    ],
    stop_sequences: ['END', 'STOP'],
    tools: [
      {
        name: 'lookup',
        description: 'Find data',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'any' },
    metadata: { user_id: 'user-123', trace_id: 'trace-456' },
  });

  assert.equal(converted.messages[0].role, 'system');
  assert.equal(converted.messages[0].content, 'Follow the policy.');
  assert.deepEqual(converted.stop, ['END', 'STOP']);
  assert.equal(converted.tool_choice, 'required');
  assert.equal(converted.user, 'user-123');
  assert.equal('thinking' in converted, false);
  assert.equal('metadata' in converted, false);
  assert.equal('top_k' in converted, false);
});

test('Anthropic specific tool_choice maps to OpenAI function selection', () => {
  const converted = convertAnthropicToOpenAI({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Use the calculator.' }],
    tools: [
      {
        name: 'calculator',
        input_schema: { type: 'object', properties: { expression: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'tool', name: 'calculator' },
  });

  assert.deepEqual(converted.tool_choice, {
    type: 'function',
    function: { name: 'calculator' },
  });
});

test('Anthropic user image blocks map to OpenAI image_url content parts', () => {
  const converted = convertAnthropicToOpenAI({
    model: 'claude-sonnet-4-6',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'ZmFrZS1pbWFnZS1ieXRlcw==',
            },
          },
        ],
      },
    ],
  });

  assert.equal(converted.messages.length, 1);
  assert.equal(converted.messages[0].role, 'user');
  assert.ok(Array.isArray(converted.messages[0].content));
  assert.deepEqual(converted.messages[0].content[0], {
    type: 'text',
    text: 'What is in this image?',
  });
  assert.deepEqual(converted.messages[0].content[1], {
    type: 'image_url',
    image_url: {
      url: 'data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==',
    },
  });
});

test('Anthropic tool_result content arrays collapse into OpenAI tool messages safely', () => {
  const converted = convertAnthropicToOpenAI({
    model: 'claude-sonnet-4-6',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'done' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' },
              },
            ],
          },
          { type: 'text', text: 'Continue.' },
        ],
      },
    ],
  });

  assert.equal(converted.messages.length, 2);
  assert.deepEqual(converted.messages[0], {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'done\n[Unsupported tool_result block types omitted: image]',
  });
  assert.deepEqual(converted.messages[1], {
    role: 'user',
    content: 'Continue.',
  });
});

test('Chat request converts to Responses format for native responses models', () => {
  const converted = convertRequestChatToResponses({
    model: 'gpt-5.4-pro',
    stream: true,
    messages: [
      { role: 'system', content: 'Follow the coding guidelines.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this screenshot.' },
          { type: 'image_url', image_url: { url: 'https://example.com/shot.png' } },
        ],
      },
      {
        role: 'assistant',
        content: 'Calling a tool now.',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"src/index.mjs"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_123', content: 'file contents' },
    ],
    max_completion_tokens: 2048,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ],
    tool_choice: 'required',
  });

  assert.equal(converted.instructions, 'Follow the coding guidelines.');
  assert.equal(converted.stream, true);
  assert.equal(converted.max_output_tokens, 2048);
  assert.equal(converted.input[0].type, 'message');
  assert.equal(converted.input[0].role, 'user');
  assert.deepEqual(converted.input[0].content[0], {
    type: 'input_text',
    text: 'Inspect this screenshot.',
  });
  assert.deepEqual(converted.input[0].content[1], {
    type: 'input_image',
    image_url: 'https://example.com/shot.png',
  });
  assert.deepEqual(converted.input[1], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Calling a tool now.' }],
  });
  assert.deepEqual(converted.input[2], {
    type: 'function_call',
    call_id: 'call_123',
    name: 'read_file',
    arguments: '{"path":"src/index.mjs"}',
  });
  assert.deepEqual(converted.input[3], {
    type: 'function_call_output',
    call_id: 'call_123',
    output: 'file contents',
  });
});

test('Responses conversion drops overlong user values', () => {
  const converted = convertRequestChatToResponses({
    model: 'gpt-5.4-pro',
    user: 'u'.repeat(65),
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(converted.user, undefined);
});
