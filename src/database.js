const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const createTables = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

async function setupDatabase() {
  try {
    const client = await pool.connect();
    await client.query(createTables);
    client.release();
    console.log('Database setup completed');
  } catch (err) {
    console.error('Database setup error:', err);
    throw err;
  }
}

module.exports = {
  pool,
  setupDatabase
};
