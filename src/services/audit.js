export async function audit(client, { actorType, actorId = null, action, entityType = null, entityId = null, ip = null, details = {} }) {
  await client.query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, ip, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorType, actorId, action, entityType, entityId == null ? null : String(entityId), ip, JSON.stringify(details)]);
}
export const notify = (client, userId, type, title, body) =>
  client.query('INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)', [userId, type, title, body]);
