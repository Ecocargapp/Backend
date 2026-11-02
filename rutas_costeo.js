// ============================================================
//  AgroSoft — Costeo por banda
//  Gestación: prorrateada por hembras en gestación por día
//  Lactancia: consumo real por banda
// ============================================================
import express from 'express';
import pool from './db.js';
import { calcularCosteoBanda } from './costeo_banda.js';

const router = express.Router();

// ---------- CONSUMO DIARIO DE LA GRANJA ----------
router.get('/consumo-diario', async (req, res) => {
  const desde = req.query.desde || '1900-01-01';
  const hasta = req.query.hasta || '2999-12-31';
  const { rows } = await pool.query(
    `SELECT * FROM consumo_diario WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha DESC`,
    [desde, hasta]);
  res.json(rows);
});

// Crear o actualizar el consumo de un día (un registro por fecha)
router.post('/consumo-diario', async (req, res) => {
  const { fecha, bultos_gestacion, costo_bulto_gestacion,
          bultos_lactancia, costo_bulto_lactancia, observaciones } = req.body;
  if (!fecha) return res.status(400).json({ error: 'La fecha es obligatoria' });
  const { rows } = await pool.query(
    `INSERT INTO consumo_diario (fecha, bultos_gestacion, costo_bulto_gestacion,
                                 bultos_lactancia, costo_bulto_lactancia, observaciones, usuario_id)
     VALUES ($1, COALESCE($2,0), $3, COALESCE($4,0), $5, $6, $7)
     ON CONFLICT (fecha) DO UPDATE SET
       bultos_gestacion=EXCLUDED.bultos_gestacion,
       costo_bulto_gestacion=EXCLUDED.costo_bulto_gestacion,
       bultos_lactancia=EXCLUDED.bultos_lactancia,
       costo_bulto_lactancia=EXCLUDED.costo_bulto_lactancia,
       observaciones=EXCLUDED.observaciones
     RETURNING *`,
    [fecha, bultos_gestacion, costo_bulto_gestacion||null,
     bultos_lactancia, costo_bulto_lactancia||null, observaciones||null, req.usuario?.id||null]);
  res.json(rows[0]);
});

// ---------- LACTANCIA POR BANDA (real, manual) ----------
router.post('/lactancia-banda', async (req, res) => {
  const { banda_id, fecha, bultos, costo_bulto, observaciones } = req.body;
  if (!banda_id || !fecha || bultos == null)
    return res.status(400).json({ error: 'Banda, fecha y bultos son obligatorios' });
  const { rows } = await pool.query(
    `INSERT INTO lactancia_banda (banda_id, fecha, bultos, costo_bulto, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [banda_id, fecha, bultos, costo_bulto||null, observaciones||null, req.usuario?.id||null]);
  res.json(rows[0]);
});

router.get('/lactancia-banda/:bandaId', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM lactancia_banda WHERE banda_id=$1 ORDER BY fecha', [Number(req.params.bandaId)]);
  res.json(rows);
});

// ============================================================
//  COSTEO DE UNA BANDA
//  Une gestación prorrateada + lactancia real
// ============================================================
router.get('/costeo/:bandaId', async (req, res) => {
  const bandaId = Number(req.params.bandaId);
  const resultado = await calcularCosteoBanda(bandaId);
  if (!resultado) return res.status(404).json({ error: 'Banda no encontrada' });
  res.json(resultado);
});


// ---------- Asignar hembras a una banda (por lista de aretes) ----------
router.post('/asignar-banda', async (req, res) => {
  const { banda_id, aretes } = req.body;
  if (!banda_id || !Array.isArray(aretes) || !aretes.length)
    return res.status(400).json({ error: 'Banda y lista de aretes son obligatorios' });
  const r = await pool.query(
    `UPDATE cerdas SET banda_id=$1 WHERE arete = ANY($2::text[])`,
    [banda_id, aretes]);
  res.json({ ok: true, actualizadas: r.rowCount });
});

// ---------- Cuántas hembras hay en cada fase hoy (para verificar el prorrateo) ----------
router.get('/estado-fases', async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0,10);
  const gestacion = Number((await pool.query(
    `SELECT COUNT(*) AS n FROM cerdas
     WHERE fecha_ultimo_servicio IS NOT NULL AND fecha_ultimo_servicio <= $1
       AND (fecha_ultimo_parto IS NULL OR fecha_ultimo_parto > $1)`, [fecha])).rows[0].n);
  const lactancia = Number((await pool.query(
    `SELECT COUNT(*) AS n FROM cerdas
     WHERE fecha_ultimo_parto IS NOT NULL AND fecha_ultimo_parto <= $1
       AND (fecha_ultimo_destete IS NULL OR fecha_ultimo_destete > $1)`, [fecha])).rows[0].n);
  res.json({ fecha, en_gestacion: gestacion, en_lactancia: lactancia });
});

export default router;
