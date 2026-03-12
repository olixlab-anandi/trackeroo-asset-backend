export async function getUserSnapshot(client, id) {
    const { rows } = await client.query(
        `
            SELECT id, email, name, role, is_active, created_at, updated_at
            FROM users
            WHERE id = $1
            LIMIT 1
        `, [id]
    );
    return rows[0] || null;
}