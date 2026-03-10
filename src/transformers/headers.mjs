import { log } from '../utils/logger.mjs';

/**
 * Transform request headers based on route type
 * @param {object} incomingHeaders - Original request headers
 * @param {boolean} isAnthropicRoute - Whether this is an Anthropic route
 * @param {object} config - Configuration object
 * @returns {object} Transformed headers
 */
export function transformHeaders(incomingHeaders, isAnthropicRoute, config) {
  // Clone headers (lowercase keys from Node.js http)
  const headers = { ...incomingHeaders };

  // Remove hop-by-hop headers
  delete headers['host'];
  delete headers['connection'];

  if (isAnthropicRoute) {
    // 항상 Azure API 키로 교체 (클라이언트가 보낸 인증 정보 무시)
    delete headers['x-api-key'];
    headers['authorization'] = `Bearer ${config.azure.apiKey}`;

    // Ensure anthropic-version is set
    if (!headers['anthropic-version']) {
      headers['anthropic-version'] = '2023-06-01';
    }
    log('PROXY', `Anthropic: Bearer auth, version=${headers['anthropic-version']}`);

    // Filter unsupported anthropic-beta values
    if (headers['anthropic-beta']) {
      const originalBeta = String(headers['anthropic-beta']);
      const betas = originalBeta.split(',').map(b => b.trim()).filter(Boolean);
      const unsupportedBetas = Array.isArray(config.unsupportedAnthropicBetas) ? config.unsupportedAnthropicBetas : [];
      const filtered = betas.filter(b => !unsupportedBetas.includes(b));

      if (filtered.length === 0) {
        delete headers['anthropic-beta'];
        log('PROXY', `beta: "${originalBeta}" → "(removed)"`);
      } else {
        headers['anthropic-beta'] = filtered.join(',');
        if (originalBeta !== headers['anthropic-beta']) {
          log('PROXY', `beta: "${originalBeta}" → "${headers['anthropic-beta']}"`);
        }
      }
    }
  } else {
    // Azure OpenAI route: api-key 헤더 사용 (openai.azure.com 형식)
    delete headers['authorization'];
    delete headers['x-api-key'];
    headers['api-key'] = config.azure.apiKey;
  }

  return headers;
}
