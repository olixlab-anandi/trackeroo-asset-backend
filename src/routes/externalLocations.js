import express from "express";
import { pool } from "../db.js";
//import auditSafe from "../services/audit.js";
import { getIssueItemSnapshot } from "../services/issueSnapshots.js";
import { sendNotificationIfEnabled } from "../services/emailNotificationHelper.js";
import { auditSafe } from '../services/audit.js';
import { getExternalLocationSnapshot } from "../services/externalLocationSnapshot.js";
const router = express.Router();

// GET all or search
router.get("/", async (req, res) => {
    try {
        const { search = "", type = "", status = "", country = "" } = req.query;
        const values = [];
        const where = [];

        if (search) {
            values.push(`%${search}%`);
            where.push(`(company_name ILIKE $${values.length} OR contact_person ILIKE $${values.length})`);
        }

        if (type) {
            values.push(type);
            where.push(`type = $${values.length}`);
        }

        if (status) {
            values.push(status === "true");
            where.push(`is_active = $${values.length}`);
        }

        if (country) {
            values.push(`%${country}%`);
            where.push(`country ILIKE $${values.length}`);
        }

        const query = `
      SELECT * FROM external_location
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY company_name ASC;
    `;

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching external locations:", err);
        res.status(500).json({ error: "Failed to fetch external locations" });
    }
});


/**
 * GET /external-locations/search?q=
 * Search active external locations by company name or contact person
 * - If q is empty, return first 50 active external locations
 * - If q is provided, perform ILIKE search
 */
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();

    try {
        let sql, params;

        if (q) {
            // 🔍 Search mode
            sql = `
        SELECT 
          id,
          company_name,
          contact_person,
          email,
          phone,
          city,
          state,
          country
        FROM external_location
        WHERE is_active = TRUE
          AND (
            company_name ILIKE $1 OR
            contact_person ILIKE $1 OR
            email ILIKE $1 OR
            phone ILIKE $1
          )
        ORDER BY company_name ASC
        LIMIT 50
      `;
            params = [`%${q}%`];
        } else {
            // 🧭 Default mode – first 50
            sql = `
        SELECT 
          id,
          company_name,
          contact_person,
          email,
          phone,
          city,
          state,
          country
        FROM external_location
        WHERE is_active = TRUE
        ORDER BY company_name ASC
        LIMIT 50
      `;
            params = [];
        }

        const { rows } = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        console.error('[GET /external-locations/search] failed:', err);
        res.status(500).json({ error: 'Failed to fetch external locations' });
    }
});



// CREATE
router.post("/", async (req, res) => {
    try {
        const {
            type,
            company_name,
            contact_person,
            email,
            phone,
            address_line1,
            address_line2,
            city,
            state,
            postal_code,
            country,
            notes,
            user_email
        } = req.body;

        const client = await pool.connect();
        await client.query('BEGIN');

        const result = await pool.query(
            `INSERT INTO external_location
       (type, company_name, contact_person, email, phone, address_line1, address_line2, city, state, postal_code, country, notes, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,NOW(),NOW())
       RETURNING *;`,
            [
                type,
                company_name,
                contact_person,
                email,
                phone,
                address_line1,
                address_line2,
                city,
                state,
                postal_code,
                country,
                notes,
            ]
        );
        res.json(result.rows[0]);
        const data = result.rows[0];
        // Insert Parent to Audit
        await auditSafe(client, {
            action: 'EXTERNAL_LOCATION_CREATE',
            entity_type: 'external location',
            entity_id: data.id,
            actor_email: user_email,
            summary: `External Location Created "${company_name}"`,
            before_data: null,
            after_data: JSON.stringify(data)
        });

        await client.query('COMMIT');

        // 🔔 Send email if enabled
        await sendNotificationIfEnabled(
            "EXTERNAL_LOCATION_CREATE",
            `New External Location Created`,
            `<p>External location Created ${JSON.stringify(result.rows[0])} by ${user_email} </p>`
        );
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add external location" });
    }
});

// UPDATE
// router.put("/:id", async (req, res) => {


//     try {
//         const id = req.params.id;
//         const fields = [
//             "type",
//             "company_name",
//             "contact_person",
//             "email",
//             "phone",
//             "address_line1",
//             "address_line2",
//             "city",
//             "state",
//             "postal_code",
//             "country",
//             "notes",
//             "is_active",
//         ];

//         const updates = [];
//         const values = [];
//         let idx = 1;

//         for (const key of fields) {
//             if (req.body[key] !== undefined) {
//                 updates.push(`${key} = ${idx}`);
//                 values.push(req.body[key]);
//                 idx++;
//             }
//         }

//         if (updates.length === 0) {
//             return res.status(400).json({ error: "No fields to update" });
//         }

//         values.push(id);
//         const query = `
//       UPDATE external_location
//       SET ${updates.join(", ")}, updated_at = NOW()
//       WHERE id = $${idx}
//       RETURNING *;
//     `;

//         const result = await pool.query(query, values);
//         res.json(result.rows[0]);
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: "Failed to update external location" });
//     }
// });

// UPDATE external location
router.put("/:id", async (req, res) => {

    //console.log('Body', req.body);
    try {
        const id = req.params.id;
        // Normalize is_active to real boolean (in case frontend sends "true"/"false"/1/0)
        if (req.body.is_active !== undefined) {
            req.body.is_active =
                req.body.is_active === true ||
                req.body.is_active === "true" ||
                req.body.is_active === 1 ||
                req.body.is_active === "1";
        }

        const user_email = req.body.user_email;

        const client = await pool.connect();
        await client.query('BEGIN');

        const locationSnapshot = await getExternalLocationSnapshot(req.body.id, client);
        await client.query('COMMIT');

        // Define updatable fields
        const fields = [
            "type",
            "company_name",
            "contact_person",
            "email",
            "phone",
            "address_line1",
            "address_line2",
            "city",
            "state",
            "postal_code",
            "country",
            "notes",
            "is_active",
        ];

        const updates = [];
        const values = [];
        let idx = 1;

        // Build dynamic query with boolean casting
        for (const key of fields) {
            if (req.body[key] !== undefined) {
                if (key === "is_active") {
                    updates.push(`${key} = $${idx}:: boolean`); // ✅ CORRECT
                } else {
                    updates.push(`${key} = $${idx}`);
                }
                values.push(req.body[key]);
                idx++;
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        // Add updated_at and WHERE clause
        values.push(id);

        const query = `
            UPDATE external_location
            SET ${updates.join(", ")}, updated_at = NOW()
            WHERE id = $${idx}
            RETURNING *;
            `;

        const result = await pool.query(query, values);
        res.json(result.rows[0]);
        const data = result.rows[0];

        const beforeActive = !!locationSnapshot.is_active;
        const afterActive = !!req.body.is_active;
        let actionVar = '';
        let summaryVar = '';

        if(!afterActive) {
            //Deactivated
            actionVar = 'EXTERNAL_LOCATION_DELETE';
            summaryVar = 'External Location Deactivated'
        } else {
            actionVar = 'EXTERNAL_LOCATION_EDIT';
            summaryVar = 'External Location Edited'
        }

        // Insert Parent to Audit
        await auditSafe(client, {
            action: actionVar,
            entity_type: 'external location',
            entity_id: data.id,
            actor_email: user_email,
            summary: summaryVar,
            before_data: JSON.stringify(locationSnapshot),
            after_data: JSON.stringify(req.body),
        });

        await client.query('COMMIT');

        // 🔔 Send email if enabled
        await sendNotificationIfEnabled(
            actionVar,
            summaryVar,
            `<p>${summaryVar} ${JSON.stringify(result.rows[0])} by ${user_email} </p>`
        );
    } catch (err) {
        console.error("Error updating external location:", err);
        res.status(500).json({ error: "Failed to update external location" });
    }
});

// SOFT DELETE / deactivate
router.delete("/:id", async (req, res) => {
    try {
        const id = req.params.id;
        await pool.query(
            "UPDATE external_location SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
            [id]
        );

        const client = await pool.connect();
        await client.query('BEGIN');

        // Insert Parent to Audit
        await auditSafe(client, {
            action: 'EXTERNAL_LOCATION_EDIT',
            entity_type: 'external location',
            entity_id: data.id,
            actor_email: user_email,
            summary: `External Location Edited`,
            //before_data: JSON.stringify(updates),
            after_data: JSON.stringify(data)
        });

        await client.query('COMMIT');

        // 🔔 Send email if enabled
        await sendNotificationIfEnabled(
            "EXTERNAL_LOCATION_DELETE",
            `External Location Deactivated`,
            `<p>External location Edited ${JSON.stringify(result.rows[0])} by ${user_email} </p>`
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to deactivate location" });
    }
});

export default router;