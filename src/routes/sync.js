// routes/sync.js
import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.get('/ok', (_req, res) => res.json({ ok: true, scope: 'sync' }));

function toInt(value, fallback) {
    const n = parseInt(String(value || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isoOrNull(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numOrNull(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Cursor helpers
 * Cursor payload shape:
 *   { updated_at: "2026-03-01T00:00:00.000Z", id: "uuid" }
 */
function encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeCursor(cursor) {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid cursor');
    if ((!parsed.updated_at && !parsed?.created_at) || !parsed.id) throw new Error('Invalid cursor shape');

    const d = new Date(parsed.updated_at || parsed.created_at || parsed.u);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid cursor updated_at');
    
    // Return both keys to be compatible with all sync routes (assets, locations, movements, etc.)
    const iso = d.toISOString();
    return { 
        updated_at: iso, 
        created_at: iso, 
        id: String(parsed.id || parsed.i) 
    };
}

function parseUpdatedAfter(value) {
    // Same behavior as /sync/assets: allow missing updated_after for first sync
    if (!value) return new Date(0).toISOString(); // 1970-01-01T00:00:00.000Z
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}

/**
 * DELTA SYNC (keyset pagination)
 *
 * GET /sync/assets?updated_after=2026-02-20T09:00:00Z&limit=200&cursor=<base64>
 *
 * - updated_after: last successful sync timestamp from device (ISO)
 * - cursor: internal paging cursor returned from previous call (base64 JSON)
 * - limit: page size (max 500)
 * 
 * Response:
 * - assets: array
 * - has_more: boolean
 * - next_cursor: string|null
 * - synced_at: server timestamp when response generated
 */
router.get('/assets', async (req, res) => {
    try {
        const limit = Math.min(toInt(req.query.limit, 200), 500);

        // updated_after is optional: if missing, do full sync
        const updatedAfterRaw = (req.query.updated_after || '').trim();
        const updatedAfter = updatedAfterRaw ? new Date(updatedAfterRaw) : null;
        if (updatedAfterRaw && Number.isNaN(updatedAfter.getTime())) {
            return res.status(400).json({ error: 'Invalid updated_after ISO timestamp' });
        }

        // cursor is optional; used for paging within the same delta window
        // cursor format: base64(JSON.stringify({ u: "<updated_at>", i: "<uuid>" }))
        let cursor = null;
        const cursorRaw = (req.query.cursor || '').trim();
        if (cursorRaw) {
            try {
                const decoded = Buffer.from(cursorRaw, 'base64').toString('utf8');
                const parsed = JSON.parse(decoded);
                if (!parsed?.u || !parsed?.i) throw new Error('bad cursor');
                const cu = new Date(parsed.u);
                if (Number.isNaN(cu.getTime())) throw new Error('bad cursor timestamp');
                cursor = { updated_at: cu.toISOString(), id: String(parsed.i) };
            } catch (e) {
                return res.status(400).json({ error: 'Invalid cursor' });
            }
        }

        // Build keyset WHERE:
        // 1) if updated_after provided: only rows with updated_at > updated_after
        // 2) if cursor provided: fetch rows AFTER (cursor.updated_at, cursor.id) in ORDER BY updated_at,id
        //
        // ORDER BY updated_at ASC, id ASC makes keyset stable.
        const whereParts = [];
        const params = [];
        let p = 1;

        if (updatedAfter) {
            whereParts.push(`a.updated_at > $${p++}`);
            params.push(updatedAfter.toISOString());
        }

        if (cursor) {
            // FIX: cast to millisecond precision to match JS cursor precision (.000Z)
            // AND use >= to stay index-friendly for the first column
            whereParts.push(`a.updated_at >= $${p}::timestamptz`);
            whereParts.push(`(a.updated_at::timestamptz(3), a.id) > ($${p++}::timestamptz(3), $${p++}::uuid)`);
            params.push(cursor.updated_at, cursor.id);
        }

        const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

        // Fetch limit+1 so we can compute has_more without COUNT(*)
        params.push(limit + 1);
        const limitParam = `$${p++}`;

        const sql = `
      SELECT
        a.id,
        a.barcode,
        a.title,
        a.is_active,
        a.status,
        a.serial_number,
        a.category,
        a.tag,
        a.company_asset_id,
        a.part_name,
        a.part_description,
        a.type,
        a.work_order_number,
        a.attributes,
        a.location_id,
        a.created_at,
        a.updated_at,
        a.created_by_user,

        COALESCE(
          l.path,
          TRIM(
            CONCAT(
              COALESCE(el.company_name, ''),
              CASE WHEN el.contact_person IS NOT NULL THEN ' | ' || el.contact_person ELSE '' END,
              CASE WHEN el.email IS NOT NULL THEN ' | ' || el.email ELSE '' END,
              CASE WHEN el.phone IS NOT NULL THEN ' | ' || el.phone ELSE '' END,
              CASE WHEN el.address_line1 IS NOT NULL THEN ' | ' || el.address_line1 ELSE '' END,
              CASE WHEN el.address_line2 IS NOT NULL THEN ', ' || el.address_line2 ELSE '' END,
              CASE WHEN el.city IS NOT NULL THEN ' | ' || el.city ELSE '' END,
              CASE WHEN el.postal_code IS NOT NULL THEN ' | ' || el.postal_code ELSE '' END,
              CASE WHEN el.notes IS NOT NULL THEN ' | ' || el.notes ELSE '' END
            )
          ),
          '—'
        ) AS location_path,

        CASE
          WHEN a.location_id IS NOT NULL THEN 'internal'
          WHEN el.id IS NOT NULL THEN 'external'
          ELSE 'unknown'
        END AS location_type,

        el.id               AS external_location_id,
        el.company_name     AS external_company_name,
        el.contact_person   AS external_contact_person,
        el.email            AS external_email,
        el.phone            AS external_phone,
        el.address_line1    AS external_address_line1,
        el.address_line2    AS external_address_line2,
        el.notes            AS external_notes

      FROM assets a
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN issue_item ii ON ii.asset_id = a.id AND ii.status = 'ISSUED'
      LEFT JOIN issue_transaction it ON it.id = ii.transaction_id
      LEFT JOIN external_location el ON el.id = it.external_location_id
      ${whereSql}
      ORDER BY a.created_at ASC NULLS LAST, a.id ASC
      LIMIT ${limitParam}
    `;

        const client = await pool.connect();
        try {
            const result = await client.query(sql, params);
            const rows = result.rows || [];

            const has_more = rows.length > limit;
            const pageRows = has_more ? rows.slice(0, limit) : rows;

            const assets = pageRows.map((r) => ({
                id: r.id,
                barcode: r.barcode || null,
                title: r.title || null,
                status: r.status || null,
                is_active: !!r.is_active,

                location_id: r.location_id || null,
                location_path: r.location_path || '—',
                location_type: r.location_type || 'unknown',

                serial_number: r.serial_number || null,
                category: r.category || null,
                tag: r.tag || null,
                company_asset_id: r.company_asset_id || null,

                part_name: r.part_name || null,
                part_description: r.part_description || null,
                type: r.type || null,
                work_order_number: r.work_order_number || null,

                attributes: r.attributes || {},

                created_at: isoOrNull(r.created_at),
                updated_at: isoOrNull(r.updated_at),

                created_by: r.created_by_user || null,

                external_location: r.external_location_id
                    ? {
                        id: r.external_location_id,
                        company_name: r.external_company_name || null,
                        contact_person: r.external_contact_person || null,
                        email: r.external_email || null,
                        phone: r.external_phone || null,
                        address_line1: r.external_address_line1 || null,
                        address_line2: r.external_address_line2 || null,
                        notes: r.external_notes || null,
                    }
                    : null,
            }));

            let next_cursor = null;
            if (has_more && pageRows.length) {
                const last = pageRows[pageRows.length - 1];
                next_cursor = Buffer.from(
                    JSON.stringify({ u: last.updated_at, i: last.id }),
                    'utf8'
                ).toString('base64');
            }

            return res.status(200).json({
                assets,
                returned: assets.length,
                has_more,
                next_cursor,
                updated_after: updatedAfter ? updatedAfter.toISOString() : null,
                synced_at: new Date().toISOString(),
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('[sync][assets] error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});


/**
 * GET /sync/locations
 * Query params:
 *   - updated_after: ISO timestamp (optional; if omitted => full sync)
 *   - cursor: base64 cursor from previous response (optional)
 *   - limit: page size (optional)
 */
router.get('/locations', async (req, res) => {
    const startedAt = new Date();

    try {
        const limitRaw = req.query.limit;
        const limit =
            Math.min(Math.max(parseInt(limitRaw || '500', 10) || 500, 1), 1000); // 1..1000

        const updatedAfter = parseUpdatedAfter(req.query.updated_after);
        if (updatedAfter === null) {
            return res.status(400).json({
                error: 'invalid_updated_after',
                message: 'updated_after must be a valid ISO date string',
            });
        }

        let cursor = null;
        if (req.query.cursor) {
            try {
                cursor = decodeCursor(String(req.query.cursor));
            } catch (e) {
                return res.status(400).json({
                    error: 'invalid_cursor',
                    message: 'cursor is not valid base64 JSON cursor',
                });
            }
        }

        /**
         * Delta + keyset pagination:
         *   WHERE updated_at > updatedAfter
         *   AND (updated_at, id) > (cursor.updated_at, cursor.id)  [if cursor]
         *   ORDER BY updated_at ASC, id ASC
         *   LIMIT limit + 1
         */
        const params = [];
        let whereSql = '';

        // 1) delta filter
        params.push(updatedAfter);
        whereSql += `WHERE l.updated_at > $${params.length}\n`;

        // 2) keyset cursor filter
        if (cursor) {
            params.push(cursor.updated_at);
            params.push(cursor.id);
            whereSql += `  AND l.updated_at >= $${params.length - 1}::timestamptz\n`;
            whereSql += `  AND (l.updated_at::timestamptz(3), l.id) > ($${params.length - 1}::timestamptz(3), $${params.length}::uuid)\n`;
        }

        // 3) limit (+1 to detect has_more)
        params.push(limit + 1);

        const sql = `
      SELECT
        l.id,
        l.name,
        l.parent_id,
        l.path,
        l.depth,
        l.created_at,
        l.updated_at,
        l.created_by_user,
        l.updated_by_user,
        l.active,
        l.barcode
      FROM locations l
      ${whereSql}
      ORDER BY l.updated_at ASC, l.id ASC
      LIMIT $${params.length};
    `;

        const { rows } = await pool.query(sql, params);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const nextCursor =
            hasMore && page.length
                ? encodeCursor({
                    updated_at: page[page.length - 1].updated_at,
                    id: page[page.length - 1].id,
                })
                : null;

        return res.json({
            locations: page,
            returned: page.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            updated_after: updatedAfter,
            synced_at: startedAt.toISOString(),
        });
    } catch (err) {
        // Keep same error style as /sync/assets (do not leak internals)
        console.error('[sync/locations] error', err);
        return res.status(500).json({
            error: 'internal_error',
            message: 'Failed to sync locations',
        });
    }
});



/**
 * GET /sync/external-locations
 * Query params:
 *   - updated_after: ISO timestamp (optional)
 *   - cursor: base64 cursor (optional)
 *   - limit: page size (optional)
 */
router.get('/external-locations', async (req, res) => {
    const startedAt = new Date();

    try {
        const limitRaw = req.query.limit;
        const limit = Math.min(Math.max(parseInt(limitRaw || '500', 10) || 500, 1), 1000);

        const updatedAfter = parseUpdatedAfter(req.query.updated_after);
        if (updatedAfter === null) {
            return res.status(400).json({
                error: 'invalid_updated_after',
                message: 'updated_after must be a valid ISO date string',
            });
        }

        let cursor = null;
        if (req.query.cursor) {
            try {
                cursor = decodeCursor(String(req.query.cursor));
            } catch (e) {
                return res.status(400).json({
                    error: 'invalid_cursor',
                    message: 'cursor is not valid base64 JSON cursor',
                });
            }
        }

        const params = [];
        let whereSql = '';

        // delta filter
        params.push(updatedAfter);
        whereSql += `WHERE el.updated_at > $${params.length}\n`;

        // keyset cursor filter
        if (cursor) {
            params.push(cursor.updated_at);
            params.push(cursor.id);
            whereSql += `  AND el.updated_at >= $${params.length - 1}::timestamptz\n`;
            whereSql += `  AND (el.updated_at::timestamptz(3), el.id) > ($${params.length - 1}::timestamptz(3), $${params.length}::uuid)\n`;
        }

        // limit + 1 for has_more
        params.push(limit + 1);

        const sql = `
      SELECT
        el.id,
        el.type,
        el.company_name,
        el.contact_person,
        el.email,
        el.phone,
        el.address_line1,
        el.address_line2,
        el.city,
        el.state,
        el.postal_code,
        el.country,
        el.notes,
        el.is_active,
        el.created_at,
        el.updated_at
      FROM external_location el
      ${whereSql}
      ORDER BY el.updated_at ASC, el.id ASC
      LIMIT $${params.length};
    `;

        const { rows } = await pool.query(sql, params);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const nextCursor =
            hasMore && page.length
                ? encodeCursor({
                    updated_at: page[page.length - 1].updated_at,
                    id: page[page.length - 1].id,
                })
                : null;

        return res.json({
            external_locations: page,
            returned: page.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            updated_after: updatedAfter,
            synced_at: startedAt.toISOString(),
        });
    } catch (err) {
        console.error('[sync/external-locations] error', err);
        return res.status(500).json({
            error: 'internal_error',
            message: 'Failed to sync external locations',
        });
    }
});

/**
 * GET /sync/issues
 * Query params:
 *   - updated_after: ISO timestamp (optional)
 *   - cursor: base64 cursor (optional)
 *   - limit: page size (optional)
 */
router.get('/issues', async (req, res) => {
    const startedAt = new Date();

    try {
        const limitRaw = req.query.limit;
        const limit = Math.min(Math.max(parseInt(limitRaw || '500', 10) || 500, 1), 1000);

        const updatedAfter = parseUpdatedAfter(req.query.updated_after);
        if (updatedAfter === null) {
            return res.status(400).json({
                error: 'invalid_updated_after',
                message: 'updated_after must be a valid ISO date string',
            });
        }

        let cursor = null;
        if (req.query.cursor) {
            try {
                cursor = decodeCursor(String(req.query.cursor));
            } catch (e) {
                return res.status(400).json({
                    error: 'invalid_cursor',
                    message: 'cursor is not valid base64 JSON cursor',
                });
            }
        }

        /**
         * Delta + keyset pagination:
         * WHERE it.updated_at > updatedAfter
         * AND (it.updated_at, it.id) > (cursor.updated_at, cursor.id)  [if cursor]
         * ORDER BY it.updated_at ASC, it.id ASC
         * LIMIT limit + 1
         */
        const params = [];
        let whereSql = '';

        // delta filter
        params.push(updatedAfter);
        whereSql += `WHERE it.updated_at > $${params.length}\n`;

        // keyset cursor filter
        if (cursor) {
            params.push(cursor.updated_at);
            params.push(cursor.id);
            whereSql += `  AND it.updated_at >= $${params.length - 1}::timestamptz\n`;
            whereSql += `  AND (it.updated_at::timestamptz(3), it.id) > ($${params.length - 1}::timestamptz(3), $${params.length}::uuid)\n`;
        }

        // limit + 1 to detect has_more
        params.push(limit + 1);

        // NOTE: For sync, avoid "NOW()" computed status if you want deterministic data.
        // If your UI needs OVERDUE, client can compute: status == OPEN && due_date < now => OVERDUE.
        // But since your UI query includes it, I’m returning BOTH:
        // - raw_status (original it.status)
        // - computed_status (OVERDUE transformation)
        const sql = `
      SELECT
        it.id,
        it.reference,
        it.issue_date,
        it.from_location_id,
        it.external_location_id,
        it.due_date,
        it.status AS raw_status,
        CASE
          WHEN it.status = 'OPEN' AND it.due_date IS NOT NULL AND it.due_date < NOW() THEN 'OVERDUE'
          ELSE it.status
        END AS computed_status,

        -- From internal location
        lf.path AS from_path,

        -- External destination
        el.company_name AS external_company,
        el.contact_person AS external_contact,
        el.email AS external_email,
        el.phone AS external_phone,

        -- Unified name (for table display)
        el.company_name AS destination_name,

        -- Asset preview (first issue_item)
        a.title AS asset_title,
        a.part_name AS asset_part_name,
        a.id AS asset_id,
        ii_one.note AS issue_note,

        -- Count of assets
        (
          SELECT COUNT(*)::int
          FROM issue_item ii_cnt
          WHERE ii_cnt.transaction_id = it.id
        ) AS asset_count,

        -- Sync fields
        it.created_at,
        it.updated_at

      FROM issue_transaction it
      LEFT JOIN locations lf ON lf.id = it.from_location_id
      LEFT JOIN external_location el ON el.id = it.external_location_id

      -- Pick first item for preview
      LEFT JOIN LATERAL (
        SELECT ii.asset_id, ii.note
        FROM issue_item ii
        WHERE ii.transaction_id = it.id
        ORDER BY ii.created_at ASC
        LIMIT 1
      ) AS ii_one ON TRUE

      LEFT JOIN assets a ON a.id = ii_one.asset_id

      ${whereSql}
      ORDER BY it.updated_at ASC, it.id ASC
      LIMIT $${params.length};
    `;

        const { rows } = await pool.query(sql, params);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const nextCursor =
            hasMore && page.length
                ? encodeCursor({
                    updated_at: page[page.length - 1].updated_at,
                    id: page[page.length - 1].id,
                })
                : null;

        return res.json({
            issues: page,
            returned: page.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            updated_after: updatedAfter,
            synced_at: startedAt.toISOString(),
        });
    } catch (err) {
        console.error('[sync/issues] error', err);
        return res.status(500).json({
            error: 'internal_error',
            message: 'Failed to sync issues',
        });
    }
});


/**
 * GET /sync/movements
 * Delta sync is based on movements.created_at (table has no updated_at).
 *
 * Query params:
 *   - updated_after: ISO timestamp (optional)  -> compared to created_at
 *   - cursor: base64 cursor (optional)
 *   - limit: page size (optional)
 */
router.get('/movements', async (req, res) => {
    const startedAt = new Date();

    try {
        const limitRaw = req.query.limit;
        const limit = Math.min(Math.max(parseInt(limitRaw || '500', 10) || 500, 1), 1000);

        const updatedAfter = parseUpdatedAfter(req.query.updated_after);
        if (updatedAfter === null) {
            return res.status(400).json({
                error: 'invalid_updated_after',
                message: 'updated_after must be a valid ISO date string',
            });
        }

        let cursor = null;
        if (req.query.cursor) {
            try {
                cursor = decodeCursor(String(req.query.cursor));
            } catch (e) {
                return res.status(400).json({
                    error: 'invalid_cursor',
                    message: 'cursor is not valid base64 JSON cursor',
                });
            }
        }

        /**
         * Delta + keyset pagination:
         * WHERE m.created_at > updatedAfter
         * AND (m.created_at, m.id) > (cursor.created_at, cursor.id)  [if cursor]
         * ORDER BY m.created_at ASC, m.id ASC
         * LIMIT limit + 1
         */
        const params = [];
        let whereSql = '';

        // delta filter (created_at because movements have no updated_at)
        params.push(updatedAfter);
        whereSql += `WHERE m.created_at > $${params.length}\n`;

        // keyset cursor filter
        if (cursor) {
            params.push(cursor.created_at);
            params.push(cursor.id);
            whereSql += `  AND m.created_at >= $${params.length - 1}::timestamptz\n`;
            whereSql += `  AND (m.created_at::timestamptz(3), m.id) > ($${params.length - 1}::timestamptz(3), $${params.length}::uuid)\n`;
        }

        // limit + 1 to detect has_more
        params.push(limit + 1);

        const sql = `
      SELECT
        m.id,
        m.asset_id,
        a.title     AS asset_title,
        a.part_name AS asset_part_name,

        m.from_location_id,
        lf.path     AS from_path,

        m.to_location_id,
        lt.path     AS to_path,

        m.external_location_id,

        m.reason,
        m.note,
        m.created_by_user,
        m.ref_type,
        m.ref_id,
        m.reverse_movement_id,

        m.created_at
      FROM movements m
      LEFT JOIN assets    a  ON a.id  = m.asset_id
      LEFT JOIN locations lf ON lf.id = m.from_location_id
      LEFT JOIN locations lt ON lt.id = m.to_location_id
      ${whereSql}
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $${params.length};
    `;

        const { rows } = await pool.query(sql, params);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const nextCursor =
            hasMore && page.length
                ? encodeCursor({
                    created_at: page[page.length - 1].created_at,
                    id: page[page.length - 1].id,
                })
                : null;

        return res.json({
            movements: page,
            returned: page.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            updated_after: updatedAfter, // API contract stays consistent across endpoints
            synced_at: startedAt.toISOString(),
        });
    } catch (err) {
        console.error('[sync/movements] error', err);
        return res.status(500).json({
            error: 'internal_error',
            message: 'Failed to sync movements',
        });
    }
});



/**
 * DELTA SYNC FOR ISSUE OPTIONS ASSETS (keyset pagination)
 *
 * GET /sync/issues/options/assets?updated_after=2026-02-20T09:00:00Z&limit=200&cursor=<base64>
 *
 * Used by frontend to offline issue creation.
 */
router.get('/issues/options/assets', async (req, res) => {
    const startedAt = new Date();

    try {
        const limitRaw = req.query.limit;
        const limit = Math.min(Math.max(parseInt(limitRaw || '500', 10) || 500, 1), 1000);

        const updatedAfter = parseUpdatedAfter(req.query.updated_after);
        if (updatedAfter === null) {
            return res.status(400).json({
                error: 'invalid_updated_after',
                message: 'updated_after must be a valid ISO date string',
            });
        }

        let cursor = null;
        if (req.query.cursor) {
            try {
                cursor = decodeCursor(String(req.query.cursor));
            } catch (e) {
                return res.status(400).json({
                    error: 'invalid_cursor',
                    message: 'cursor is not valid base64 JSON cursor',
                });
            }
        }

        const params = [];
        let whereSql = `WHERE a.is_active = true
            AND NOT EXISTS (
                SELECT 1
                FROM issue_item ii
                JOIN issue_transaction it ON it.id = ii.transaction_id
                WHERE ii.asset_id = a.id
                    AND ii.returned_at IS NULL
                    AND it.status IN ('OPEN','OVERDUE')
            )\n`;

        // 1) delta filter
        params.push(updatedAfter);
        whereSql += `  AND a.updated_at > $${params.length}\n`;

        // 2) keyset cursor filter
        if (cursor) {
            params.push(cursor.updated_at);
            params.push(cursor.id);
            whereSql += `  AND a.updated_at >= $${params.length - 1}::timestamptz\n`;
            whereSql += `  AND (a.updated_at::timestamptz(3), a.id) > ($${params.length - 1}::timestamptz(3), $${params.length}::uuid)\n`;
        }

        // 3) limit (+1 to detect has_more)
        params.push(limit + 1);

        const sql = `
            SELECT
                a.id,
                a.title,
                a.is_active,
                a.part_name,
                a.tag,
                a.barcode,
                a.serial_number,
                a.location_id,
                a.updated_at,
                l.path AS location_path
            FROM assets a
            LEFT JOIN locations l ON l.id = a.location_id
            ${whereSql}
            ORDER BY a.updated_at ASC, a.id ASC
            LIMIT $${params.length};
        `;

        const { rows } = await pool.query(sql, params);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const nextCursor =
            hasMore && page.length
                ? encodeCursor({
                    updated_at: page[page.length - 1].updated_at,
                    id: page[page.length - 1].id,
                })
                : null;

        // Return the exact same shape as /issues/options/assets + sync metadata
        return res.json({
            items: page,
            returned: page.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            updated_after: updatedAfter,
            synced_at: startedAt.toISOString(),
        });
    } catch (err) {
        console.error('[sync] /issues/options/assets error:', err);
        return res.status(500).json({
            error: 'internal_error',
            message: 'Failed to sync issue options assets',
        });
    }
});
export default router;