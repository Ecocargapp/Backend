// ============================================================
//  AgroSoft — Tareas y vacunación
//  Genera el calendario de tareas según el estado reproductivo
// ============================================================
import express from 'express';
import pool from './db.js';

const router = express.Router();

function fechaMas(fecha, dias) {
  const d = new Date(fecha);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ---------- CATÁLOGO DE TAREAS ----------
router.get('/catalogo', async (req, res) => {
  const { tipo_animal } = req.query;
  let sql = 'SELECT * FROM tareas_catalogo WHERE activo=TRUE';
  const params = [];
  if (tipo_animal) { params.push(tipo_animal); sql += ` AND tipo_animal=$${params.length}`; }
  sql += ' ORDER BY tipo_animal, evento_ref, dias';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/catalogo', async (req, res) => {
  const { tipo_tarea, tarea, tipo_animal, evento_ref, dias, cantidad, observacion } = req.body;
  if (!tarea || !tipo_animal || !evento_ref || dias == null)
    return res.status(400).json({ error: 'Tarea, tipo de animal, evento y días son obligatorios' });
  const { rows } = await pool.query(
    `INSERT INTO tareas_catalogo (tipo_tarea, tarea, tipo_animal, evento_ref, dias, cantidad, observacion)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tipo_tarea||'Sanidad', tarea, tipo_animal, evento_ref, dias, cantidad||null, observacion||null]);
  res.json(rows[0]);
});

router.put('/catalogo/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { tipo_tarea, tarea, tipo_animal, evento_ref, dias, cantidad, observacion } = req.body;
  await pool.query(
    `UPDATE tareas_catalogo SET tipo_tarea=$1, tarea=$2, tipo_animal=$3, evento_ref=$4,
       dias=$5, cantidad=$6, observacion=$7 WHERE id=$8`,
    [tipo_tarea, tarea, tipo_animal, evento_ref, dias, cantidad||null, observacion||null, id]);
  res.json({ ok: true });
});

router.delete('/catalogo/:id', async (req, res) => {
  await pool.query('UPDATE tareas_catalogo SET activo=FALSE WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================
//  CALENDARIO DE TAREAS
//  Cruza el catálogo con las hembras activas y sus fechas,
//  calculando en qué fecha le toca cada tarea a cada animal.
//  Filtra por rango de fechas (?desde=&hasta=).
// ============================================================
router.get('/calendario', async (req, res) => {
  const desde = req.query.desde || new Date().toISOString().slice(0,10);
  const hasta = req.query.hasta || fechaMas(desde, 30);

  const catalogo = (await pool.query('SELECT * FROM tareas_catalogo WHERE activo=TRUE')).rows;
  const cerdas = (await pool.query(
    `SELECT id, arete, estado, fecha_ultimo_servicio, fecha_ultimo_parto, fecha_ultimo_destete, fecha_nacimiento
     FROM cerdas WHERE activo=TRUE`)).rows;

  // Tareas ya aplicadas (para no repetirlas)
  const aplicadas = (await pool.query(
    `SELECT tarea_id, cerda_id, fecha_programada FROM tareas_aplicadas`)).rows;
  const yaAplicada = new Set(aplicadas.map(a => `${a.tarea_id}-${a.cerda_id}-${a.fecha_programada?a.fecha_programada.toISOString().slice(0,10):''}`));

  const eventos = [];

  for (const t of catalogo) {
    // Elegir el conjunto de animales según el tipo
    for (const c of cerdas) {
      let fechaBase = null;
      // Determinar la fecha base según el evento de referencia y el tipo de animal
      if (t.tipo_animal === 'Gestante' && t.evento_ref === 'servicio') {
        // aplica a cerdas gestantes/servidas con servicio y sin parto posterior
        if (c.fecha_ultimo_servicio && (!c.fecha_ultimo_parto ||
            new Date(c.fecha_ultimo_parto) < new Date(c.fecha_ultimo_servicio)))
          fechaBase = c.fecha_ultimo_servicio;
      } else if (t.tipo_animal === 'Madre' && t.evento_ref === 'parto') {
        // aplica a madres lactantes con parto y sin destete posterior
        if (c.fecha_ultimo_parto && (!c.fecha_ultimo_destete ||
            new Date(c.fecha_ultimo_destete) < new Date(c.fecha_ultimo_parto)))
          fechaBase = c.fecha_ultimo_parto;
      } else if (t.tipo_animal === 'Reemplazo' && t.evento_ref === 'nacimiento') {
        if (c.estado === 'reemplazo' && c.fecha_nacimiento) fechaBase = c.fecha_nacimiento;
      }
      // (Lechones y Ceba se manejan por lote, no por cerda individual — ver más abajo)

      if (!fechaBase) continue;
      const fechaTarea = fechaMas(fechaBase, t.dias);
      if (fechaTarea < desde || fechaTarea > hasta) continue;
      const clave = `${t.id}-${c.id}-${fechaTarea}`;
      if (yaAplicada.has(clave)) continue;

      eventos.push({
        fecha: fechaTarea,
        tipo_tarea: t.tipo_tarea,
        tarea: t.tarea,
        tipo_animal: t.tipo_animal,
        animal: c.arete,
        cerda_id: c.id,
        tarea_id: t.id,
        dias: t.dias,
        evento_ref: t.evento_ref,
        cantidad: t.cantidad,
      });
    }
  }

  // Ordenar por fecha
  eventos.sort((a,b) => a.fecha.localeCompare(b.fecha) || a.tarea.localeCompare(b.tarea));

  // Resumen por tarea
  const resumen = {};
  for (const e of eventos) {
    const k = e.tarea;
    resumen[k] = (resumen[k]||0) + 1;
  }

  res.json({
    periodo: { desde, hasta },
    total: eventos.length,
    resumen,
    eventos,
    nota: 'Las tareas de Lechones y Ceba se programan por lote/camada (según fecha de parto o destete). Este calendario cubre las reproductoras individuales.',
  });
});

// ---------- MARCAR TAREA COMO APLICADA ----------
router.post('/aplicar', async (req, res) => {
  const { tarea_id, cerda_id, identificacion, fecha_programada, fecha_aplicada, operario, observacion } = req.body;
  if (!tarea_id) return res.status(400).json({ error: 'La tarea es obligatoria' });
  const { rows } = await pool.query(
    `INSERT INTO tareas_aplicadas (tarea_id, cerda_id, identificacion, fecha_programada, fecha_aplicada, operario, observacion, usuario_id)
     VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8) RETURNING *`,
    [tarea_id, cerda_id||null, identificacion||null, fecha_programada||null,
     fecha_aplicada||null, operario||null, observacion||null, req.usuario?.id||null]);
  res.json(rows[0]);
});

// ---------- HISTORIAL DE TAREAS APLICADAS ----------
router.get('/aplicadas', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ta.*, tc.tarea, tc.tipo_animal, c.arete
     FROM tareas_aplicadas ta
     LEFT JOIN tareas_catalogo tc ON tc.id = ta.tarea_id
     LEFT JOIN cerdas c ON c.id = ta.cerda_id
     ORDER BY ta.fecha_aplicada DESC LIMIT 200`);
  res.json(rows);
});

export default router;
