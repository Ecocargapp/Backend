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
  await pool.query("UPDATE cerdas SET estado='servida', fecha_ultimo_servicio=$2 WHERE id=$1", [cerda_id, fecha_servicio]);

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
  await pool.query("UPDATE cerdas SET estado='lactante', ciclo_actual=$1, fecha_ultimo_parto=$3 WHERE id=$2", [ciclo, cerda_id, fecha_parto]);

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
  await pool.query("UPDATE cerdas SET estado='vacia', fecha_ultimo_destete=$2 WHERE id=$1", [cerda_id, fecha_destete]);

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

// ---------- VER CERDAS QUE SALIERON (descartadas/vendidas/muertas) ----------
router.get('/salidas', async (req, res) => {
  const { tipo } = req.query; // opcional: filtrar por descarte/venta/muerte
  let sql = `
    SELECT s.id AS salida_id, s.cerda_id, s.fecha, s.tipo, s.causa, s.valor_venta,
           s.peso, s.comprador, s.observaciones,
           c.arete, c.estado, c.ciclo_actual, c.raza_id, r.nombre AS raza
    FROM salidas_cerda s
    JOIN cerdas c ON c.id = s.cerda_id
    LEFT JOIN razas r ON r.id = c.raza_id
    WHERE c.activo = FALSE`;
  const params = [];
  if (tipo) { params.push(tipo); sql += ` AND s.tipo = $${params.length}`; }
  sql += ' ORDER BY s.fecha DESC, s.id DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// ---------- REVERTIR UNA SALIDA (reactivar la cerda) ----------
router.delete('/salidas/:id', async (req, res) => {
  const salidaId = Number(req.params.id);
  const salida = (await pool.query('SELECT * FROM salidas_cerda WHERE id=$1', [salidaId])).rows[0];
  if (!salida) return res.status(404).json({ error: 'Salida no encontrada' });

  // Borrar el registro de salida
  await pool.query('DELETE FROM salidas_cerda WHERE id=$1', [salidaId]);
  // Reactivar la cerda
  await pool.query('UPDATE cerdas SET activo=TRUE WHERE id=$1', [salida.cerda_id]);
  // Recalcular su estado según sus fechas (servicio/parto/destete)
  await recalcularCerda(salida.cerda_id);

  res.json({ ok: true, cerda_id: salida.cerda_id });
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

// ============================================================
//  RECÁLCULO DE ESTADO Y FECHAS DE UNA CERDA
//  Se ejecuta tras editar o eliminar cualquier evento, para mantener
//  coherentes el estado, el ciclo y las fechas (que alimentan el prorrateo).
// ============================================================
async function recalcularCerda(cerdaId) {
  const ultServicio = (await pool.query(
    'SELECT fecha_servicio FROM servicios WHERE cerda_id=$1 ORDER BY fecha_servicio DESC LIMIT 1', [cerdaId])).rows[0];
  const ultParto = (await pool.query(
    'SELECT fecha_parto FROM partos WHERE cerda_id=$1 ORDER BY fecha_parto DESC LIMIT 1', [cerdaId])).rows[0];
  const ultDestete = (await pool.query(
    'SELECT fecha_destete FROM destetes WHERE cerda_id=$1 ORDER BY fecha_destete DESC LIMIT 1', [cerdaId])).rows[0];
  const numPartos = Number((await pool.query(
    'SELECT COUNT(*) AS n FROM partos WHERE cerda_id=$1', [cerdaId])).rows[0].n);

  const fs = ultServicio?.fecha_servicio || null;
  const fp = ultParto?.fecha_parto || null;
  const fd = ultDestete?.fecha_destete || null;

  // Si la cerda ya salió del hato (muerta/vendida/descartada), no tocar su estado.
  const cerda = (await pool.query('SELECT estado, activo FROM cerdas WHERE id=$1', [cerdaId])).rows[0];
  if (!cerda || !cerda.activo) {
    // solo actualizar fechas y ciclo
    await pool.query(
      `UPDATE cerdas SET fecha_ultimo_servicio=$1, fecha_ultimo_parto=$2, fecha_ultimo_destete=$3, ciclo_actual=$4 WHERE id=$5`,
      [fs, fp, fd, numPartos, cerdaId]);
    return;
  }

  // Determinar estado por la secuencia de fechas
  let estado = 'vacia';
  const t = f => f ? new Date(f).getTime() : 0;
  if (fs && t(fs) >= t(fp) && t(fs) >= t(fd)) estado = 'servida';
  else if (fp && t(fp) >= t(fd) && t(fp) >= t(fs)) estado = 'lactante';
  else if (fd) estado = 'vacia';
  else estado = 'reemplazo';

  await pool.query(
    `UPDATE cerdas SET estado=$1, ciclo_actual=$2,
       fecha_ultimo_servicio=$3, fecha_ultimo_parto=$4, fecha_ultimo_destete=$5 WHERE id=$6`,
    [estado, numPartos, fs, fp, fd, cerdaId]);
}

// ---------- EDITAR / ELIMINAR SERVICIO ----------
router.put('/servicios/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { fecha_servicio, tipo, verraco, dosis, operario, observaciones } = req.body;
  const s = (await pool.query('SELECT cerda_id FROM servicios WHERE id=$1', [id])).rows[0];
  if (!s) return res.status(404).json({ error: 'Servicio no encontrado' });
  await pool.query(
    `UPDATE servicios SET fecha_servicio=COALESCE($1,fecha_servicio), tipo=COALESCE($2,tipo),
       verraco=$3, dosis=$4, operario=$5, observaciones=$6 WHERE id=$7`,
    [fecha_servicio||null, tipo||null, verraco||null, dosis||null, operario||null, observaciones||null, id]);
  await recalcularCerda(s.cerda_id);
  res.json({ ok: true });
});
router.delete('/servicios/:id', async (req, res) => {
  const id = Number(req.params.id);
  const s = (await pool.query('SELECT cerda_id FROM servicios WHERE id=$1', [id])).rows[0];
  if (!s) return res.status(404).json({ error: 'Servicio no encontrado' });
  // No permitir borrar si tiene diagnósticos o partos ligados
  const dep = Number((await pool.query('SELECT COUNT(*) AS n FROM partos WHERE servicio_id=$1', [id])).rows[0].n);
  if (dep > 0) return res.status(400).json({ error: 'No se puede eliminar: tiene un parto asociado. Elimina primero el parto.' });
  await pool.query('DELETE FROM diagnosticos WHERE servicio_id=$1', [id]);
  await pool.query('DELETE FROM servicios WHERE id=$1', [id]);
  await recalcularCerda(s.cerda_id);
  res.json({ ok: true });
});

// ---------- EDITAR / ELIMINAR PARTO ----------
router.put('/partos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { fecha_parto, nacidos_vivos, nacidos_muertos, momificados, peso_camada, observaciones } = req.body;
  const p = (await pool.query('SELECT cerda_id FROM partos WHERE id=$1', [id])).rows[0];
  if (!p) return res.status(404).json({ error: 'Parto no encontrado' });
  await pool.query(
    `UPDATE partos SET fecha_parto=COALESCE($1,fecha_parto),
       nacidos_vivos=COALESCE($2,nacidos_vivos), nacidos_muertos=COALESCE($3,nacidos_muertos),
       momificados=COALESCE($4,momificados), peso_camada=$5, observaciones=$6 WHERE id=$7`,
    [fecha_parto||null, nacidos_vivos, nacidos_muertos, momificados, peso_camada||null, observaciones||null, id]);
  await recalcularCerda(p.cerda_id);
  res.json({ ok: true });
});
router.delete('/partos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const p = (await pool.query('SELECT cerda_id FROM partos WHERE id=$1', [id])).rows[0];
  if (!p) return res.status(404).json({ error: 'Parto no encontrado' });
  const dep = Number((await pool.query('SELECT COUNT(*) AS n FROM destetes WHERE parto_id=$1', [id])).rows[0].n);
  if (dep > 0) return res.status(400).json({ error: 'No se puede eliminar: tiene un destete asociado. Elimina primero el destete.' });
  await pool.query('DELETE FROM partos WHERE id=$1', [id]);
  await recalcularCerda(p.cerda_id);
  res.json({ ok: true });
});

// ---------- EDITAR / ELIMINAR DESTETE ----------
router.put('/destetes/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { fecha_destete, lechones_destetados, peso_camada, observaciones } = req.body;
  const d = (await pool.query('SELECT cerda_id FROM destetes WHERE id=$1', [id])).rows[0];
  if (!d) return res.status(404).json({ error: 'Destete no encontrado' });
  await pool.query(
    `UPDATE destetes SET fecha_destete=COALESCE($1,fecha_destete),
       lechones_destetados=COALESCE($2,lechones_destetados), peso_camada=$3, observaciones=$4 WHERE id=$5`,
    [fecha_destete||null, lechones_destetados, peso_camada||null, observaciones||null, id]);
  await recalcularCerda(d.cerda_id);
  res.json({ ok: true });
});
router.delete('/destetes/:id', async (req, res) => {
  const id = Number(req.params.id);
  const d = (await pool.query('SELECT cerda_id FROM destetes WHERE id=$1', [id])).rows[0];
  if (!d) return res.status(404).json({ error: 'Destete no encontrado' });
  await pool.query('DELETE FROM destetes WHERE id=$1', [id]);
  await recalcularCerda(d.cerda_id);
  res.json({ ok: true });
});

export default router;
