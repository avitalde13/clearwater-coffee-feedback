// Database connection.
// On Railway, DATABASE_URL points at the Postgres service.
// Locally, if DATABASE_URL is not set, we use an in-memory Postgres (pg-mem)
// so the app runs with zero setup. In-memory data is lost on restart.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feedback (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(50),
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment    VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS photo TEXT; -- base64 image data
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS photo_type VARCHAR(30);
`;

function createPool() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    // Railway's private network (*.railway.internal) and localhost don't use SSL;
    // public Postgres URLs (e.g. Railway's TCP proxy) do.
    const noSsl = /localhost|127\.0\.0\.1|\.railway\.internal/.test(process.env.DATABASE_URL);
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: noSsl ? false : { rejectUnauthorized: false },
    });
  }

  if (process.env.RAILWAY_ENVIRONMENT) {
    throw new Error('DATABASE_URL is missing. In Railway, add the variable DATABASE_URL = ${{Postgres.DATABASE_URL}} to this service.');
  }

  console.warn('DATABASE_URL not set: using in-memory database (data resets on restart).');
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

const pool = createPool();

async function init() {
  await pool.query(SCHEMA);
}

module.exports = { pool, init };
