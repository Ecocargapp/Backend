import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = readFileSync(join(__dirname, 'schema_campo.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tablas de la app de campo creadas / verificadas (recelos, claves_idempotencia)');
  await pool.end();
}
main().catch(err => { console.error('Error:', err.message); process.exit(1); });
