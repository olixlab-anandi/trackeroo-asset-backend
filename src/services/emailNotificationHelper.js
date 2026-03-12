import nodemailer from "nodemailer";
import { pool } from '../db.js'; //
import dotenv from "dotenv";
dotenv.config();

/**
 * Send notification email if the rule is enabled.
 * @param {string} eventType - e.g. 'ASSET_CREATE', 'ASSET_EDIT'
 * @param {string} subject - Email subject
 * @param {string} body - HTML or text body
 */
export async function sendNotificationIfEnabled(eventType, subject, body) {
  try {
    // 1 Get rule
    const { rows } = await pool.query(
      "SELECT * FROM notification_rules WHERE event_type = $1 AND is_enabled = TRUE LIMIT 1",
      [eventType]
    );

    if (rows.length === 0) {
      console.log(`[Email] Skipped: ${eventType} is disabled or not found.`);
      return;
    }

    const rule = rows[0];

    // 2 Setup transporter using .env
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const mailOptions = {
      from: process.env.SMTP_FROM_EMAIL,
      to: rule.recipients || rule.email, // fallback
      cc: rule.cc || "",
      bcc: rule.bcc || "",
      subject,
      html: body,
    };

    // 3 Send email
    const info = await transporter.sendMail(mailOptions);

    // 4 Log success
    await pool.query(
      `INSERT INTO email_log (rule_id, recipient, subject, body, sent_at, status)
       VALUES ($1, $2, $3, $4, NOW(), $5)`,
      [rule.id, mailOptions.to, subject, body, "SENT"]
    );

    console.log(`[Email] Sent successfully: ${eventType} -> ${info.response}`);
  } catch (err) {
    console.error(`[Email] Error sending for ${eventType}:`, err.message);

    // 5 Log failure
    try {
      await pool.query(
        `INSERT INTO email_log (rule_id, recipient, subject, body, sent_at, status)
         VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [null, "SYSTEM", subject, err.message, "FAILED"]
      );
    } catch (logErr) {
      console.error("[Email] Failed to log error:", logErr.message);
    }
  }
}
