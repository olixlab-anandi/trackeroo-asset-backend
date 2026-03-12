// src/routes/users.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js'; // your Pool instance

import { requireAuth } from '../middleware/authz.js';
import { requireRole } from '../middleware/role.js';
import { getUserSnapshot } from '../services/userSnapshots.js';
import { auditSafe } from '../services/audit.js';

const router = Router();

// src/routes/users.js
router.get(
    '/',
    requireAuth,
    requireRole(['admin', 'super_admin']),
    async (req, res) => {
        try {
            const sql = `
        SELECT
          id,
          email,
          name,
          role,
          is_active,
          created_at,
          updated_at
        FROM users
        WHERE role <> $1       
        ORDER BY created_at DESC
      `;
            const r = await pool.query(sql, ['super_admin']);
            //console.log('[users] ✅ rows:', r.rowCount);
            return res.json({ items: r.rows });
        } catch (e) {
            console.error('[GET /users] failed:', e); // keep this
            console.error('[users] ❌ failed:', e);
            return res.status(500).json({ error: 'Failed to load users' });
        }
    }
);


/**
 * POST /users
 * Create a user (admin only). Role cannot be super_admin here.
 * body: { email, name, role, password, is_active? }
 */
router.post('/',
    requireAuth,
    requireRole('admin', 'super_admin'),
    async (req, res) => {
        const { email, name, role, password, is_active = true, user_email } = req.body || {};
        if (!email || !password || !role) {
            return res.status(400).json({ error: 'email, password and role are required' });
        }
        if (role === 'super_admin') {
            return res.status(400).json({ error: 'Cannot create super_admin' });
        }
        try {
            const hash = await bcrypt.hash(password, 12);
            const sql = `
        INSERT INTO users (email, password_hash, name, role, is_active, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5, now(), now())
        RETURNING id, email, name, role, is_active, created_at;
      `;
            const r = await pool.query(sql, [email, hash, name || '', role, !!is_active]);
            res.status(201).json({ user: r.rows[0] });

            const after = r.rows[0];

            await auditSafe(pool, {
                action: 'USER_CREATE',
                entity_type: 'user',
                entity_id: after.id,
                actor_email: user_email,
                summary: `Created user ${after.email} (${after.role})`,
                before_data: null,
                after_data: after,
            });
        } catch (e) {
            if (e.code === '23505') {
                return res.status(409).json({ error: 'Email already exists' });
            }
            console.error('[POST /users] failed:', e);
            res.status(500).json({ error: 'Failed to create user' });
        }
    }
);

/**
 * PATCH /users/:id
 * Update name/role/is_active or reset password (optional)
 */
router.patch('/:id',
    requireAuth,
    requireRole('admin', 'super_admin'),
    async (req, res) => {
        const { id } = req.params;
        const { name, role, is_active, password, user_email } = req.body || {};
        const client = await pool.connect();

        const before = await getUserSnapshot(client, id);
        if (!before) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found.' });
        }


        // Block changing/assigning super_admin through this API
        if (role === 'super_admin') {
            return res.status(400).json({ error: 'Cannot assign super_admin' });
        }

        // Prevent touching the seeded super admin if someone guesses the id
        const guard = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
        if (!guard.rowCount) return res.status(404).json({ error: 'User not found' });
        if (guard.rows[0].role === 'super_admin') {
            return res.status(403).json({ error: 'Cannot modify super_admin' });
        }

        const fields = [];
        const values = [];
        let i = 1;

        if (typeof name === 'string') { fields.push(`name = $${i++}`); values.push(name); }
        if (typeof role === 'string') { fields.push(`role = $${i++}`); values.push(role); }
        if (typeof is_active === 'boolean') { fields.push(`is_active = $${i++}`); values.push(is_active); }
        if (typeof password === 'string' && password.length > 0) {
            const hash = await bcrypt.hash(password, 12);
            fields.push(`password_hash = $${i++}`); values.push(hash);
        }

        if (!fields.length) return res.json({ ok: true }); // nothing to update

        const sql = `
      UPDATE users
      SET ${fields.join(', ')}, updated_at = now()
      WHERE id = $${i}
      RETURNING id, email, name, role, is_active, updated_at;
    `;
        values.push(id);

        const { rows } = await client.query(sql, values);
        const after = rows[0];

        if (before.is_active == true && after.is_active == false) {
            //console.log('Is deactivated');
            await auditSafe(client, {
                action: 'USER_DEACTIVATE',
                entity_type: 'user',
                entity_id: id,
                actor_email: user_email,
                summary: `Deactivated user ${before.email}`,
                before_data: before,
                after_data: {
                    is_active: false
                },
            });
        }

        
        await auditSafe(client, {
            action: 'USER_EDIT',
            entity_type: 'user',
            entity_id: id,
            actor_email: user_email,
            summary: `Updated user ${before.email}`,
            before_data: before,
            after_data: after,
        });

        await client.query('COMMIT');

        try {
            const r = await pool.query(sql, values);
            res.json({ user: r.rows[0] });
        } catch (e) {
            console.error('[PATCH /users/:id] failed:', e);
            res.status(500).json({ error: 'Failed to update user' });
        } finally {
            client.release();
        }

    }
);

/**
 * DELETE /users/:id
 * Soft-delete alternative: set is_active = false
 */
router.delete('/:id',
    requireAuth,
    requireRole('admin', 'super_admin'),
    async (req, res) => {
        const { id } = req.params;
        const client = await pool.connect();
        const before = await getUserSnapshot(client, id);
        if (!before) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found.' });
        }
        if (before.is_active === false) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'User already deactivated.' });
        }

        const guard = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
        if (!guard.rowCount) return res.status(404).json({ error: 'User not found' });
        if (guard.rows[0].role === 'super_admin') {
            return res.status(403).json({ error: 'Cannot delete super_admin' });
        }

        await auditSafe(client, {
            action: 'USER_DEACTIVATE',
            entity_type: 'user',
            entity_id: id,
            actor_email,
            summary: `Deactivated user ${before.email}`,
            before_data: before,
            after_data: {
                is_active: false
            },
        });

        await client.query('COMMIT');
        try {
            await pool.query('UPDATE users SET is_active = false, updated_at = now() WHERE id = $1', [id]);
            res.json({ ok: true });
        } catch (e) {
            console.error('[DELETE /users/:id] failed:', e);
            res.status(500).json({ error: 'Failed to delete user' });
        } finally {
            client.release();
        }
    }
);

export default router;
