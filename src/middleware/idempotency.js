import crypto from "crypto";

function hashRequest(req) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ body: req.body ?? null }))
    .digest("hex");
}

export function createIdempotencyMiddleware(pool) {
  return async function idempotency(req, res, next) {
    const key = req.header("X-Idempotency-Key");
    if (!key) return next();
    console.log("req.user:", req.user);
    const userId = req.user.id; // UUID
    const method = req.method.toUpperCase();
    const route = req.route?.path || req.originalUrl;
    const requestHash = hashRequest(req);

    try {
      await pool.query(
        `
        INSERT INTO idempotency_keys (key, user_id, method, route, request_hash)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [key, userId, method, route, requestHash]
      );
    } catch (e) {
      if (e.code !== "23505") return next(e);

      const { rows } = await pool.query(
        `SELECT * FROM idempotency_keys WHERE key=$1 AND user_id=$2`,
        [key, userId]
      );

      const row = rows[0];

      if (!row) return next();

      if (row.state === "COMPLETED") {
        if ((row.status_code || 200) === 204) return res.status(204).send();
        return res.status(row.status_code || 200).json(row.response_body);
      }

      return res.status(409).json({ error: "IDEMPOTENCY_IN_PROGRESS" });
    }

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    async function markComplete(body) {
      await pool.query(
        `
        UPDATE idempotency_keys
        SET state='COMPLETED',
            status_code=$1,
            response_body=$2,
            completed_at=NOW()
        WHERE key=$3 AND user_id=$4
        `,
        [res.statusCode || 200, body ?? null, key, userId]
      );
    }

    res.json = async (body) => {
      await markComplete(body);
      return originalJson(body);
    };

    res.send = async (body) => {
      const toStore = body && typeof body === "object" ? body : null;
      await markComplete(toStore);
      return originalSend(body);
    };

    return next();
  };
}