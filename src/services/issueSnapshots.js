// src/services/issueSnapshots.js
// Return a single “snapshot” of an issue item with asset + from/to location context

export async function getIssueItemSnapshot(client, issueItemId) {
  const { rows } = await client.query(`
    SELECT
      ii.id,
      ii.asset_id,
      ii.transaction_id,
      a.title AS asset_title,
      a.part_name AS asset_part_name,
      a.tag AS asset_tag,
      COALESCE(l.path, el.company_name, '—') AS current_location,
      CASE
        WHEN el.id IS NOT NULL THEN 'external'
        WHEN l.id IS NOT NULL THEN 'internal'
        ELSE 'unknown'
      END AS location_type
    FROM issue_item ii
    LEFT JOIN assets a ON a.id = ii.asset_id
    LEFT JOIN locations l ON l.id = a.location_id
    LEFT JOIN issue_transaction it ON it.id = ii.transaction_id
    LEFT JOIN external_location el ON el.id = it.external_location_id
    WHERE ii.id = $1
  `, [issueItemId]);

  return rows[0] || null;
}

//Olf logic for internal location
// export async function getIssueItemSnapshot(client, itemId) {
//   const { rows } = await client.query(
//     `
//     SELECT
//       ii.id,
//       ii.transaction_id,
//       ii.asset_id,
//       a.title                      AS asset_title,
//       a.tag                        AS asset_tag,

//       -- from/to come from the transaction table
//       itx.from_location_id,
//       fl.path                      AS from_path,
//       itx.to_location_id,
//       tl.path                      AS to_path,

//       ii.status,
//       ii.issued_at,
//       ii.returned_at,
//       itx.due_date,                -- due_date is on the transaction
//       ii.note,

//       ii.created_at,
//       ii.updated_at
//     FROM issue_item            ii
//     JOIN assets                a   ON a.id  = ii.asset_id
//     JOIN issue_transaction     itx ON itx.id = ii.transaction_id
//     LEFT JOIN locations        fl  ON fl.id  = itx.from_location_id
//     LEFT JOIN locations        tl  ON tl.id  = itx.to_location_id
//     WHERE ii.id = $1
//     LIMIT 1
//     `,
//     [itemId]
//   );

//   return rows[0] || null;
// }


