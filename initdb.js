import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // 1) Crear las tablas
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tablas creadas / verificadas');

  // 2) Usuario administrador de pruebas.
  //    Contraseña TEMPORAL solo para el primer ingreso: cámbiala en la app.
  const CONTRASENA_TEMPORAL = 'CambiarEsta2026';
  const email = 'jonatanbotero0105@gmail.com';

  const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
  if (existe.rowCount === 0) {
    const hash = bcrypt.hashSync(CONTRASENA_TEMPORAL, 10);
    await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, 'admin')`,
      ['Jonatan Botero', email, hash]
    );
    console.log('✓ Usuario administrador creado:');
    console.log('    email:      ' + email);
    console.log('    contraseña: ' + CONTRASENA_TEMPORAL + '   (CÁMBIALA al entrar)');
  } else {
    console.log('• El usuario administrador ya existe, no se modificó.');
  }

  // 3) Ubicación base
  await pool.query(
    `INSERT INTO ubicaciones (nombre, tipo)
     SELECT 'Planta de Concentrados', 'planta'
     WHERE NOT EXISTS (SELECT 1 FROM ubicaciones WHERE nombre = 'Planta de Concentrados')`
  );
  console.log('✓ Ubicación base (planta) verificada');

  console.log('\nListo. Inicia el servidor con: npm start');
  await pool.end();
}

main().catch(err => {
  console.error('Error inicializando la base de datos:', err.message);
  process.exit(1);
});
