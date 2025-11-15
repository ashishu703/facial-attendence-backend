const { Pool } = require('pg');
require('dotenv').config();

// This configuration directly maps to our.env file.
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  
  // CRITICAL: This line is mandated by the.env (DB_SSL=require)
  ssl: process.env.DB_SSL === 'require' ? { rejectUnauthorized: false } : false,
});

// Test the connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database:', err.stack);
  } else {
    console.log('Database connected successfully:', res.rows[0].now);
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};

