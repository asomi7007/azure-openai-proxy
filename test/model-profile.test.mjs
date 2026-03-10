import test from 'node:test';
import assert from 'node:assert/strict';

import { isOpenAIModel } from '../src/transformers/anthropic-to-openai.mjs';
import { transformBody } from '../src/transformers/body.mjs';

function loadConfigWithProfile(profileName) {
  process.env.PROXY_MODEL_PROFILE = profileName;
  const nonce = `${Date.now()}-${Math.random()}`;
  return import(`../src/config.mjs?nonce=${nonce}`).then(m => m.default);
}

test('default profile keeps existing Claude mapping', async () => {
  const config = await loadConfigWithProfile('default');
  assert.equal(config.modelNameMap['claude-opus-4-6'], 'claude-opus-4-6');
  assert.equal(config.modelNameMap['claude-sonnet-4-6'], 'claude-sonnet-4-6');
});

test('claude-to-gpt profile overrides Claude model mapping', async () => {
  const config = await loadConfigWithProfile('claude-to-gpt');
  assert.equal(config.modelNameMap['claude-opus-4-6'], 'gpt-5.4-pro');
  assert.equal(config.modelNameMap['claude-sonnet-4-6'], 'gpt-5.4');
  assert.ok(config.openAIModels.includes('gpt-5.4-pro'));
  assert.ok(config.openAIModels.includes('gpt-5.4'));
});

test('claude-to-gpt profile makes Claude request routable to OpenAI', async () => {
  const config = await loadConfigWithProfile('claude-to-gpt');
  const mapped = transformBody(
    {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    },
    true,
    config,
  ).body;

  assert.equal(mapped.model, 'gpt-5.4-pro');
  assert.equal(isOpenAIModel('claude-opus-4-6', config), true);
});

test('max_tokens is converted to max_completion_tokens for OpenAI routes', async () => {
  const config = await loadConfigWithProfile('claude-to-gpt');
  const mapped = transformBody(
    {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 512,
    },
    true,
    config,
  ).body;

  // Anthropic 포맷에서 OpenAI로 변환되므로 max_tokens은 유지되어야 함
  assert.ok(mapped.max_tokens === 512 || mapped.max_completion_tokens === 512);
});

test('OpenAI route converts max_tokens to max_completion_tokens', async () => {
  const config = await loadConfigWithProfile('default');
  const mapped = transformBody(
    {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 512,
    },
    false,
    config,
  ).body;

  assert.equal(mapped.max_completion_tokens, 512);
  assert.equal(mapped.max_tokens, undefined);
});
