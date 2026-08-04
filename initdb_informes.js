import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = readFileSync(join(__dirname, 'schema_informes.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tablas de bandas y consumo de alimento creadas / verificadas');
  console.log('\nListo. El módulo de informes está preparado.');
  await pool.end();
}

main().catch(err => {
  console.error('Error inicializando informes:', err.message);
  process.exit(1);
});
