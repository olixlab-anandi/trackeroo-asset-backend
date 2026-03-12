import express from 'express';
import { pool } from '../db.js';
import ImportService from '../services/importService.js';
import { auditSafe } from '../services/audit.js';
import QueryStream from 'pg-query-stream';


const { ensureLocationPath } = ImportService;
const router = express.Router();

//router.get('/ok', (_req, res) => res.json({ ok: true, scope: 'audit' }));

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsvLine(row, columns) {
  return columns.map((c) => csvEscape(row[c])).join(',') + '\n';
}

// src/routes/audit.js
router.get('/', async (req, res) => {
  const {
    from, to, actor, action, entityType, q,
    page = 1, pageSize = 50, hasChanges
  } = req.query;

  const values = [];
  const where = [];

  if (from) { values.push(from); where.push(`occurred_at >= $${values.length}`); }
  if (to) { values.push(to); where.push(`occurred_at <  $${values.length}`); }
  if (actor) { values.push(actor); where.push(`actor_email = $${values.length}`); }
  if (action) { values.push(action); where.push(`action = $${values.length}`); }
  if (entityType) { values.push(entityType); where.push(`entity_type = $${values.length}`); }
  if (hasChanges === 'true') where.push(`(before_data IS DISTINCT FROM after_data)`);

  // naive text search across summary + JSON stringification
  if (q && q.trim()) {
    values.push(`%${q.trim()}%`);
    const idx = values.length;
    where.push(`(
      summary ILIKE $${idx} OR
      actor_email ILIKE $${idx} OR
      before_data::text ILIKE $${idx} OR
      after_data::text  ILIKE $${idx}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 50));
  const offset = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limit);

  const listSql = `
    SELECT id, occurred_at, actor_email, action, entity_type, entity_id, ref_type, ref_id, summary,
           (CASE WHEN before_data IS DISTINCT FROM after_data THEN 1 ELSE 0 END) AS has_changes
    FROM audit_events
    ${whereSql}
    ORDER BY occurred_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countSql = `SELECT COUNT(*) AS total FROM audit_events ${whereSql}`;

  const client = await pool.connect();
  try {
    const [rowsRes, countRes] = await Promise.all([
      client.query(listSql, values),
      client.query(countSql, values),
    ]);
    res.json({
      rows: rowsRes.rows,
      total: parseInt(countRes.rows[0].total, 10),
      page: Number(page), pageSize: limit
    });
  } finally {
    client.release();
  }
});

// router.get('/:id', async (req, res) => {
//   const { id } = req.params;
//   const { rows } = await pool.query(
//     `SELECT id, occurred_at, actor_email, action, entity_type, entity_id, ref_type, ref_id,
//             summary, before_data, after_data
//      FROM audit_events
//      WHERE id = $1`, [id]
//   );
//   if (!rows[0]) return res.status(404).json({ error: 'Not found' });
//   res.json({ audit: rows[0] });
// });


// router.get('/options', async (_req, res) => {
//   const [actions, types, actors] = await Promise.all([
//     pool.query(`SELECT DISTINCT action FROM audit_events ORDER BY action`),
//     pool.query(`SELECT DISTINCT entity_type FROM audit_events ORDER BY entity_type`),
//     pool.query(`SELECT DISTINCT actor_email FROM audit_events WHERE actor_email IS NOT NULL ORDER BY actor_email`),
//   ]);
//   res.json({
//     actions: actions.rows.map(r => r.action),
//     entityTypes: types.rows.map(r => r.entity_type),
//     actors: actors.rows.map(r => r.actor_email),
//   });
// });


router.get('/options', async (req, res) => {
  try {
    const [actions, types, actors] = await Promise.all([
      pool.query('SELECT DISTINCT action      FROM audit_events ORDER BY action'),
      pool.query('SELECT DISTINCT entity_type FROM audit_events ORDER BY entity_type'),
      pool.query('SELECT DISTINCT actor_email FROM audit_events WHERE actor_email IS NOT NULL ORDER BY actor_email'),
    ]);
    res.json({
      actions: actions.rows.map(r => r.action),
      types: types.rows.map(r => r.entity_type),
      actors: actors.rows.map(r => r.actor_email),
    });
  } catch (e) {
    console.error('[GET /audits/options] failed:', e);
    res.status(500).json({ error: 'Failed to load options' });
  }
});


// STREAMING CSV EXPORT (scalable, backpressure-safe)
// Place this BEFORE router.get('/:id', ...)
router.get('/export.csv', async (req, res) => {
  const {
    from, to, actor, action, entityType, q,
    hasChanges
  } = req.query;

  const values = [];
  const where = [];

  if (from) { values.push(from); where.push(`occurred_at >= $${values.length}`); }
  if (to) { values.push(to); where.push(`occurred_at <  $${values.length}`); }
  if (actor) { values.push(actor); where.push(`actor_email = $${values.length}`); }
  if (action) { values.push(action); where.push(`action = $${values.length}`); }
  if (entityType) { values.push(entityType); where.push(`entity_type = $${values.length}`); }
  if (hasChanges === 'true') where.push(`(before_data IS DISTINCT FROM after_data)`);

  if (q && q.trim()) {
    values.push(`%${q.trim()}%`);
    const idx = values.length;
    where.push(`(
      summary ILIKE $${idx} OR
      actor_email ILIKE $${idx} OR
      before_data::text ILIKE $${idx} OR
      after_data::text  ILIKE $${idx}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const columns = [
    'id',
    'occurred_at',
    'actor_email',
    'action',
    'entity_type',
    'entity_id',
    'ref_type',
    'ref_id',
    'summary',
    'has_changes',
    'before_data',
    'after_data',
  ];

  const exportSql = `
    SELECT
      id,
      occurred_at,
      actor_email,
      action,
      entity_type,
      entity_id,
      ref_type,
      ref_id,
      summary,
      (CASE WHEN before_data IS DISTINCT FROM after_data THEN 1 ELSE 0 END) AS has_changes,
      before_data,
      after_data
    FROM audit_events
    ${whereSql}
    ORDER BY occurred_at DESC
  `;

  let client;
  let released = false;            // ✅ ADDED
  let queryStream = null;          // ✅ ADDED

  const safeRelease = () => {      // ✅ ADDED
    if (released) return;
    released = true;
    try { client?.release(); } catch { }
  };

  const safeEnd = () => {          // ✅ ADDED
    try { res.end(); } catch { }
  };

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_${ts}.csv"`);
    res.setHeader('Cache-Control', 'no-store');

    // header
    res.write(columns.join(',') + '\n');

    client = await pool.connect();

    const stream = new QueryStream(exportSql, values, { highWaterMark: 500 });
    queryStream = client.query(stream);

    // If the client disconnects mid-stream, stop everything safely
    req.on('close', () => {
      // close can fire after 'end' too -> safeRelease prevents double release
      try { queryStream?.destroy(); } catch { }
      safeRelease();
    });

    queryStream.on('data', (row) => {
      const line = toCsvLine(row, columns);
      if (!res.write(line)) {
        queryStream.pause();
        res.once('drain', () => queryStream.resume());
      }
    });

    queryStream.on('end', () => {
      safeEnd();
      safeRelease();
    });

    queryStream.on('error', (err) => {
      console.error('[GET /audits/export.csv] stream error:', err);
      safeEnd();
      safeRelease();
    });

  } catch (e) {
    console.error('[GET /audits/export.csv] failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    else safeEnd();
    safeRelease();
  }
});



// DETAIL ROUTE WITH UUID GUARD
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, occurred_at, actor_email, action, entity_type, entity_id,
              ref_type, ref_id, summary, before_data, after_data
       FROM audit_events
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ audit: rows[0] });
  } catch (e) {
    console.error('[GET /audits/:id] failed:', e);
    res.status(500).json({ error: 'Failed to load audit detail' });
  }
});





export default router;
