// routes/locations.js
import express from 'express';
import { pool } from '../db.js';
import ImportService from '../services/importService.js';
import { auditSafe } from '../services/audit.js';
import { stringifyTree } from '../services/stringifyTree.js';
import { getLocationSnapshot, getLocationSubtree } from '../services/locationSnapshots.js';
import { sendNotificationIfEnabled } from '../services/emailNotificationHelper.js';


const { ensureLocationPath } = ImportService;

const router = express.Router();

/* ----------------------------- helpers ----------------------------- */

async function getLocationById(client, id) {
  const { rows } = await client.query(
    `SELECT
       l.id, l.name, l.parent_id, l.path, l.depth, l.barcode,
       EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = l.id) AS has_children
     FROM locations l
     WHERE l.id = $1`,
    [id]
  );
  return rows[0] || null;
}

function buildPath(parentRow, name) {
  const selfName = name.trim();
  if (!parentRow) return { path: selfName, depth: 1 };
  return {
    path: `${parentRow.path} > ${selfName}`,
    depth: parentRow.depth + 1,
  };
}

async function rewriteDescendantPaths(client, oldPrefix, newPrefix) {
  // Only rewrite rows whose path starts with the old prefix (plus separator if needed)
  // Example: oldPrefix = "HQ > Floor 1", newPrefix = "HQ > Floor 101"
  // child "HQ > Floor 1 > Room A" -> "HQ > Floor 101 > Room A"
  await client.query(
    `UPDATE locations
     SET path = newvals.new_path,
         depth = newvals.new_depth,
         updated_at = now()
     FROM (
       SELECT
         id,
         new_path,
         (length(new_path) - length(replace(new_path, '>', ''))) + 1 AS new_depth
       FROM (
         SELECT
           l.id,
           $2 || substring(l.path FROM length($1) + 1) AS new_path
         FROM locations l
         WHERE l.path LIKE $1 || ' > %'
       ) s
     ) AS newvals
     WHERE locations.id = newvals.id`,
    [oldPrefix, newPrefix]
  );
}

async function getAssetCount(clientOrPool, locationId) {
  const { rows } = await clientOrPool.query(
    'SELECT COUNT(*)::int AS count FROM assets WHERE location_id = $1',
    [locationId]
  );
  return rows[0].count;
}

async function locationExists(clientOrPool, id) {
  const { rows } = await clientOrPool.query(
    'SELECT id, name, active FROM locations WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

/* ---------------------------- GET /locations ---------------------------- */
/** List with search + pagination */
router.get('/', async (req, res) => {
  const { search = '', page = 1, pageSize = 25 } = req.query;
  const p = Math.max(1, Number(page));
  const ps = Math.max(1, Math.min(200, Number(pageSize)));
  const offset = (p - 1) * ps;

  const where = ["l.active = true"];
  const params = [];
  if (search.trim()) {
    params.push(`%${search.trim()}%`);
    where.push('(l.name ILIKE $' + params.length + ' OR l.path ILIKE $' + params.length + ')');
  }
  const whereSQL = `WHERE ${where.join(' AND ')}`;

  try {
    const client = await pool.connect();
    try {
      const totalSql = `SELECT COUNT(*) AS cnt FROM locations l ${whereSQL}`;
      const totalRes = await client.query(totalSql, params);
      const total = Number(totalRes.rows[0]?.cnt || 0);

      const itemsSql = `
        SELECT
          l.id, l.name, l.parent_id, l.path, l.depth,
          EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = l.id AND c.active = true) AS has_children
        FROM locations l
        ${whereSQL}
        ORDER BY l.path ASC
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `;
      const itemsRes = await client.query(itemsSql, [...params, ps, offset]);
      res.json({ items: itemsRes.rows, total });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[GET /locations] failed:', e);
    res.status(500).json({ error: 'Failed to load locations' });
  }
});

/* ------------------------- GET /locations/roots ------------------------ */
router.get('/roots', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         l.id, l.name, l.parent_id, l.path, l.depth, l.barcode,
         EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = l.id AND c.active = true) AS has_children
       FROM locations l
       WHERE l.parent_id IS NULL
       AND l.active = true
       ORDER BY l.name ASC`
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('[GET /locations/roots] failed:', e);
    res.status(500).json({ error: 'Failed to load root locations' });
  }
});

/* ---------------------- GET /locations/children ----------------------- */
/** ?parent_id=UUID */
router.get('/children', async (req, res) => {
  const { parent_id } = req.query;
  if (!parent_id) return res.status(400).json({ error: 'parent_id is required' });

  try {
    const { rows } = await pool.query(
      `SELECT
         l.id, l.name, l.parent_id, l.path, l.depth, l.barcode,
         EXISTS (
          SELECT 1 FROM locations c WHERE c.parent_id = l.id AND c.active = true
         ) AS has_children
       FROM locations l
       WHERE l.parent_id = $1
       AND l.active = true
       ORDER BY l.name ASC`,
      [parent_id]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('[GET /locations/children] failed:', e);
    res.status(500).json({ error: 'Failed to fetch children' });
  }
});

/* -------------------------- GET /locations/search -------------------------- */
/** ?q= */
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ items: [] });

  try {
    const { rows } = await pool.query(
      `SELECT
         l.id, l.name, l.parent_id, l.path, l.depth, l.barcode,
         EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = l.id) AS has_children
       FROM locations l
       WHERE l.name ILIKE $1 OR l.path ILIKE $1
       ORDER BY l.path ASC
       LIMIT 50`,
      [`%${q}%`]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('[GET /locations/search] failed:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

/* ---------------------------- POST /locations ---------------------------- */
/** Create single location (optionally under parent_id) */
router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  const parent_id = req.body.parent_id || null;
  const user_email = req.body.user_email || null;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const parent = parent_id ? await getLocationById(client, parent_id) : null;
    if (parent_id && !parent) throw new Error('Parent not found');

    const { path, depth } = buildPath(parent, name);

    // Uniqueness on path
    const exists = await client.query('SELECT 1 FROM locations WHERE path = $1 LIMIT 1', [path]);
    if (exists.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A location with this path already exists' });
    }

    const { rows } = await client.query(
      `INSERT INTO locations (name, parent_id, path, depth, created_by_user, updated_by_user)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING
         id, name, parent_id, path, depth,
         EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = locations.id) AS has_children`,
      [name, parent_id, path, depth, user_email]
    );

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /locations] failed:', e);
    res.status(500).json({ error: 'Failed to create location' });
  } finally {
    client.release();
  }
});

/* ------------------- POST /locations/bulkCreateRoot ------------------- */
/** Add modal – create a new parent and nested children in one shot */
// router.post('/bulkCreateRoot', async (req, res) => {
//   const parent_name = (req.body.parent_name || '').trim();
//   const tree = Array.isArray(req.body.tree) ? req.body.tree : [];
//   const user_email = (req.headers['x-user-email'] || req.headers['X-User-Email'] || '').toString().trim() || null;
//   const childArray = [];

//   //console.log('email', user_email);


//   if (!parent_name) return res.status(400).json({ error: 'Parent name is required' });

//   const client = await pool.connect();
//   try {
//     await client.query('BEGIN');

//     // 1) Create the parent at root
//     const parentPath = parent_name;
//     const parentDepth = 1;

//     const dupe = await client.query('SELECT 1 FROM locations WHERE path = $1', [parentPath]);
//     if (dupe.rowCount) {
//       await client.query('ROLLBACK');
//       return res.status(409).json({ error: 'Parent with this name/path already exists' });
//     }

//     const parentIns = await client.query(
//       `INSERT INTO locations (name, parent_id, path, depth, created_by_user, updated_by_user)
//        VALUES ($1, NULL, $2, $3, $4, NULL, $5)
//        RETURNING id, name, parent_id, path, depth,
//          EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = locations.id) AS has_children`,
//       [parent_name, parentPath, parentDepth, user_email]
//     );


//     const parent = parentIns.rows[0];
//     //console.log('aprent', parent);

//     // 2) Recursive insert children
//     async function insertChildren(parentRow, nodes) {
//       for (const n of nodes) {
//         const childName = (n.name || '').trim();
//         if (!childName) continue;

//         const childPath = `${parentRow.path} > ${childName}`;
//         // enforce uniqueness on path
//         const exists = await client.query('SELECT 1 FROM locations WHERE path = $1', [childPath]);
//         if (exists.rowCount) throw new Error(`Duplicate path "${childPath}"`);

//         //console.log('child path', childPath);
//         childArray.push(childPath);


//         const childIns = await client.query(
//           `INSERT INTO locations (name, parent_id, path, depth, created_by_user, updated_by_user)
//            VALUES ($1, $2, $3, $4, $5, $5)
//            RETURNING id, name, parent_id, path, depth,
//              EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = locations.id) AS has_children`,
//           [childName, parentRow.id, childPath, parentRow.depth + 1, user_email]
//         );

//         const childRow = childIns.rows[0];

//         if (Array.isArray(n.children) && n.children.length > 0) {
//           await insertChildren(childRow, n.children);
//         }
//       }
//     }



//     await insertChildren(parent, tree);

//     const jsonStringChilds = JSON.stringify(childArray);


//     // Insert Parent to Audit
//     await auditSafe(client, {
//       action: 'LOCATION_CREATE',
//       entity_type: 'location',
//       entity_id: parent.id,
//       actor_email: user_email,
//       summary: `Created location "${parent_name}"`,
//       before_data: null,
//       after_data: jsonStringChilds
//     });

//     // 🔔 Send email if enabled
//     await sendNotificationIfEnabled(
//       "LOCATION_CREATE",
//       `New Location Created`,
//       `<p>Created location ${jsonStringChilds} by ${user_email} </p>`
//     );


//     await client.query('COMMIT');
//     res.json(parent);
//   } catch (e) {
//     await client.query('ROLLBACK');
//     console.error('[POST /locations/bulkCreateRoot] failed:', e);
//     res.status(500).json({ error: e.message || 'Failed to save locations' });
//   } finally {
//     client.release();
//   }
// });

router.post('/bulkCreateRoot', async (req, res) => {
  const parent_name = (req.body.parent_name || '').trim();
  const barcode = (req.body.barcode || '').trim(); // ✅ added: capture parent barcode
  const tree = Array.isArray(req.body.tree) ? req.body.tree : [];
  const user_email = (req.headers['x-user-email'] || req.headers['X-User-Email'] || '').toString().trim() || null;
  const childArray = [];

  if (!parent_name) return res.status(400).json({ error: 'Parent name is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Create the parent at root
    const parentPath = parent_name;
    const parentDepth = 1;

    const dupe = await client.query('SELECT 1 FROM locations WHERE path = $1', [parentPath]);
    if (dupe.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Parent with this name/path already exists' });
    }

    const parentIns = await client.query(
      `INSERT INTO locations (name, parent_id, path, depth, created_by_user, updated_by_user, barcode)
       VALUES ($1, NULL, $2, $3, $4, NULL, $5)
       RETURNING id, name, parent_id, path, depth, barcode,
         EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = locations.id) AS has_children`,
      [parent_name, parentPath, parentDepth, user_email, barcode || null] // ✅ allow empty barcode
    );

    const parent = parentIns.rows[0];

    // 2) Recursive insert children
    async function insertChildren(parentRow, nodes) {
      for (const n of nodes) {
        const childName = (n.name || '').trim();
        const childBarcode = (n.barcode || '').trim(); // ✅ added: get barcode from frontend node
        if (!childName) continue;

        const childPath = `${parentRow.path} > ${childName}`;
        const exists = await client.query('SELECT 1 FROM locations WHERE path = $1', [childPath]);
        if (exists.rowCount) throw new Error(`Duplicate path "${childPath}"`);

        childArray.push(childPath);

        const childIns = await client.query(
          `INSERT INTO locations (name, parent_id, path, depth, created_by_user, updated_by_user, barcode)
           VALUES ($1, $2, $3, $4, $5, $5, $6)
           RETURNING id, name, parent_id, path, depth, barcode,
             EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = locations.id) AS has_children`,
          [childName, parentRow.id, childPath, parentRow.depth + 1, user_email, childBarcode || null] // ✅ pass barcode from frontend
        );

        const childRow = childIns.rows[0];

        if (Array.isArray(n.children) && n.children.length > 0) {
          await insertChildren(childRow, n.children);
        }
      }
    }

    await insertChildren(parent, tree);

    const jsonStringChilds = JSON.stringify(childArray);

    await auditSafe(client, {
      action: 'LOCATION_CREATE',
      entity_type: 'location',
      entity_id: parent.id,
      actor_email: user_email,
      summary: `Created location "${parent_name}"`,
      before_data: null,
      after_data: jsonStringChilds
    });

    await sendNotificationIfEnabled(
      "LOCATION_CREATE",
      `New Location Created`,
      `<p>Created location ${jsonStringChilds} by ${user_email}</p>`
    );

    await client.query('COMMIT');
    res.json(parent);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /locations/bulkCreateRoot] failed:', e);
    res.status(500).json({ error: e.message || 'Failed to save locations' });
  } finally {
    client.release();
  }
});


/* --------------------------- PUT /locations/:id --------------------------- */
/** Edit modal – rename + optional move under a new parent_id */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const name = (req.body.name || '').trim();
  const new_parent_id = req.body.parent_id ?? null; // allow explicit null
  const user_email = req.body.user_email || null;

  // BEFORE snapshot(s)
  const beforeOne = await getLocationSnapshot(client, id);
  if (!beforeOne) {
    await client.query('ROLLBACK');
    return res.status(404).json({ error: 'Location not found.' });
  }
  // Optionally capture full subtree before changes
  const beforeSubtree = await getLocationSubtree(client, id);


  if (!name) return res.status(400).json({ error: 'Name is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await getLocationById(client, id);
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Location not found' });
    }

    const parent = new_parent_id ? await getLocationById(client, new_parent_id) : null;
    if (new_parent_id && !parent) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'New parent not found' });
    }

    // Prevent moving under itself or its descendants
    if (new_parent_id && new_parent_id === id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot move a node under itself' });
    }
    if (new_parent_id && parent && parent.path.startsWith(current.path)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot move a node under its descendant' });
    }

    const oldPath = current.path;
    const { path: newPath, depth: newDepth } = buildPath(parent, name);

    // if path changes, enforce uniqueness
    if (newPath !== oldPath) {
      const dupe = await client.query('SELECT 1 FROM locations WHERE path = $1 LIMIT 1', [newPath]);
      if (dupe.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A location with this path already exists' });
      }
    }

    // Update the node
    await client.query(
      `UPDATE locations
       SET name = $1,
           parent_id = $2,
           path = $3,
           depth = $4,
           updated_at = now(),
           updated_by_user = $5
       WHERE id = $6`,
      [name, new_parent_id, newPath, newDepth, user_email, id]
    );

    // Rewrite descendants if path changed
    if (newPath !== oldPath) {
      await rewriteDescendantPaths(client, oldPath, newPath);
    }

    const updated = await getLocationById(client, id);
    await client.query('COMMIT');
    res.json(updated);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[PUT /locations/:id] failed:', e);
    res.status(500).json({ error: 'Failed to save changes' });
  } finally {
    client.release();
  }
});

/* ---------------------- PUT /locations/:id/tree ---------------------- */
/** Edit modal – add new children under this node in one save */
// routes/locations.js  (inside your router)

router.put('/:id/tree', async (req, res) => {
  const { id } = req.params;
  const {
    name,
    barcode,               // ✅ added
    new_parent_id,
    user_email,
    children = []
  } = req.body || {};

  const client = await pool.connect();
  let created = 0, updated = 0, deleted = 0;

  try {
    await client.query('BEGIN');

    // Load self
    const { rows: selfRows } = await client.query(
      'SELECT id, name, parent_id, path, depth, barcode FROM locations WHERE id = $1', // ✅ include barcode
      [id]
    );
    if (selfRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Location not found' });
    }
    let self = selfRows[0];

    const beforeOne = await getLocationSnapshot(client, id);
    if (!beforeOne) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Location not found.' });
    }
    const beforeSubtree = await getLocationSubtree(client, id);

    // 1️⃣ Optional rename or barcode update
    const newName = name?.trim() || self.name;
    const newBarcode = barcode?.trim() || null;

    if (newName !== self.name || newBarcode !== self.barcode) {
      const oldPath = self.path;
      const pathBits = oldPath.split(' > ');
      pathBits[pathBits.length - 1] = newName;
      const newPath = pathBits.join(' > ');

      await client.query(
        `UPDATE locations
           SET name = $1,
               path = $2,
               barcode = $3,           -- ✅ update barcode too
               updated_at = now(),
               updated_by_user = $4
         WHERE id = $5`,
        [newName, newPath, newBarcode, user_email, self.id]
      );
      updated++;

      // update descendants’ paths if renamed
      if (newName !== self.name) {
        await client.query(
          `UPDATE locations AS c
              SET path = $2 || substr(c.path, length($1) + 1),
                  updated_at = now(),
                  updated_by_user = $3
            WHERE c.path LIKE $1 || ' > %'`,
          [oldPath, newPath, user_email]
        );
      }

      // refresh self
      self.path = newPath;
      self.name = newName;
      self.barcode = newBarcode;
    }

    // 2️⃣ Optional re-parent (same as before)
    if (typeof new_parent_id !== 'undefined' && new_parent_id !== self.parent_id) {
      let newParent = null;
      if (new_parent_id) {
        const { rows: pRows } = await client.query(
          'SELECT id, path, depth FROM locations WHERE id = $1',
          [new_parent_id]
        );
        if (pRows.length === 0) throw new Error('New parent not found');
        newParent = pRows[0];
      }
      if (newParent && newParent.path.startsWith(self.path + ' >')) {
        throw new Error('Cannot move a location under its own subtree');
      }
      const oldPath = self.path;
      const newPath = newParent ? `${newParent.path} > ${self.name}` : self.name;

      await client.query(
        `UPDATE locations
            SET parent_id = $1,
                path = $2,
                depth = (SELECT COALESCE(array_length(regexp_split_to_array($2, '\\s>\\s'), 1), 1)),
                updated_at = now(),
                updated_by_user = $3
          WHERE id = $4`,
        [newParent ? newParent.id : null, newPath, user_email, self.id]
      );
      updated++;

      await client.query(
        `UPDATE locations AS c
            SET path = $2 || substr(c.path, length($1) + 1),
                depth = (SELECT COALESCE(array_length(regexp_split_to_array(
                        $2 || substr(c.path, length($1) + 1), '\\s>\\s'), 1), 1)),
                updated_at = now(),
                updated_by_user = $3
          WHERE c.path LIKE $1 || ' > %'`,
        [oldPath, newPath, user_email]
      );

      self.path = newPath;
      self.parent_id = newParent ? newParent.id : null;
      self.depth = newPath.split(' > ').length;
    }

    // 3️⃣ Upsert children recursively (with barcode)
    async function upsertSubtree(parent, items) {
      const incomingIds = new Set(items.filter(x => x.id && !x._deleted).map(x => x.id));

      const { rows: existing } = await client.query(
        'SELECT id, name, path, depth, barcode FROM locations WHERE parent_id = $1', // ✅ include barcode
        [parent.id]
      );
      const existingMap = new Map(existing.map(r => [r.id, r]));

      for (const item of items) {
        if (item._deleted) {
          if (item.id) {
            await client.query('DELETE FROM locations WHERE id = $1', [item.id]);
            deleted++;
          }
          continue;
        }

        const childName = (item.name || '').trim();
        const childBarcode = item.barcode?.trim() || null; // ✅ added
        if (!childName) continue;

        if (item.id && existingMap.has(item.id)) {
          const before = existingMap.get(item.id);
          const nameChanged = childName !== before.name;
          const barcodeChanged = childBarcode !== before.barcode;

          if (nameChanged || barcodeChanged) {
            const newPath = nameChanged ? `${parent.path} > ${childName}` : before.path;
            await client.query(
              `UPDATE locations
                  SET name = $1,
                      path = $2,
                      barcode = $3,      -- ✅ added
                      updated_at = now(),
                      updated_by_user = $4
                WHERE id = $5`,
              [childName, newPath, childBarcode, user_email, before.id]
            );
            updated++;

            if (nameChanged) {
              await client.query(
                `UPDATE locations AS c
                    SET path = $2 || substr(c.path, length($1) + 1),
                        updated_at = now(),
                        updated_by_user = $3
                  WHERE c.path LIKE $1 || ' > %'`,
                [before.path, newPath, user_email]
              );
              before.path = newPath;
              before.name = childName;
            }
            before.barcode = childBarcode;
          }

          await upsertSubtree(
            { id: before.id, path: `${parent.path} > ${childName}` },
            item.children || []
          );
        } else {
          // CREATE
          const childPath = `${parent.path} > ${childName}`;
          const childDepth = parent.path.split(' > ').length + 1;
          const { rows: ins } = await client.query(
            `INSERT INTO locations (name, barcode, parent_id, path, depth, created_by_user, updated_by_user)
             VALUES ($1, $2, $3, $4, $5, $6, $6)
             RETURNING id, path`,
            [childName, childBarcode, parent.id, childPath, childDepth, user_email]
          );
          created++;

          await upsertSubtree(
            { id: ins[0].id, path: childPath },
            item.children || []
          );
        }
      }

      for (const ex of existing) {
        if (!incomingIds.has(ex.id)) {
          await client.query('DELETE FROM locations WHERE id = $1', [ex.id]);
          deleted++;
        }
      }
    }

    if (Array.isArray(children)) {
      await upsertSubtree({ id: self.id, path: self.path }, children);
    }

    const afterOne = await getLocationSnapshot(client, self.id);
    const afterSubtree = await getLocationSubtree(client, self.id);

    await auditSafe(client, {
      action: 'LOCATION_EDIT',
      entity_type: 'location',
      entity_id: id,
      actor_email: user_email,
      summary: `Edited location "${beforeOne.name}" → "${afterOne.name}"`,
      before_data: { one: beforeOne, subtree: beforeSubtree || [] },
      after_data: { one: afterOne, subtree: afterSubtree || [] }
    });

    await sendNotificationIfEnabled(
      "LOCATION_EDIT",
      `Location Edited`,
      `<p>Edited location ${JSON.stringify(afterOne)} - ${JSON.stringify(afterSubtree)} by ${user_email}</p>`
    );

    await client.query('COMMIT');
    
    return res.json({
      ok: true,
      id: self.id,
      path: self.path,
      created,
      updated,
      deleted
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[locations PUT /:id/tree] failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to save changes' });
  } finally {
    client.release();
  }
});


// router.put('/:id/tree', async (req, res) => {
//   const { id } = req.params;

//   // body:
//   // {
//   //   name: string,                  // new name for this location (optional)
//   //   new_parent_id: string|null,    // re-parent under this id (optional)
//   //   user_email: string,            // required for auditing
//   //   children: [                    // new full desired children set (optional)
//   //     { id?: string, name: string, children?: [...] , _deleted?: boolean }
//   //   ]
//   // }
//   const {
//     name,
//     new_parent_id,
//     user_email,
//     children = []
//   } = req.body || {};

//   const client = await pool.connect();
//   let created = 0, updated = 0, deleted = 0;

//   // console.log('user_email', user_email);
//   // console.log('id', id);

//   try {
//     await client.query('BEGIN');

//     // Load self
//     const { rows: selfRows } = await client.query(
//       'SELECT id, name, parent_id, path, depth FROM locations WHERE id = $1',
//       [id]
//     );
//     if (selfRows.length === 0) {
//       await client.query('ROLLBACK');
//       return res.status(404).json({ error: 'Location not found' });
//     }
//     let self = selfRows[0];

//     //console.log('self', self);

//     // BEFORE snapshot(s)
//     const beforeOne = await getLocationSnapshot(client, id);
//     if (!beforeOne) {
//       await client.query('ROLLBACK');
//       return res.status(404).json({ error: 'Location not found.' });
//     }
//     // Optionally capture full subtree before changes
//     const beforeSubtree = await getLocationSubtree(client, id);

//     //console.log('beforeOne', beforeOne);
//     //console.log('beforeSubtree', beforeSubtree);





//     // 1) Optional rename
//     if (name && name.trim() && name.trim() !== self.name) {
//       const oldPath = self.path;
//       const newName = name.trim();
//       const pathBits = oldPath.split(' > ');
//       pathBits[pathBits.length - 1] = newName;
//       const newPath = pathBits.join(' > ');

//       // update self
//       await client.query(
//         `UPDATE locations
//            SET name = $1,
//                path = $2,
//                updated_at = now(),
//                updated_by_user = $3
//          WHERE id = $4`,
//         [newName, newPath, user_email, self.id]
//       );
//       updated++;

//       // update descendants’ paths (prefix replace)
//       await client.query(
//         `UPDATE locations AS c
//             SET path = $2 || substr(c.path, length($1) + 1),
//                 updated_at = now(),
//                 updated_by_user = $3
//           WHERE c.path LIKE $1 || ' > %'`,
//         [oldPath, newPath, user_email]
//       );

//       // refresh self
//       self.path = newPath;
//       self.name = newName;
//     }

//     // 2) Optional re-parent (move)
//     if (typeof new_parent_id !== 'undefined' && new_parent_id !== self.parent_id) {
//       // NULL means move to root
//       let newParent = null;
//       if (new_parent_id) {
//         const { rows: pRows } = await client.query(
//           'SELECT id, path, depth FROM locations WHERE id = $1',
//           [new_parent_id]
//         );
//         if (pRows.length === 0) {
//           throw new Error('New parent not found');
//         }
//         newParent = pRows[0];
//       }

//       // guard: cannot move under own subtree
//       if (newParent && newParent.path.startsWith(self.path + ' >')) {
//         throw new Error('Cannot move a location under its own subtree');
//       }

//       const oldPath = self.path;
//       const newPath = newParent ? `${newParent.path} > ${self.name}` : self.name;

//       await client.query(
//         `UPDATE locations
//             SET parent_id = $1,
//                 path = $2,
//                 depth = (SELECT COALESCE(array_length(regexp_split_to_array($2, '\\s>\\s'), 1), 1)),
//                 updated_at = now(),
//                 updated_by_user = $3
//           WHERE id = $4`,
//         [newParent ? newParent.id : null, newPath, user_email, self.id]
//       );
//       updated++;

//       // update descendants’ paths after move
//       await client.query(
//         `UPDATE locations AS c
//             SET path = $2 || substr(c.path, length($1) + 1),
//                 depth = (SELECT COALESCE(array_length(regexp_split_to_array(
//                         $2 || substr(c.path, length($1) + 1), '\\s>\\s'), 1), 1)),
//                 updated_at = now(),
//                 updated_by_user = $3
//           WHERE c.path LIKE $1 || ' > %'`,
//         [oldPath, newPath, user_email]
//       );

//       // refresh self
//       self.path = newPath;
//       self.parent_id = newParent ? newParent.id : null;
//       self.depth = newPath.split(' > ').length;
//     }

//     // 3) Upsert children under self (create/update/delete) RECURSIVELY
//     async function upsertSubtree(parent, items) {
//       // Build a set of incoming ids for deletion detection
//       const incomingIds = new Set(items.filter(x => x.id && !x._deleted).map(x => x.id));

//       // existing children under parent
//       const { rows: existing } = await client.query(
//         'SELECT id, name, path, depth FROM locations WHERE parent_id = $1',
//         [parent.id]
//       );
//       const existingMap = new Map(existing.map(r => [r.id, r]));

//       // handle create/update
//       for (const item of items) {
//         if (item._deleted) {
//           if (item.id) {
//             await client.query('DELETE FROM locations WHERE id = $1', [item.id]);
//             deleted++;
//           }
//           continue;
//         }

//         const childName = (item.name || '').trim();
//         if (!childName) continue;

//         if (item.id && existingMap.has(item.id)) {
//           // UPDATE (name change)
//           const before = existingMap.get(item.id);
//           if (childName !== before.name) {
//             const newPath = `${parent.path} > ${childName}`;
//             await client.query(
//               `UPDATE locations
//                   SET name = $1,
//                       path = $2,
//                       updated_at = now(),
//                       updated_by_user = $3
//                 WHERE id = $4`,
//               [childName, newPath, user_email, before.id]
//             );
//             updated++;

//             // update this child’s descendants’ paths
//             await client.query(
//               `UPDATE locations AS c
//                   SET path = $2 || substr(c.path, length($1) + 1),
//                       updated_at = now(),
//                       updated_by_user = $3
//                 WHERE c.path LIKE $1 || ' > %'`,
//               [before.path, newPath, user_email]
//             );
//             before.path = newPath;
//             before.name = childName;
//           }
//           // recurse for grandchildren
//           await upsertSubtree(
//             { id: before.id, path: `${parent.path} > ${childName}` },
//             item.children || []
//           );
//         } else {
//           // CREATE
//           const childPath = `${parent.path} > ${childName}`;
//           const childDepth = parent.path.split(' > ').length + 1;
//           const { rows: ins } = await client.query(
//             `INSERT INTO locations (name, parent_id, path, depth, created_by_user, updated_by_user)
//              VALUES ($1, $2, $3, $4, $5, $5)
//              RETURNING id, path`,
//             [childName, parent.id, childPath, childDepth, user_email]
//           );
//           created++;

//           // recurse for grandchildren (if any)
//           await upsertSubtree(
//             { id: ins[0].id, path: childPath },
//             item.children || []
//           );
//         }
//       }

//       // DELETE children that are not in incoming list (hard delete)
//       for (const ex of existing) {
//         if (!incomingIds.has(ex.id)) {
//           await client.query('DELETE FROM locations WHERE id = $1', [ex.id]);
//           deleted++;
//         }
//       }
//     }

//     // Only reconcile children if `children` is provided (so caller can skip this part)
//     if (Array.isArray(children)) {
//       await upsertSubtree({ id: self.id, path: self.path }, children);
//     }

//     // AFTER snapshot(s)
//     const afterOne = await getLocationSnapshot(client, self.id);
//     const afterSubtree = await getLocationSubtree(client, self.id);

//     //console.log('afterOne', afterOne);
//     //console.log('afterSubtree', afterSubtree);

//     await auditSafe(client, {
//       action: 'LOCATION_EDIT',
//       entity_type: 'location',
//       entity_id: id,
//       actor_email: user_email,
//       summary: `Edited location "${beforeOne.name}" → "${afterOne.name}"`,
//       before_data: {
//         one: beforeOne,
//         subtree: beforeSubtree || []
//       },
//       after_data: {
//         one: afterOne,
//         subtree: afterSubtree || []
//       }
//     });

//     // 🔔 Send email if enabled
//     await sendNotificationIfEnabled(
//       "LOCATION_EDIT",
//       `Location Edited`,
//       `<p>Edited location ${JSON.stringify(afterOne)} - ${JSON.stringify(afterSubtree)} by ${user_email} </p>`
//     );


//     await client.query('COMMIT');

//     // Return a small summary so FE can refresh confidently
//     return res.json({
//       ok: true,
//       id: self.id,
//       path: self.path,
//       created,
//       updated,
//       deleted
//     });
//   } catch (e) {
//     await client.query('ROLLBACK');
//     console.error('[locations PUT /:id/tree] failed:', e);
//     return res.status(500).json({ error: e.message || 'Failed to save changes' });
//   } finally {
//     client.release();
//   }
// });


/* ------------------------- DELETE /locations/:id ------------------------- */
// DELETE /locations/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    // 1) Does it exist?
    const locRes = await client.query(
      `SELECT id FROM locations WHERE id = $1`,
      [id]
    );
    if (locRes.rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // 2) Any children?
    const childRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM locations WHERE parent_id = $1`,
      [id]
    );
    if (childRes.rows[0].cnt > 0) {
      return res.status(409).json({
        error: 'Location has child locations. Remove or reparent them first.',
        code: 'HAS_CHILDREN',
      });
    }

    // 3) Any assets?
    const assetsRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM assets WHERE location_id = $1`,
      [id]
    );
    if (assetsRes.rows[0].cnt > 0) {
      return res.status(409).json({
        error: 'Location has assets. Reassign them before deleting.',
        code: 'HAS_ASSETS',
      });
    }

    // 4) Safe to delete
    await client.query(`DELETE FROM locations WHERE id = $1`, [id]);
    return res.json({ message: 'Location deleted' });
  } catch (e) {
    console.error('[DELETE] /locations/:id failed:', e);
    return res.status(500).json({ error: 'Failed to delete location' });
  } finally {
    client.release();
  }
});


// routes/locations.js
router.post('/:id/merge-into', async (req, res) => {
  const { id: source_id } = req.params;
  const { target_id, user_email } = req.body;

  if (!target_id) return res.status(400).json({ error: 'target_id is required' });
  if (target_id === source_id) return res.status(400).json({ error: 'target_id cannot equal source_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Ensure both exist
    const { rows: s } = await client.query(`SELECT id, path FROM locations WHERE id = $1`, [source_id]);
    const { rows: t } = await client.query(`SELECT id, path FROM locations WHERE id = $1`, [target_id]);
    if (!s.length || !t.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Source or target not found' });
    }

    // 2) (Optional) block merging into own descendant
    const { rows: desc } = await client.query(
      `WITH RECURSIVE d AS (
         SELECT id, parent_id FROM locations WHERE id = $1
         UNION ALL
         SELECT l.id, l.parent_id FROM locations l
         JOIN d ON l.parent_id = d.id
       )
       SELECT 1 FROM d WHERE id = $2 LIMIT 1`,
      [source_id, target_id]
    );
    if (desc.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Target cannot be a descendant of source' });
    }

    // 3) Move assets
    await client.query(
      `UPDATE assets SET location_id = $1, updated_at = now(), updated_by = COALESCE($2, updated_by)
       WHERE location_id = $3`,
      [target_id, user_email || null, source_id]
    );

    // 4) Ensure no children remain on source (UI should have handled, but keep server safe)
    const { rows: childRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM locations WHERE parent_id = $1`,
      [source_id]
    );
    if (childRows[0].cnt > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Source still has children. Move or delete children first.',
        reason: 'HAS_CHILDREN',
        data: { children: childRows[0].cnt },
      });
    }

    // 5) Delete source location
    await client.query(`DELETE FROM locations WHERE id = $1`, [source_id]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /locations/:id/merge-into] failed:', e);
    res.status(500).json({ error: 'Failed to merge and delete location' });
  } finally {
    client.release();
  }
});




/* ------------------------- GET /locations/:id ------------------------- */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const client = await pool.connect();
    try {
      const row = await getLocationById(client, id);
      if (!row) return res.status(404).json({ error: 'Location not found' });
      res.json(row);
      //console.log('row', row);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[GET /locations/:id] failed:', e);
    res.status(500).json({ error: 'Failed to load location' });
  }
});


// GET /locations/:id/assets
router.get('/:id/assets', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    // still block if location has children
    const { rows: c } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM locations WHERE parent_id = $1',
      [id]
    );
    if (c[0].cnt > 0) {
      return res.status(409).json({
        error: 'Location has children. Move/delete children before assets.',
        reason: 'HAS_CHILDREN',
        data: { children: c[0].cnt }
      });
    }

    const { rows } = await client.query(
      `SELECT a.id, a.name, a.asset_tag, a.location_id
         FROM assets a
        WHERE a.location_id = $1
        ORDER BY a.name ASC`,
      [id]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('[GET /locations/:id/assets] failed:', e);
    res.status(500).json({ error: 'Failed to load assets' });
  } finally {
    client.release();
  }
});


// POST /locations/:id/move-assets-and-delete
// body: { moves: [{ asset_id, new_location_id }], user_email }
router.post('/:id/move-assets-and-delete', async (req, res) => {
  const { id: sourceId } = req.params;
  const { moves = [], user_email } = req.body;

  if (!Array.isArray(moves) || moves.length === 0) {
    return res.status(400).json({ error: 'No moves supplied' });
  }
  // validate structure
  for (const m of moves) {
    if (!m.asset_id || !m.new_location_id) {
      return res.status(400).json({ error: 'Each move requires asset_id and new_location_id' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Block if children still exist
    const { rows: c } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM locations WHERE parent_id = $1',
      [sourceId]
    );
    if (c[0].cnt > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Location has children. Move/delete children first.',
        reason: 'HAS_CHILDREN',
        data: { children: c[0].cnt }
      });
    }

    // Ensure all assets in payload actually belong to source location
    const assetIds = moves.map(m => m.asset_id);
    const { rows: checkRows } = await client.query(
      `SELECT id FROM assets WHERE id = ANY($1::uuid[]) AND location_id = $2`,
      [assetIds, sourceId]
    );
    if (checkRows.length !== assetIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One or more assets do not belong to this location' });
    }

    // Perform moves
    for (const m of moves) {
      await client.query(
        `UPDATE assets
            SET location_id = $1, updated_at = now(), updated_by = COALESCE($3, updated_by)
          WHERE id = $2`,
        [m.new_location_id, m.asset_id, user_email || null]
      );
    }

    // Verify no assets remain at source
    const { rows: remain } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM assets WHERE location_id = $1`,
      [sourceId]
    );
    if (remain[0].cnt > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Some assets still remain at the source after move',
        reason: 'ASSETS_REMAIN'
      });
    }

    // Delete the location
    await client.query(`DELETE FROM locations WHERE id = $1`, [sourceId]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST /locations/:id/move-assets-and-delete] failed:', e);
    res.status(500).json({ error: 'Failed to move assets and delete location' });
  } finally {
    client.release();
  }
});

// --- Get location deletion metadata (asset count) ---
router.get('/:id/deletion-metadata', async (req, res) => {
  const { id } = req.params;
  try {
    const count = await getAssetCount(pool, id);
    res.json({ count });
  } catch (err) {
    console.error('Error fetching deletion metadata:', err);
    res.status(500).json({ error: 'Failed to load deletion metadata' });
  }
});


/* -------------------------- deactivate (safe path) ------------------------- */
/* If no assets => deactivate immediately. If has assets => 409 for FE modal. */
router.post('/:id/deactivate', async (req, res) => {
  const { id } = req.params;
  const { target_location_id, user_email } = req.body || {}; // modal will send this
  const client = await pool.connect();

  console.log('user-email', user_email);

  const before = await getLocationSnapshot(client, id);
  if (!before) {
    await client.query('ROLLBACK');
    return res.status(404).json({ error: 'Location not found.' });
  }
  if (before.is_active === false) {
    await client.query('ROLLBACK');
    return res.status(409).json({ error: 'Location already deactivated.' });
  }

  //console.log('Before', before);

  try {
    // make sure location exists
    const loc = await locationExists(client, id);
    if (!loc) {
      client.release();
      return res.status(404).json({ error: 'Location not found' });
    }

    // If the modal is providing a target, we do a bulk move + deactivate here.
    if (target_location_id) {
      if (target_location_id === id) {
        client.release();
        return res.status(400).json({ error: 'Target location must be different from source' });
      }

      // validate target exists and is active
      const tgt = await locationExists(client, target_location_id);
      if (!tgt) {
        client.release();
        return res.status(400).json({ error: 'Invalid target location' });
      }
      if (tgt.active === false) {
        client.release();
        return res.status(400).json({ error: 'Target location is inactive' });
      }

      await client.query('BEGIN');

      // move all assets in one UPDATE
      await client.query(
        'UPDATE assets SET location_id = $1, updated_by_user = $3, updated_at = now() WHERE location_id = $2',
        [target_location_id, id, user_email]
      );

      // deactivate source
      await client.query(
        'UPDATE locations SET active = false, updated_by_user = $2, updated_at = now() WHERE id = $1',
        [id, user_email]
      );


      await client.query('COMMIT');
      client.release();
      return res.json({ success: true, moved: true, deactivated: true });
    }

    // No target provided: try simple deactivate if empty, else 409 with count
    const count = await getAssetCount(client, id);
    if (count > 0) {
      client.release();
      return res
        .status(409)
        .json({ error: 'Location has assets. Please reassign before deactivating.', count });
    }

    await client.query('UPDATE locations SET active = false, updated_by_user = $2, updated_at = now() WHERE id = $1', [id, user_email]);

    // AUDIT
    await auditSafe(client, {
      action: 'LOCATION_DEACTIVATE',
      entity_type: 'location',
      entity_id: target_location_id,
      actor_email: user_email,
      summary: `Deactivated location "${before.path || before.name}"`,
      before_data: before,
      after_data: {
        active: false
      }
    });

    // 🔔 Send email if enabled
    await sendNotificationIfEnabled(
      "LOCATION_DELETE",
      `Location Deactivated`,
      `<p>Deactivated location ${JSON.stringify(before)} by ${user_email} </p>`
    );

    await client.query('COMMIT');

    return res.json({ success: true, id, deactivated: true, count: 0 });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    client.release();
    console.error('Error in /locations/:id/deactivate:', err);
    res.status(500).json({ error: 'Failed to deactivate location' });
  } finally {
    client.release();
  }
});


/* ---------------------------- bulk reassign API ---------------------------- */
/**
 * POST /locations/:id/reassign-assets
 * Body: { target_location_id: string, deactivate?: boolean }
 *
 * Moves ALL assets from :id -> target_location_id in one shot.
 * If deactivate=true, the source location will be deactivated afterwards
 * (only if the move succeeds).
 */
router.post('/:id/reassign-assets', async (req, res) => {
  const sourceId = req.params.id;
  const { target_location_id: targetId, deactivate } = req.body || {};

  if (!targetId) {
    return res.status(400).json({ error: 'target_location_id is required' });
  }
  if (sourceId === targetId) {
    return res.status(400).json({ error: 'Target location must be different from source' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate both locations
    const src = await locationExists(client, sourceId);
    if (!src) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Source location not found' });
    }
    const tgt = await locationExists(client, targetId);
    if (!tgt) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Target location not found' });
    }
    if (tgt.active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Target location is inactive' });
    }

    // Count assets that will be moved
    const before = await getAssetCount(client, sourceId);

    // If nothing to move, short-circuit (and optionally deactivate)
    if (before === 0) {
      if (deactivate) {
        await client.query('UPDATE locations SET active = false WHERE id = $1', [sourceId]);
      }
      await client.query('COMMIT');
      return res.json({
        success: true,
        moved: 0,
        deactivated: Boolean(deactivate),
      });
    }

    // Bulk move
    const update = await client.query(
      'UPDATE assets SET location_id = $1 WHERE location_id = $2',
      [targetId, sourceId]
    );
    const moved = update.rowCount ?? before;

    // Optional deactivate after move
    let deactivated = false;
    if (deactivate) {
      await client.query('UPDATE locations SET active = false WHERE id = $1', [sourceId]);
      deactivated = true;
    }

    await client.query('COMMIT');
    res.json({ success: true, moved, deactivated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error reassigning assets:', err);
    res.status(500).json({ error: 'Failed to reassign assets' });
  } finally {
    client.release();
  }
});




/**
 * POST /locations/:id/reassign-and-delete
 * Body:
 * {
 *   user_email: string,               // who is doing this (optional — store in audit if you have it)
 *   moveAllTo?: string | null,        // optional location_id to move all assets to
 *   moves?: Array<{ asset_id: string, new_location_id: string }>
 * }
 *
 * Rules:
 *  - Location must have NO children.
 *  - If there are assets attached, each must be reassigned either via moveAllTo or moves[].
 */
router.post('/:id/reassign-and-delete', async (req, res) => {
  const { id } = req.params;
  const { user_email, moveAllTo = null, moves = [] } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Location must exist
    const locRes = await client.query(
      `SELECT id, name FROM locations WHERE id = $1`,
      [id]
    );
    if (locRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Location not found' });
    }

    // 2) No children allowed (avoid reparenting complexity here)
    const childRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM locations WHERE parent_id = $1`,
      [id]
    );
    if (childRes.rows[0].cnt > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Location has child locations. Remove or reparent them first.',
        code: 'HAS_CHILDREN',
      });
    }

    // 3) Fetch all assets on this location
    const assetsRes = await client.query(
      `SELECT id FROM assets WHERE location_id = $1 ORDER BY id`,
      [id]
    );
    const assetIds = assetsRes.rows.map(r => r.id);

    // No assets → delete right away
    if (assetIds.length === 0) {
      await client.query(`DELETE FROM locations WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return res.json({ message: 'Location deleted (no assets to reassign)' });
    }

    // 4) Build a mapping asset_id → new_location_id
    const map = new Map(); // asset_id -> new_location_id

    if (moveAllTo) {
      // Validate target exists & not same as current
      const targetRes = await client.query(
        `SELECT id FROM locations WHERE id = $1`,
        [moveAllTo]
      );
      if (targetRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'moveAllTo is not a valid location' });
      }
      for (const aId of assetIds) map.set(aId, moveAllTo);
    }

    for (const m of moves || []) {
      if (!m.asset_id || !m.new_location_id) continue;
      const validTarget = await client.query(
        `SELECT id FROM locations WHERE id = $1`,
        [m.new_location_id]
      );
      if (validTarget.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Invalid target location for asset ${m.asset_id}` });
      }
      map.set(m.asset_id, m.new_location_id);
    }

    // 5) Ensure EVERY asset on this location has a destination
    const missing = assetIds.filter(a => !map.has(a));
    if (missing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Some assets are missing a destination location',
        missing_asset_ids: missing,
      });
    }

    // 6) Perform the reassignments
    for (const aId of assetIds) {
      const dest = map.get(aId);
      await client.query(
        `UPDATE assets
         SET location_id = $2
         WHERE id = $1`,
        [aId, dest]
      );
    }

    // (Optional) Write to an audit table if you have one
    // await client.query(
    //   `INSERT INTO audit_log (actor, action, details)
    //    VALUES ($1, 'reassign_and_delete_location', $2)`,
    //   [user_email || null, JSON.stringify({ location_id: id, moved_assets: assetIds.length })]
    // );

    // 7) Delete the location after assets are moved
    await client.query(`DELETE FROM locations WHERE id = $1`, [id]);

    await client.query('COMMIT');
    return res.json({ message: 'Assets reassigned and location deleted' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[POST] /locations/:id/reassign-and-delete error:', e);
    return res.status(500).json({ error: 'Failed to reassign and delete location' });
  } finally {
    client.release();
  }
});

// GET /locations/:id/summary  → asset count + basic info
router.get("/:id/summary", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const { rows: locRows } = await client.query(
      `SELECT id, name, path, active FROM locations WHERE id = $1`,
      [id]
    );
    if (locRows.length === 0) return res.status(404).json({ error: "Location not found" });

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS asset_count FROM assets WHERE location_id = $1`,
      [id]
    );
    res.json({
      location: locRows[0],
      asset_count: countRows[0]?.asset_count ?? 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load location summary" });
  } finally {
    client.release();
  }
});

// GET /locations/active  → options for dropdowns
router.get("/active/list", async (_req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, name, path
       FROM locations
       WHERE active = true
       ORDER BY path, name`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load active locations" });
  } finally {
    client.release();
  }
});


// POST /locations/:id/deactivate  { target_location_id }
// router.post("/:id/deactivate", async (req, res) => {
//   const { id } = req.params;
//   const { target_location_id } = req.body;

//   if (!target_location_id) {
//     return res.status(400).json({ error: "target_location_id is required" });
//   }
//   if (target_location_id === id) {
//     return res.status(400).json({ error: "Target location must be different" });
//   }

//   const client = await pool.connect();
//   try {
//     await client.query("BEGIN");

//     // ensure current location exists
//     const { rows: cur } = await client.query(
//       `SELECT id, active FROM locations WHERE id = $1`,
//       [id]
//     );
//     if (cur.length === 0) {
//       await client.query("ROLLBACK");
//       return res.status(404).json({ error: "Location not found" });
//     }

//     // ensure target exists + active
//     const { rows: tgt } = await client.query(
//       `SELECT id FROM locations WHERE id = $1 AND active = true`,
//       [target_location_id]
//     );
//     if (tgt.length === 0) {
//       await client.query("ROLLBACK");
//       return res.status(400).json({ error: "Invalid or inactive target location" });
//     }

//     // bulk move assets
//     await client.query(
//       `UPDATE assets
//        SET location_id = $1, updated_at = NOW()
//        WHERE location_id = $2`,
//       [target_location_id, id]
//     );

//     // deactivate
//     await client.query(
//       `UPDATE locations SET active = false, updated_at = NOW() WHERE id = $1`,
//       [id]
//     );

//     await client.query("COMMIT");
//     res.json({ ok: true, message: "Assets moved and location deactivated." });
//   } catch (e) {
//     await client.query("ROLLBACK");
//     console.error("Deactivate failed:", e);
//     res.status(500).json({ error: "Failed to deactivate location" });
//   } finally {
//     client.release();
//   }
// });





export default router;
