import config from './config.mjs';
import { createProxyServer } from './server.mjs';
import { logRaw, log, logSuccess } from './utils/logger.mjs';

const server = createProxyServer(config);
const port = config.server.port;

server.listen(port, () => {
  logRaw('');
  logRaw('╔══════════════════════════════════════════════════════════════╗');
  logRaw('║           Azure OpenAI Proxy - Roo Code Edition            ║');
  logRaw('╚══════════════════════════════════════════════════════════════╝');
  logRaw('');
  logSuccess('SERVER', `Proxy server listening on http://localhost:${port}`);
  log('SERVER', `Model profile: ${config.activeModelProfile || 'default'}`);
  log('SERVER', `Azure endpoint: ${config.azure.baseUrl}`);
  log('SERVER', `API Key: ${config.azure.apiKey ? '***' + config.azure.apiKey.slice(-4) : '(not set)'}`);
  logRaw('');
  logRaw('  Routes:');
  logRaw('    /anthropic/*       → Azure AI Foundry Claude (Anthropic API)');
  logRaw('    /v1/messages       → Azure AI Foundry Claude (prefix 자동 보정)');
  logRaw('    /openai/*          → Azure OpenAI (Codex 등)');
  logRaw('    /v1/responses      → Azure OpenAI Responses API');
  logRaw('    /v1/chat/completions → Azure OpenAI Chat API');
  logRaw('    /health            → Health check');
  logRaw('');
  logRaw('  Roo Code 설정:');
  logRaw('  ┌──────────────────────────────────────────────────────────┐');
  logRaw(`  │ Claude  Base URL : http://localhost:${port}/anthropic        │`);
  logRaw(`  │         또는      : http://localhost:${port}                 │`);
  logRaw(`  │ Codex   Base URL : http://localhost:${port}/openai           │`);
  logRaw('  │ API Key          : (아무 값)                             │');
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
