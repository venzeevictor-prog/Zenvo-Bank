// Secure first-admin setup. Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run create-admin
// Refuses to run if any super_admin already exists, so it cannot be used as a backdoor later.
import { validateConfig } from '../src/config/index.js';
import { closePool, withTx } from '../src/database/pool.js';
import { hashSecret } from '../src/modules/auth/auth.service.js';
import { audit } from '../src/services/audit.js';

validateConfig();
const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 14) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 14 characters).');
  process.exit(1);
}
try {
  await withTx(async (client) => {
    const existing = await client.query(
      `SELECT 1 FROM staff_role_assignments a JOIN roles r ON r.id = a.role_id WHERE r.code = 'super_admin' LIMIT 1`);
    if (existing.rowCount) throw new Error('A super admin already exists. Use the admin portal to manage staff.');
    const s = (await client.query(
      `INSERT INTO staff_users (email, full_name, password_hash) VALUES ($1,'Initial Administrator',$2) RETURNING id`,
      [email.toLowerCase(), await hashSecret(password)])).rows[0];
    await client.query(`INSERT INTO staff_role_assignments (staff_id, role_id) SELECT $1, id FROM roles WHERE code = 'super_admin'`, [s.id]);
    await audit(client, { actorType: 'system', action: 'staff.initial_admin_created', entityType: 'staff_user', entityId: s.id });
  });
  console.log('Initial administrator created. MFA enrolment is required before production login (not yet implemented).');
} catch (e) { console.error(e.message); process.exitCode = 1; }
await closePool();
