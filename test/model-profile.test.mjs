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
  assert.equal(config.modelNameMap['claude-opus-4-6'], 'gpt-3.5-pro');
  assert.equal(config.modelNameMap['claude-sonnet-4-6'], 'gpt-3.5');
  assert.ok(config.openAIModels.includes('gpt-3.5-pro'));
  assert.ok(config.openAIModels.includes('gpt-3.5'));
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

  assert.equal(mapped.model, 'gpt-3.5-pro');
  assert.equal(isOpenAIModel('claude-opus-4-6', config), true);
});
