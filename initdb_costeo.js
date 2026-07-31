import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = readFileSync(join(__dirname, 'schema_costeo.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tablas de consumo diario y costeo por banda creadas / verificadas');
  await pool.end();
}
main().catch(err => { console.error('Error:', err.message); process.exit(1); });
