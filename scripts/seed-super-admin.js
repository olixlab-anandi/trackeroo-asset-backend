/*
------------------------------------------------------------------------------
File: scripts/seed-super-admin.js
Purpose:
  Seed the database with an initial Super Admin user so you can log in.

How it works:
  - Reads email, name, and password from environment variables.
  - Hashes the password with bcrypt.
  - Inserts or updates the user into the "users" table with role=super_admin.
  - Can be re-run safely: if the user exists, it updates their role + password.

Usage:
  # Make sure DATABASE_URL is set in .env
  npm run seed:superadmin
------------------------------------------------------------------------------
*/

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { q } from '../src/db.js';

async function main() {
  const email = process.env.SEED_SUPERADMIN_EMAIL;
  const name = process.env.SEED_SUPERADMIN_NAME;
  const password = process.env.SEED_SUPERADMIN_PASSWORD;

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set in .env');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  await q(
    `INSERT INTO users (email, name, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'super_admin', TRUE)
     ON CONFLICT (email)
     DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       role = 'super_admin',
       is_active = TRUE`,
    [email.toLowerCase(), name, hash]
  );

  //console.log(`✅ Super Admin ensured: ${email}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error seeding super admin:', err);
  process.exit(1);
});
