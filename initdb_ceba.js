import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = readFileSync(join(__dirname, 'schema_ceba.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tablas de ceba creadas / verificadas');

  // Crear las granjas Barrancas y Barro si no existen
  for (const nombre of ['Barrancas', 'Barro']) {
    await pool.query(
      `INSERT INTO granjas_ceba (nombre) SELECT $1
       WHERE NOT EXISTS (SELECT 1 FROM granjas_ceba WHERE nombre=$1)`, [nombre]);
  }
  const g = (await pool.query('SELECT nombre FROM granjas_ceba ORDER BY nombre')).rows;
  console.log('✓ Granjas de ceba:', g.map(x=>x.nombre).join(', '));

  console.log('\nListo. El módulo de ceba está preparado.');
  await pool.end();
}
main().catch(err => { console.error('Error:', err.message); process.exit(1); });
