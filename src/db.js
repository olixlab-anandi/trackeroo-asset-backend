/*
------------------------------------------------------------------------------
File: src/db.js
Purpose:
  Initialize a PostgreSQL connection pool and expose a helper query function.

Usage:
  import { q } from './db.js';
  const { rows } = await q('SELECT 1');
------------------------------------------------------------------------------
*/

import { Pool } from 'pg';
import { ENV } from './env.js';

// Create a connection pool using DATABASE_URL from .env
export const pool = new Pool({ connectionString: ENV.DATABASE_URL });

// Simple helper for running queries
export const q = (text, params = []) => pool.query(text, params);
