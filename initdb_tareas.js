import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Catálogo de tareas de Agriness (22) + inmunocastración de ceba (2)
const CATALOGO = [
  // Reemplazo (días de edad / nacimiento)
  ['Sanidad','Vacuna - Micoflex','Reemplazo','nacimiento',112,'1'],
  ['Sanidad','Vacuna - Cyrcoflex','Reemplazo','nacimiento',150,'1'],
  ['Sanidad','Vacuna - PARVOLEPTO','Reemplazo','nacimiento',175,'1'],
  ['Sanidad','Vacuna - PARVOLEPTO','Reemplazo','nacimiento',190,'1'],
  ['Sanidad','Vacuna - Glaserella','Reemplazo','nacimiento',165,'1'],
  ['Sanidad','Vacuna - Glaserella','Reemplazo','nacimiento',180,'1'],
  // Gestante (días de gestación / servicio)
  ['Sanidad','Vacuna - Micoflex','Gestante','servicio',63,'1'],
  ['Sanidad','Vacuna - Micoflex','Gestante','servicio',77,'1'],
  ['Sanidad','Vacuna - Cyrcoflex','Gestante','servicio',80,'1'],
  ['Sanidad','Vacuna - E. coli','Gestante','servicio',70,'1'],
  ['Sanidad','Vacuna - E. coli','Gestante','servicio',84,'1'],
  ['Operacional','CHEQUEO 18 A 23','Gestante','servicio',18,'-'],
  ['Operacional','CHEQUEO 30 DIAS','Gestante','servicio',30,'-'],
  ['Operacional','CHEQUEO 36 A 46 DIAS','Gestante','servicio',40,'-'],
  ['Operacional','CHEQUEO 60 DIAS','Gestante','servicio',60,'-'],
  // Madre (días de lactancia / parto)
  ['Sanidad','Vacuna - PARVOLEPTO','Madre','parto',7,'1'],
  ['Sanidad','Medicamento - Betaferol','Madre','parto',21,'10'],
  // Lechones (días de edad / nacimiento)
  ['Sanidad','Vacuna - Hierro','Lechones','nacimiento',1,'1'],
  ['Sanidad','Vacuna - VEPURED','Lechones','nacimiento',7,'1'],
  ['Sanidad','Vacuna - HIPRASUIS GLASSER','Lechones','nacimiento',7,'1'],
  ['Sanidad','Vacuna - HIPRASUIS GLASSER','Lechones','nacimiento',21,'1'],
  ['Sanidad','Medicamento - AMOXIPHAR','Lechones','nacimiento',21,'1'],
  // Ceba (inmunocastración por edad: semana 8 = 56 días, semana 12 = 84 días)
  ['Sanidad','Inmunocastración - Dosis 1','Ceba','nacimiento',56,'1'],
  ['Sanidad','Inmunocastración - Dosis 2','Ceba','nacimiento',84,'1'],
];

async function main() {
  const schema = readFileSync(join(__dirname, 'schema_tareas.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tablas de tareas creadas / verificadas');

  // Cargar catálogo (idempotente: solo si está vacío)
  const existe = Number((await pool.query('SELECT COUNT(*) AS n FROM tareas_catalogo')).rows[0].n);
  if (existe === 0) {
    for (const [tt, t, ta, ev, d, c] of CATALOGO) {
      await pool.query(
        `INSERT INTO tareas_catalogo (tipo_tarea, tarea, tipo_animal, evento_ref, dias, cantidad)
         VALUES ($1,$2,$3,$4,$5,$6)`, [tt, t, ta, ev, d, c]);
    }
    console.log(`✓ Catálogo cargado: ${CATALOGO.length} tareas`);
  } else {
    console.log(`✓ Catálogo ya tenía ${existe} tareas (no se recargó)`);
  }

  console.log('\nListo. El módulo de tareas está preparado.');
  await pool.end();
}
main().catch(err => { console.error('Error:', err.message); process.exit(1); });
