import config from './config.mjs';
import { createProxyServer } from './server.mjs';
import { logRaw, log, logSuccess } from './utils/logger.mjs';

const server = createProxyServer(config);
const port = config.server.port;
const BOX_WIDTH = 60;
const BOX_CONTENT_WIDTH = BOX_WIDTH - 2;
const BOX_LABEL_WIDTH = 18;
const ROUTE_PATH_WIDTH = 22;

function boxLine(label, value) {
  const content = ` ${label.padEnd(BOX_LABEL_WIDTH)} ${value}`;
  return `  │${content.padEnd(BOX_CONTENT_WIDTH)}│`;
}

function routeLine(path, description) {
  return `    ${path.padEnd(ROUTE_PATH_WIDTH)} → ${description}`;
}

function getProfileModelMappings(config) {
  const activeProfile = config.activeModelProfile;
  if (!activeProfile || activeProfile === 'default') return [];

  const baseModelMap = [
    { label: 'Claude Opus', sourceModel: 'claude-opus-4-6', defaultTarget: 'claude-opus-4-6' },
    { label: 'Claude Sonnet', sourceModel: 'claude-sonnet-4-6', defaultTarget: 'claude-sonnet-4-6' },
    { label: 'Claude Haiku', sourceModel: 'claude-haiku-4-5-20251001', defaultTarget: 'claude-sonnet-4-5' },
  ];

  return baseModelMap
    .map(({ label, sourceModel, defaultTarget }) => {
      const currentTarget = config.modelNameMap?.[sourceModel] || defaultTarget;
      return currentTarget !== defaultTarget ? { label, value: `${sourceModel} → ${currentTarget}` } : null;
    })
    .filter(Boolean);
}

server.listen(port, () => {
  logRaw('');
  logRaw('╔══════════════════════════════════════════════════════════════╗');
  logRaw('║                 Azure OpenAI Proxy Server                  ║');
  logRaw('╚══════════════════════════════════════════════════════════════╝');
  logRaw('');
  logSuccess('SERVER', `Listening on http://localhost:${port}`);
  log('SERVER', `Active profile: ${config.activeModelProfile || 'default'}`);
  log('SERVER', `Azure endpoint: ${config.azure.baseUrl}`);
  log('SERVER', `API key: ${config.azure.apiKey ? '***' + config.azure.apiKey.slice(-4) : '(not set)'}`);
  logRaw('');

  const profileMappings = getProfileModelMappings(config);

  logRaw('  Routes:');
  logRaw(routeLine('/anthropic/*', 'Azure AI Foundry Anthropic API'));
  logRaw(routeLine('/v1/messages', 'Anthropic-compatible messages route'));
  logRaw(routeLine('/openai/*', 'Azure OpenAI compatible route'));
  logRaw(routeLine('/v1/responses', 'OpenAI Responses API route'));
  logRaw(routeLine('/v1/chat/completions', 'OpenAI Chat Completions route'));
  logRaw(routeLine('/health', 'Health check'));
  logRaw('');

  logRaw('  Connection info:');
  logRaw('  ┌──────────────────────────────────────────────────────────┐');
  logRaw(boxLine('Anthropic API', `http://localhost:${port}/anthropic`));
  logRaw(boxLine('OpenAI API', `http://localhost:${port}/openai`));
  logRaw(boxLine('API key', 'Any non-empty value'));
  logRaw(boxLine('Profile', String(config.activeModelProfile || 'default')));
  for (const mapping of profileMappings) {
    logRaw(boxLine(mapping.label, mapping.value));
  }
  logRaw('  └──────────────────────────────────────────────────────────┘');
  logRaw('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('SERVER', 'Shutting down...');
  server.close(() => {
    log('SERVER', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  log('SERVER', 'Shutting down...');
  server.close(() => {
    log('SERVER', 'Server closed');
    process.exit(0);
  });
});
