// returns a compact snapshot of the location row
export async function getLocationSnapshot(client, id) {
  const { rows } = await client.query(
    `SELECT id, name, parent_id, path, depth, created_at, updated_at
     FROM locations
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}


export async function getLocationSubtree(client, rootId) {
  // Assuming path contains the full ancestry like "A > B > C"
  const { rows: rootRows } = await client.query(
    `SELECT id, path FROM locations WHERE id = $1 LIMIT 1`,
    [rootId]
  );
  const root = rootRows[0];
  if (!root) return null;

  const { rows } = await client.query(
    `SELECT id, name, parent_id, path, depth
     FROM locations
     WHERE path = $1 OR path LIKE $2
     ORDER BY depth ASC`,
    [root.path, `${root.path} > %`]
  );
  return rows;
}