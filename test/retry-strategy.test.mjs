import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNoCapacityError,
  computeRetryDelaySeconds,
  downscaleMaxCompletionTokens,
} from '../src/proxy.mjs';

test('isNoCapacityError detects NoCapacity payloads', () => {
  const body = JSON.stringify({
    error: {
      code: 'NoCapacity',
      message: 'The system is currently experiencing high demand and cannot process your request.',
    },
  });
  assert.equal(isNoCapacityError(body), true);
});

test('isNoCapacityError ignores unrelated payloads', () => {
  const body = JSON.stringify({
    error: {
      code: 'rate_limit_exceeded',
      message: 'Please wait 52 seconds before retrying.',
    },
  });
  assert.equal(isNoCapacityError(body), false);
});

test('downscaleMaxCompletionTokens reduces max_completion_tokens', () => {
  const result = downscaleMaxCompletionTokens({ model: 'gpt-5.4', max_completion_tokens: 32000 }, {
    noCapacityDownscaleRatio: 0.7,
    noCapacityMinTokens: 512,
  });

  assert.equal(result.changed, true);
  assert.equal(result.from, 32000);
  assert.equal(result.to, 22400);
  assert.equal(result.body.max_completion_tokens, 22400);
});

test('downscaleMaxCompletionTokens respects minimum floor', () => {
  const result = downscaleMaxCompletionTokens({ model: 'gpt-5.4', max_completion_tokens: 600 }, {
    noCapacityDownscaleRatio: 0.5,
    noCapacityMinTokens: 512,
  });

  assert.equal(result.changed, true);
  assert.equal(result.to, 512);
});

test('computeRetryDelaySeconds increases with retries under same base', () => {
  const cfg = {
    fallbackBaseSeconds: 20,
    multiplier: 2,
    maxSeconds: 300,
    jitterRatio: 0,
  };

  const d0 = computeRetryDelaySeconds(20, 0, cfg);
  const d1 = computeRetryDelaySeconds(20, 1, cfg);
  const d2 = computeRetryDelaySeconds(20, 2, cfg);

  assert.equal(d0, 20);
  assert.equal(d1, 40);
  assert.equal(d2, 80);
});
