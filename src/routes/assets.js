/**
 * Assets API (global search + dynamic custom keys)
 * ------------------------------------------------
 * MOUNTED AT: /assets
 *
 * GET /assets
 *   ?q=...        (generic search across fixed fields + location path + attributes)
 *   ?page=1       (1-based)
 *   ?pageSize=25
 *
 * Response:
 * {
 *   columns: string[],           // fixed + all distinct custom keys
 *   rows: Array<Record<string,any>>, // a page of results (fixed + attributes spread)
 *   total: number
 * }
 */

import express from 'express';
import { pool } from '../db.js';
import ImportService from '../services/importService.js';
import { auditSafe } from '../services/audit.js';
import { sendNotificationIfEnabled } from '../services/emailNotificationHelper.js';
import { getLocationSnapshot } from '../services/locationSnapshots.js';
import QueryStream from 'pg-query-stream';
import { Transform } from 'stream';
import { createIdempotencyMiddleware } from "../middleware/idempotency.js";


const { ensureLocationPath } = ImportService;
const router = express.Router();
const idempotency = createIdempotencyMiddleware(pool);

router.get('/ok', (_req, res) => res.json({ ok: true, scope: 'assets' }));


/** Fixed columns we always expose */
const FIXED_COLUMNS = [
  'barcode',
  'title',
  'status',
  'is_active',
  'location_path',
  'serial_number',
  'category',
  'tag',
  'company_asset_id',
  'part_name',
  'part_description',
  'type',
  'work_order_number',
  'attributes', // raw JSONB (for completeness)
];

/** Build WHERE clause + params for generic search */
function buildSearchWhere(q, params) {
  if (!q) return { whereSql: '', params };

  const needle = String(q).slice(0, 200);
  params.push(`%${needle}%`);
  const p = `$${params.length}`;

  const whereSql = `
    WHERE
      a.barcode ILIKE ${p} OR
      a.title ILIKE ${p} OR
      a.status ILIKE ${p} OR
      a.is_active ILIKE ${p} OR
      a.serial_number ILIKE ${p} OR
      a.category ILIKE ${p} OR
      a.tag ILIKE ${p} OR
      a.company_asset_id ILIKE ${p} OR
      a.part_name ILIKE ${p} OR
      a.part_description ILIKE ${p} OR
      a.type ILIKE ${p} OR
      a.work_order_number ILIKE ${p} OR
      COALESCE(l.path, '') ILIKE ${p} OR
      EXISTS (
        SELECT 1
        FROM jsonb_each_text(a.attributes) AS kv(k, v)
        WHERE v ILIKE ${p}
      )
  `;
  return { whereSql, params };
}

/** Collect all distinct attribute keys for the current filter */
async function getDistinctAttributeKeys(client, q) {
  let params = [];
  const { whereSql, params: whereParams } = buildSearchWhere(q, params);
  params = whereParams;

  const sql = `
    WITH keys AS (
      SELECT jsonb_object_keys(a.attributes) AS k
      FROM assets a
      LEFT JOIN locations l ON l.id = a.location_id
      ${whereSql}
    )
    SELECT DISTINCT k AS key
    FROM keys
    WHERE k IS NOT NULL
    ORDER BY key ASC
  `;

  const { rows } = await client.query(sql, params);
  return rows.map(r => r.key);
}


// CSV helpers (safe escaping)
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}


function buildWhereAndParams(filters = {}) {
  const params = [];
  const where = [];

  // 🔍 Free-text search
  if (filters.q && filters.q.trim()) {
    params.push(`%${filters.q.trim()}%`);
    const p = `$${params.length}`;
    where.push(`
      (
        a.title ILIKE ${p}
        OR a.barcode ILIKE ${p}
        OR a.serial_number ILIKE ${p}
        OR a.tag ILIKE ${p}
        OR a.company_asset_id ILIKE ${p}
        OR a.part_name ILIKE ${p}
        OR a.part_description ILIKE ${p}
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(a.attributes)
          WHERE value ILIKE ${p}
        )
      )
    `);
  }

  // Optional filters
  if (filters.status && filters.status.trim()) {
    params.push(filters.status.trim());
    where.push(`a.status = $${params.length}`);
  }
  if (filters.category && filters.category.trim()) {
    params.push(filters.category.trim());
    where.push(`a.category = $${params.length}`);
  }
  if (filters.type && filters.type.trim()) {
    params.push(filters.type.trim());
    where.push(`a.type = $${params.length}`);
  }
  if (filters.locationId && filters.locationId.trim()) {
    params.push(filters.locationId.trim());
    where.push(`a.location_id = $${params.length}`);
  }
  if (filters.isActive !== undefined && filters.isActive !== '') {
    params.push(filters.isActive === 'true');
    where.push(`a.is_active = $${params.length}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

// Export CSV (streaming)
router.post('/export-csv', async (req, res) => {
  const client = await pool.connect(); // dedicated client for streaming

  try {
    const { filters = {} } = req.body || {};

    const { whereSql, params } = buildWhereAndParams(filters);

    const sql = `
      SELECT
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
        COALESCE(l.path, el.company_name, '—') AS location_path,
        CASE
          WHEN a.location_id IS NOT NULL THEN 'internal'
          WHEN el.id IS NOT NULL THEN 'external'
          ELSE 'unknown'
        END AS location_type,
        el.company_name     AS external_company_name,
        el.contact_person   AS external_contact_person,
        el.email            AS external_email,
        el.phone            AS external_phone,
        el.address_line1,
        el.address_line2,
        el.notes            AS external_notes
      FROM assets a
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN issue_item ii ON ii.asset_id = a.id AND ii.status = 'ISSUED'
      LEFT JOIN issue_transaction it ON it.id = ii.transaction_id
      LEFT JOIN external_location el ON el.id = it.external_location_id
      ${whereSql}
      ORDER BY a.created_at DESC NULLS LAST, a.id DESC
    `;

    // CSV headers
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="assets-${ts}.csv"`);
    res.setHeader('Cache-Control', 'no-store');

    const queryStream = new QueryStream(sql, params, { highWaterMark: 1000 });
    const dbStream = client.query(queryStream);

    let headerWritten = false;
    let headers = [];

    const csvTransform = new Transform({
      objectMode: true,
      transform(row, _enc, cb) {
        try {
          if (!headerWritten) {
            headers = Object.keys(row);
            this.push(headers.map(csvEscape).join(',') + '\n');
            headerWritten = true;
          }

          const line = headers.map(h => csvEscape(row[h])).join(',') + '\n';
          this.push(line);
          cb();
        } catch (e) {
          cb(e);
        }
      }
    });

    dbStream.on('error', (err) => {
      console.error('[export-csv db error]', err);
      res.end();
    });

    csvTransform.on('error', (err) => {
      console.error('[export-csv transform error]', err);
      res.end();
    });

    dbStream.pipe(csvTransform).pipe(res);

  } catch (err) {
    console.error('[POST /assets/export-csv]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'CSV export failed' });
    }
  } finally {
    client.release();
  }
});



// routes/assets/status-options.js
router.get('/status-options', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT status
      FROM assets
      WHERE status IS NOT NULL
      ORDER BY status ASC
    `);

    const statuses = rows.map(r => r.status);
    res.json({ statuses });
  } catch (e) {
    console.error('[GET /assets/status-options] failed:', e);
    res.status(500).json({ error: 'Failed to load asset statuses' });
  }
});

router.get('/filters', async (req, res) => {
  try {
    const [statuses, categories, types, locations] = await Promise.all([
      pool.query(`SELECT DISTINCT status FROM assets WHERE status IS NOT NULL ORDER BY status`),
      pool.query(`SELECT DISTINCT category FROM assets WHERE category IS NOT NULL ORDER BY category`),
      pool.query(`SELECT DISTINCT type FROM assets WHERE type IS NOT NULL ORDER BY type`),
      pool.query(`SELECT id, path FROM locations ORDER BY path`)
    ]);

    res.json({
      statuses: statuses.rows.map(r => r.status),
      categories: categories.rows.map(r => r.category),
      types: types.rows.map(r => r.type),
      locations: locations.rows
    });
  } catch (e) {
    console.error('[GET /assets/filters] failed:', e);
    res.status(500).json({ error: 'Failed to load filters' });
  }
});


// POST /assets/search
router.post('/search', async (req, res) => {
  try {
    const { page = 1, pageSize = 25, filters = {} } = req.body;

    const offset = (page - 1) * pageSize;
    const params = [];
    const where = [];

    // 🔍 Free-text search
    if (filters.q && filters.q.trim()) {
      params.push(`%${filters.q.trim()}%`);
      const p = `$${params.length}`;
      where.push(`
        (
          a.title ILIKE ${p}
          OR a.barcode ILIKE ${p}
          OR a.serial_number ILIKE ${p}
          OR a.tag ILIKE ${p}
          OR a.company_asset_id ILIKE ${p}
          OR a.part_name ILIKE ${p}
          OR a.part_description ILIKE ${p}
          OR EXISTS (
            SELECT 1 FROM jsonb_each_text(a.attributes)
            WHERE value ILIKE ${p}
          )
        )
      `);
    }

    // 🧩 Optional filters
    if (filters.status && filters.status.trim()) {
      params.push(filters.status.trim());
      where.push(`a.status = $${params.length}`);
    }
    if (filters.category && filters.category.trim()) {
      params.push(filters.category.trim());
      where.push(`a.category = $${params.length}`);
    }
    if (filters.type && filters.type.trim()) {
      params.push(filters.type.trim());
      where.push(`a.type = $${params.length}`);
    }
    if (filters.locationId && filters.locationId.trim()) {
      params.push(filters.locationId.trim());
      where.push(`a.location_id = $${params.length}`);
    }
    if (filters.isActive !== undefined && filters.isActive !== '') {
      params.push(filters.isActive === 'true');
      where.push(`a.is_active = $${params.length}`);
    }

    // ✅ SAFE: only add WHERE if we actually have conditions
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // 🧮 Count query
    const totalSql = `SELECT COUNT(*)::int AS cnt FROM assets a ${whereSql}`;
    //console.log('[DEBUG totalSql]', totalSql, params);
    const totalRes = await pool.query(totalSql, params);
    const total = totalRes.rows?.[0]?.cnt || 0;

    // 📦 Paginated list
    params.push(pageSize);
    params.push(offset);

    // const listSql = `
    //   SELECT
    //     a.barcode,
    //     a.title,
    //     COALESCE(l.path, '') AS location_path,
    //     a.is_active,
    //     a.status,
    //     a.serial_number,
    //     a.category,
    //     a.tag,
    //     a.company_asset_id,
    //     a.part_name,
    //     a.part_description,
    //     a.type,
    //     a.work_order_number,
    //     a.attributes
    //   FROM assets a
    //   LEFT JOIN locations l ON l.id = a.location_id
    //   ${whereSql}
    //   ORDER BY a.created_at DESC
    //   LIMIT $${params.length - 1} OFFSET $${params.length};
    // `;
    const listSql = `
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
          COALESCE(l.path, el.company_name, '—') AS location_path,
          CASE
            WHEN a.location_id IS NOT NULL THEN 'internal'
            WHEN el.id IS NOT NULL THEN 'external'
            ELSE 'unknown'
          END AS location_type,

          -- ✅ External Location Snapshot (only when asset is ISSUED)
          el.id               AS external_location_id,
          el.company_name     AS external_company_name,
          el.contact_person     AS external_contact_person,
          el.email    AS external_email,
          el.phone    AS external_phone,
          el.address_line1          AS address_line1,
          el.address_line2          AS address_line2,
          el.notes            AS external_notes

        FROM assets a
        LEFT JOIN locations l ON l.id = a.location_id
        LEFT JOIN issue_item ii ON ii.asset_id = a.id AND ii.status = 'ISSUED'
        LEFT JOIN issue_transaction it ON it.id = ii.transaction_id
        LEFT JOIN external_location el ON el.id = it.external_location_id
        ${whereSql}
        ORDER BY a.created_at DESC NULLS LAST, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length};
      `;


    //console.log('[DEBUG listSql]', listSql, params);
    const listRes = await pool.query(listSql, params);

    res.json({
      rows: listRes.rows,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    console.error('[POST /assets/search] failed:', err);
    res.status(500).json({ error: 'Failed to search assets' });
  }
});





/** LIST (mounted at /assets) */
/**
 * 
If assets.location_id is NULL, it means the asset is currently issued externally.

So, find its current external location by looking up:

issue_item.asset_id = assets.id

Join to issue_transaction → get external_location_id (and resolve the company name).

If neither location_id (internal) nor external mapping exists, mark the asset as inactive
 */

router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const offset = (page - 1) * pageSize;
  const q = (req.query.q || '').toString().trim();

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // so we can safely audit any state corrections

    let params = [];
    const { whereSql, params: whereParams } = buildSearchWhere(q, params);
    params = whereParams;

    // 1️⃣ total count
    const countSql = `
      SELECT COUNT(*) AS c
      FROM assets a
      LEFT JOIN locations l ON l.id = a.location_id
      ${whereSql}
    `;
    const { rows: countRows } = await client.query(countSql, params);
    const total = parseInt(countRows[0]?.c || '0', 10);

    // 2️⃣ gather all distinct custom attribute keys
    const customKeys = await getDistinctAttributeKeys(client, q);

    // 3️⃣ main data query — smartly resolve internal / external location
    params = [];
    const where2 = buildSearchWhere(q, params);
    params = where2.params;
    params.push(pageSize);
    params.push(offset);

    const listSql = `
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
          a.attributes,

          -- ✅ External Location Snapshot (when issued externally)
          el.id               AS external_location_id,
          el.company_name     AS external_company_name,
          el.contact_person     AS external_contact_person,
          el.email            AS external_email,
          el.phone            AS external_phone,
          el.address_line1          AS external_address_line1,
          el.address_line2          AS external_address_line2,
          el.notes            AS external_notes

        FROM assets a
        LEFT JOIN locations l ON l.id = a.location_id
        LEFT JOIN issue_item ii ON ii.asset_id = a.id AND ii.status = 'ISSUED'
        LEFT JOIN issue_transaction it ON it.id = ii.transaction_id
        LEFT JOIN external_location el ON el.id = it.external_location_id
        ${where2.whereSql}
        ORDER BY a.created_at DESC NULLS LAST, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await client.query(listSql, params);


    // 4️⃣ Auto-mark inactive if asset has neither internal nor external location
    //    ✅ BUT skip those whose status = 'ISSUED'
    const orphanIds = rows
      .filter(r =>
        !r.location_id &&
        r.location_type === 'unknown' &&
        (!r.status || r.status.toUpperCase() !== 'ISSUED')
      )
      .map(r => r.id);

    if (orphanIds.length > 0) {
      for (const assetId of orphanIds) {
        await client.query(
          `UPDATE assets
       SET is_active = false, updated_at = now()
       WHERE id = $1`,
          [assetId]
        );

        await auditSafe(client, {
          action: 'ASSET_MARK_INACTIVE',
          entity_type: 'asset',
          entity_id: assetId,
          actor_email: req.user?.email || 'system@auto',
          summary: 'Asset marked inactive because no valid internal or external location found (non-issued)',
          after_data: { is_active: false }
        });
      }
    }

    // 5️⃣ Shape final response
    const shaped = rows.map(r => {
      const base = {
        //id: r.id,
        barcode: r.barcode,
        title: r.title,
        is_active: r.is_active,
        status: r.status,
        location_path: r.location_path,
        location_type: r.location_type,
        serial_number: r.serial_number,
        category: r.category,
        tag: r.tag,
        company_asset_id: r.company_asset_id,
        part_name: r.part_name,
        part_description: r.part_description,
        type: r.type,
        work_order_number: r.work_order_number,

        // ✅ Add external location snapshot if present
        external_location: r.external_location_id
          ? {
            //id: r.external_location_id,
            company_name: r.external_company_name,
            contact_person: r.external_person,
            email: r.external_email,
            contact_phone: r.external_phone,
            address1: r.external_address_line1,
            address2: r.external_address_line2,
            notes: r.external_notes,
          }
          : null,
        //attributes: r.attributes || {},
      };

      const attrs = r.attributes || {};
      customKeys.forEach(k => {
        base[k] = attrs[k] ?? null;
      });

      return base;
    });


    const columns = [...FIXED_COLUMNS, ...customKeys];

    await client.query('COMMIT');
    res.json({ columns, rows: shaped, total });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[assets] list failed:', err);
    res.status(500).json({ error: 'Failed to load assets' });
  } finally {
    client.release();
  }
});
//Old logic with internal location
// router.get('/', async (req, res) => {
//   const page = Math.max(1, parseInt(req.query.page, 10) || 1);
//   const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
//   const offset = (page - 1) * pageSize;
//   const q = (req.query.q || '').toString().trim();

//   const client = await pool.connect();
//   try {
//     // total count with filter
//     let params = [];
//     const { whereSql, params: whereParams } = buildSearchWhere(q, params);
//     params = whereParams;

//     const countSql = `
//       SELECT COUNT(*) AS c
//       FROM assets a
//       LEFT JOIN locations l ON l.id = a.location_id
//       ${whereSql}
//     `;
//     const { rows: countRows } = await client.query(countSql, params);
//     const total = parseInt(countRows[0]?.c || '0', 10);

//     // gather all distinct custom keys for the current filter
//     const customKeys = await getDistinctAttributeKeys(client, q);

//     // page of rows
//     params = [];
//     const where2 = buildSearchWhere(q, params);
//     params = where2.params;
//     params.push(pageSize);
//     params.push(offset);

//     const listSql = `
//       SELECT
//         a.id,
//         a.barcode,
//         a.title,
//         a.is_active,
//         a.status,
//         a.serial_number,
//         a.category,
//         a.tag,
//         a.company_asset_id,
//         a.part_name,
//         a.part_description,
//         a.type,
//         a.work_order_number,
//         COALESCE(l.path, '') AS location_path,
//         a.attributes
//       FROM assets a
//       LEFT JOIN locations l ON l.id = a.location_id
//       ${where2.whereSql}
//       ORDER BY a.created_at DESC NULLS LAST, a.id DESC
//       LIMIT $${params.length - 1} OFFSET $${params.length}
//     `;

//     const { rows } = await client.query(listSql, params);

//     // spread attributes into row shape
//     const shaped = rows.map(r => {
//       const base = {
//         barcode: r.barcode,
//         title: r.title,
//         is_active: r.is_active,
//         status: r.status,
//         location_path: r.location_path,
//         serial_number: r.serial_number,
//         category: r.category,
//         tag: r.tag,
//         company_asset_id: r.company_asset_id,
//         part_name: r.part_name,
//         part_description: r.part_description,
//         type: r.type,
//         work_order_number: r.work_order_number,
//         attributes: r.attributes || {},
//       };

//       // add custom keys so they render as columns
//       const attrs = r.attributes || {};
//       customKeys.forEach(k => {
//         base[k] = attrs[k] ?? null;
//       });

//       return base;
//     });

//     const columns = [...FIXED_COLUMNS, ...customKeys];

//     res.json({ columns, rows: shaped, total });
//   } catch (err) {
//     console.error('[assets] list failed:', err);
//     res.status(500).json({ error: 'Failed to load assets' });
//   } finally {
//     client.release();
//   }
// });


/**
 * GET /assets/:barcode
 * Returns one asset by barcode (with location_path and attributes)
 */
router.get('/:barcode', async (req, res) => {
  const { barcode } = req.params;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        a.id,
        a.barcode,
        a.title,
        a.status,
        a.serial_number,
        a.category,
        a.tag,
        a.company_asset_id,
        a.part_name,
        a.part_description,
        a.type,
        a.work_order_number,
        a.is_active,
        a.created_at,
        a.updated_at,
        a.attributes,                 -- jsonb
        l.path AS location_path
      FROM assets a
      LEFT JOIN locations l ON l.id = a.location_id
      WHERE a.barcode = $1
      LIMIT 1
      `,
      [barcode]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const r = rows[0];

    // normalize a little for FE parity with list response
    const item = {
      id: r.id,
      barcode: r.barcode,
      title: r.title,
      status: r.status,
      location_path: r.location_path || '',
      serial_number: r.serial_number,
      category: r.category,
      tag: r.tag,
      company_asset_id: r.company_asset_id,
      part_name: r.part_name,
      part_description: r.part_description,
      type: r.type,
      work_order_number: r.work_order_number,
      is_active: r.is_active,
      attributes: r.attributes || {},          // ensure object
      created_at: r.created_at,
      updated_at: r.updated_at,
    };

    // ⬇️ NEW: fetch movement history for this asset
    // const { rows: mrows } = await pool.query(
    //   `
    //   SELECT
    //     m.id,
    //     m.reason,                     -- 'INTERNAL','ISSUE','RETURN','ISSUE_VOID','BULK_IMPORT',...
    //     m.note,
    //     m.created_at,
    //     m.created_by_user,
    //     lf.path AS from_path,
    //     lt.path AS to_path
    //   FROM movements m
    //   LEFT JOIN locations lf ON lf.id = m.from_location_id
    //   LEFT JOIN locations lt ON lt.id = m.to_location_id
    //   WHERE m.asset_id = $1
    //   ORDER BY m.created_at DESC
    //   LIMIT 200
    //   `,
    //   [r.id]
    // );

    // ✅ Fetch ALL movement history for a given asset (accurate version)
    const { rows: mrows } = await pool.query(`
           SELECT
            m.id,
            m.reason,
            m.note,
            m.created_at,
            m.created_by_user,
            a.title AS asset_title,
            a.part_name AS asset_part_name,
            lf.path AS from_path,
            lt.path AS to_path
          FROM movements m
          LEFT JOIN assets a ON a.id = m.asset_id
          LEFT JOIN locations lf ON lf.id = m.from_location_id
          LEFT JOIN locations lt ON lt.id = m.to_location_id
          WHERE m.asset_id = $1
          ORDER BY m.created_at DESC
          LIMIT 200
        `,
      [r.id]); // or [r.id] depending on your variable

    // console.log('==== movments ====');
    // console.log(mrows);

    item.movements = mrows.map(m => ({
      id: m.id,
      reason: m.reason,          // keep original; map to label in FE if you want
      note: m.note || '',
      when: m.created_at,
      from: m.from_path || '',
      to: m.to_path || '',
      by: m.created_by_user || '',
    }));


    return res.json({ item });
  } catch (err) {
    console.error('[GET /assets/:barcode] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** Normalize/clean attribute payload keys and values */
function normalizeAttrs(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;

  for (const [k, v] of Object.entries(obj)) {
    // clean up key: trim, replace spaces with _, strip non-alphanumeric
    const key = String(k || '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^\w.-]/g, '')
      .slice(0, 64);
    if (!key) continue;

    // clean up value
    out[key] = (typeof v === 'string') ? v.trim() : v;
  }

  return out;
}


/* ------------------------------------------------------------- */
/* PUT /assets/:barcode                                          */
/* Partial updates:
 * - location_path (resolves/creates; logs movement on change)
 * - fixed columns
 * - attributes:
 *     * default "merge" (add/update keys)
 *     * "replace" via ?attrs_mode=replace or body.attrs_mode = 'replace'
 *     * delete keys by sending null or '' for that key
 */
/* ------------------------------------------------------------- */
// PUT /assets/:barcode
router.put('/:barcode', idempotency, async (req, res) => {
  const barcode = String(req.params.barcode || '').trim();
  if (!barcode) return res.status(400).json({ error: 'Missing barcode' });

  // who is performing the change (front-end sends this header)
  const userEmail = (req.headers['x-user-email'] || req.headers['X-User-Email'] || '').toString().trim() || null;

  // accepted payload
  const payload = req.body || {};
  const attrsMode = (payload.attrsMode || 'merge').toLowerCase(); // 'merge' | 'replace' | 'patch'
  const removeKeys = Array.isArray(payload.removeKeys) ? payload.removeKeys : [];


  // small helper: clean/normalize attribute object
  const normalizeAttrs = (obj) => {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^\w.-]/g, '')
        .slice(0, 64);
      if (!key) continue;
      out[key] = (typeof v === 'string') ? v.trim() : v;
    }
    return out;
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // fetch current asset (id, location, attributes)
    const prev = await client.query(
      `SELECT a.id, a.location_id, a.attributes, a.is_active
         FROM assets a
        WHERE a.barcode = $1
        LIMIT 1`,
      [barcode]
    );
    if (!prev.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }

    const assetId = prev.rows[0].id;
    const prevLocId = prev.rows[0].location_id;
    const prevAttrs = prev.rows[0].attributes || {};

    // 1) resolve/ensure location if caller provided location_path (could be null to clear)
    let newLocId = prevLocId;
    if (payload.location_path !== undefined) {
      if (payload.location_path === null || String(payload.location_path).trim() === '') {
        newLocId = null; // clear
      } else {
        const { id } = await ensureLocationPath(client, payload.location_path);
        newLocId = id; // never null here
      }
    }

    // 2) compute next attributes if caller touched attributes or removeKeys
    let nextAttributes = undefined; // undefined => don't touch column
    if (payload.attributes !== undefined || removeKeys.length) {
      const incoming = normalizeAttrs(payload.attributes || {});
      if (attrsMode === 'replace') {
        nextAttributes = { ...incoming };
      } else if (attrsMode === 'patch') {
        // add keys that don't exist; don't overwrite existing keys
        nextAttributes = { ...prevAttrs };
        for (const [k, v] of Object.entries(incoming)) {
          if (!(k in nextAttributes)) nextAttributes[k] = v;
        }
      } else {
        // merge (default): overwrite/insert provided keys
        nextAttributes = { ...prevAttrs, ...incoming };
      }
      // deletions
      for (const k of removeKeys) delete nextAttributes[k];
    }

    // 3) build dynamic UPDATE
    const sets = [];
    const params = [];

    const add = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (payload.title !== undefined) add('title', payload.title);
    if (payload.status !== undefined) add('status', payload.status);
    if (payload.serial_number !== undefined) add('serial_number', payload.serial_number);
    if (payload.category !== undefined) add('category', payload.category);
    if (payload.tag !== undefined) add('tag', payload.tag);
    if (payload.company_asset_id !== undefined) add('company_asset_id', payload.company_asset_id);
    if (payload.part_name !== undefined) add('part_name', payload.part_name);
    if (payload.part_description !== undefined) add('part_description', payload.part_description);
    if (payload.type !== undefined) add('type', payload.type);
    if (payload.work_order_number !== undefined) add('work_order_number', payload.work_order_number);
    if (payload.is_active !== undefined) add('is_active', payload.is_active);

    // location
    if (payload.location_path !== undefined) add('location_id', newLocId);

    // attributes (jsonb)
    if (nextAttributes !== undefined) add('attributes', nextAttributes);

    // audit columns
    add('updated_at', new Date());
    if (userEmail) add('updated_by_user', userEmail);

    // WHERE barcode
    params.push(barcode);

    if (sets.length) {
      await client.query(
        `UPDATE assets
            SET ${sets.join(', ')}
          WHERE barcode = $${params.length}`,
        params
      );
    }

    // 4) movement log if location changed
    if (payload.location_path !== undefined && prevLocId !== newLocId) {
      await client.query(
        `INSERT INTO movements (asset_id, from_location_id, to_location_id, reason, note, created_at, created_by_user)
         VALUES ($1, $2, $3, $4, $5, now(), $6)`,
        [
          assetId,
          prevLocId,
          newLocId,
          'manual-edit',
          'Location changed via asset edit',
          userEmail || null
        ]
      );
    }

    // 5) return updated snapshot
    const { rows } = await client.query(
      `SELECT a.id,
              a.barcode,
              a.title,
              a.status,
              a.serial_number,
              a.category,
              a.tag,
              a.company_asset_id,
              a.part_name,
              a.part_description,
              a.type,
              a.work_order_number,
              a.location_id,
              COALESCE(l.path, NULL) AS location_path,
              a.attributes,
              a.updated_at,
              a.updated_by_user
         FROM assets a
         LEFT JOIN locations l ON l.id = a.location_id
        WHERE a.barcode = $1
        LIMIT 1`,
      [barcode]
    );

    const before = prev.rows[0];
    const after = payload;
    let eventType = '';

    // Detect if is_active is changed
    if (before?.is_active !== undefined && before?.is_active !== after.is_active) {
      if (after?.is_active === false) {
        eventType = 'DEACTIVATE';
      } else if (after?.is_active === true) {
        eventType = 'ACTIVATED'
      }
    }


    //Audit table
    await auditSafe(client, {
      actor_email: userEmail,
      action: eventType === 'ACTIVATED' ? 'ASSET_UPDATE' : 'ASSET_DEACTIVATE',
      entity_type: 'asset',
      entity_id: rows[0].id,
      summary: `Updated asset "${payload.title}"`,
      before_data: before,
      after_data: after,
    });

    if (eventType === 'ACTIVATED') {
      // 🔔 Send email if enabled
      await sendNotificationIfEnabled(
        "ASSET_EDIT",
        `Asset Updated: ${payload.title}`,
        `<p>Asset updated by user ${userEmail}</p>`
      );
    } else if (eventType === 'DEACTIVATE') {
      // 🔔 Send email if enabled
      await sendNotificationIfEnabled(
        "ASSET_DEACTIVATE",
        `Asset Deactivate: ${payload.title}`,
        `<p>Asset Deactivated by user ${userEmail}</p>`
      );
    }



    await client.query('COMMIT');
    return res.json({ ok: true, item: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PUT /assets/:barcode] failed:', err);
    return res.status(500).json({ error: 'Update failed', detail: err.message });
  } finally {
    client.release();
  }
});


/* -----------------------------------------------
 * POST /assets
 * Body (only provided fields are used):
 * {
 *   barcode: string (required),
 *   title?, status?, serial_number?, category?, tag?,
 *   company_asset_id?, part_name?, part_description?, type?,
 *   work_order_number?, location_path?, attributes?: object
 * }
 * Headers:
 *   X-User-Email: <email> (optional; used as created_by_user)
 * ----------------------------------------------- */
router.post('/', idempotency, async (req, res) => {
  const payload = req.body || {};
  const userEmail = (req.get('x-user-email') || '').trim() || null;

  // console.log('Payload', payload);
  // console.log('userEmail', userEmail);

  // Basic validation
  const barcode = (payload.barcode || '').toString().trim();
  if (!barcode) {
    return res.status(400).json({ error: 'barcode is required' });
  }

  // Clean helper
  const clean = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') {
      const s = v.replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, '').trim();
      return s === '' ? null : s;
    }
    return v;
  };

  // Normalize attributes to a plain object (or null)
  const normalizeAttrs = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^\w.-]/g, '')
        .toLowerCase();
      if (key) {
        const val = typeof v === 'string' ? v.trim() : v;
        if (val !== '' && val !== undefined) out[key] = val;
      }
    }
    return Object.keys(out).length ? out : null;
  };

  const fields = {
    title: clean(payload.title),
    status: clean(payload.status),
    serial_number: clean(payload.serial_number),
    category: clean(payload.category),
    tag: clean(payload.tag),
    company_asset_id: clean(payload.company_asset_id),
    part_name: clean(payload.part_name),
    part_description: clean(payload.part_description),
    type: clean(payload.type),
    work_order_number: clean(payload.work_order_number),
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fail if barcode already exists
    const exists = await client.query(
      'SELECT id, location_id FROM assets WHERE barcode = $1 LIMIT 1',
      [barcode]
    );
    if (exists.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'asset with this barcode already exists' });
    }

    // Resolve/ensure location (optional)
    let locationId = null;
    const locationPath = clean(payload.location_path);
    if (locationPath) {
      const { id } = await ensureLocationPath(client, locationPath);
      locationId = id || null;
    }

    // Attributes (JSONB)
    const attributes = normalizeAttrs(payload.attributes);

    // Insert asset
    const cols = [
      'barcode',
      'title',
      'status',
      'serial_number',
      'category',
      'tag',
      'company_asset_id',
      'part_name',
      'part_description',
      'type',
      'work_order_number',
      'location_id',
      'attributes',
      'created_at',
      'updated_at',
      'created_by_user',
      'updated_by_user',
    ];
    const vals = [
      barcode,
      fields.title,
      fields.status,
      fields.serial_number,
      fields.category,
      fields.tag,
      fields.company_asset_id,
      fields.part_name,
      fields.part_description,
      fields.type,
      fields.work_order_number,
      locationId,
      attributes, // jsonb
      new Date(),
      new Date(),
      userEmail,
      userEmail,
    ];

    const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
    const insertSql = `INSERT INTO assets (${cols.join(',')})
                       VALUES (${placeholders})
                       RETURNING id, location_id`;
    const ins = await client.query(insertSql, vals);
    const assetId = ins.rows[0].id;

    // Movement (null -> location) if we got a location
    if (locationId) {
      await client.query(
        `INSERT INTO movements
         (asset_id, from_location_id, to_location_id, reason, note, created_by_user, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [assetId, null, locationId, 'create', 'created from API', userEmail]
      );
    }

    // Return created record with location_path + attributes
    const { rows } = await client.query(
      `SELECT a.id,
              a.barcode,
              a.title,
              a.status,
              a.serial_number,
              a.category,
              a.tag,
              a.company_asset_id,
              a.part_name,
              a.part_description,
              a.type,
              a.work_order_number,
              a.location_id,
              COALESCE(l.path, '') AS location_path,
              COALESCE(a.attributes, '{}'::jsonb) AS attributes,
              a.created_at,
              a.updated_at,
              a.created_by_user,
              a.updated_by_user
       FROM assets a
       LEFT JOIN locations l ON l.id = a.location_id
       WHERE a.id = $1`,
      [assetId]
    );

    const assetAuditPaylod = rows[0];


    //Audit table
    await auditSafe(pool, {
      actor_email: userEmail,
      action: 'ASSET_CREATE',
      entity_type: 'asset',
      entity_id: rows[0].id,
      summary: `Created new asset "${rows[0].title}"`,
      after_data: { assetAuditPaylod, userEmail },
    });

    // 🔔 Send email if enabled
    await sendNotificationIfEnabled(
      "ASSET_CREATE",
      `New Asset Created: ${rows[0].title}`,
      `<p>Asset <b>${rows[0].title}</b> (Barcode: ${rows[0].barcode}) has been created successfully.</p>`
    );




    await client.query('COMMIT');
    return res.status(201).json({ item: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /assets] failed:', err);
    return res.status(500).json({ error: 'Create failed', detail: err.message });
  } finally {
    client.release();
  }
});






export default router;
