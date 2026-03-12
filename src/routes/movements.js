import express from 'express';
import { pool } from '../db.js';
import QueryStream from 'pg-query-stream';
import { createIdempotencyMiddleware } from "../middleware/idempotency.js";

const router = express.Router();
const idempotency = createIdempotencyMiddleware(pool);

router.get('/ok', (_req, res) => res.json({ ok: true, scope: 'movements' }));


function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}
function toCsvLine(row, columns) {
    return columns.map((c) => csvEscape(row[c])).join(',') + '\n';
}

function normalizeDate(d) {
    if (!d) return '';

    // already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;

    // DD/MM/YYYY
    const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return d; // fallback – let postgres try

    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3];

    return `${yyyy}-${mm}-${dd}`;
}

// MUST be above "/:id"
router.get('/export', async (req, res) => {
    const {
        q = '',
        // reason = '',   // ✅ keep reading it if you want, but we will NOT apply it (to match GET /movements)
        date_from = '',
        date_to = '',
        asset_id = '',
        from_location_id = '',
        to_location_id = '',
        created_by_user = '',
    } = req.query;

    const params = [];
    const where = [];

    const dateFrom = normalizeDate(date_from);
    const dateTo = normalizeDate(date_to);

    if (q) {
        params.push(`%${q}%`);
        where.push(`(
      m.note ILIKE $${params.length}
      OR a.title ILIKE $${params.length}
      OR a.part_name ILIKE $${params.length}
      OR lf.path ILIKE $${params.length}
      OR lt.path ILIKE $${params.length}
    )`);
    }

    // ✅ IMPORTANT:
    // We intentionally DO NOT apply `reason` filtering here,
    // because your existing GET /movements has the reason filter commented out.
    // This keeps export results consistent with the list/search results.

    if (dateFrom) {
        params.push(dateFrom);
        where.push(`m.created_at >= $${params.length}::date`);
    }

    if (dateTo) {
        params.push(dateTo);
        where.push(`m.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    if (asset_id) { params.push(asset_id); where.push(`m.asset_id = $${params.length}`); }
    if (from_location_id) { params.push(from_location_id); where.push(`m.from_location_id = $${params.length}`); }
    if (to_location_id) { params.push(to_location_id); where.push(`m.to_location_id = $${params.length}`); }
    if (created_by_user) { params.push(created_by_user); where.push(`m.created_by_user = $${params.length}`); }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
    SELECT
      m.id,
      m.asset_id,
      a.title         AS asset_title,
      a.part_name     AS asset_part_name,
      m.from_location_id,
      lf.path         AS from_path,
      m.to_location_id,
      lt.path         AS to_path,
      m.reason,
      m.note,
      m.created_by_user,
      m.created_at
    FROM movements m
    LEFT JOIN assets a     ON a.id = m.asset_id
    LEFT JOIN locations lf ON lf.id = m.from_location_id
    LEFT JOIN locations lt ON lt.id = m.to_location_id
    ${whereSQL}
    ORDER BY m.created_at DESC;
  `;

    const columns = [
        'id', 'asset_id', 'asset_title', 'asset_part_name',
        'from_location_id', 'from_path',
        'to_location_id', 'to_path',
        'reason', 'note', 'created_by_user', 'created_at'
    ];

    const filename = `movements_export_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');

    let client;
    try {
        client = await pool.connect();

        res.write(columns.join(',') + '\n');

        const qs = new QueryStream(sql, params, { highWaterMark: 1000 });
        const stream = client.query(qs);

        let rowCount = 0;

        for await (const row of stream) {
            rowCount++;
            const line = columns.map((c) => csvEscape(row[c])).join(',') + '\n';

            if (!res.write(line)) {
                await new Promise((resolve) => res.once('drain', resolve));
            }
        }

        // ✅ trailer so you can verify streamed count
        res.write(`# rows=${rowCount}\n`);
        res.end();
    } catch (e) {
        console.error('[GET /movements/export] failed:', e);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to export movements' });
        else res.end();
    } finally {
        if (client) client.release();
    }
});





/* -------------------------------------------------------
 *  POST /movements/internal
 *  Body: { asset_id, from_location_id?, to_location_id, note?, user_email? }
 * -----------------------------------------------------*/
router.post('/internal', idempotency, async (req, res) => {
    const { asset_id, from_location_id, to_location_id, note = '', user_email = null } = req.body || {};
    if (!asset_id || !to_location_id) {
        return res.status(400).json({ error: 'asset_id and to_location_id are required' });
    }
    if (from_location_id && from_location_id === to_location_id) {
        return res.status(400).json({ error: 'from and to locations cannot be the same' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the asset to avoid race moves
        const assetRes = await client.query(
            `SELECT id, location_id, status FROM assets WHERE id = $1 FOR UPDATE`,
            [asset_id]
        );
        const asset = assetRes.rows[0];
        if (!asset) throw new Error('Asset not found');

        // Optional rule: only allow move when Active/In use
        if (asset.status && !['ACTIVE', 'IN_USE'].includes(asset.status)) {
            throw new Error(`Asset status does not allow movement: ${asset.status}`);
        }

        // If caller provided from_location_id, enforce it matches the asset’s current location
        if (from_location_id && asset.location_id && asset.location_id !== from_location_id) {
            throw new Error('from_location_id does not match asset current location');
        }

        // Insert movement
        const mvRes = await client.query(
            `INSERT INTO movements
         (asset_id, from_location_id, to_location_id, reason, note, created_by_user)
       VALUES ($1, $2, $3, 'INTERNAL', $4, $5)
       RETURNING id, created_at`,
            [asset_id, asset.location_id || null, to_location_id, note, user_email]
        );

        // Update asset current location
        await client.query(
            `UPDATE assets SET location_id = $1, updated_at = now() WHERE id = $2`,
            [to_location_id, asset_id]
        );

        await client.query('COMMIT');
        res.json({ ok: true, movement_id: mvRes.rows[0].id, moved_at: mvRes.rows[0].created_at });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[POST /movements/internal] failed:', e);
        res.status(400).json({ error: e.message || 'Failed to move asset' });
    } finally {
        client.release();
    }
});

/* -------------------------------------------------------
 *  GET /movements  (paged list + filters)
 *  Query:
 *   page=1&pageSize=20
 *   q=free text (matches asset title/part/path via joins, and note)
 *   reason=INTERNAL|ISSUE|RETURN|IMPORT|ADJUSTMENT (comma allowed)
 *   date_from=YYYY-MM-DD  date_to=YYYY-MM-DD
 *   asset_id=uuid
 *   from_location_id=uuid  to_location_id=uuid
 *   created_by_user=email
 * -----------------------------------------------------*/
router.get('/', async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 20)));
    const offset = (page - 1) * pageSize;

    const {
        q = '',
        reason = '',
        date_from = '',
        date_to = '',
        asset_id = '',
        from_location_id = '',
        to_location_id = '',
        created_by_user = '',
    } = req.query;

    const params = [];
    const where = [];

    // free text (note + asset title/part name + from/to path via joins)
    if (q) {
        params.push(`%${q}%`);
        // Note: we use simple ILIKE on note; asset/title/part via LEFT JOIN below
        where.push(`(
      m.note ILIKE $${params.length}
      OR a.title ILIKE $${params.length}
      OR a.part_name ILIKE $${params.length}
      OR lf.path ILIKE $${params.length}
      OR lt.path ILIKE $${params.length}
    )`);
    }

    // if (reason) {
    //     const rs = reason.split(',').map(s => s.trim()).filter(Boolean);
    //     if (rs.length) {
    //         const placeholders = rs.map((r, i) => {
    //             params.push(r);
    //             return `$${params.length}`;
    //         });
    //         where.push(`m.reason IN (${placeholders.join(',')})`);
    //     }
    // }

    if (date_from) {
        params.push(date_from);
        where.push(`m.created_at >= $${params.length}::date`);
    }
    if (date_to) {
        params.push(date_to);
        where.push(`m.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    if (asset_id) {
        params.push(asset_id);
        where.push(`m.asset_id = $${params.length}`);
    }
    if (from_location_id) {
        params.push(from_location_id);
        where.push(`m.from_location_id = $${params.length}`);
    }
    if (to_location_id) {
        params.push(to_location_id);
        where.push(`m.to_location_id = $${params.length}`);
    }
    if (created_by_user) {
        params.push(created_by_user);
        where.push(`m.created_by_user = $${params.length}`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
        // total
        const totalSQL = `
      SELECT COUNT(*)::int AS cnt
      FROM movements m
      LEFT JOIN assets a   ON a.id  = m.asset_id
      LEFT JOIN locations lf ON lf.id = m.from_location_id
      LEFT JOIN locations lt ON lt.id = m.to_location_id
      ${whereSQL};
    `;
        const totalRes = await pool.query(totalSQL, params);
        const total = totalRes.rows[0]?.cnt || 0;

        // rows
        params.push(pageSize, offset);
        const listSQL = `
      SELECT
        m.id,
        m.asset_id,
        a.title         AS asset_title,
        a.part_name     AS asset_part_name,
        m.from_location_id,
        lf.path         AS from_path,
        m.to_location_id,
        lt.path         AS to_path,
        m.reason,
        m.note,
        m.created_by_user,
        m.created_at
      FROM movements m
      LEFT JOIN assets    a  ON a.id  = m.asset_id
      LEFT JOIN locations lf ON lf.id = m.from_location_id
      LEFT JOIN locations lt ON lt.id = m.to_location_id
      ${whereSQL}
      ORDER BY m.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length};
    `;
        const rows = (await pool.query(listSQL, params)).rows;

        res.json({ items: rows, total, page, pageSize });
    } catch (e) {
        console.error('[GET /movements] failed:', e);
        res.status(500).json({ error: 'Failed to load movements' });
    }
});

/* -------------------------------------------------------
 *  GET /movements/:id  (detail)
 * -----------------------------------------------------*/
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const sql = `
      SELECT
        m.*,
        a.title AS asset_title,
        a.part_name AS asset_part_name,
        lf.path AS from_path,
        lt.path AS to_path
      FROM movements m
      LEFT JOIN assets a   ON a.id  = m.asset_id
      LEFT JOIN locations lf ON lf.id = m.from_location_id
      LEFT JOIN locations lt ON lt.id = m.to_location_id
      WHERE m.id = $1
      LIMIT 1;
    `;
        const r = await pool.query(sql, [id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json(r.rows[0]);
    } catch (e) {
        console.error('[GET /movements/:id] failed:', e);
        res.status(500).json({ error: 'Failed to load movement' });
    }
});

/* -------------------------------------------------------
 *  PATCH /movements/:id  (safe edits)
 *  Allowed: note only (history integrity)
 * -----------------------------------------------------*/
router.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;

    if (!note || note.trim() === '') {
        return res.status(400).json({ error: 'Note cannot be empty' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const upd = await client.query(
            `UPDATE movements
       SET note = TRIM(
           COALESCE(note, '') ||
           CASE
             WHEN note IS NULL OR note = '' THEN $1::text
             ELSE E'\n' || $1::text
           END
         )
       WHERE id = $2
       RETURNING id, note`,
            [note, id]
        );

        if (!upd.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }

        await client.query('COMMIT');
        res.json({ movement: upd.rows[0] });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[PATCH /movements/:id] failed:', e);
        res.status(500).json({ error: 'Failed to update movement' });
    } finally {
        client.release();
    }
});

// -------------------------------------------
// POST /movements/moveAsset
// Body: { asset_id, to_location_id, note?, user_email? }
// -------------------------------------------
router.post('/move-asset', async (req, res) => {
    const { asset_id, to_location_id, note = '', user_email = null } = req.body || {};

    if (!asset_id || !to_location_id) {
        return res.status(400).json({ error: 'asset_id and to_location_id are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock and fetch current asset
        const assetRes = await client.query(
            `SELECT id, location_id, status FROM assets WHERE id = $1 FOR UPDATE`,
            [asset_id]
        );
        const asset = assetRes.rows[0];
        if (!asset) throw new Error('Asset not found');

        const from_location_id = asset.location_id;

        //console.log('from_location_id', from_location_id);
        //console.log('from_location_id', to_location_id);

        // Asset moved to same location than throw an error
        if (from_location_id === to_location_id) {
            return res.status(400).json({ error: 'Asset is already in the selected location' });
        }

        // Insert movement
        const mvRes = await client.query(
            `INSERT INTO movements
         (asset_id, from_location_id, to_location_id, reason, note, created_by_user)
       VALUES ($1, $2, $3, 'INTERNAL', $4, $5)
       RETURNING id, created_at`,
            [asset_id, from_location_id, to_location_id, note, user_email]
        );

        // Update asset current location
        await client.query(
            `UPDATE assets
         SET location_id = $1, updated_at = now()
       WHERE id = $2`,
            [to_location_id, asset_id]
        );

        await client.query('COMMIT');
        res.json({
            ok: true,
            movement_id: mvRes.rows[0].id,
            moved_at: mvRes.rows[0].created_at,
        });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[POST /movements/moveAsset] failed:', e);
        res.status(400).json({ error: e.message || 'Failed to move asset' });
    } finally {
        client.release();
    }
});


/* -------------------------------------------------------
 *  OPTIONAL: POST /movements/:id/reverse
 *  Creates a reversal entry and reverts asset location.
 *  (Enable when you want reversible edits.)
 * -----------------------------------------------------*/
// router.post('/:id/reverse', async (req, res) => {
//   const { id } = req.params;
//   const { user_email = null, note = 'Reversal' } = req.body || {};
//   const client = await pool.connect();
//   try {
//     await client.query('BEGIN');
//     const r = await client.query(
//       `SELECT * FROM movements WHERE id = $1 FOR UPDATE`,
//       [id]
//     );
//     const m = r.rows[0];
//     if (!m) return res.status(404).json({ error: 'Not found' });
//
//     // Create reversal row
//     const ins = await client.query(
//       `INSERT INTO movements
//           (asset_id, from_location_id, to_location_id, reason, note, created_by_user, reverse_movement_id)
//        VALUES ($1, $2, $3, 'ADJUSTMENT', $4, $5, $6)
//        RETURNING id, created_at`,
//       [m.asset_id, m.to_location_id, m.from_location_id, note, user_email, m.id]
//     );
//
//     // Revert asset location
//     await client.query(
//       `UPDATE assets SET location_id = $1, updated_at = now() WHERE id = $2`,
//       [m.from_location_id, m.asset_id]
//     );
//
//     await client.query('COMMIT');
//     res.json({ ok: true, reversal_id: ins.rows[0].id });
//   } catch (e) {
//     await client.query('ROLLBACK');
//     console.error('[POST /movements/:id/reverse] failed:', e);
//     res.status(500).json({ error: 'Failed to reverse movement' });
//   } finally {
//     client.release();
//   }
// });

export default router;
