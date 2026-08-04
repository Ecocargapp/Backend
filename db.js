import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// El pool gestiona varias conexiones a la vez (necesario cuando varios
// usuarios operan simultáneamente).
const { Pool } = pg;

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  user:     process.env.DB_USER     || 'agrosoft',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'agrosoft',
  // Si algún día pasas a Amazon RDS, se activa SSL con DB_SSL=true
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL:', err);
});

export default pool;
