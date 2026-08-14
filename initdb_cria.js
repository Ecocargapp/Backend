import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = readFileSync(join(__dirname, 'schema_cria.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tablas del módulo de cría creadas / verificadas');

  // Razas iniciales (vistas en la operación actual)
  for (const raza of ['Camborough', 'Franpabel']) {
    await pool.query(
      `INSERT INTO razas (nombre) SELECT $1
       WHERE NOT EXISTS (SELECT 1 FROM razas WHERE nombre = $1)`,
      [raza]
    );
  }
  console.log('✓ Razas base cargadas (Camborough, Franpabel)');

  console.log('\nListo. El módulo de cría está preparado.');
  await pool.end();
}

main().catch(err => {
  console.error('Error inicializando el módulo de cría:', err.message);
  process.exit(1);
});
