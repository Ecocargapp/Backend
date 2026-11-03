import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';
import { sincronizarGranjas } from './rutas_planta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = readFileSync(join(__dirname, 'schema_planta.sql'), 'utf-8');
  await pool.query(schema);
  await sincronizarGranjas();
  const g = (await pool.query('SELECT nombre, tipo FROM alimento_granjas ORDER BY tipo, nombre')).rows;
  const r = (await pool.query('SELECT nombre FROM alimento_referencias ORDER BY orden')).rows;
  console.log('✓ Módulo de planta listo');
  console.log('  Granjas:', g.map(x => `${x.nombre} (${x.tipo})`).join(', '));
  console.log('  Referencias:', r.map(x => x.nombre).join(', '));
  await pool.end();
}
main().catch(err => { console.error('Error:', err.message); process.exit(1); });
