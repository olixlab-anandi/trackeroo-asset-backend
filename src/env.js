/*
------------------------------------------------------------------------------
File: src/env.js
Purpose:
  Central place to load environment variables with defaults.
------------------------------------------------------------------------------
*/

import 'dotenv/config';

export const ENV = {
  PORT: Number(process.env.PORT ?? 4000),
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-secret',
  COOKIE_NAME: process.env.COOKIE_NAME ?? 'at.sid',
  COOKIE_SECURE: (process.env.COOKIE_SECURE ?? 'false') === 'true',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
};
