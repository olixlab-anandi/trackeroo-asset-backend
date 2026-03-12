// src/routes/dashboard.js
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/authz.js';
import { requireRole } from '../middleware/role.js';

const router = Router();

// All roles that can view the web portal dashboard
const PORTAL_ROLES = ['super_admin', 'admin', 'portal_user', 'portal_mobile_user'];

// ---- Summary cards
router.get('/summary',
    requireAuth,
    requireRole(PORTAL_ROLES),
    async (req, res) => {
        try {
            const q = `
        SELECT
          /* total assets */
          (SELECT COUNT(*) FROM assets WHERE is_active = true) AS total_assets,

          /* assets currently in use = open issue_item (issued and not returned/voided) */
          (SELECT COUNT(DISTINCT ii.asset_id)
             FROM issue_item ii
            WHERE ii.status = 'ISSUED'
              AND ii.returned_at IS NULL) AS assets_in_use,

          /* assets available = assets not currently in use and not retired/lost/void */
          (SELECT COUNT(*)
             FROM assets a
            WHERE COALESCE(a.status, 'available') NOT IN ('retired','lost','void')
              AND NOT EXISTS (
                    SELECT 1
                      FROM issue_item ii
                     WHERE ii.asset_id = a.id
                       AND ii.status   = 'ISSUED'
                       AND ii.returned_at IS NULL
              ))  AS assets_available,

          /* activity widgets you already had */
          (SELECT COUNT(*) FROM movements m
            WHERE m.reason = 'INTERNAL'
              AND m.created_at >= date_trunc('month', now()))  AS internal_moves_this_month,

          (SELECT COUNT(*) FROM movements m
            WHERE m.reason = 'ISSUE'
              AND m.created_at >= date_trunc('week', now())) AS issues_this_week
      `;
            const { rows: [row] } = await pool.query(q);
            res.json({ summary: row });
        } catch (err) {
            console.error('[GET /dashboard/summary] error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);


// ---- Status breakdown (donut)
router.get('/status-breakdown',
    requireAuth,
    requireRole(PORTAL_ROLES),
    async (_req, res) => {
        try {
            const q = `
        SELECT status, COUNT(*)::int AS count
        FROM assets
        GROUP BY status
        ORDER BY status
      `;
            const { rows } = await pool.query(q);
            res.json({ items: rows });
        } catch (err) {
            console.error('[GET /dashboard/status-breakdown]', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

// ---- Monthly issues vs returns trend
router.get('/issues-returns-trend',
    requireAuth,
    requireRole(PORTAL_ROLES),
    async (req, res) => {
        try {
            const months = Math.max(1, Math.min(24, Number(req.query.months) || 6));
            const q = `
        WITH months AS (
          SELECT date_trunc('month', (now() - (n||' months')::interval)) AS m
          FROM generate_series(0, $1 - 1) AS g(n)
        )
        SELECT
          to_char(m.m, 'YYYY-MM') AS month,
          COALESCE( (SELECT COUNT(*) FROM movements WHERE reason='ISSUE'  AND date_trunc('month', created_at)=m.m), 0)::int AS issues,
          COALESCE( (SELECT COUNT(*) FROM movements WHERE reason='RETURN' AND date_trunc('month', created_at)=m.m), 0)::int AS returns
        FROM months m
        ORDER BY month
      `;
            const { rows } = await pool.query(q, [months]);
            res.json({ items: rows });
        } catch (err) {
            console.error('[GET /dashboard/issues-returns-trend]', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

// ---- Recent movements table
router.get('/recent-movements',
    requireAuth,
    requireRole(PORTAL_ROLES),
    async (_req, res) => {
        try {
            const q = `
        SELECT
          m.id,
          m.created_at,
          m.reason,
          m.note,
          m.created_by_user,
          a.barcode,
          a.id AS asset_id,
          a.title AS asset_title,
          lf.path AS from_path,
          lt.path AS to_path,
          u.name AS by_name
        FROM movements m
        LEFT JOIN assets a ON a.id = m.asset_id
        LEFT JOIN locations lf ON lf.id = m.from_location_id
        LEFT JOIN locations lt ON lt.id = m.to_location_id
        LEFT JOIN users u ON u.id::text = m.created_by_user
        ORDER BY m.created_at DESC
        LIMIT 15
      `;
            const { rows } = await pool.query(q);
            res.json({ items: rows });
        } catch (err) {
            console.error('[GET /dashboard/recent-movements]', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

// ---- Top active locations
router.get('/top-locations',
    requireAuth,
    requireRole(PORTAL_ROLES),
    async (_req, res) => {
        try {
            const q = `
        SELECT l.path, COUNT(*)::int AS total
        FROM movements m
        JOIN locations l ON l.id = COALESCE(m.to_location_id, m.from_location_id)
        GROUP BY l.path
        ORDER BY total DESC
        LIMIT 5
      `;
            const { rows } = await pool.query(q);
            res.json({ items: rows });
        } catch (err) {
            console.error('[GET /dashboard/top-locations]', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
);

/**
 * GET /dashboard/under-repair
 * Returns assets currently marked “under repair”
 */
router.get('/under-repair', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `
      SELECT
        a.id,
        a.title,
        a.tag,
        a.category,
        a.type,
        a.status,
        l.path AS location_path,
        -- latest movement timestamp for context
        lm.last_moved_at
      FROM assets a
      LEFT JOIN locations l ON l.id = a.location_id::uuid
      LEFT JOIN LATERAL (
        SELECT MAX(m.created_at) AS last_moved_at
        FROM movements m
        WHERE m.asset_id = a.id::uuid
      ) lm ON TRUE
      WHERE
        a.status = 'Needs Repair'
        OR COALESCE(a.attributes->>'under_repair','false') = 'true'
      ORDER BY lm.last_moved_at DESC NULLS LAST
      LIMIT 20;
      `
        );

        res.json({ items: rows });
    } catch (err) {
        console.error('[GET /dashboard/under-repair] error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});


// src/routes/dashboard.js
router.get('/utilization-category', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `
      /* Utilization by Category based on active issue_item */
      SELECT
        a.category,
        COUNT(*)::int AS total,
        SUM(
          CASE WHEN EXISTS (
            SELECT 1
            FROM issue_item ii
            WHERE ii.asset_id = a.id::uuid
              AND ii.status = 'ISSUED'
              AND ii.returned_at IS NULL
              AND ii.voided_at  IS NULL
          )
          THEN 1 ELSE 0 END
        )::int AS in_use,
        CASE WHEN COUNT(*) = 0
             THEN 0
             ELSE ROUND(
               100.0 * SUM(
                 CASE WHEN EXISTS (
                   SELECT 1
                   FROM issue_item ii
                   WHERE ii.asset_id = a.id::uuid
                     AND ii.status = 'ISSUED'
                     AND ii.returned_at IS NULL
                     AND ii.voided_at  IS NULL
                 )
                 THEN 1 ELSE 0 END
               ) / COUNT(*), 1
             )
        END AS utilization_pct
      FROM assets a
      GROUP BY a.category
      ORDER BY utilization_pct DESC, a.category ASC;
      `
        );

        res.json({ items: rows });
    } catch (err) {
        console.error('[GET /dashboard/utilization-category] error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});


export default router;
