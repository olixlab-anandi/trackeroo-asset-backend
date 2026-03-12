import express from 'express';
import { pool } from '../db.js';
import nodemailer from 'nodemailer';
import 'dotenv/config';

const router = express.Router();

router.get('/ok', (_req, res) => res.json({ ok: true, scope: 'settings' }));

// All event types we support (for fallback creation)
const ALL_EVENTS = [
  'ASSET_CREATE',
  'ASSET_EDIT',
  'ASSET_DEACTIVATE',
  'ISSUE_CREATE',
  'ISSUE_EDIT',
  'ISSUE_RETURN',
  'ISSUE_VOID',
  'LOCATION_CREATE',
  'LOCATION_EDIT',
  'LOCATION_DELETE',
  'EXTERNAL_LOCATION_CREATE',
  'EXTERNAL_LOCATION_EDIT',
  'EXTERNAL_LOCATION_DELETE',
];

/* =======================================================
   GET /settings/notifications
   ======================================================= */
router.get('/notifications', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT event_type, is_enabled, recipients, cc, bcc
      FROM notification_rules
      ORDER BY event_type
    `);

    // Build default list in case some rules missing
    const existingMap = Object.fromEntries(rows.map(r => [r.event_type, r]));
    const merged = ALL_EVENTS.map(e => ({
      event_type: e,
      is_enabled: existingMap[e]?.is_enabled ?? false,
      recipients: existingMap[e]?.recipients ?? [],
      cc: existingMap[e]?.cc ?? [],
      bcc: existingMap[e]?.bcc ?? []
    }));

    res.json({ events: merged });
  } catch (err) {
    console.error('[GET /settings/notifications] failed:', err);
    res.status(500).json({ error: 'Failed to load notification rules' });
  }
});

/* =======================================================
   PUT /settings/notifications
   ======================================================= */

// Update notification rules
router.put('/notifications', async (req, res) => {
  const { events = [], global = {}, user_email } = req.body;

  try {
    const client = await pool.connect();

    for (const e of events) {
      const eventType = e.event_type;
      const isEnabled = e.is_enabled || false;
      const recipients = e.recipients && e.recipients.length > 0 ? e.recipients : [];
      const cc = e.cc && e.cc.length > 0 ? e.cc : [];
      const bcc = e.bcc && e.bcc.length > 0 ? e.bcc : [];

      // use first recipient as 'email' field (non-null)
      const primaryEmail = recipients.length > 0 ? recipients[0] : '';

      await client.query(
        `
        INSERT INTO notification_rules (
          event_type, email, is_enabled, recipients, cc, bcc, updated_by, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (event_type)
        DO UPDATE SET
          email = EXCLUDED.email,
          is_enabled = EXCLUDED.is_enabled,
          recipients = EXCLUDED.recipients,
          cc = EXCLUDED.cc,
          bcc = EXCLUDED.bcc,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
        `,
        [eventType, primaryEmail, isEnabled, recipients, cc, bcc, user_email]
      );
    }

    // optionally update global table if you have one
    // await client.query(`UPDATE global_settings ...`);

    client.release();
    res.json({ success: true });
  } catch (err) {
    console.error('[PUT /settings/notifications] Error:', err);
    res.status(500).json({ error: 'Failed to save notification rules' });
  }
});

// Test SMTP connection
router.post('/smtp/test', async (req, res) => {
  try {
    const {
      fromEmail,
      toEmail = process.env.SMTP_USER, // optional fallback
    } = req.body;

    // Create transporter from env
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    // Verify connection
    await transporter.verify();

    // Send test email
    await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME}" <${fromEmail || process.env.SMTP_USER}>`,
      to: toEmail,
      subject: '✅ SMTP Test Successful',
      text: 'Your SMTP connection is working successfully.',
    });

    res.json({ success: true, message: 'SMTP connection successful and test email sent!' });
  } catch (err) {
    console.error('SMTP test failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});




export default router;
