import test from 'node:test';
import assert from 'node:assert/strict';
import { convertOpenAIToAnthropic } from '../src/transformers/openai-to-anthropic.mjs';

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
  assert.equal(anthropicResp.stop_reason, 'length');
});
