import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

/**
 * Parse .env file and merge into process.env
 * @param {string} envPath - Path to .env file
 */
function loadEnv(envPath) {
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    // .env file is optional
    if (err.code !== 'ENOENT') {
      console.warn(`Warning: Failed to parse .env file: ${err.message}`);
    }
  }
}

/**
 * Load config.yaml and merge with environment variables
 * @returns {object} Configuration object
 */
function loadConfig() {
  // Load .env first
  loadEnv(resolve(PROJECT_ROOT, '.env'));

  // Load config.yaml
  const configPath = resolve(PROJECT_ROOT, 'config.yaml');
  let fileConfig;
  try {
    const content = readFileSync(configPath, 'utf-8');
    fileConfig = yaml.load(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('Warning: config.yaml not found, using defaults');
      fileConfig = {};
    } else {
      throw new Error(`Failed to load config.yaml: ${err.message}`);
    }
  }

  // Build final config with env overrides
  const config = {
    server: {
      port: parseInt(process.env.PORT, 10) || fileConfig?.server?.port || 8081,
    },
    azure: {
      baseUrl: process.env.AZURE_BASE_URL || fileConfig?.azure?.baseUrl || 'https://claude-opus-4-5-resource-kr.services.ai.azure.com',
      openAIBaseUrl: process.env.AZURE_OPENAI_BASE_URL || fileConfig?.azure?.openAIBaseUrl || '',
      openAIApiVersion: fileConfig?.azure?.openAIApiVersion || '2024-05-01-preview',
      openAIResponsesApiVersion: fileConfig?.azure?.openAIResponsesApiVersion || 'preview',
      apiKey: process.env.AZURE_API_KEY || fileConfig?.azure?.apiKey || '',
    },
    unsupportedParams: fileConfig?.unsupportedParams || ['prompt_cache_retention', 'prompt_cache_key'],
    modelNameMap: fileConfig?.modelNameMap || {},
    openAIModels: fileConfig?.openAIModels || [],
    nativeResponsesModels: fileConfig?.nativeResponsesModels || [],
    completionsModels: fileConfig?.completionsModels || [],
    unsupportedAnthropicBetas: fileConfig?.unsupportedAnthropicBetas || [],
  };

  return config;
}

/** @type {ReturnType<typeof loadConfig>} */
const config = loadConfig();

export default config;
