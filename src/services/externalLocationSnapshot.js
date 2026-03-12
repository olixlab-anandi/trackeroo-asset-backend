import { pool } from '../db.js'; //

/**
 * 📦 getExternalLocationSnapshot
 * Fetches all columns for a given external location.
 *
 * @param {number} externalLocationId - The ID of the external location.
 * @param {object} [client] - Optional existing pg client (for transactions).
 * @returns {Promise<object|null>} The full external_location record or null if not found.
 */
export async function getExternalLocationSnapshot(externalLocationId, client) {
  if (!externalLocationId) {
    throw new Error('Invalid external location ID');
  }

  const db = client || (await pool.connect());
  try {
    const { rows } = await db.query(
      `
      SELECT
        el.*
      FROM external_location el
      WHERE el.id = $1
      `,
      [externalLocationId]
    );

    if (!rows.length) return null;

    return rows[0]; // full row snapshot
  } finally {
    if (!client) db.release();
  }
}

