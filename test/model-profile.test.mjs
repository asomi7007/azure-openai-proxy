import test from 'node:test';
import assert from 'node:assert/strict';

import { isOpenAIModel } from '../src/transformers/anthropic-to-openai.mjs';
import { transformBody } from '../src/transformers/body.mjs';
import { resolveResponsesApiModel } from '../src/server.mjs';

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
  assert.ok(config.nativeResponsesModels.includes('gpt-5.4-pro'));
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

test('claude-to-gpt profile keeps OpenAI-family model ids routable to Azure OpenAI', async () => {
  const config = await loadConfigWithProfile('claude-to-gpt');
  const openAIModels = ['gpt-5.2-chat', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-pro'];

  for (const model of openAIModels) {
    const anthropicMapped = transformBody(
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
      },
      true,
      config,
    ).body;

    const openAIMapped = transformBody(
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
      },
      false,
      config,
    ).body;

    assert.equal(anthropicMapped.model, model);
    assert.equal(openAIMapped.model, model);
    assert.equal(isOpenAIModel(model, config), true);
  }
});

test('OpenAI native codex alias resolves to the Azure codex deployment', async () => {
  const config = await loadConfigWithProfile('default');
  const mapped = transformBody(
    {
      model: 'gpt-5.1-codex-max',
      messages: [{ role: 'user', content: 'hi' }],
    },
    false,
    config,
  ).body;

  assert.equal(mapped.model, 'gpt-5.3-codex');
  assert.equal(isOpenAIModel('gpt-5.1-codex-max', config), true);
});

test('model-router profile maps Claude requests to model-router deployment', async () => {
  const config = await loadConfigWithProfile('model-router');
  const mapped = transformBody(
    {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'plan this project' }],
    },
    true,
    config,
  ).body;

  assert.equal(mapped.model, 'model-router');
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

test('Native Responses route converts max_tokens to max_output_tokens', async () => {
  const config = await loadConfigWithProfile('default');
  const mapped = transformBody(
    {
      model: 'gpt-5.3-codex',
      input: 'hi',
      max_tokens: 512,
    },
    false,
    config,
    { outputTokenField: 'max_output_tokens' },
  ).body;

  assert.equal(mapped.max_output_tokens, 512);
  assert.equal(mapped.max_completion_tokens, undefined);
  assert.equal(mapped.max_tokens, undefined);
});

test('OpenAI route adaptively clamps oversized max_completion_tokens', async () => {
  const config = await loadConfigWithProfile('default');
  config.dynamicMaxCompletionTokens = {
    enabled: true,
    defaultContextWindow: 1000000,
    modelContextWindows: { 'gpt-5.4': 1000000 },
    minOutputTokens: 1024,
    maxOutputTokens: 32000,
    outputToInputRatio: 1.2,
    maxOutputShareOfContext: 0.12,
    safetyBufferTokens: 4096,
    charPerToken: 4,
    applyWhenMissing: true,
  };

  const mapped = transformBody(
    {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: '짧은 질문' }],
      max_tokens: 32000,
    },
    false,
    config,
  ).body;

  assert.ok(mapped.max_completion_tokens < 32000);
  assert.ok(mapped.max_completion_tokens >= 1024);
});

test('OpenAI route sets adaptive max_completion_tokens when client omitted it', async () => {
  const config = await loadConfigWithProfile('default');
  config.dynamicMaxCompletionTokens = {
    enabled: true,
    defaultContextWindow: 1000000,
    modelContextWindows: { 'gpt-5.4': 1000000 },
    minOutputTokens: 1024,
    maxOutputTokens: 32000,
    outputToInputRatio: 1.2,
    maxOutputShareOfContext: 0.12,
    safetyBufferTokens: 4096,
    charPerToken: 4,
    applyWhenMissing: true,
  };

  const mapped = transformBody(
    {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: '요약해줘' }],
    },
    false,
    config,
  ).body;

  assert.ok(mapped.max_completion_tokens >= 1);
});

test('Native Responses route sets adaptive max_output_tokens when client omitted it', async () => {
  const config = await loadConfigWithProfile('default');
  config.dynamicMaxCompletionTokens = {
    enabled: true,
    defaultContextWindow: 1000000,
    modelContextWindows: { 'gpt-5.3-codex': 1000000 },
    minOutputTokens: 1024,
    maxOutputTokens: 32000,
    outputToInputRatio: 1.2,
    maxOutputShareOfContext: 0.12,
    safetyBufferTokens: 4096,
    charPerToken: 4,
    applyWhenMissing: true,
  };

  const mapped = transformBody(
    {
      model: 'gpt-5.3-codex',
      input: '요약해줘',
    },
    false,
    config,
    { outputTokenField: 'max_output_tokens' },
  ).body;

  assert.ok(mapped.max_output_tokens >= 1);
  assert.equal(mapped.max_completion_tokens, undefined);
});

test('Request-type profile can raise output budget for code-heavy prompts', async () => {
  const config = await loadConfigWithProfile('default');
  config.dynamicMaxCompletionTokens = {
    enabled: true,
    defaultContextWindow: 1000000,
    modelContextWindows: { 'gpt-5.4': 1000000 },
    minOutputTokens: 1024,
    maxOutputTokens: 32000,
    outputToInputRatio: 1.2,
    maxOutputShareOfContext: 0.12,
    safetyBufferTokens: 4096,
    charPerToken: 4,
    applyWhenMissing: true,
    requestTypeProfiles: [
      {
        name: 'code-heavy',
        keywords: ['code', 'implement', 'fix'],
        outputToInputRatio: 2.5,
        minOutputTokens: 4096,
        maxOutputTokens: 64000,
        maxOutputShareOfContext: 0.25,
      },
    ],
  };

  const mapped = transformBody(
    {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Please implement code for parser.' }],
    },
    false,
    config,
  ).body;

  assert.ok(mapped.max_completion_tokens >= 4096);
});

test('claude-to-gpt profile resolves claude-opus-4-6 to a native responses deployment', async () => {
  const config = await loadConfigWithProfile('claude-to-gpt');
  const resolved = resolveResponsesApiModel('claude-opus-4-6', config);

  assert.equal(resolved.requestedModel, 'claude-opus-4-6');
  assert.equal(resolved.resolvedModel, 'gpt-5.4-pro');
  assert.equal(resolved.isNative, true);
});
