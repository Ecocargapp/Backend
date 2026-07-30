// ============================================================
//  AgroSoft — Rutas del módulo GRANJA DE CRÍA
//  Se monta sobre el servidor principal (server.js)
// ============================================================
import express from 'express';
import pool from './db.js';

const router = express.Router();

// Gestación porcina ≈ 114 días. Se usa para calcular la fecha probable de parto.
const DIAS_GESTACION = 114;

function fechaMas(fecha, dias) {
  const d = new Date(fecha);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ============================================================
//  RAZAS
// ============================================================
router.get('/razas', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM razas WHERE activo = TRUE ORDER BY nombre');
  res.json(rows);
});

router.post('/razas', async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre de la raza es obligatorio' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO razas (nombre) VALUES ($1) RETURNING *', [nombre.trim()]
    );
    res.json(rows[0]);
  } catch {
    res.status(400).json({ error: 'Esa raza ya existe' });
  }
});

// ============================================================
//  CERDAS (censo / ficha individual)
// ============================================================
router.get('/cerdas', async (req, res) => {
  const { estado, buscar } = req.query;
  let sql = `SELECT c.*, r.nombre AS raza
             FROM cerdas c LEFT JOIN razas r ON r.id = c.raza_id
             WHERE c.activo = TRUE`;
  const params = [];
  if (estado) { params.push(estado); sql += ` AND c.estado = $${params.length}`; }
  if (buscar) { params.push('%' + buscar + '%'); sql += ` AND c.arete ILIKE $${params.length}`; }
  sql += ' ORDER BY c.arete';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// Ficha completa de una cerda con todo su historial
router.get('/cerdas/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cerda = (await pool.query(
    `SELECT c.*, r.nombre AS raza FROM cerdas c
     LEFT JOIN razas r ON r.id = c.raza_id WHERE c.id = $1`, [id]
  )).rows[0];
  if (!cerda) return res.status(404).json({ error: 'Cerda no encontrada' });

  const servicios = (await pool.query(
    'SELECT * FROM servicios WHERE cerda_id = $1 ORDER BY fecha_servicio DESC', [id])).rows;
  const partos = (await pool.query(
    'SELECT * FROM partos WHERE cerda_id = $1 ORDER BY fecha_parto DESC', [id])).rows;
  const destetes = (await pool.query(
    'SELECT * FROM destetes WHERE cerda_id = $1 ORDER BY fecha_destete DESC', [id])).rows;
  const diagnosticos = (await pool.query(
    'SELECT * FROM diagnosticos WHERE cerda_id = $1 ORDER BY fecha DESC', [id])).rows;

  res.json({ ...cerda, servicios, partos, destetes, diagnosticos });
});

router.post('/cerdas', async (req, res) => {
  const { arete, arete_secundario, raza_id, fecha_nacimiento, fecha_ingreso,
          origen, estado, ubicacion, valor_compra, peso_ingreso, proveedor, observaciones } = req.body;
  if (!arete) return res.status(400).json({ error: 'El arete (ID) es obligatorio' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO cerdas (arete, arete_secundario, raza_id, fecha_nacimiento, fecha_ingreso,
                           origen, estado, ubicacion, valor_compra, peso_ingreso, proveedor, observaciones)
       VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),COALESCE($6,'compra'),
               COALESCE($7,'reemplazo'),$8,$9,$10,$11,$12) RETURNING *`,
      [arete.trim(), arete_secundario||null, raza_id||null, fecha_nacimiento||null,
       fecha_ingreso||null, origen||null, estado||null, ubicacion||null,
       valor_compra||null, peso_ingreso||null, proveedor||null, observaciones||null]
    );
    res.json(rows[0]);
  } catch (e) {
    if (String(e.message).includes('unique'))
      return res.status(400).json({ error: 'Ya existe una cerda con ese arete' });
    res.status(500).json({ error: 'Error al registrar la cerda' });
  }
});

router.put('/cerdas/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { arete_secundario, raza_id, fecha_nacimiento, ubicacion, observaciones } = req.body;
  await pool.query(
    `UPDATE cerdas SET arete_secundario=$1, raza_id=$2, fecha_nacimiento=$3,
                       ubicacion=$4, observaciones=$5 WHERE id=$6`,
    [arete_secundario||null, raza_id||null, fecha_nacimiento||null,
     ubicacion||null, observaciones||null, id]
  );
  res.json({ ok: true });
});

// ============================================================
//  SERVICIOS (inseminación)
// ============================================================
router.post('/servicios', async (req, res) => {
  const { cerda_id, fecha_servicio, tipo, verraco, dosis, operario, observaciones } = req.body;
  if (!cerda_id || !fecha_servicio)
    return res.status(400).json({ error: 'Cerda y fecha de servicio son obligatorios' });

  const cerda = (await pool.query('SELECT * FROM cerdas WHERE id=$1', [cerda_id])).rows[0];
  if (!cerda) return res.status(404).json({ error: 'Cerda no encontrada' });

  const ciclo = cerda.ciclo_actual + 1;  // el servicio abre un nuevo ciclo
  const { rows } = await pool.query(
    `INSERT INTO servicios (cerda_id, ciclo, fecha_servicio, tipo, verraco, dosis, operario, observaciones, usuario_id)
     VALUES ($1,$2,$3,COALESCE($4,'IA'),$5,$6,$7,$8,$9) RETURNING *`,
    [cerda_id, ciclo, fecha_servicio, tipo||null, verraco||null, dosis||null,
     operario||null, observaciones||null, req.usuario?.id||null]
  );
  // La cerda pasa a estado "servida"
  await pool.query("UPDATE cerdas SET estado='servida' WHERE id=$1", [cerda_id]);

  res.json({ ...rows[0], fecha_probable_parto: fechaMas(fecha_servicio, DIAS_GESTACION) });
});

// ============================================================
//  DIAGNÓSTICO DE PREÑEZ
// ============================================================
router.post('/diagnosticos', async (req, res) => {
  const { servicio_id, cerda_id, fecha, resultado, metodo, observaciones } = req.body;
  if (!cerda_id || !fecha || !resultado)
    return res.status(400).json({ error: 'Cerda, fecha y resultado son obligatorios' });

  const { rows } = await pool.query(
    `INSERT INTO diagnosticos (servicio_id, cerda_id, fecha, resultado, metodo, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [servicio_id||null, cerda_id, fecha, resultado, metodo||null, observaciones||null, req.usuario?.id||null]
  );
  // positivo → gestante ; negativo → vuelve a vacía para reservicio
  const nuevoEstado = resultado === 'positivo' ? 'gestante' : (resultado === 'negativo' ? 'vacia' : null);
  if (nuevoEstado) await pool.query('UPDATE cerdas SET estado=$1 WHERE id=$2', [nuevoEstado, cerda_id]);

  res.json(rows[0]);
});

// ============================================================
//  PARTOS
// ============================================================
router.post('/partos', async (req, res) => {
  const { cerda_id, servicio_id, fecha_parto, nacidos_vivos, nacidos_muertos,
          momificados, peso_camada, observaciones } = req.body;
  if (!cerda_id || !fecha_parto)
    return res.status(400).json({ error: 'Cerda y fecha de parto son obligatorios' });

  const cerda = (await pool.query('SELECT * FROM cerdas WHERE id=$1', [cerda_id])).rows[0];
  if (!cerda) return res.status(404).json({ error: 'Cerda no encontrada' });
  const ciclo = cerda.ciclo_actual + 1;

  const { rows } = await pool.query(
    `INSERT INTO partos (cerda_id, servicio_id, ciclo, fecha_parto,
                         nacidos_vivos, nacidos_muertos, momificados, peso_camada, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,COALESCE($5,0),COALESCE($6,0),COALESCE($7,0),$8,$9,$10) RETURNING *`,
    [cerda_id, servicio_id||null, ciclo, fecha_parto,
     nacidos_vivos, nacidos_muertos, momificados, peso_camada||null,
     observaciones||null, req.usuario?.id||null]
  );
  // La cerda pasa a lactante y sube su contador de ciclos
  await pool.query("UPDATE cerdas SET estado='lactante', ciclo_actual=$1 WHERE id=$2", [ciclo, cerda_id]);

  res.json(rows[0]);
});

// ============================================================
//  DESTETES
// ============================================================
router.post('/destetes', async (req, res) => {
  const { parto_id, cerda_id, fecha_destete, lechones_destetados, peso_camada, observaciones } = req.body;
  if (!parto_id || !cerda_id || !fecha_destete)
    return res.status(400).json({ error: 'Parto, cerda y fecha de destete son obligatorios' });

  const cerda = (await pool.query('SELECT * FROM cerdas WHERE id=$1', [cerda_id])).rows[0];
  const { rows } = await pool.query(
    `INSERT INTO destetes (parto_id, cerda_id, ciclo, fecha_destete, lechones_destetados, peso_camada, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,COALESCE($5,0),$6,$7,$8) RETURNING *`,
    [parto_id, cerda_id, cerda.ciclo_actual, fecha_destete,
     lechones_destetados, peso_camada||null, observaciones||null, req.usuario?.id||null]
  );
  // Tras el destete la cerda queda vacía, lista para nuevo servicio
  await pool.query("UPDATE cerdas SET estado='vacia' WHERE id=$1", [cerda_id]);

  res.json(rows[0]);
});

// ============================================================
//  SALIDAS (muerte / descarte / venta)
// ============================================================
router.post('/salidas', async (req, res) => {
  const { cerda_id, fecha, tipo, causa, valor_venta, peso, comprador, observaciones } = req.body;
  if (!cerda_id || !fecha || !tipo)
    return res.status(400).json({ error: 'Cerda, fecha y tipo de salida son obligatorios' });

  const { rows } = await pool.query(
    `INSERT INTO salidas_cerda (cerda_id, fecha, tipo, causa, valor_venta, peso, comprador, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [cerda_id, fecha, tipo, causa||null, valor_venta||null, peso||null,
     comprador||null, observaciones||null, req.usuario?.id||null]
  );
  const estado = tipo === 'muerte' ? 'muerta' : (tipo === 'venta' ? 'vendida' : 'descartada');
  await pool.query('UPDATE cerdas SET estado=$1, activo=FALSE WHERE id=$2', [estado, cerda_id]);

  res.json(rows[0]);
});

// ============================================================
//  RESUMEN / TABLERO
// ============================================================
router.get('/resumen', async (req, res) => {
  const total = (await pool.query('SELECT COUNT(*) FROM cerdas WHERE activo=TRUE')).rows[0].count;
  const porEstado = (await pool.query(
    `SELECT estado, COUNT(*) AS cantidad FROM cerdas WHERE activo=TRUE GROUP BY estado`)).rows;
  res.json({ total: Number(total), por_estado: porEstado });
});

export default router;
