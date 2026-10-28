import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { query } from './database/pool.js';
import { logger } from './services/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { customerAuthRouter, staffAuthRouter } from './modules/auth/auth.routes.js';
import { customerRouter, publicRouter } from './modules/accounts/accounts.routes.js';
import { transfersRouter } from './modules/transfers/transfers.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false); // Railway terminates TLS in front of the app
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }, 'request'));
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (config.rateLimitEnabled) app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.get('/healthz', async (_req, res) => {
    try { await query('SELECT 1'); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });

  app.use('/api/v1', publicRouter);
  app.use('/api/v1/auth', customerAuthRouter);
  app.use('/api/v1/admin/auth', staffAuthRouter);
  app.use('/api/v1/transfers', transfersRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1', customerRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
