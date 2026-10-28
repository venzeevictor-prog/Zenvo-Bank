import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { logger } from '../services/logger.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(422).json({ error: { code: 'validation_failed', message: 'Invalid input',
      details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON' } });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Payload too large' } });
  logger.error({ err: { message: err.message, code: err.code, stack: err.stack }, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
}
