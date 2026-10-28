// Drops and recreates the public schema of the TEST database, then migrates. Refuses non-test databases.
process.env.NODE_ENV = 'test';
const { config } = await import('../src/config/index.js');
const { getPool, closePool } = await import('../src/database/pool.js');
const { migrate } = await import('../src/database/migrate.js');
if (!config.databaseUrl || !/test/i.test(new URL(config.databaseUrl).pathname)) {
  console.error('Refusing to reset: DATABASE_URL must point at a database whose name contains "test".');
  process.exit(1);
}
await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate(() => {});
await closePool();
console.log('Test database reset and migrated.');
