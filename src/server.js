import { config, validateConfig } from './config/index.js';
import { createApp } from './app.js';
import { closePool } from './database/pool.js';
import { logger } from './services/logger.js';

validateConfig();
const server = createApp().listen(config.port, () => logger.info({ port: config.port, env: config.env }, 'ZenvoBank API listening'));

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => { await closePool(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
