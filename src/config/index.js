import 'dotenv/config';

const env = process.env;
const nodeEnv = env.NODE_ENV || 'development';

export const config = {
  env: nodeEnv,
  isProd: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: Number(env.PORT || 3000),
  logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
  databaseUrl: env.DATABASE_URL,
  dbSsl: env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', ca: env.DATABASE_CA_CERT || undefined }
    : false,
  dbPoolMax: Number(env.DATABASE_POOL_MAX || 10),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
  staffSessionTtlHours: Number(env.STAFF_SESSION_TTL_HOURS || 8),
  // Dev/test only: return one-time tokens in API responses because no email provider is connected.
  exposeDevTokens: nodeEnv !== 'production',
  // All accounts created outside production are flagged as test accounts (simulated money).
  accountsAreTest: nodeEnv !== 'production',
  rateLimitEnabled: nodeEnv !== 'test',
};

export function validateConfig() {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is required');
  if (config.isProd && !config.dbSsl) problems.push('DATABASE_SSL=true is required in production');
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
}
