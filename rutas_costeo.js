// ============================================================
//  AgroSoft — Costeo por banda
//  Gestación: prorrateada por hembras en gestación por día
//  Lactancia: consumo real por banda
// ============================================================
import express from 'express';
import pool from './db.js';

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
  const banda = (await pool.query('SELECT * FROM bandas WHERE id=$1', [bandaId])).rows[0];
  if (!banda) return res.status(404).json({ error: 'Banda no encontrada' });

  // Hembras de la banda (las que tienen banda_id = esta banda)
  const hembras = (await pool.query(
    `SELECT id, arete, fecha_ultimo_servicio, fecha_ultimo_parto, fecha_ultimo_destete
     FROM cerdas WHERE banda_id=$1`, [bandaId])).rows;

  // Rango del corte de la banda: del primer servicio al último destete de sus hembras
  const fServicios = hembras.map(h=>h.fecha_ultimo_servicio).filter(Boolean).sort();
  const fDestetes  = hembras.map(h=>h.fecha_ultimo_destete).filter(Boolean).sort();
  const corte_inicio = banda.fecha_servicio || fServicios[0] || null;
  const corte_fin    = banda.fecha_destete  || fDestetes[fDestetes.length-1] || null;

  // ---- GESTACIÓN PRORRATEADA ----
  // Para cada día del corte:
  //   consumo_por_hembra = bultos_gestacion_granja / hembras_en_gestacion_ese_dia
  //   cargo_banda = hembras_de_la_banda_en_gestacion_ese_dia * consumo_por_hembra
  // "En gestación ese día" = fecha entre su servicio y su parto.
  let bultos_gestacion_banda = 0;
  let costo_gestacion_banda = 0;
  let dias_gestacion_calculados = 0;

  if (corte_inicio && corte_fin) {
    // Traer el consumo diario de gestación del rango
    const diario = (await pool.query(
      `SELECT fecha, bultos_gestacion, costo_bulto_gestacion
       FROM consumo_diario WHERE fecha BETWEEN $1 AND $2 AND bultos_gestacion > 0`,
      [corte_inicio, corte_fin])).rows;

    for (const dia of diario) {
      const f = dia.fecha.toISOString().slice(0,10);
      // hembras de TODA la granja en gestación ese día
      const granjaGest = Number((await pool.query(
        `SELECT COUNT(*) AS n FROM cerdas
         WHERE fecha_ultimo_servicio IS NOT NULL
           AND fecha_ultimo_servicio <= $1
           AND (fecha_ultimo_parto IS NULL OR fecha_ultimo_parto > $1)`,
        [f])).rows[0].n);
      if (granjaGest === 0) continue;

      // hembras de la BANDA en gestación ese día
      const bandaGest = hembras.filter(h =>
        h.fecha_ultimo_servicio && h.fecha_ultimo_servicio.toISOString().slice(0,10) <= f &&
        (!h.fecha_ultimo_parto || h.fecha_ultimo_parto.toISOString().slice(0,10) > f)
      ).length;
      if (bandaGest === 0) continue;

      const consumoPorHembra = Number(dia.bultos_gestacion) / granjaGest;
      const cargoBanda = bandaGest * consumoPorHembra;
      bultos_gestacion_banda += cargoBanda;
      costo_gestacion_banda += cargoBanda * (Number(dia.costo_bulto_gestacion) || 0);
      dias_gestacion_calculados++;
    }
  }

  // ---- LACTANCIA AUTOMÁTICA POR VENTANA DE LA BANDA ----
  // Como se trabaja con bandas mensuales (una sola banda lactando a la vez),
  // el consumo de lactancia de la granja durante la ventana de la banda
  // (primer parto → último destete) corresponde íntegro a esa banda.
  const fPartos = hembras.map(h=>h.fecha_ultimo_parto).filter(Boolean).sort();
  const lact_inicio = banda.fecha_parto || fPartos[0] || null;
  const lact_fin    = banda.fecha_destete || fDestetes[fDestetes.length-1] || null;

  let bultos_lactancia_banda = 0;
  let costo_lactancia_banda = 0;
  if (lact_inicio && lact_fin) {
    const lactDiaria = (await pool.query(
      `SELECT COALESCE(SUM(bultos_lactancia),0) AS bultos,
              COALESCE(SUM(bultos_lactancia*COALESCE(costo_bulto_lactancia,0)),0) AS costo
       FROM consumo_diario WHERE fecha BETWEEN $1 AND $2`, [lact_inicio, lact_fin])).rows[0];
    bultos_lactancia_banda = Number(lactDiaria.bultos);
    costo_lactancia_banda = Number(lactDiaria.costo);
  }

  // Sumar además cualquier lactancia registrada manualmente para esta banda (si la hubiera)
  const lactManual = (await pool.query(
    `SELECT COALESCE(SUM(bultos),0) AS bultos,
            COALESCE(SUM(bultos*COALESCE(costo_bulto,0)),0) AS costo
     FROM lactancia_banda WHERE banda_id=$1`, [bandaId])).rows[0];
  bultos_lactancia_banda += Number(lactManual.bultos);
  costo_lactancia_banda += Number(lactManual.costo);

  // ---- LECHONES DESTETADOS DE LA BANDA ----
  const destetados = Number((await pool.query(
    `SELECT COALESCE(SUM(d.lechones_destetados),0) AS n
     FROM destetes d JOIN cerdas c ON c.id=d.cerda_id WHERE c.banda_id=$1`, [bandaId])).rows[0].n);

  const costo_total = costo_gestacion_banda + costo_lactancia_banda;

  res.json({
    banda: { id: banda.id, nombre: banda.nombre },
    corte: { inicio: corte_inicio, fin: corte_fin, dias_gestacion_calculados },
    ventana_lactancia: { inicio: lact_inicio, fin: lact_fin },
    hembras_en_banda: hembras.length,
    gestacion: {
      bultos: Number(bultos_gestacion_banda.toFixed(2)),
      costo: Number(costo_gestacion_banda.toFixed(2)),
      metodo: 'prorrateo por hembras en gestación por día'
    },
    lactancia: {
      bultos: Number(bultos_lactancia_banda.toFixed(2)),
      costo: Number(costo_lactancia_banda.toFixed(2)),
      metodo: 'consumo de la granja durante la ventana de lactancia de la banda (primer parto → último destete)'
    },
    costo_total: Number(costo_total.toFixed(2)),
    lechones_destetados: destetados,
    costo_por_lechon: destetados > 0 ? Number((costo_total / destetados).toFixed(2)) : null,
    nota: 'Costo solo de alimento (gestación prorrateada + lactancia por ventana de banda). No incluye sanidad, mano de obra ni instalaciones.'
  });
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
