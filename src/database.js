// database.js
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Функція для перевірки підключення з повторними спробами
const connectWithRetry = async () => {
  const maxRetries = 5;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      console.log('Successfully connected to database');
      client.release();
      return;
    } catch (err) {
      retries += 1;
      console.log(`Failed to connect to database (attempt ${retries}/${maxRetries}):`, err.message);
      // Чекаємо 5 секунд перед наступною спробою
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  // Якщо всі спроби невдалі
  throw new Error('Failed to connect to database after multiple attempts');
};

// Експортуємо pool та функцію підключення
module.exports = {
  pool,
  connectWithRetry
};