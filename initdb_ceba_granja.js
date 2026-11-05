// ============================================================
//  Migración: inventario de ceba POR GRANJA (en lugar de por lote)
//  - Cada lote ya trasladado genera su movimiento de INGRESO en la granja.
//  - Los pesajes aceptan el tipo 'granja'.
//  Es seguro correrlo varias veces. Imprime el inventario antes y después para verificar.
// ============================================================
import pool from './db.js';

async function inventarios() {
  const viejo = (await pool.query(
    `SELECT g.id, g.nombre,
       COALESCE((SELECT SUM(l.lechones) FROM lotes_destete l WHERE l.granja_ceba_id = g.id AND l.activo = TRUE), 0)
       - COALESCE((SELECT SUM(m.cantidad) FROM movimientos_ceba m JOIN lotes_destete l ON l.id = m.lote_id
                   WHERE l.granja_ceba_id = g.id AND l.activo = TRUE AND m.tipo IN ('muerte','venta')), 0) AS inv
     FROM granjas_ceba g ORDER BY g.nombre`)).rows;
  const nuevo = (await pool.query(
    `SELECT g.id, g.nombre,
       COALESCE((SELECT SUM(CASE m.tipo WHEN 'ingreso' THEN m.cantidad ELSE -m.cantidad END)
                 FROM movimientos_ceba m WHERE m.granja_id = g.id AND m.tipo IN ('ingreso','muerte','venta')), 0) AS inv
     FROM granjas_ceba g ORDER BY g.nombre`)).rows;
  return { viejo, nuevo };
}

async function main() {
  const antes = await inventarios();

  // 1. Ingreso en la granja por cada lote ya trasladado que aún no lo tiene
  const r = await pool.query(
    `INSERT INTO movimientos_ceba (granja_id, lote_id, fecha, tipo, cantidad, peso_promedio, peso_total, costo_lechon, causa, observaciones)
     SELECT l.granja_ceba_id, l.id, COALESCE(l.trasladado_en::date, CURRENT_DATE), 'ingreso', l.lechones,
            l.peso_entrada_prom, l.peso_total, l.costo_por_lechon, 'Traslado desde cría', 'Lote ' || l.nombre
     FROM lotes_destete l
     WHERE l.granja_ceba_id IS NOT NULL AND l.movimiento_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM movimientos_ceba m WHERE m.lote_id = l.id AND m.tipo = 'ingreso')`);
  console.log(`✓ Ingresos creados para lotes ya trasladados: ${r.rowCount}`);
  await pool.query(
    `UPDATE lotes_destete l SET movimiento_id = m.id
     FROM movimientos_ceba m WHERE m.lote_id = l.id AND m.tipo = 'ingreso' AND l.movimiento_id IS NULL`);

  // 2. Pesajes por granja
  const hayPesajes = (await pool.query(`SELECT to_regclass('public.pesajes') AS t`)).rows[0].t;
  if (hayPesajes) {
    await pool.query(`ALTER TABLE pesajes DROP CONSTRAINT IF EXISTS pesajes_tipo_check`);
    await pool.query(`ALTER TABLE pesajes ADD CONSTRAINT pesajes_tipo_check CHECK (tipo IN ('hembra','lote','granja'))`);
    await pool.query(`ALTER TABLE pesajes ADD COLUMN IF NOT EXISTS granja_ceba_id INTEGER REFERENCES granjas_ceba(id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pesajes_granja ON pesajes(granja_ceba_id)`);
    console.log('✓ Pesajes por granja habilitados');
  }

  // 3. Verificación
  const des = await inventarios();
  console.log('\nInventario de animales por granja (antes → después):');
  let alerta = false;
  for (const g of des.nuevo) {
    const a = Number(antes.viejo.find(x => x.id === g.id)?.inv || 0), d = Number(g.inv);
    if (a !== d) alerta = true;
    console.log(`  ${g.nombre}: ${a} → ${d}${a !== d ? '   ⚠ NO COINCIDE, revisar' : '   ✓'}`);
  }
  if (alerta) console.log('\n⚠ Hay diferencias: puede haber movimientos antiguos sin lote. Avísame antes de seguir usando la ceba.');
  else console.log('\nListo. El inventario de ceba ahora se maneja por granja y coincide con el anterior.');
  await pool.end();
}
main().catch(err => { console.error('Error:', err.message); process.exit(1); });
