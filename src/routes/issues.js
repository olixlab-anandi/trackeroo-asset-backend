import express from 'express';
import { pool } from '../db.js';
import { auditSafe } from '../services/audit.js';
import { getIssueItemSnapshot } from '../services/issueSnapshots.js';
import { sendNotificationIfEnabled } from '../services/emailNotificationHelper.js';
import QueryStream from 'pg-query-stream';
import { createIdempotencyMiddleware } from "../middleware/idempotency.js";

const router = express.Router();
const idempotency = createIdempotencyMiddleware(pool);


// CSV helpers
function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function toCsvLine(row, columns) {
    return columns.map((c) => csvEscape(row[c])).join(',') + '\n';
}



/* Helpers */
async function getLocationsBySearch(q) {
    const { rows } = await pool.query(
        `SELECT id, name, path
       FROM locations
      WHERE active = true
        AND (name ILIKE $1 OR path ILIKE $1)
      ORDER BY path ASC
      LIMIT 50`,
        [`%${q}%`]
    );
    return rows;
}

async function getAssetsBySearch(q) {
    const { rows } = await pool.query(
        `SELECT a.id, a.name, a.asset_tag, a.location_id, l.path AS location_path
       FROM assets a
       LEFT JOIN locations l ON l.id = a.location_id
      WHERE (a.asset_tag ILIKE $1 OR a.name ILIKE $1)
      ORDER BY a.asset_tag NULLS LAST, a.name
      LIMIT 100`,
        [`%${q}%`]
    );
    return rows;
}

/* ---------- options for selectors ---------- */
router.get('/options/locations', async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    try {
        const items = await getLocationsBySearch(q);
        res.json({ items });
    } catch (e) {
        console.error('[GET /issues/options/locations] failed:', e);
        res.status(500).json({ error: 'Failed to load locations' });
    }
});


// routes/issues.js → /issues/options/assets
// GET /issues/options/assets?q=<search>&limit=100
router.get('/options/assets', async (req, res) => {
    const qRaw = (req.query.q || '').toString().trim();
    const limit = Math.min(200, Number(req.query.limit || 100));

    // Build SQL dynamically so we don't send an untyped '' to $1 (fixes 42P18).
    // Also guard out assets currently issued (no return yet, transaction OPEN/OVERDUE).
    let sql = `
    SELECT
      a.id,
      a.title,
      a.is_active,
      a.part_name,
      a.tag,
      a.barcode,
      a.serial_number,
      a.location_id,
      l.path AS location_path
    FROM assets a
    LEFT JOIN locations l ON l.id = a.location_id
    WHERE a.is_active = true
    AND NOT EXISTS (
      SELECT 1
      FROM issue_item ii
      JOIN issue_transaction it ON it.id = ii.transaction_id
      WHERE ii.asset_id = a.id
        AND ii.returned_at IS NULL
        AND it.status IN ('OPEN','OVERDUE')
    )
  `;

    const params = [];

    if (qRaw) {
        params.push(`%${qRaw}%`);
        sql += `
      AND (
           a.title         ILIKE $${params.length}
        OR a.part_name     ILIKE $${params.length}
        OR a.tag           ILIKE $${params.length}
        OR a.barcode       ILIKE $${params.length}
        OR a.serial_number ILIKE $${params.length}
        OR l.path          ILIKE $${params.length}
      )
    `;
    }

    // Sort by a friendly name, then ID as tie-breaker
    sql += `
    ORDER BY COALESCE(NULLIF(a.title, ''), NULLIF(a.part_name, ''), a.tag, a.barcode, a.serial_number) ASC, a.id ASC
    LIMIT $${params.length + 1}
  `;
    params.push(limit);

    try {
        const t0 = Date.now();
        const { rows } = await pool.query(sql, params);
        console.log('[API] GET /issues/options/assets', Date.now() - t0, 'ms  –', rows.length, 'rows');
        res.json({ items: rows });
    } catch (err) {
        console.error('[GET /issues/options/assets] failed:', err);
        res.status(500).json({ error: 'Failed to load assets' });
    }
});

/**
 * POST /issues/search
 * Body:
 * {
 *   page: number,
 *   pageSize: number,
 *   filters: {
 *     q?: string,
 *     statuses?: string[],            // ['OPEN','OVERDUE','CLOSED','VOID']
 *     issueFrom?: 'YYYY-MM-DD',
 *     issueTo?: 'YYYY-MM-DD',
 *     dueFrom?: 'YYYY-MM-DD',
 *     dueTo?: 'YYYY-MM-DD',
 *     fromLocationId?: string | null, // UUID
 *     toLocationId?: string | null    // UUID
 *   }
 * }
 */
// router.post('/search', async (req, res) => {
//     const page = Math.max(1, Number(req.body.page || 1));
//     const pageSize = Math.min(200, Math.max(1, Number(req.body.pageSize || 20)));
//     const offset = (page - 1) * pageSize;

//     const f = req.body.filters || {};
//     const params = [];
//     const where = [];

//     // Joins we need (location paths & single-item for asset)
//     // We'll reuse them in both total & items queries.
//     const baseFrom = `
//     FROM issue_transaction it
//     LEFT JOIN locations lf ON lf.id = it.from_location_id
//     LEFT JOIN locations lt ON lt.id = it.to_location_id
//     LEFT JOIN LATERAL (
//       SELECT ii.asset_id, ii.note
//       FROM issue_item ii
//       WHERE ii.transaction_id = it.id
//       ORDER BY ii.created_at ASC
//       LIMIT 1
//     ) AS ii_one ON TRUE
//     LEFT JOIN assets a ON a.id = ii_one.asset_id
//   `;

//     // ---- filters (AND'ed) ----
//     if (f.q && String(f.q).trim() !== '') {
//         params.push(`%${String(f.q).trim()}%`);
//         const p = `$${params.length}`;
//         where.push(`
//       (
//         it.reference ILIKE ${p}
//         OR lf.path ILIKE ${p}
//         OR lt.path ILIKE ${p}
//         OR a.title ILIKE ${p}
//         OR a.part_name ILIKE ${p}
//         OR a.tag ILIKE ${p}
//         OR a.serial_number ILIKE ${p}
//         OR ii_one.note ILIKE ${p}
//       )
//     `);
//     }

//     if (Array.isArray(f.statuses) && f.statuses.length > 0) {
//         const hasOverdue = f.statuses.includes('OVERDUE');
//         const others = f.statuses.filter(s => s !== 'OVERDUE');
//         const statusParts = [];

//         if (others.length) {
//             // IN ($x, $y, ...)
//             const placeholders = others.map(() => `$${params.length + 1}`).join(', ');
//             params.push(...others);
//             statusParts.push(`it.status IN (${placeholders})`);
//         }

//         if (hasOverdue) {
//             // overdue = open + past due
//             statusParts.push(`(it.status = 'OPEN' AND it.due_date < NOW())`);
//         }

//         // combine with OR inside one () group
//         if (statusParts.length) where.push(`(${statusParts.join(' OR ')})`);
//     }

//     if (f.issueFrom) { params.push(f.issueFrom); where.push(`it.issue_date >= $${params.length}`); }
//     if (f.issueTo) { params.push(f.issueTo); where.push(`it.issue_date <= $${params.length}`); }
//     if (f.dueFrom) { params.push(f.dueFrom); where.push(`it.due_date >= $${params.length}`); }
//     if (f.dueTo) { params.push(f.dueTo); where.push(`it.due_date <= $${params.length}`); }
//     if (f.fromLocationId) { params.push(f.fromLocationId); where.push(`it.from_location_id = $${params.length}`); }
//     if (f.toLocationId) { params.push(f.toLocationId); where.push(`it.to_location_id   = $${params.length}`); }

//     const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

//     try {
//         // ---- total ----
//         const totalSql = `SELECT COUNT(*)::int AS cnt ${baseFrom} ${whereSQL}`;
//         const totalRes = await pool.query(totalSql, params);
//         const total = totalRes.rows?.[0]?.cnt || 0;

//         // ---- items ----
//         params.push(pageSize, offset);
//         const itemsSql = `
//       SELECT
//         it.id,
//         it.reference,
//         it.issue_date,
//         it.from_location_id,
//         it.to_location_id,
//         it.due_date,
//         CASE
//             WHEN it.status = 'OPEN' AND it.due_date < NOW() THEN 'OVERDUE'
//             ELSE it.status
//         END AS STATUS,    
//         lf.path AS from_path,
//         lt.path AS to_path,

//         /* single-asset fields for the grid */
//         a.title     AS asset_title,
//         a.part_name AS asset_part_name,
//         ii_one.note AS issue_note,

//         /* count still useful */
//         (
//           SELECT COUNT(*)::int
//           FROM issue_item ii_cnt
//           WHERE ii_cnt.transaction_id = it.id
//         ) AS asset_count

//       ${baseFrom}
//       ${whereSQL}
//       ORDER BY it.created_at DESC
//       LIMIT $${params.length - 1} OFFSET $${params.length}
//     `;
//         const itemsRes = await pool.query(itemsSql, params);

//         res.json({ items: itemsRes.rows, total, page, pageSize });
//     } catch (e) {
//         console.error('[POST /issues/search] failed', e);
//         res.status(500).json({ error: 'Search failed' });
//     }
// });


router.post('/search', async (req, res) => {
    const page = Math.max(1, Number(req.body.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.body.pageSize || 20)));
    const offset = (page - 1) * pageSize;

    const f = req.body.filters || {};
    const params = [];
    const where = [];

    // ✅ Clean FROM / JOIN block
    const baseFrom = `
    FROM issue_transaction it
    LEFT JOIN locations lf ON lf.id = it.from_location_id
    LEFT JOIN external_location el ON el.id = it.external_location_id
    LEFT JOIN LATERAL (
      SELECT ii.asset_id, ii.note
      FROM issue_item ii
      WHERE ii.transaction_id = it.id
      ORDER BY ii.created_at ASC
      LIMIT 1
    ) AS ii_one ON TRUE
    LEFT JOIN assets a ON a.id = ii_one.asset_id
  `;

    // ✅ Filters
    if (f.q && String(f.q).trim() !== '') {
        params.push(`%${String(f.q).trim()}%`);
        const p = `$${params.length}`;
        where.push(`
      (
        it.reference ILIKE ${p}
        OR lf.path ILIKE ${p}
        OR el.company_name ILIKE ${p}
        OR el.contact_person ILIKE ${p}
        OR el.email ILIKE ${p}
        OR el.phone ILIKE ${p}
        OR a.title ILIKE ${p}
        OR a.part_name ILIKE ${p}
        OR a.tag ILIKE ${p}
        OR a.serial_number ILIKE ${p}
        OR ii_one.note ILIKE ${p}
      )
    `);
    }

    // ✅ Status filter (fully safe)
    if (Array.isArray(f.statuses) && f.statuses.length > 0) {
        const normalizedStatuses = f.statuses.filter(s => typeof s === 'string' && s.trim() !== '');
        if (normalizedStatuses.length > 0) {
            const hasOverdue = normalizedStatuses.includes('OVERDUE');
            const others = normalizedStatuses.filter(s => s !== 'OVERDUE');
            const statusParts = [];

            if (Array.isArray(others) && others.length > 0) {
                const placeholders = others.map((_, i) => `$${params.length + i + 1}`).join(', ');
                params.push(...others);
                statusParts.push(`it.status IN(${placeholders})`);
            }

            if (hasOverdue) {
                statusParts.push((`it.status = 'OPEN' AND it.due_date < NOW()`));
            }

            if (statusParts.length > 0) where.push((`${statusParts.join(' OR ')}`));
        }
    }

    if (f.issueFrom) { params.push(f.issueFrom); where.push(`it.issue_date >= $${params.length}`); }
    if (f.issueTo) { params.push(f.issueTo); where.push(`it.issue_date <= $${params.length}`); }
    if (f.dueFrom) { params.push(f.dueFrom); where.push(`it.due_date >= $${params.length}`); }
    if (f.dueTo) { params.push(f.dueTo); where.push(`it.due_date <= $${params.length}`); }
    if (f.fromLocationId) { params.push(f.fromLocationId); where.push(`it.from_location_id = $${params.length}`); }
    if (f.externalLocationId) { params.push(f.externalLocationId); where.push(`it.external_location_id = $${params.length}`); }

    // ✅ Safe WHERE block
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
        // ---- TOTAL ----
        const totalSql = `SELECT COUNT(*)::int AS cnt ${baseFrom} ${whereSQL}`;
        const totalRes = await pool.query(totalSql, params);
        const total = totalRes.rows?.[0]?.cnt || 0;



        // ---- ITEMS ----
        params.push(pageSize, offset);
        const itemsSql = `
      SELECT
        it.id,
        it.reference,
        it.issue_date,
        it.from_location_id,
        it.external_location_id,
        it.due_date,
        CASE
          WHEN it.status = 'OPEN' AND it.due_date < NOW() THEN 'OVERDUE'
          ELSE it.status
        END AS status,
        lf.path AS from_path,

        -- external location details
        el.company_name AS external_company,
        el.contact_person AS external_contact,
        el.email AS external_email,
        el.phone AS external_phone,

        -- asset info
        a.title     AS asset_title,
        a.part_name AS asset_part_name,
        ii_one.note AS issue_note,

        (
          SELECT COUNT(*)::int
          FROM issue_item ii_cnt
          WHERE ii_cnt.transaction_id = it.id
        ) AS asset_count

      ${baseFrom}
      ${whereSQL}
      ORDER BY it.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length};
    `;

        const itemsRes = await pool.query(itemsSql, params);

        res.json({ items: itemsRes.rows, total, page, pageSize });
    } catch (e) {
        console.error('[POST /issues/search] failed', e);
        res.status(500).json({ error: 'Search failed' });
    }
});


// ✅ ADD: Streaming Export (do not remove or change existing /search)
router.post('/export', async (req, res) => {
    const f = req.body.filters || {};
    const params = [];
    const where = [];

    // ✅ Same FROM/JOIN block as /search (copied)
    const baseFrom = `
    FROM issue_transaction it
    LEFT JOIN locations lf ON lf.id = it.from_location_id
    LEFT JOIN external_location el ON el.id = it.external_location_id
    LEFT JOIN LATERAL (
      SELECT ii.asset_id, ii.note
      FROM issue_item ii
      WHERE ii.transaction_id = it.id
      ORDER BY ii.created_at ASC
      LIMIT 1
    ) AS ii_one ON TRUE
    LEFT JOIN assets a ON a.id = ii_one.asset_id
  `;

    // ✅ Same filters as /search (copied)
    if (f.q && String(f.q).trim() !== '') {
        params.push(`%${String(f.q).trim()}%`);
        const p = `$${params.length}`;
        where.push(`
      (
        it.reference ILIKE ${p}
        OR lf.path ILIKE ${p}
        OR el.company_name ILIKE ${p}
        OR el.contact_person ILIKE ${p}
        OR el.email ILIKE ${p}
        OR el.phone ILIKE ${p}
        OR a.title ILIKE ${p}
        OR a.part_name ILIKE ${p}
        OR a.tag ILIKE ${p}
        OR a.serial_number ILIKE ${p}
        OR ii_one.note ILIKE ${p}
      )
    `);
    }

    if (Array.isArray(f.statuses) && f.statuses.length > 0) {
        const normalizedStatuses = f.statuses.filter(s => typeof s === 'string' && s.trim() !== '');
        if (normalizedStatuses.length > 0) {
            const hasOverdue = normalizedStatuses.includes('OVERDUE');
            const others = normalizedStatuses.filter(s => s !== 'OVERDUE');
            const statusParts = [];

            if (Array.isArray(others) && others.length > 0) {
                const placeholders = others.map((_, i) => `$${params.length + i + 1}`).join(', ');
                params.push(...others);
                statusParts.push(`it.status IN(${placeholders})`);
            }

            if (hasOverdue) {
                statusParts.push((`it.status = 'OPEN' AND it.due_date < NOW()`));
            }

            if (statusParts.length > 0) where.push((`${statusParts.join(' OR ')}`));
        }
    }

    if (f.issueFrom) { params.push(f.issueFrom); where.push(`it.issue_date >= $${params.length}`); }
    if (f.issueTo) { params.push(f.issueTo); where.push(`it.issue_date <= $${params.length}`); }
    if (f.dueFrom) { params.push(f.dueFrom); where.push(`it.due_date >= $${params.length}`); }
    if (f.dueTo) { params.push(f.dueTo); where.push(`it.due_date <= $${params.length}`); }
    if (f.fromLocationId) { params.push(f.fromLocationId); where.push(`it.from_location_id = $${params.length}`); }
    if (f.externalLocationId) { params.push(f.externalLocationId); where.push(`it.external_location_id = $${params.length}`); }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // ✅ CSV columns (export same fields user sees)
    const columns = [
        'reference',
        'asset_title',
        'asset_part_name',
        'issue_date',
        'from_path',
        'external_company',
        'external_contact',
        'external_phone',
        'external_email',
        'issue_note',
        'due_date',
        'status',
        'asset_count',
    ];

    // ✅ Build export query (no LIMIT/OFFSET) + compute OVERDUE same as /search
    const exportSql = `
    SELECT
      it.reference,
      a.title     AS asset_title,
      a.part_name AS asset_part_name,
      it.issue_date,
      lf.path AS from_path,

      el.company_name AS external_company,
      el.contact_person AS external_contact,
      el.email AS external_email,
      el.phone AS external_phone,

      ii_one.note AS issue_note,
      it.due_date,

      CASE
        WHEN it.status = 'OPEN' AND it.due_date < NOW() THEN 'OVERDUE'
        ELSE it.status
      END AS status,

      (
        SELECT COUNT(*)::int
        FROM issue_item ii_cnt
        WHERE ii_cnt.transaction_id = it.id
      ) AS asset_count

    ${baseFrom}
    ${whereSQL}
    ORDER BY it.created_at DESC
  `;

    let client;
    try {
        client = await pool.connect();

        const filename = `issues_export_${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');

        // Header row
        res.write(columns.join(',') + '\n');

        const qs = new QueryStream(exportSql, params, { highWaterMark: 1000 });
        const stream = client.query(qs);

        stream.on('data', (row) => {
            res.write(toCsvLine(row, columns));
        });

        stream.on('end', () => {
            res.end();
        });

        stream.on('error', (err) => {
            console.error('[POST /issues/export] stream error', err);
            try { res.end(); } catch (_) { }
        });

        // If client disconnects mid-download, stop the stream + release connection
        req.on('close', () => {
            try { stream.destroy(); } catch (_) { }
        });
    } catch (e) {
        console.error('[POST /issues/export] failed', e);
        res.status(500).json({ error: 'Export failed' });
    } finally {
        if (client) client.release();
    }
});




/* ---------- list ---------- */
// GET /issues  -> list with paging + counts
// router.get('/', async (req, res) => {
//     const page = Math.max(1, Number(req.query.page || 1));
//     const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 50)));
//     const offset = (page - 1) * pageSize;

//     // optional search by "path" text (from or to)
//     const q = (req.query.q || '').toString().trim();
//     const params = [];
//     let whereSQL = '';
//     if (q) {
//         params.push(`%${q}%`);
//         whereSQL = `WHERE (lf.path ILIKE $${params.length} OR lt.path ILIKE $${params.length})`;
//     }

//     try {
//         // total
//         const totalSql = `
//       SELECT COUNT(*)::int AS cnt
//       FROM issue_transaction it
//       LEFT JOIN locations lf ON lf.id = it.from_location_id
//       LEFT JOIN locations lt ON lt.id = it.to_location_id
//       ${whereSQL}
//     `;
//         const totalRes = await pool.query(totalSql, params);
//         const total = totalRes.rows[0]?.cnt || 0;

//         // items
//         params.push(pageSize, offset);
//         const itemsSql = `
//                     SELECT
//                         it.id,
//                         it.reference,
//                         it.issue_date,
//                         it.from_location_id,
//                         it.to_location_id,
//                         it.due_date,
//                         CASE
//                             WHEN it.status = 'OPEN' AND it.due_date < NOW() THEN 'OVERDUE'
//                             ELSE it.status
//                         END AS STATUS,    
//                         lf.path  AS from_path,
//                         lt.path  AS to_path,

//                         -- single-asset fields for the grid
//                         a.title       AS asset_title,
//                         a.part_name   AS asset_part_name,
//                         ii_one.note   AS issue_note,

//                         -- keep your existing count (still useful)
//                         (
//                         SELECT COUNT(*)::int
//                         FROM issue_item ii_cnt
//                         WHERE ii_cnt.transaction_id = it.id
//                         ) AS asset_count

//                     FROM issue_transaction it
//                     LEFT JOIN locations lf ON lf.id = it.from_location_id
//                     LEFT JOIN locations lt ON lt.id = it.to_location_id

//                     -- pick the single (current) item for this issue
//                     LEFT JOIN LATERAL (
//                         SELECT ii.asset_id, ii.note
//                         FROM issue_item ii
//                         WHERE ii.transaction_id = it.id
//                         ORDER BY ii.created_at ASC
//                         LIMIT 1
//                     ) AS ii_one ON TRUE

//                     LEFT JOIN assets a ON a.id = ii_one.asset_id

//                     ${whereSQL}
//                     ORDER BY it.created_at DESC
//                     LIMIT $${params.length - 1} OFFSET $${params.length}
//                     `;

//         const itemsRes = await pool.query(itemsSql, params);

//         //console.log('itemsRes', itemsRes.rows);

//         res.json({ items: itemsRes.rows, total, page, pageSize });
//     } catch (e) {
//         console.error('[GET /issues] failed:', e);
//         res.status(500).json({ error: 'Failed to load issues' });
//     }
// });

router.get('/', async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 50)));
    const offset = (page - 1) * pageSize;

    const q = (req.query.q || '').toString().trim();
    const params = [];
    let whereSQL = '';

    // 🔍 Search by company name or contact person only
    if (q) {
        params.push(`% ${q} %`);
        whereSQL = `
      WHERE (
        el.company_name ILIKE $${params.length}
        OR el.contact_person ILIKE $${params.length}
      )
    `;
    }

    try {
        // 1️⃣ Total count
        const totalSql = `
      SELECT COUNT(*)::int AS cnt
      FROM issue_transaction it
      LEFT JOIN external_location el ON el.id = it.external_location_id
      ${whereSQL};
    `;
        const totalRes = await pool.query(totalSql, params);
        const total = totalRes.rows[0]?.cnt || 0;

        // 2️⃣ Paged results
        params.push(pageSize);
        params.push(offset);

        const itemsSql = `
      SELECT
        it.id,
        it.reference,
        it.issue_date,
        it.from_location_id,
        it.external_location_id,
        it.due_date,
        CASE
          WHEN it.status = 'OPEN' AND it.due_date < NOW() THEN 'OVERDUE'
          ELSE it.status
        END AS status,

        -- From internal location
        lf.path AS from_path,

        -- External destination
        el.company_name AS external_company,
        el.contact_person AS external_contact,
        el.email AS external_email,
        el.phone AS external_phone,

        -- Unified name (for table display)
        el.company_name AS destination_name,

        -- Asset details
        a.title AS asset_title,
        a.part_name AS asset_part_name,
        ii_one.note AS issue_note,

        -- Count of assets
        (
          SELECT COUNT(*)::int
          FROM issue_item ii_cnt
          WHERE ii_cnt.transaction_id = it.id
        ) AS asset_count

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

      ${whereSQL}
      ORDER BY it.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length};
    `;

        const itemsRes = await pool.query(itemsSql, params);

        res.json({
            items: itemsRes.rows,
            total,
            page,
            pageSize,
        });
    } catch (e) {
        console.error('[GET /issues] failed:', e);
        res.status(500).json({ error: 'Failed to load issues' });
    }
});





/* ---------- detail ---------- */
// --- EDIT SUPPORT: load one issue with items (for the modal) ---
router.get('/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const { rows: [issue] } = await pool.query(
            `
            SELECT 
                it.id,
                it.reference,
                it.issue_date,
                it.due_date,
                it.status,
                it.from_location_id,
                lf.path AS from_path,
                it.external_location_id,
                el.company_name AS external_company_name,
                el.contact_person AS external_contact,
                el.email AS external_email,
                el.phone AS external_phone
            FROM issue_transaction it
            LEFT JOIN locations lf ON lf.id = it.from_location_id
            LEFT JOIN external_location el ON el.id = it.external_location_id
            WHERE it.id = $1
            `,
            [id]
        );

        if (!issue) return res.status(404).json({ error: 'Issue not found' });

        // fetch issued items for this issue
        const { rows: items } = await pool.query(
            `
            SELECT 
                ii.id,
                ii.asset_id,
                ii.status,
                ii.issued_at,
                ii.returned_at,
                ii.note,
                a.title,
                a.part_name,
                a.tag,
                a.serial_number,
                COALESCE(l.path, '—') AS current_location
            FROM issue_item ii
            JOIN assets a ON a.id = ii.asset_id
            LEFT JOIN locations l ON l.id = a.location_id
            WHERE ii.transaction_id = $1
            ORDER BY a.title NULLS LAST, a.part_name, a.tag
            `,
            [id]
        );

        // Normalize JSON structure for the frontend modal
        res.json({
            issue: {
                ...issue,
                from_path: issue.from_path || '—',
                to_path: issue.external_company_name || '—'
            },
            items
        });
    } catch (e) {
        console.error('[GET /issues/:id] failed:', e);
        res.status(500).json({ error: 'Failed to load issue details' });
    }
});

//Old logic for internal location
// router.get('/:id', async (req, res) => {
//     const id = req.params.id;
//     try {
//         const { rows: [issue] } = await pool.query(
//             `
//       SELECT it.id, it.reference, it.issue_date, it.due_date, it.status,
//              it.from_location_id, lf.path  AS from_path,
//              it.to_location_id,   lt.path  AS to_path
//       FROM issue_transaction it
//       LEFT JOIN locations lf ON lf.id = it.from_location_id
//       LEFT JOIN locations lt ON lt.id = it.to_location_id
//       WHERE it.id = $1
//       `,
//             [id]
//         );

//         if (!issue) return res.status(404).json({ error: 'Issue not found' });

//         const { rows: items } = await pool.query(
//             `
//       SELECT ii.id, ii.asset_id, ii.status, ii.issued_at, ii.returned_at, ii.note,
//              a.title, a.part_name, a.tag, a.serial_number,
//              l.path AS location_path
//       FROM issue_item ii
//       JOIN assets a      ON a.id = ii.asset_id
//       LEFT JOIN locations l ON l.id = a.location_id
//       WHERE ii.transaction_id = $1
//       ORDER BY a.title NULLS LAST, a.part_name, a.tag
//       `,
//             [id]
//         );

//         res.json({ issue, items });
//     } catch (e) {
//         console.error('[GET /issues/:id] failed:', e);
//         res.status(500).json({ error: 'Failed to load issue' });
//     }
// });

// router.get('/:id', async (req, res) => {
//     const id = req.params.id;
//     try {
//         const { rows: [issue] } = await pool.query(`
//       SELECT 
//         it.id,
//         it.reference,
//         it.issue_date,
//         it.due_date,
//         it.status,
//         it.from_location_id,
//         lf.path AS from_path,
//         it.external_location_id,
//         el.company_name AS external_company,
//         el.contact_person AS external_contact
//       FROM issue_transaction it
//       LEFT JOIN locations lf ON lf.id = it.from_location_id
//       LEFT JOIN external_location el ON el.id = it.external_location_id
//       WHERE it.id = $1
//     `, [id]);

//         if (!issue) return res.status(404).json({ error: 'Issue not found' });

//         const { rows: items } = await pool.query(`
//       SELECT 
//         ii.id, ii.asset_id, ii.status, ii.issued_at, ii.returned_at, ii.note,
//         a.title, a.part_name, a.tag, a.serial_number,
//         COALESCE(l.path, el.company_name) AS location_path
//       FROM issue_item ii
//       JOIN assets a ON a.id = ii.asset_id
//       LEFT JOIN locations l ON l.id = a.location_id
//       LEFT JOIN issue_transaction it ON it.id = ii.transaction_id
//       LEFT JOIN external_location el ON el.id = it.external_location_id
//       WHERE ii.transaction_id = $1
//       ORDER BY a.title NULLS LAST, a.part_name, a.tag
//     `, [id]);

//         res.json({ issue, items });
//     } catch (e) {
//         console.error('[GET /issues/:id] failed:', e);
//         res.status(500).json({ error: 'Failed to load issue' });
//     }
// });






// --- EDIT: PATCH /issues/:id ---
// PATCH /issues/:id  — edit destination, due date, optional item note
router.patch('/:id', async (req, res) => {
    const id = (req.params.id || '').trim(); // issue_transaction.id (uuid)

    // replaced to_location_id with external_location_id
    const {
        external_location_id: bodyExternalLoc, // <-- new field from frontend
        due_date: bodyDue,
        note: bodyNote,
        user_email: userEmail
    } = req.body || {};

    const userId = req.user?.id || null;
    const external_location_id = bodyExternalLoc ? String(bodyExternalLoc).trim() : null;
    const due_date = bodyDue ? new Date(bodyDue) : null;
    const note = (bodyNote ?? '').toString().trim();
    const user_email = userEmail;

    if (!external_location_id && !due_date && !note) {
        return res.status(400).json({ error: 'Nothing to update.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1 Fetch transaction
        const txRes = await client.query(
            `SELECT id, from_location_id, external_location_id, due_date, status
         FROM issue_transaction
        WHERE id = $1
        FOR UPDATE`,
            [id]
        );
        if (!txRes.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Issue transaction not found' });
        }
        const curTx = txRes.rows[0];

        // 2 Fetch item (1:1)
        const itemRes = await client.query(
            `SELECT id, asset_id, note
         FROM issue_item
        WHERE transaction_id = $1`,
            [id]
        );
        if (itemRes.rowCount > 1) {
            throw new Error('Invariant violation: more than one asset on this issue');
        }
        const curItem = itemRes.rows[0] || null;

        const before = await getIssueItemSnapshot(client, curItem.id);
        if (!before || before.transaction_id !== id) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Issue item not found.' });
        }

        // 3 Update issue_transaction
        await client.query(
            `UPDATE issue_transaction
          SET external_location_id = COALESCE($2, external_location_id),  -- 🟢 changed
              due_date             = COALESCE($3, due_date),
              updated_at           = now(),
              updated_by           = COALESCE($4, updated_by)
        WHERE id = $1`,
            [id, external_location_id, due_date, user_email]
        );

        // 4 Update note if provided
        if (note && curItem) {
            await client.query(
                `UPDATE issue_item
            SET note = $2, updated_at = now(), updated_by = $3
          WHERE id  = $1`,
                [curItem.id, note, user_email]
            );
        }

        // We do NOT update assets.location_id anymore
        // External issues leave asset.location_id unchanged internally

        await client.query('COMMIT');

        // 6 Return refreshed issue summary
        const fresh = await pool.query(
            `SELECT it.id,
              it.from_location_id,
              it.external_location_id,
              it.due_date,
              it.status,
              (SELECT jsonb_build_object(
                       'id', ii.id,
                       'asset_id', ii.asset_id,
                       'note', ii.note
               )
               FROM issue_item ii
               WHERE ii.transaction_id = it.id
               LIMIT 1
              ) AS item
         FROM issue_transaction it
        WHERE it.id = $1`,
            [id]
        );

        const after = await getIssueItemSnapshot(client, itemRes.rows[0].id);

        await auditSafe(pool, {
            action: 'ISSUE_EDIT',
            entity_type: 'issue_item',
            entity_id: fresh.rows[0].id,
            ref_type: 'issue',
            ref_id: before.transaction_id,
            actor_email: user_email,
            summary: `Edited issue item for ${after.asset_title || after.asset_id}`,
            before_data: before,
            after_data: after
        });

        await sendNotificationIfEnabled(
            "ISSUE_EDIT",
            `Issue Edited: Edited issue item for ${after.asset_title || after.asset_id}`,
            `<p>Edited issue item for ${after.asset_title || after.asset_id} by ${user_email}</p>`
        );

        return res.json({ ok: true, issue: fresh.rows[0] });
    } catch (e) {
        try {
            await client.query('ROLLBACK');
        } catch (_) { }
        console.error('[PATCH /issues/:id] failed:', e);
        return res.status(400).json({ error: e.message || 'Failed to edit issue' });
    } finally {
        client.release();
    }
});


//Old logic with internal location for issue
// router.patch('/:id', async (req, res) => {
//     const id = (req.params.id || '').trim(); // issue_transaction.id (uuid)
//     const { to_location_id: bodyToLoc, due_date: bodyDue, note: bodyNote, user_email: userEmail } = req.body || {};
//     const userId = req.user?.id || null; // if you have auth; else leave null

//     // very defensive normalization
//     const to_location_id = bodyToLoc ? String(bodyToLoc).trim() : null;
//     const due_date = bodyDue ? new Date(bodyDue) : null; // accepts ISO or yyyy-mm-dd
//     const note = (bodyNote ?? '').toString().trim();
//     const user_email = userEmail;

//     // quick sanity: at least one thing to update
//     if (!to_location_id && !due_date && !note) {
//         return res.status(400).json({ error: 'Nothing to update.' });
//     }

//     const client = await pool.connect();
//     try {
//         await client.query('BEGIN');

//         // 1) fetch current transaction + single item (we enforce 0/1)
//         const txRes = await client.query(
//             `SELECT id, from_location_id, to_location_id, due_date, status
//          FROM issue_transaction
//         WHERE id = $1
//         FOR UPDATE`,
//             [id]
//         );
//         if (!txRes.rowCount) {
//             await client.query('ROLLBACK');
//             return res.status(404).json({ error: 'Issue transaction not found' });
//         }
//         const curTx = txRes.rows[0];

//         //console.log('txRes', txRes.rows[0].id);

//         const itemRes = await client.query(
//             `SELECT id, asset_id, note
//          FROM issue_item
//         WHERE transaction_id = $1`,
//             [id]
//         );
//         if (itemRes.rowCount > 1) {
//             throw new Error('Invariant violation: more than one asset on this issue');
//         }
//         //console.log('itemRes.row', itemRes.rows[0]);
//         const curItem = itemRes.rows[0] || null;

//         // BEFORE snapshot
//         const before = await getIssueItemSnapshot(client, curItem.id);
//         if (!before || before.transaction_id !== id) {
//             await client.query('ROLLBACK');
//             return res.status(404).json({ error: 'Issue item not found.' });
//         }

//         //console.log('curItem.row', curItem);

//         // 2) apply edits on issue_transaction
//         const updRes = await client.query(
//             `UPDATE issue_transaction
//           SET to_location_id = COALESCE($2, to_location_id),
//               due_date       = COALESCE($3, due_date),
//               updated_at     = now(),
//               updated_by     = COALESCE($4, updated_by)
//         WHERE id = $1`,
//             [id, to_location_id, due_date, user_email]
//         );

//         // 3) optional: update the item note if provided and item exists
//         if (note && curItem) {
//             await client.query(
//                 `UPDATE issue_item
//             SET note = $2, updated_at = now(), updated_by = $3
//           WHERE id  = $1`,
//                 [curItem.id, note, user_email]
//             );
//         }

//         // 4) if destination changed, log a movement + update asset location
//         const destChanged = !!(to_location_id && to_location_id !== curTx.to_location_id);
//         if (destChanged && curItem?.asset_id) {
//             // movements row
//             await client.query(
//                 `INSERT INTO movements
//            (id, asset_id, from_location_id, to_location_id, reason, note, created_at, created_by_user, ref_type, ref_id)
//          VALUES
//            (gen_random_uuid(), $1, $2, $3, 'ISSUE_EDIT', NULLIF($4, ''), now(), $5, 'ISSUE', $6)`,
//                 [
//                     curItem.asset_id,
//                     curTx.to_location_id,      // from = previous destination
//                     to_location_id,            // to   = new destination
//                     note || null,              // optional movement note
//                     user_email,                    // may be null
//                     id,                        // ref_id = issue_transaction.id
//                 ]
//             );

//             // keep assets table in sync
//             await client.query(
//                 `UPDATE assets
//             SET location_id = $2, updated_at = now(), updated_by_user = $3
//           WHERE id = $1`,
//                 [curItem.asset_id, to_location_id, user_email]
//             );
//         }

//         await client.query('COMMIT');

//         // 5) respond with the refreshed issue (thin)
//         const fresh = await pool.query(
//             `SELECT it.id,
//               it.from_location_id,
//               it.to_location_id,
//               it.due_date,
//               it.status,
//               (SELECT jsonb_build_object(
//                        'id', ii.id,
//                        'asset_id', ii.asset_id,
//                        'note', ii.note
//                )
//                FROM issue_item ii
//                WHERE ii.transaction_id = it.id
//                LIMIT 1
//               ) AS item
//          FROM issue_transaction it
//         WHERE it.id = $1`,
//             [id]
//         );

//         //console.log('issue item id', itemRes.rows[0].id);

//         // AFTER snapshot
//         const after = await getIssueItemSnapshot(client, itemRes.rows[0].id);

//         //console.log('before', before);
//         //console.log('after', after);

//         // AUDIT
//         await auditSafe(pool, {
//             action: 'ISSUE_EDIT',
//             entity_type: 'issue_item',
//             entity_id: fresh.rows[0].id,
//             ref_type: 'issue',
//             ref_id: before.transaction_id,
//             actor_email: user_email,
//             summary: `Edited issue item for ${after.asset_title || after.asset_id}`,
//             before_data: before,
//             after_data: after,
//         });

//         // 🔔 Send email if enabled
//         await sendNotificationIfEnabled(
//             "ISSUE_EDIT",
//             `Issue Edited: Edited issue item for ${after.asset_title || after.asset_id}`,
//             `<p>Edited issue item for ${after.asset_title || after.asset_id} by user ${user_email} </p>`
//         );


//         await client.query('COMMIT');

//         return res.json({ ok: true, issue: fresh.rows[0] });
//     } catch (e) {
//         try { await client.query('ROLLBACK'); } catch (_) { }
//         console.error('[PATCH /issues/:id] failed:', e);
//         return res.status(400).json({ error: e.message || 'Failed to edit issue' });
//     } finally {
//         client.release();
//     }
// });





/* ---------- create ---------- */
// -----------------------------
// POST /issues
// Purpose: Create a new issue transaction and related issue items.
// Notes:
//   - We no longer ask the user to select "Issue From" in the UI.
//   - The "from_location_id" is derived from the asset’s current location_id.
//   - If the asset has no current location (NULL), that's treated as "Unassigned."
//   - On issuing, we always update:
//       1) issue_transaction (header record)
//       2) issue_item (per asset record)
//       3) movements (audit trail of where it moved from → to)
//       4) assets.location_id (current location gets updated to the "to")
//   - This keeps DB as the single source of truth and simplifies the UI logic.
// -----------------------------
// body: { asset_id: string, to_location_id: string, due_date?: string(YYYY-MM-DD), user_email?: string }
// POST /issues
// Body: { asset_id, to_location_id, due_date?: string|null, user_email?: string|null }
// router.post('/', async (req, res) => {
//     const { asset_id, to_location_id, due_date = null, user_email = null } = req.body || {};

//     if (!asset_id) return res.status(400).json({ error: 'asset_id is required' });
//     if (!to_location_id) return res.status(400).json({ error: 'to_location_id is required' });

//     const client = await pool.connect();
//     try {
//         await client.query('BEGIN');

//         // 1) Load asset (current location before we move it)
//         const { rows: arows } = await client.query(
//             `SELECT id, location_id, title, part_name FROM assets WHERE id = $1 FOR UPDATE`,
//             [asset_id]
//         );
//         if (arows.length === 0) {
//             await client.query('ROLLBACK');
//             return res.status(404).json({ error: 'Asset not found' });
//         }
//         const asset = arows[0];
//         const from_location_id = asset.location_id || null;

//         // 2) Basic guard: ensure not already issued (OPEN/OVERDUE)
//         const { rows: guardRows } = await client.query(
//             `SELECT 1
//          FROM issue_item ii
//          JOIN issue_transaction it ON it.id = ii.transaction_id
//         WHERE ii.asset_id = $1
//           AND ii.returned_at IS NULL
//           AND it.status IN ('OPEN','OVERDUE')
//         LIMIT 1`,
//             [asset_id]
//         );
//         if (guardRows.length) {
//             await client.query('ROLLBACK');
//             return res.status(409).json({ error: 'Asset is already issued' });
//         }

//         // 3) Create the issue transaction (from = current asset location)
//         const { rows: txRows } = await client.query(
//             `INSERT INTO issue_transaction (from_location_id, to_location_id, due_date, status, created_at, updated_at, created_by)
//        VALUES ($1, $2, $3, 'OPEN', now(), now(), $4)
//        RETURNING id`,
//             [from_location_id, to_location_id, due_date, user_email]
//         );
//         const transaction_id = txRows[0].id;

//         // 4) Create the item row
//         const { rows: itemRows } = await client.query(
//             `INSERT INTO issue_item (transaction_id, asset_id, issued_at, status, created_at, updated_at, created_by)
//        VALUES ($1, $2, now(), 'ISSUED', now(), now(), $3)
//        RETURNING id`,
//             [transaction_id, asset_id, user_email]
//         );
//         const item_id = itemRows[0].id;

//         // 5) Movement row (reason is REQUIRED -> provide it)
//         await client.query(
//             `INSERT INTO movements
//      (asset_id, from_location_id, to_location_id, reason, note,
//       created_at, created_by_user, ref_type, ref_id)
//    VALUES
//      ($1, $2, $3, $4, $5,
//       now(), $6, $7, $8)`,
//             [
//                 asset_id,
//                 from_location_id,
//                 to_location_id,
//                 'ISSUE',               // <--- reason is hardcoded here
//                 null,                  // note (optional)
//                 user_email,            // created_by_user
//                 'issue_item',          // ref_type
//                 item_id                // ref_id
//             ]
//         );



//         // 6) Update asset’s current location to "to"
//         await client.query(
//             `UPDATE assets SET location_id = $1, updated_at = now(), updated_by_user = COALESCE($2, updated_by_user) WHERE id = $3`,
//             [to_location_id, user_email, asset_id]
//         );

//         // 7) Update Audit trail
//         const { rows: metaRows } = await client.query(
//             `
//                 SELECT
//                     a.id                          AS asset_id,
//                     a.title                       AS asset_title,
//                     a.tag                         AS asset_tag,
//                     a.company_asset_id            AS company_asset_id,
//                     lf.id                         AS from_location_id,
//                     COALESCE(lf.path, lf.name)    AS from_location_name,
//                     $1::uuid                      AS to_location_id,
//                     COALESCE(lt.path, lt.name)    AS to_location_name
//                 FROM assets a
//                 LEFT JOIN locations lf ON lf.id = a.location_id
//                 LEFT JOIN locations lt ON lt.id = $1
//                 WHERE a.id = $2
//                 LIMIT 1;
//                 `,
//             [to_location_id, asset_id]
//         );

//         const meta = metaRows[0] || {};

//         // Now write the audit using the joined fields
//         await auditSafe(pool, {
//             action: 'ISSUE',
//             entity_type: 'issue_item',
//             entity_id: item_id,            // your inserted issue_item id
//             actor_email: user_email,
//             summary: `Issued ${meta.asset_title || meta.asset_tag || meta.company_asset_id || meta.asset_id}`,
//             details: {
//                 transaction_id,
//                 item_id,
//                 asset_id: meta.asset_id,
//                 asset_title: meta.asset_title,
//                 asset_tag: meta.asset_tag,
//                 company_asset_id: meta.company_asset_id,
//                 from_location_id: meta.from_location_id,
//                 from_location_name: meta.from_location_name,
//                 to_location_id: meta.to_location_id,
//                 to_location_name: meta.to_location_name,
//                 status: 'OPEN',
//                 due_date: due_date || null
//             }
//         });

//         // 🔔 Send email if enabled
//         await sendNotificationIfEnabled(
//             "ISSUE_CREATE",
//             `New Issue Created: Issued ${meta.asset_title || meta.asset_tag}`,
//             `<p>Issued ${meta.asset_title || meta.asset_tag || meta.company_asset_id || meta.asset_id} from location ${meta.from_location_name} to location ${meta.to_location_name} </p>`
//         );

//         await client.query('COMMIT');
//         return res.status(201).json({
//             ok: true,
//             transaction_id,
//             item_id,
//         });
//     } catch (e) {
//         await client.query('ROLLBACK');
//         console.error('[POST /issues] failed:', e);
//         return res.status(500).json({ error: 'Failed to create issue' });
//     } finally {
//         client.release();
//     }
// });

router.post('/', idempotency, async (req, res) => {
    const { asset_id, external_location_id, due_date = null, user_email = null } =
        req.body || {};

    if (!asset_id) return res.status(400).json({ error: 'asset_id is required' });
    if (!external_location_id)
        return res
            .status(400)
            .json({ error: 'external_location_id is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1️⃣ Load asset (get current location before we move it)
        const { rows: arows } = await client.query(
            `SELECT id, location_id, title, part_name FROM assets WHERE id = $1 FOR UPDATE`,
            [asset_id]
        );
        if (arows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Asset not found' });
        }
        const asset = arows[0];
        const from_location_id = asset.location_id || null;

        // 2️⃣ Ensure asset is not already issued
        const { rows: guardRows } = await client.query(
            `SELECT 1
       FROM issue_item ii
       JOIN issue_transaction it ON it.id = ii.transaction_id
       WHERE ii.asset_id = $1
         AND ii.returned_at IS NULL
         AND it.status IN ('OPEN','OVERDUE')
       LIMIT 1`,
            [asset_id]
        );
        if (guardRows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Asset is already issued' });
        }

        // 3️⃣ Create issue transaction (external destination)
        const { rows: txRows } = await client.query(
            `INSERT INTO issue_transaction (
          from_location_id,
          external_location_id,
          due_date,
          issue_date,
          status,
          created_at,
          updated_at,
          created_by
       )
       VALUES ($1, $2, $3, now(), 'OPEN', now(), now(), $4)
       RETURNING id`,
            [from_location_id, external_location_id, due_date, user_email]
        );
        const transaction_id = txRows[0].id;

        // 4️⃣ Create issue item
        const { rows: itemRows } = await client.query(
            `INSERT INTO issue_item (
          transaction_id,
          asset_id,
          issued_at,
          status,
          created_at,
          updated_at,
          created_by
       )
       VALUES ($1, $2, now(), 'ISSUED', now(), now(), $3)
       RETURNING id`,
            [transaction_id, asset_id, user_email]
        );
        const item_id = itemRows[0].id;

        // 5️⃣ Keep asset’s location unchanged (still physically in same place),
        // OR set to null if you want it to be “offsite”
        await client.query(
            `UPDATE assets
         SET location_id = NULL,
             status = 'ISSUED',
             updated_at = now(),
             updated_by_user = COALESCE($1, updated_by_user)
       WHERE id = $2`,
            [user_email, asset_id]
        );

        // 6️⃣ Audit metadata
        const { rows: metaRows } = await client.query(
            `
      SELECT
        a.id AS asset_id,
        a.title AS asset_title,
        a.tag AS asset_tag,
        el.company_name AS external_name,
        el.contact_person,
        el.email,
        el.phone
      FROM assets a
      LEFT JOIN external_location el ON el.id = $1
      WHERE a.id = $2
      LIMIT 1;
      `,
            [external_location_id, asset_id]
        );

        const meta = metaRows[0] || {};

        await auditSafe(pool, {
            action: 'ISSUE_CREATE',
            entity_type: 'issue_item',
            entity_id: item_id,
            actor_email: user_email,
            summary: `Issued ${meta.asset_title || meta.asset_tag} to ${meta.external_name}`,
            details: {
                transaction_id,
                item_id,
                asset_id: meta.asset_id,
                asset_title: meta.asset_title,
                asset_tag: meta.asset_tag,
                external_location_id,
                external_name: meta.external_name,
                status: 'OPEN',
                due_date: due_date || null,
                after: metaRows[0]
            },
        });

        // 8️⃣ Optional email notification
        await sendNotificationIfEnabled(
            'ISSUE_CREATE',
            `Asset Issued: ${meta.asset_title || meta.asset_tag}`,
            `<p>${meta.asset_title || meta.asset_tag} issued to ${meta.external_name} by ${user_email}</p>`
        );

        await client.query('COMMIT');
        return res.status(201).json({
            ok: true,
            transaction_id,
            item_id,
        });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[POST /issues] failed:', e);
        return res.status(500).json({ error: 'Failed to create issue' });
    } finally {
        client.release();
    }
});




// DELETE /issues/:id — void an issue transaction

router.delete('/:id', idempotency, async (req, res) => {
    const id = (req.params.id || '').trim();       // issue_transaction.id
    const note = (req.body?.note ?? '').trim();    // note from modal (optional)
    const user_email = (req.body?.userEmail || req.body?.user_email || '').trim();
    const asset_status = (req.body?.asset_status ?? '').trim();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1) Load the issue (FOR UPDATE) and the single item we allow per issue
        const txRes = await client.query(
            `SELECT
         it.id,
         it.status,
         it.from_location_id,
         it.external_location_id,     -- 👈 external destination for issues
         it.to_location_id,           -- (legacy / not used anymore for issues)
         it.reference
       FROM issue_transaction it
       WHERE it.id = $1
       FOR UPDATE`,
            [id]
        );

        if (!txRes.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Issue transaction not found' });
        }
        const issue = txRes.rows[0];

        // (Optional) guard
        if (issue.status === 'VOID') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Issue already voided' });
        }

        const itemRes = await client.query(
            `SELECT id, asset_id, status, returned_at
         FROM issue_item
        WHERE transaction_id = $1`,
            [id]
        );
        if (!itemRes.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Issue item not found' });
        }
        if (itemRes.rowCount > 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invariant: multiple items on issue — not supported by void flow' });
        }

        const curItem = itemRes.rows[0];

        // Take BEFORE snapshot for audit
        const issueItemBefore = await getIssueItemSnapshot(client, curItem.id);

        // 2) Mark issue as VOID
        await client.query(
            `UPDATE issue_transaction
          SET status = 'VOID',
              updated_at = now(),
              voided_at = now(),
              voided_by = $2
        WHERE id = $1`,
            [id, user_email || null]
        );

        // 3) Mark its item as VOID (+ append note if provided)
        if (note) {
            await client.query(
                `UPDATE issue_item
            SET note =
                  CASE
                    WHEN note IS NULL OR btrim(note) = '' THEN $2
                    ELSE note || E'\n' || $2
                  END,
                status = 'VOID',
                updated_at = now(),
                voided_at = now(),
                voided_by = $3
          WHERE transaction_id = $1`,
                [id, note, user_email || null]
            );
        } else {
            await client.query(
                `UPDATE issue_item
            SET status = 'VOID',
                updated_at = now(),
                voided_at = now(),
                voided_by = $2
          WHERE transaction_id = $1`,
                [id, user_email || null]
            );
        }

        // 4) Roll back asset location to original internal "from_location_id"
        if (curItem?.asset_id && issue.from_location_id) {
            await client.query(
                `UPDATE assets
            SET location_id = $2,
                updated_at  = now(),
                status = $4,
                updated_by_user = COALESCE($3, updated_by_user)
          WHERE id = $1`,
                [curItem.asset_id, issue.from_location_id, user_email || null, asset_status]
            );
        }

        // 5) Write a movement row (external -> original internal), reason ISSUE_VOID
        // If you decided to keep movement logs for issue flows:
        // if (curItem?.asset_id && issue.external_location_id && issue.from_location_id) {
        //     await client.query(
        //         `INSERT INTO movements
        //    (id, asset_id, from_location_id, to_location_id,
        //     reason, note, created_at, created_by_user, ref_type, ref_id)
        //  VALUES
        //    (gen_random_uuid(), $1, $2, $3,
        //     'ISSUE_VOID', NULLIF($4,''), now(), $5, 'ISSUE', $6)`,
        //         [
        //             curItem.asset_id,
        //             issue.external_location_id,   // 👈 from = external
        //             issue.from_location_id,       // 👈 to   = original internal
        //             note || null,
        //             user_email || null,
        //             id
        //         ]
        //     );
        // }

        // AFTER snapshot (we only need minimal marker here)
        const after = { status: 'VOID' };

        // 6) Audit
        await auditSafe(client, {
            action: 'ISSUE_VOID',
            entity_type: 'issue_item',
            entity_id: issueItemBefore.id,       // the issue_item id
            ref_type: 'issue_transaction',
            ref_id: issue.id,
            actor_email: user_email || null,
            summary: `Voided issue item for ${issueItemBefore.asset_title || issueItemBefore.asset_id}`,
            before_data: issueItemBefore,
            after_data: after
        });

        // 7) Notification (optional)
        await sendNotificationIfEnabled(
            "ISSUE_VOID",
            `Issue Voided: Voided ${issueItemBefore.asset_title}`,
            `<p>Issue voided for ${issueItemBefore.asset_title || issueItemBefore.asset_tag || issueItemBefore.company_asset_id || issueItemBefore.asset_id} ${note ? (`for reason ${note}`) : ''} by ${user_email}</p>`
        );

        await client.query('COMMIT');
        return res.json({ ok: true, voided: id });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        console.error('[DELETE /issues/:id] failed:', e);
        return res.status(400).json({ error: e.message || 'Failed to void issue' });
    } finally {
        client.release();
    }
});

//Old logic with internal location
// router.delete('/:id', async (req, res) => {
//     const id = (req.params.id || '').trim();
//     const userId = req.user?.id || null;
//     const note = (req.body?.note ?? '').trim();     // note from modal
//     const user_email = (req.body?.userEmail);

//     console.log('user_email', user_email);
//     console.log('Is this correct void route');


//     const client = await pool.connect();
//     try {
//         await client.query('BEGIN');

//         // fetch issue + item (must exist)
//         const txRes = await client.query(
//             `SELECT id, from_location_id, to_location_id, status
//          FROM issue_transaction
//         WHERE id = $1
//         FOR UPDATE`,
//             [id]
//         );

//         if (!txRes.rowCount) {
//             await client.query('ROLLBACK');
//             return res.status(404).json({ error: 'Issue transaction not found' });
//         }
//         const issue = txRes.rows[0];

//         const itemRes = await client.query(
//             `SELECT id, asset_id
//          FROM issue_item
//         WHERE transaction_id = $1`,
//             [id]
//         );
//         const curItem = itemRes.rows[0] || null;

//         const issueItem = await getIssueItemSnapshot(client, curItem.id);


//         // 1) mark issue as VOID
//         await client.query(
//             `UPDATE issue_transaction
//           SET status = 'VOID',
//               updated_at = now(),
//               voided_at = now(),
//               voided_by = $2
//         WHERE id = $1`,
//             [id, user_email]
//         );

//         // 2) mark its item(s) as VOID and update note is provided
//         if (note) {
//             await client.query(
//                 `UPDATE issue_item
//               SET note =
//                     CASE
//                       WHEN note IS NULL OR btrim(note) = '' THEN $2
//                       ELSE note || E'\n' || $2
//                     END,
//                   updated_at = now(),
//                   status = 'VOID',
//                   voided_at = now(),
//                   voided_by = $3
//             WHERE transaction_id = $1`,
//                 [id, note, user_email]
//             );
//         } else {
//             await client.query(
//                 `UPDATE issue_item
//               SET status = 'VOID',
//                   updated_at = now(),
//                   voided_at = now(),
//                   voided_by = $2
//             WHERE transaction_id = $1`,
//                 [id, user_email]
//             );
//         }


//         // 3) write movement reversal (optional but recommended)
//         if (curItem?.asset_id) {
//             await client.query(
//                 `INSERT INTO movements
//            (id, asset_id, from_location_id, to_location_id, reason, note, created_at, created_by_user, ref_type, ref_id)
//          VALUES
//            (gen_random_uuid(), $1, $2, $3, 'ISSUE_VOID', 'Issue voided', now(), $4, 'ISSUE', $5)`,
//                 [
//                     curItem.asset_id,
//                     issue.to_location_id,    // from = where it was issued
//                     issue.from_location_id,  // to   = revert back
//                     userId,
//                     id,
//                 ]
//             );

//             // 4) rollback asset location to original
//             await client.query(
//                 `UPDATE assets
//             SET location_id = $2, updated_at = now()
//           WHERE id = $1`,
//                 [curItem.asset_id, issue.from_location_id]
//             );
//         }

//         console.log('Issue item', issueItem);



//         // AFTER snapshot (synthetic)
//         const after = { status: 'VOID' };

//         // AUDIT
//         await auditSafe(client, {
//             action: 'ISSUE_VOID',
//             entity_type: 'issue_item',
//             entity_id: issueItem.id,
//             ref_type: 'issue_transaction',
//             ref_id: txRes.rows[0].id,
//             actor_email: user_email,
//             summary: `Voided issue item for ${issueItem.asset_title || issueItem.asset_id}`,
//             after_data: after
//         });

//         // 🔔 Send email if enabled
//         await sendNotificationIfEnabled(
//             "ISSUE_VOID",
//             `Issue Voided: Voided ${issueItem.asset_title}`,
//             `<p>Issued ${issueItem.asset_title || issueItem.asset_tag || issueItem.company_asset_id || issueItem.asset_id} for reason ${note} </p>`
//         );


//         await client.query('COMMIT');
//         return res.json({ ok: true, voided: id });
//     } catch (e) {
//         try { await client.query('ROLLBACK'); } catch (_) { }
//         console.error('[DELETE /issues/:id] failed:', e);
//         return res.status(400).json({ error: e.message || 'Failed to void issue' });
//     } finally {
//         client.release();
//     }
// });




// --- in src/routes/issues.js ---
// PATCH /issues/:id/return
router.patch('/:id/return', idempotency, async (req, res) => {
    const { id } = req.params; // issue_transaction.id
    const { note, user_email, asset_status } = req.body || {};

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1 Load the issue and its related item
        const { rows: txRows } = await client.query(`
      SELECT
        it.id AS tx_id,
        it.status AS tx_status,
        it.reference,
        it.from_location_id,
        it.external_location_id,
        it.created_by,
        ii.id AS item_id,
        ii.asset_id,
        ii.status AS item_status,
        ii.returned_at,
        a.location_id AS asset_location_id
      FROM issue_transaction it
      LEFT JOIN issue_item ii ON ii.transaction_id = it.id
      LEFT JOIN assets a ON a.id = ii.asset_id
      WHERE it.id = $1
      LIMIT 1
    `, [id]);

        if (!txRows.length) throw new Error('Issue not found.');
        const tx = txRows[0];

        if (!tx.item_id)
            throw new Error('No item found for this issue.');
        if (tx.item_status !== 'ISSUED' || tx.returned_at)
            throw new Error('Item already returned or not in ISSUED state.');
        if (tx.tx_status === 'VOID')
            throw new Error('Cannot return item from a VOID issue.');

        // 2 Determine destination — always back to original internal location
        const destLocationId = tx.from_location_id;
        if (!destLocationId)
            throw new Error('Original from_location_id missing; cannot return.');

        // 3 Update issue_item to mark returned
        await client.query(`
      UPDATE issue_item
      SET
        returned_at = now(),
        status = 'RETURNED',
        note = CASE
                 WHEN $2::text IS NULL OR $2 = '' THEN note
                 WHEN note IS NULL THEN $2
                 ELSE note || E'\n' || $2
               END,
        updated_at = now(),
        updated_by = $3,
        returned_by = $3
      WHERE id = $1
    `, [tx.item_id, note || null, user_email]);

        // 4 Move asset back to original internal location
        await client.query(`
      UPDATE assets
      SET
        location_id = $1,
        updated_at = now(),
        status = $4,
        updated_by_user = $3
      WHERE id = $2
    `, [destLocationId, tx.asset_id, user_email, asset_status]);

        //     // 5️⃣ Record movement log
        //     await client.query(`
        //   INSERT INTO movements(
        //     id, asset_id, from_location_id, to_location_id,
        //     reason, note, ref_type, ref_id,
        //     created_at, created_by_user
        //   )
        //   VALUES (
        //     gen_random_uuid(), $1, $2, $3,
        //     'RETURN', $4, 'RETURN', $5,
        //     now(), $6
        //   )
        // `, [
        //         tx.asset_id,
        //         tx.external_location_id, // FROM (external)
        //         destLocationId,          // TO (internal/original)
        //         note || null,
        //         tx.tx_id,
        //         user_email
        //     ]);

        //5 Check if all items are returned
        const { rows: remRows } = await client.query(`
      SELECT COUNT(*)::int AS remaining
      FROM issue_item
      WHERE transaction_id = $1
        AND status = 'ISSUED'
        AND returned_at IS NULL
    `, [tx.tx_id]);

        if (remRows[0].remaining === 0) {
            await client.query(`
        UPDATE issue_transaction
        SET
          status = 'CLOSED',
          updated_at = now(),
          updated_by = $2,
          returned_at = now(),
          returned_by = $2
        WHERE id = $1
      `, [tx.tx_id, user_email]);
        } else {
            await client.query(`
        UPDATE issue_transaction
        SET updated_at = now(),
            updated_by = $2
        WHERE id = $1
      `, [tx.tx_id, user_email]);
        }

        // 6 Audit log
        const issue_item_snapshot = await getIssueItemSnapshot(client, tx.item_id);
        const issued_asset_title = issue_item_snapshot.asset_title;
        const issued_asset_id = issue_item_snapshot.asset_id;

        await auditSafe(client, {
            action: 'ISSUE_RETURN',
            entity_type: 'issue_item',
            entity_id: issue_item_snapshot.id,
            ref_type: 'issue_transaction',
            ref_id: tx.tx_id,
            actor_email: user_email,
            summary: `Returned issue item for ${issued_asset_title} | ${issued_asset_id}`,
            after_data: null
        });

        // 7 Send optional notification
        await sendNotificationIfEnabled(
            "ISSUE_RETURN",
            `Issue Returned: Returned issue item for ${issue_item_snapshot.asset_title || issue_item_snapshot.asset_id}`,
            `<p>Returned issue item for ${issue_item_snapshot.asset_title || issue_item_snapshot.asset_id} by user ${user_email} </p>`
        );

        await client.query('COMMIT');
        res.json({ ok: true, issue_id: tx.tx_id });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[PATCH /issues/:id/return] failed:', e);
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
});


//Old retuen logic with internal location
// router.patch('/:id/return', async (req, res) => {
//     const { id } = req.params;                  // issue_transaction.id (UUID)
//     const { note } = req.body || {};
//     // adjust this to however you store auth; fallback keeps local dev easy
//     const { user_email } = req.body || {};

//     console.log('ID', id);

//     const client = await pool.connect();
//     try {
//         await client.query('BEGIN');

//         // 1) Load the issue and the single outstanding item (enforce your 1-asset-per-issue rule)
//         const loadSql = `
//       SELECT
//         it.id                               AS tx_id,
//         it.status                           AS tx_status,
//         it.from_location_id,
//         it.to_location_id,
//         it.reference,
//         ii.id                               AS item_id,
//         ii.asset_id,
//         ii.status                           AS item_status,
//         ii.returned_at,
//         a.location_id                        AS asset_location_id
//       FROM issue_transaction it
//       LEFT JOIN issue_item ii
//         ON ii.transaction_id = it.id
//       LEFT JOIN assets a
//         ON a.id = ii.asset_id
//       WHERE it.id = $1
//       LIMIT 1
//     `;
//         const { rows: txRows } = await client.query(loadSql, [id]);
//         if (!txRows.length) {
//             throw new Error('Issue not found.');
//         }

//         const tx = txRows[0];

//         // Guard rails
//         if (!tx.item_id) {
//             throw new Error('No item found for this issue.');
//         }
//         if (tx.item_status !== 'ISSUED' || tx.returned_at) {
//             throw new Error('Item already returned (or not in ISSUED state).');
//         }
//         if (tx.tx_status === 'VOID') {
//             throw new Error('Cannot return an item for a void issue.');
//         }

//         // Destination for a "return" = original from_location_id
//         const destLocationId = tx.from_location_id;
//         if (!destLocationId) {
//             throw new Error('Original from_location_id missing; cannot return.');
//         }

//         // 2) Mark the item as RETURNED (+ append optional note)
//         const updateItemSql = `
//       UPDATE issue_item
//       SET
//         returned_at = now(),
//         status      = 'RETURNED',
//         note        = CASE
//                         WHEN $2::text IS NULL OR $2 = '' THEN note
//                         WHEN note IS NULL THEN $2
//                         ELSE note || E'\n' || $2
//                       END,
//         updated_at  = now(),
//         updated_by  = $3,
//         returned_by  = $3
//       WHERE id = $1
//     `;
//         await client.query(updateItemSql, [tx.item_id, note || null, user_email]);

//         // 3) Move the asset back to the original "from" location
//         const updateAssetSql = `
//       UPDATE assets
//       SET location_id = $1,
//           updated_at  = now(),
//           updated_by_user = $3
//       WHERE id = $2
//     `;
//         await client.query(updateAssetSql, [destLocationId, tx.asset_id, user_email]);

//         // 4) Write a movement record for the return
//         // NOTE: if your column is named created_by_user (common in earlier code), keep that name.
//         // 4) Write a movement record for the return
//         const insertMoveSql = `
//             INSERT INTO movements(
//                 id, asset_id, from_location_id, to_location_id,
//                 reason, note, ref_type, ref_id,
//                 created_at, created_by_user
//             )
//             VALUES (
//                 gen_random_uuid(), $1, $2, $3,
//                 'RETURN', $4, 'RETURN', $5,
//                 now(), $6
//             )
//         `;
//         await client.query(insertMoveSql, [
//             tx.asset_id,
//             tx.asset_location_id,   // from current location
//             destLocationId,         // to original "from"
//             note || null,
//             tx.tx_id,
//             user_email,
//         ]);


//         // 5) If all items on this issue are now returned, close the issue
//         const { rows: remRows } = await client.query(
//             `SELECT COUNT(*)::int AS remaining
//          FROM issue_item
//         WHERE transaction_id = $1
//           AND status = 'ISSUED'
//           AND returned_at IS NULL`,
//             [tx.tx_id]
//         );

//         if (remRows[0].remaining === 0) {
//             await client.query(
//                 `UPDATE issue_transaction
//             SET status = 'CLOSED',
//                 updated_at = now(),
//                 updated_by = $2,
//                 returned_at  = now(),
//                 returned_by  = $2
//           WHERE id = $1`,
//                 [tx.tx_id, user_email]
//             );
//         } else {
//             // still open, just bump the audit fields
//             await client.query(
//                 `UPDATE issue_transaction
//             SET updated_at = now(),
//                 updated_by = $2
//           WHERE id = $1`,
//                 [tx.tx_id, user_email]
//             );
//         }

//         const issue_item_snapshot = await getIssueItemSnapshot(client, tx.item_id);
//         //console.log('Issue', issue_item_snapshot);

//         await auditSafe(client, {
//             action: 'ISSUE_RETURN',
//             entity_type: 'issue_item',
//             entity_id: issue_item_snapshot.id,
//             ref_type: 'issue_transaction',
//             ref_id: issue_item_snapshot.id,
//             actor_email: user_email,
//             summary: `Return issue item for ${issue_item_snapshot.asset_title || issue_item_snapshot.asset_id}`,
//             after_data: null
//         });

//         // 🔔 Send email if enabled
//         await sendNotificationIfEnabled(
//             "ISSUE_RETURN",
//             `Issue Returned: Returned issue item for ${issue_item_snapshot.asset_title || issue_item_snapshot.asset_id}`,
//             `<p>Returned issue item for ${issue_item_snapshot.asset_title || issue_item_snapshot.asset_id} by user ${user_email} </p>`
//         );

//         await client.query('COMMIT');
//         res.json({ ok: true, issue_id: tx.tx_id });
//     } catch (e) {
//         await client.query('ROLLBACK');
//         res.status(400).json({ error: e.message });
//     } finally {
//         client.release();
//     }
// });





export default router;
