import { config } from '../config/index.js';
import { logger } from './logger.js';

// No email provider is connected in this build. In dev/test we log the event (never the token); production logs a warning.
export async function sendMail({ to, template }) {
  logger.warn({ to: to.replace(/(^.).*(@.*$)/, '$1***$2'), template, provider: 'none' },
    config.isProd ? 'Email provider not configured: message NOT sent' : 'Email not sent (dev mode, no provider)');
}
