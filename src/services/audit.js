// src/services/audit.js
import {pool} from '../db.js';

/**
 * Resolve user_id from users table by email.
 * Returns null if not found or email missing.
 */
async function getUserIdByEmail(client, email) {
    if (!email) return null;
    try {
        const { rows } = await client.query(
            'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
            [email]
        );
        return rows[0] ? rows[0].id : null;
    } catch (err) {
        console.error('[audit] Failed to resolve user_id:', err.message);
        return null;
    }
}

/**
 * Get client from either pool or a connected client.
 * Returns { client, release } where release indicates whether to release manually.
 */
async function getClient(maybePoolOrClient) {
    if (maybePoolOrClient && typeof maybePoolOrClient.release === 'function') {
        return { client: maybePoolOrClient, release: false };
    }
    const client = await (maybePoolOrClient?.connect?.() ?? pool.connect());
    return { client, release: true };
}

/**
 * Core audit writer.
 * Use inside your routes to record changes.
 *
 * Example usage:
 *   await addAudit(pool, {
 *     actor_email: req.user.email,
 *     action: 'ASSET_CREATE',
 *     entity_type: 'asset',
 *     entity_id: assetId,
 *     summary: `Created asset ${assetName}`,
 *     after_data: { title, barcode }
 *   });
 */
export async function addAudit(poolOrClient, payload) {
    //console.log('In audit add', payload);
    const {
        actor_email,
        action,
        entity_type,
        entity_id = null,
        ref_type = null,
        ref_id = null,
        summary = null,
        before_data = null,
        after_data = null,
        metadata = null,
    } = payload || {};

    if (!actor_email) throw new Error('audit: actor_email is required');
    if (!action) throw new Error('audit: action is required');
    if (!entity_type) throw new Error('audit: entity_type is required');

    const { client, release } = await getClient(poolOrClient);

    try {
        const actor_user_id = await getUserIdByEmail(client, actor_email);

        await client.query(
            `
      INSERT INTO audit_events (
        actor_id,
        actor_email,
        action,
        entity_type,
        entity_id,
        ref_type,
        ref_id,
        summary,
        before_data,
        after_data,
        occurred_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      `,
            [
                actor_user_id,
                actor_email,
                String(action),
                String(entity_type),
                entity_id,
                ref_type,
                ref_id,
                summary,
                before_data,
                after_data,
            ]
        );
    } catch (err) {
        console.error('[audit] insert failed:', err.message);
        throw err;
    } finally {
        if (release) client.release();
    }
}

/**
 * Safe fire-and-forget version.
 * Does not throw even if audit insert fails.
 */
export async function auditSafe(poolOrClient, payload) {
    //console.log('In audit events', poolOrClient, payload);
    try {
        await addAudit(poolOrClient, payload);
    } catch (err) {
        console.error('[auditSafe] Failed to write audit log:', err.message);
    }
}
