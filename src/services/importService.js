/**
 * Import Service (clean + stable names) — with JSONB + created_by_user
 * --------------------------------------------------------------------
 * Public API (names unchanged except importFromBuffer signature):
 *   - dryRunFromBuffer(buffer, filename, mappingJson)
 *   - importFromBuffer(buffer, filename, mappingJson, userEmail)
 *
 * Rules:
 *   - Only skip rows with empty barcode.
 *   - Location is OPTIONAL; if present we create/find the full path.
 *   - Upsert by barcode; only update fields provided in the row.
 *   - Movements are written only when we have a to_location_id.
 *   - Custom fields are merged into assets.attributes (jsonb).
 */

import * as XLSX from 'xlsx';
import crypto from 'crypto';
import { pool } from '../db.js';

/* ------------------------------------------------------------------ */
/* 1) Workbook parsing                                                  */
/* ------------------------------------------------------------------ */

function parseWorkbook(buf, filename) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Preserve blanks & empty rows
  const aoa = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true,
  });

  // True column count from sheet range (handles trailing empty cols)
  const range = XLSX.utils.decode_range(ws['!ref']);
  const colCount = range.e.c + 1;

  // Header detection helpers
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[_-]/g, '');
  const isBarcodeHeader = (s) => ['barcode', 'assetbarcode', 'barcodeid', 'bar code'].includes(norm(s));
  const looksLikeHeaderRow = (row) => {
    const hasBarcode = row.some(isBarcodeHeader);
    if (!hasBarcode) return false;
    const normed = row.map(norm);
    const hasAnother = [
      'location', 'locationpath', 'loc', 'site',
      'serialnumber', 'serial', 'sn',
      'title', 'status', 'category', 'partname', 'partdescription', 'type'
    ].some(k => normed.includes(k));
    return hasBarcode && hasAnother;
  };

  // Find header row (scan first 30)
  let headerIdx = -1;
  const scanLimit = Math.min(30, aoa.length);
  for (let i = 0; i < scanLimit; i++) {
    if (looksLikeHeaderRow(aoa[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    headerIdx = aoa.findIndex(r => r.some(c => String(c).trim() !== ''));
    if (headerIdx === -1) headerIdx = 0;
  }

  const headers = Array.from({ length: colCount }, (_, i) =>
    String((aoa[headerIdx] && aoa[headerIdx][i]) || '').trim()
  );

  const rows = aoa.slice(headerIdx + 1).map(arr => {
    const o = {};
    for (let i = 0; i < colCount; i++) {
      o[headers[i] || `col_${i + 1}`] = (arr && arr[i] !== undefined) ? arr[i] : '';
    }
    return o;
  });

  return { rows, headers, headerIdx };
}

const parseExcel = (...args) => parseWorkbook(...args);
const normHeader = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[_-]/g, '');

/* ------------------------------------------------------------------ */
/* 2) Auto-mapping + helpers                                           */
/* ------------------------------------------------------------------ */

function findHeader(headers, ...aliases) {
  const keys = headers.map(h => ({ raw: h, key: normHeader(h) }));
  const set = aliases.map(normHeader);
  const hit = keys.find(h => set.includes(h.key));
  return hit?.raw;
}

function guessMapping(headers) {
  return {
    barcode: findHeader(headers, 'barcode', 'assetbarcode', 'bar code'),
    location: findHeader(headers, 'location', 'locationpath', 'loc', 'site'),
    serial_number: findHeader(headers, 'serialnumber', 'serial', 'sn'),
    title: findHeader(headers, 'title', 'name', 'assetname'),
    category: findHeader(headers, 'category', 'group'),
    status: findHeader(headers, 'status', 'state'),
    tag: findHeader(headers, 'tag', 'label'),
    company_asset_id: findHeader(headers, 'companyassetid', 'assetid'),
    part_name: findHeader(headers, 'partname', 'part name'),
    part_description: findHeader(headers, 'partdescription', 'part desc', 'description'),
    type: findHeader(headers, 'type', 'subtype'),
    work_order_number: findHeader(headers, 'workordernumber', 'work order number', 'workorder', 'wo', 'won'),
  };
}

function buildAutoMapping(headers) {
  const g = guessMapping(headers);
  const columns = {};
  const add = (src, key) => { if (src) columns[src] = { target: 'builtin', key, type: 'string' }; };
  add(g.barcode, 'barcode');
  add(g.location, 'location_path'); // <- canonical
  add(g.serial_number, 'serial_number');
  add(g.title, 'title');
  add(g.category, 'category');
  add(g.status, 'status');
  add(g.tag, 'tag');
  add(g.company_asset_id, 'company_asset_id');
  add(g.part_name, 'part_name');
  add(g.part_description, 'part_description');
  add(g.type, 'type');
  add(g.work_order_number, 'work_order_number');
  return { columns };
}

/** Merge UI mapping with auto mapping; normalize location key to location_path. */
function mergeWithAutoMapping(headers, mappingJson) {
  const auto = buildAutoMapping(headers);
  const result = { columns: {} };

  // Copy UI mapping first
  if (mappingJson && mappingJson.columns) {
    for (const [src, cfg] of Object.entries(mappingJson.columns)) {
      const cpy = { ...cfg };
      if (cpy.target === 'builtin' && (cpy.key === 'location' || cpy.key === 'locationpath')) {
        cpy.key = 'location_path';
      }
      result.columns[src] = cpy;
    }
  }

  // Fill missing from auto
  for (const [src, cfg] of Object.entries(auto.columns)) {
    if (!result.columns[src]) {
      const cpy = { ...cfg };
      if (cpy.target === 'builtin' && (cpy.key === 'location' || cpy.key === 'locationpath')) {
        cpy.key = 'location_path';
      }
      result.columns[src] = cpy;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 3) Normalization + casting                                          */
/* ------------------------------------------------------------------ */

function cleanString(val) {
  if (val == null) return '';
  return String(val).replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, '').trim();
}

function cleanBarcode(val) {
  return cleanString(val).replace(/\s+/g, '');
}

function castValue(val, type) {
  if (val === '') return null; // do not overwrite with blanks
  if (type === 'number' || type === 'integer') return Number(val);
  if (type === 'boolean') return ['true', '1', 'yes'].includes(String(val).toLowerCase());
  if (type === 'date' || type === 'datetime') return new Date(val);
  return cleanString(val);
}

function applyMapping(rows, mappingJson) {
  if (!mappingJson || !mappingJson.columns) return rows;

  const out = [];
  for (const row of rows) {
    const mapped = { custom: {} };

    for (const [sourceHeader, cfg] of Object.entries(mappingJson.columns)) {
      const raw = row[sourceHeader];
      const v = castValue(raw, cfg.type || 'string');

      if (cfg.target === 'builtin' && cfg.key) {
        // Normalize "location" variants to canonical key
        let key = cfg.key;
        if (key === 'location' || key === 'locationpath') key = 'location_path';

        mapped[key] = (key === 'barcode') ? cleanBarcode(v) : v;
      } else if (cfg.target === 'custom' && cfg.slug) {
        mapped.custom[cfg.slug] = v;
      }
    }
    out.push(mapped);
  }
  return out;
}

function pickBuiltin(mapped) {
  const builtin = [
    'barcode',
    'location_path',
    'serial_number',
    'title',
    'category',
    'status',
    'tag',
    'company_asset_id',
    'part_name',
    'part_description',
    'type',
    'work_order_number',
  ];
  return Object.fromEntries(builtin.filter(k => mapped[k] !== undefined).map(k => [k, mapped[k]]));
}

/** Accepts parsed object or array; returns clean array of rows. */
function normalizeRows(parsed) {
  const arr = Array.isArray(parsed) ? parsed : (parsed?.rows || []);
  return arr
    .map(row => {
      const out = {};
      for (const [key, value] of Object.entries(row)) {
        if (!key) continue;
        const cleanKey = String(key).trim();
        const cleanVal = (typeof value === 'string') ? value.trim() : value;
        out[cleanKey] = cleanVal;
      }
      return out;
    })
    .filter(row => Object.values(row).some(v => v !== undefined && v !== null && v !== ''));
}

/* ------------------------------------------------------------------ */
/* 4) Validation                                                        */
/* ------------------------------------------------------------------ */

function validateRows(mappedRows) {
  const seen = new Set();
  const validRows = [];
  const invalidRows = [];

  let missingBarcode = 0;
  let missingLocation = 0;
  let dupInFile = 0;


  mappedRows.forEach((r, idx) => {
    const rowNum = idx + 2; // relative to header
    const errs = [];

    //console.log('rows', r);

    const bc = cleanBarcode(r?.barcode);
    if (!bc) {
      errs.push('missing barcode');
      missingBarcode++;
    }

    const loc = (r?.location_path || "").trim();
    //console.log('loc', loc);
    if (!loc) {
      errs.push('missing location');
      missingLocation++;
    }

    if (bc) {
      const k = bc.toLowerCase();
      if (seen.has(k)) { errs.push('duplicate barcode in file'); dupInFile++; }
      else seen.add(k);
    }

    if (errs.length) invalidRows.push({ row: rowNum, reason: errs.join(', ') });
    else {
      r.barcode = bc; // canonical
      validRows.push(r);
    }
  });

  return {
    validRows,
    invalidRows,
    counts: {
      total: mappedRows.length,
      valid: validRows.length,
      invalid: invalidRows.length,
      missing_barcode: missingBarcode,
      missing_location: missingLocation,
      duplicate_in_file: dupInFile,
    }
  };
}

/* ------------------------------------------------------------------ */
/* 5) Location helper (idempotent)                                     */
/* ------------------------------------------------------------------ */

async function ensureLocationPath(client, path, userEmail = null) {
  if (!path) return { id: null, createdCount: 0 };

  const parts = String(path)
    .split(/\s*>\s*|\/|\|/g)
    .map(s => s.trim())
    .filter(Boolean);

  if (!parts.length) return { id: null, createdCount: 0 };

  let parent = null;
  let created = 0;
  let currentPath = '';

  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    currentPath = i === 0 ? name : `${currentPath} > ${name}`;
    const depth = i + 1;

    const ins = await client.query(
      `INSERT INTO locations (name, parent_id, path, depth, created_at, updated_at, created_by_user)
       VALUES ($1,$2,$3,$4, now(), now(), $5)
       ON CONFLICT (path) DO NOTHING
       RETURNING id`,
      [name, parent, currentPath, depth, userEmail || null]
    );

    let id;
    if (ins.rows[0]) {
      id = ins.rows[0].id;
      created++;
    } else {
      const sel = await client.query(`SELECT id FROM locations WHERE path = $1 LIMIT 1`, [currentPath]);
      id = sel.rows[0]?.id ?? null;
    }
    parent = id;
  }

  return { id: parent, createdCount: created };
}

/* ------------------------------------------------------------------ */
/* 6) PUBLIC: Dry run                                                  */
/* ------------------------------------------------------------------ */

export async function dryRunFromBuffer(buffer, filename, mappingJson) {
  const parsed = parseExcel(buffer, filename);

  const effectiveMapping = mergeWithAutoMapping(parsed.headers, mappingJson);
  const rawRows = normalizeRows(parsed);
  const mappedRows = applyMapping(rawRows, effectiveMapping);

  const { validRows, invalidRows, counts } = validateRows(mappedRows);

  return {
    file: { filename, totalRows: counts.total },
    header: { headers: parsed.headers },
    counts,
    valid_rows: validRows.slice(0, 50),
    invalid_rows: invalidRows.slice(0, 50),
  };
}

/* ------------------------------------------------------------------ */
/* PUBLIC: Transactional import                                     */
/* ------------------------------------------------------------------ */

/** Turn row.custom -> proper jsonb param (or null). */
function attributesParam(row) {
  const custom = row?.custom || {};
  const keys = Object.keys(custom).filter(k => custom[k] !== null && custom[k] !== undefined && custom[k] !== '');
  if (!keys.length) return null;
  // We will cast with ::jsonb in SQL, so string is fine too
  return JSON.stringify(custom);
}

export async function importFromBuffer(buffer, filename, mappingJson, userEmail) {
  const parsed = parseExcel(buffer, filename);

  // Merge UI mapping with auto, then map
  const effectiveMapping = mergeWithAutoMapping(parsed.headers, mappingJson);
  const rawRows = normalizeRows(parsed);
  const mappedRows = applyMapping(rawRows, effectiveMapping);

  const { validRows, invalidRows, counts } = validateRows(mappedRows);

  const client = await pool.connect();
  const summary = {
    jobId: null,
    total: counts.total,
    createdAssets: 0,
    updatedAssets: 0,
    createdLocations: 0,
    movements: 0,
    invalid: counts.invalid,
    skipped: counts.invalid,
  };

  // Utility: file hash (import_jobs.file_hash is NOT NULL)
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // import_jobs (id, user_id?, filename, file_hash, total_rows, valid_rows, invalid_rows,
  // created_assets, updated_assets, created_locations, movements_logged, created_at,
  // mapping_id, mapping_snapshot, created_by_user)
  const startJob = async () => {
    const { rows } = await client.query(
      `INSERT INTO import_jobs
         (filename, file_hash, total_rows, valid_rows, invalid_rows, created_assets,
          updated_assets, created_locations, movements_logged, created_at, mapping_snapshot, created_by_user)
       VALUES ($1,$2,$3,$4,$5,0,0,0,0, now(), $6, $7)
       RETURNING id`,
      [filename, fileHash, counts.total, counts.valid, counts.invalid, effectiveMapping, userEmail || null]
    );
    return rows[0].id;
  };

  const updateJobTotals = async (jobId) => {
    await client.query(
      `UPDATE import_jobs
         SET created_assets = $2,
             updated_assets = $3,
             created_locations = $4,
             movements_logged = $5
       WHERE id = $1`,
      [jobId, summary.createdAssets, summary.updatedAssets, summary.createdLocations, summary.movements]
    );
  };

  // import_job_items (id, job_id, row_number, barcode, location_path, status, message, asset_id, location_id, created_by_user)
  const logItem = async ({ jobId, rowNumber, barcode, locationPath, status, message, assetId, locationId }) => {
    await client.query(
      `INSERT INTO import_job_items
         (job_id, row_number, barcode, location_path, status, message, asset_id, location_id, created_by_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [jobId, rowNumber, barcode || null, locationPath || null, status, message || null, assetId || null, locationId || null, userEmail || null]
    );
  };

  // Movement helper (write only if to_location_id not null)
  async function recordMovementTx(assetId, fromLoc, toLoc, note) {
    //if (!toLoc) return 0; // respect NOT NULL on to_location_id
    if (!toLoc || fromLoc === toLoc) return 0;
    await client.query(
      `INSERT INTO movements (asset_id, from_location_id, to_location_id, reason, note, created_at, created_by_user)
       VALUES ($1,$2,$3,$4,$5, now(), $6)`,
      [assetId, fromLoc, toLoc, 'bulk-import', note || null, userEmail || null]
    );
    return 1;
  }

  // Upsert asset by barcode; only update provided columns; merge attributes jsonb
  async function upsertAssetTx(row, locationId) {
    const { rows: prev } = await client.query(
      `SELECT id, location_id FROM assets WHERE barcode = $1`,
      [row.barcode]
    );

    const attrs = attributesParam(row); // JSON string or null

    if (prev[0]) {
      const assetId = prev[0].id;
      const prevLocId = prev[0].location_id;

      await client.query(
        `UPDATE assets SET
           serial_number     = COALESCE($1, serial_number),
           title             = COALESCE($2, title),
           category          = COALESCE($3, category),
           status            = COALESCE($4, status),
           tag               = COALESCE($5, tag),
           company_asset_id  = COALESCE($6, company_asset_id),
           part_name         = COALESCE($7, part_name),
           part_description  = COALESCE($8, part_description),
           type              = COALESCE($9, type),
           work_order_number = COALESCE($10, work_order_number),
           location_id       = COALESCE($11, location_id),
           attributes        = CASE
                                  WHEN $12::jsonb IS NULL THEN attributes
                                  ELSE COALESCE(attributes, '{}'::jsonb) || $12::jsonb
                               END,
           updated_at        = now()
         WHERE id = $13`,
        [
          row.serial_number ?? null,
          row.title ?? null,
          row.category ?? null,
          row.status ?? null,
          row.tag ?? null,
          row.company_asset_id ?? null,
          row.part_name ?? null,
          row.part_description ?? null,
          row.type ?? null,
          row.work_order_number ?? null,
          locationId,               // may be null
          attrs,                    // jsonb merge
          assetId,
        ]
      );
      return { assetId, inserted: false, prevLocId, newLocId: locationId ?? prevLocId };
    } else {
      const { rows: ins } = await client.query(
        `INSERT INTO assets
           (barcode, serial_number, title, category, status, tag, company_asset_id,
            part_name, part_description, type, work_order_number, location_id,
            attributes, created_at, updated_at, created_by_user)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
            COALESCE($13::jsonb, '{}'::jsonb), now(), now(), $14)
         RETURNING id, location_id`,
        [
          row.barcode,
          row.serial_number ?? null,
          row.title ?? null,
          row.category ?? null,
          row.status ?? null,
          row.tag ?? null,
          row.company_asset_id ?? null,
          row.part_name ?? null,
          row.part_description ?? null,
          row.type ?? null,
          row.work_order_number ?? null,
          locationId,               // may be null
          attrs,                    // jsonb
          userEmail || null,
        ]
      );
      return { assetId: ins[0].id, inserted: true, prevLocId: null, newLocId: ins[0].location_id };
    }
  }

  try {
    await client.query('BEGIN');

    const jobId = await startJob();
    summary.jobId = jobId;

    // Log invalid rows
    for (const inv of invalidRows) {
      await logItem({
        jobId,
        rowNumber: inv.row,
        barcode: null,
        locationPath: null,
        status: 'invalid',
        message: inv.reason,
        assetId: null,
        locationId: null,
      });
    }

    // Process valid rows
    for (let i = 0; i < validRows.length; i++) {
      const r = validRows[i];

      // Accept any alias if it slipped through mapping
      const locPath = r.location_path ?? r.location ?? r.locationpath ?? r['Location'] ?? null;

      let locationId = null;
      if (locPath) {
        const { id, createdCount } = await ensureLocationPath(client, locPath, userEmail || null);
        locationId = id;
        summary.createdLocations += createdCount;
      }

      const { assetId, inserted, prevLocId, newLocId } = await upsertAssetTx(r, locationId);

      // Movements
      let moved = 0;

      if (inserted) {
        // Always log movement for new asset
        moved = await recordMovementTx(assetId, null, newLocId, 'created from bulk import');
        summary.createdAssets++;

        await logItem({
          jobId,
          rowNumber: i + 2,
          barcode: r.barcode,
          locationPath: locPath || null,
          status: 'created',
          message: 'new asset created',
          assetId,
          locationId: newLocId || null,
        });
      } else {
        // Only log movement if location changed
        const locationChanged = prevLocId !== newLocId;
        if (locationChanged) {
          moved = await recordMovementTx(assetId, prevLocId, newLocId, 'location changed during import');
        }

        summary.updatedAssets++;
        await logItem({
          jobId,
          rowNumber: i + 2,
          barcode: r.barcode,
          locationPath: locPath || null,
          status: locationChanged ? 'moved' : 'updated',
          message: locationChanged ? 'location changed' : 'no change',
          assetId,
          locationId: newLocId || null,
        });
      }

      summary.movements += moved;

      // if (inserted) {
      //   moved = await recordMovementTx(assetId, null, newLocId, 'created from bulk import');
      //   summary.createdAssets++;
      //   await logItem({
      //     jobId,
      //     rowNumber: i + 2,
      //     barcode: r.barcode,
      //     locationPath: locPath || null,
      //     status: 'created',
      //     message: null,
      //     assetId,
      //     locationId: newLocId || null,
      //   });
      // } else {
      //   moved = await recordMovementTx(assetId, prevLocId, newLocId, (prevLocId !== newLocId) ? 'location changed' : null);
      //   summary.updatedAssets++;
      //   await logItem({
      //     jobId,
      //     rowNumber: i + 2,
      //     barcode: r.barcode,
      //     locationPath: locPath || null,
      //     status: 'updated',
      //     message: (prevLocId !== newLocId) ? 'location changed' : null,
      //     assetId,
      //     locationId: newLocId || null,
      //   });
      // }

    }

    await updateJobTotals(jobId);
    await client.query('COMMIT');

    // helpful log
    const withLoc = validRows.filter(r => (r.location_path ?? r.location ?? r.locationpath)).length;
    console.log(`[import] rows: ${counts.total} with location_path: ${withLoc}`);
    if (validRows[0]) console.log('[import] first row sample:', validRows[0]);

    return summary;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import] failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* 8) Exports (names unchanged)                                        */
/* ------------------------------------------------------------------ */
export default {
  applyMapping,
  castValue,
  pickBuiltin,
  // keep these available in case other modules import them
  parseWorkbook,
  parseExcel,
  guessMapping,
  buildAutoMapping,
  mergeWithAutoMapping,
  validateRows,
  ensureLocationPath,
  normalizeRows,
  cleanBarcode,
  cleanString,
};
