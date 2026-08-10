// ============================================================
//  AgroSoft — Informes de la granja de cría
//  Parámetros reproductivos, productivos y de costos
// ============================================================
import express from 'express';
import pool from './db.js';

const router = express.Router();

// Rango de fechas opcional para todos los informes (?desde=YYYY-MM-DD&hasta=YYYY-MM-DD)
function rango(req) {
  const desde = req.query.desde || '1900-01-01';
  const hasta = req.query.hasta || '2999-12-31';
  return { desde, hasta };
}

// ============================================================
//  INFORME REPRODUCTIVO
//  Indicadores de partos, nacidos, destetados y mortalidad
// ============================================================
router.get('/reproductivo', async (req, res) => {
  const { desde, hasta } = rango(req);

  const partos = (await pool.query(
    `SELECT
       COUNT(*)                              AS total_partos,
       COALESCE(SUM(nacidos_vivos),0)        AS nacidos_vivos,
       COALESCE(SUM(nacidos_muertos),0)      AS nacidos_muertos,
       COALESCE(SUM(momificados),0)          AS momificados,
       COALESCE(SUM(lechones_totales),0)     AS nacidos_totales,
       ROUND(AVG(nacidos_vivos)::numeric,2)  AS prom_nacidos_vivos,
       ROUND(AVG(lechones_totales)::numeric,2) AS prom_nacidos_totales,
       ROUND(AVG(peso_camada)::numeric,2)    AS prom_peso_camada
     FROM partos WHERE fecha_parto BETWEEN $1 AND $2`, [desde, hasta])).rows[0];

  const destetes = (await pool.query(
    `SELECT
       COUNT(*)                                 AS total_destetes,
       COALESCE(SUM(lechones_destetados),0)     AS lechones_destetados,
       ROUND(AVG(lechones_destetados)::numeric,2) AS prom_destetados,
       ROUND(AVG(peso_camada)::numeric,2)       AS prom_peso_destete
     FROM destetes WHERE fecha_destete BETWEEN $1 AND $2`, [desde, hasta])).rows[0];

  // Mortalidad en lactancia = (nacidos vivos - destetados) / nacidos vivos
  const nv = Number(partos.nacidos_vivos);
  const des = Number(destetes.lechones_destetados);
  const mortalidad_lactancia = nv > 0 ? Number((((nv - des) / nv) * 100).toFixed(2)) : null;

  // Servicios y tasa de partos
  const servicios = (await pool.query(
    `SELECT COUNT(*) AS total_servicios FROM servicios WHERE fecha_servicio BETWEEN $1 AND $2`,
    [desde, hasta])).rows[0];
  const tasa_partos = Number(servicios.total_servicios) > 0
    ? Number(((Number(partos.total_partos) / Number(servicios.total_servicios)) * 100).toFixed(2)) : null;

  res.json({
    periodo: { desde, hasta },
    partos: {
      total: Number(partos.total_partos),
      nacidos_vivos: Number(partos.nacidos_vivos),
      nacidos_muertos: Number(partos.nacidos_muertos),
      momificados: Number(partos.momificados),
      nacidos_totales: Number(partos.nacidos_totales),
      prom_nacidos_vivos: Number(partos.prom_nacidos_vivos) || 0,
      prom_nacidos_totales: Number(partos.prom_nacidos_totales) || 0,
      prom_peso_camada: Number(partos.prom_peso_camada) || 0,
    },
    destetes: {
      total: Number(destetes.total_destetes),
      lechones_destetados: Number(destetes.lechones_destetados),
      prom_destetados: Number(destetes.prom_destetados) || 0,
      prom_peso_destete: Number(destetes.prom_peso_destete) || 0,
    },
    mortalidad_lactancia_pct: mortalidad_lactancia,
    servicios: Number(servicios.total_servicios),
    tasa_partos_pct: tasa_partos,
  });
});

// ============================================================
//  INFORME POR BANDA
//  Agrupa los indicadores por banda/lote
// ============================================================
router.get('/por-banda', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT b.id, b.nombre, b.fecha_parto,
      COUNT(DISTINCT p.id)                     AS partos,
      COALESCE(SUM(p.nacidos_vivos),0)         AS nacidos_vivos,
      COALESCE(SUM(p.lechones_totales),0)      AS nacidos_totales,
      ROUND(AVG(p.nacidos_vivos)::numeric,2)   AS prom_nacidos_vivos,
      ROUND(AVG(p.peso_camada)::numeric,2)     AS prom_peso_camada,
      COALESCE(SUM(d.lechones_destetados),0)   AS destetados
    FROM bandas b
    LEFT JOIN partos p ON p.banda_id = b.id
    LEFT JOIN destetes d ON d.parto_id = p.id
    GROUP BY b.id, b.nombre, b.fecha_parto
    ORDER BY b.fecha_parto DESC NULLS LAST, b.nombre`);
  res.json(rows.map(r => ({
    ...r,
    partos: Number(r.partos), nacidos_vivos: Number(r.nacidos_vivos),
    nacidos_totales: Number(r.nacidos_totales),
    prom_nacidos_vivos: Number(r.prom_nacidos_vivos) || 0,
    prom_peso_camada: Number(r.prom_peso_camada) || 0,
    destetados: Number(r.destetados),
  })));
});

// ============================================================
//  INFORME DE CONSUMO Y COSTOS
//  Bultos por fase y costo por lechón
// ============================================================
router.get('/consumo', async (req, res) => {
  const { desde, hasta } = rango(req);

  const porFase = (await pool.query(`
    SELECT fase,
      ROUND(SUM(bultos)::numeric,2)                    AS bultos,
      ROUND(SUM(bultos * COALESCE(costo_bulto,0))::numeric,2) AS costo_total
    FROM consumos_alimento WHERE fecha BETWEEN $1 AND $2
    GROUP BY fase ORDER BY fase`, [desde, hasta])).rows;

  // Totales
  const tot = (await pool.query(`
    SELECT ROUND(SUM(bultos)::numeric,2) AS bultos_total,
           ROUND(SUM(bultos*COALESCE(costo_bulto,0))::numeric,2) AS costo_total
    FROM consumos_alimento WHERE fecha BETWEEN $1 AND $2`, [desde, hasta])).rows[0];

  // Lechones destetados en el periodo (base para costo por lechón)
  const destetados = Number((await pool.query(
    `SELECT COALESCE(SUM(lechones_destetados),0) AS n FROM destetes WHERE fecha_destete BETWEEN $1 AND $2`,
    [desde, hasta])).rows[0].n);

  // Bultos por fase como objeto
  const bultosPorFase = Object.fromEntries(porFase.map(f => [f.fase, Number(f.bultos)]));
  const costoTotal = Number(tot.costo_total) || 0;

  // Partos del periodo, para "bultos por lactancia/gestación" por camada
  const partos = Number((await pool.query(
    `SELECT COUNT(*) AS n FROM partos WHERE fecha_parto BETWEEN $1 AND $2`, [desde, hasta])).rows[0].n);

  res.json({
    periodo: { desde, hasta },
    por_fase: porFase.map(f => ({ fase: f.fase, bultos: Number(f.bultos), costo_total: Number(f.costo_total) })),
    bultos_total: Number(tot.bultos_total) || 0,
    costo_alimento_total: costoTotal,
    lechones_destetados: destetados,
    // Costo del lechón (solo alimento) = costo total alimento / lechones destetados
    costo_lechon_alimento: destetados > 0 ? Number((costoTotal / destetados).toFixed(2)) : null,
    // Bultos por camada según fase (referencia de eficiencia)
    bultos_lactancia_por_parto: partos > 0 && bultosPorFase.lactancia
      ? Number((bultosPorFase.lactancia / partos).toFixed(2)) : null,
    bultos_gestacion_por_parto: partos > 0 && bultosPorFase.gestacion
      ? Number((bultosPorFase.gestacion / partos).toFixed(2)) : null,
    nota: 'El costo del lechón considera solo alimento. Para costo total se sumarían sanidad, mano de obra e instalaciones.',
  });
});

// ============================================================
//  HEMBRAS A DESCARTAR
//  Criterios: ciclo alto, o bajo rendimiento en partos recientes
// ============================================================
router.get('/hembras-descartar', async (req, res) => {
  const cicloMax = Number(req.query.ciclo_max || 7);       // descarte por edad reproductiva
  const nvMin = Number(req.query.nacidos_vivos_min || 8);  // umbral de bajo rendimiento
  const diasIntervalo = Number(req.query.dias_intervalo || 21); // umbral destete-servicio

  // Por ciclo alto
  const porCiclo = (await pool.query(`
    SELECT id, arete, ciclo_actual, estado
    FROM cerdas WHERE activo=TRUE AND ciclo_actual >= $1
    ORDER BY ciclo_actual DESC, arete`, [cicloMax])).rows;

  // Por bajo rendimiento: promedio de nacidos vivos en sus últimos partos por debajo del umbral
  const porRendimiento = (await pool.query(`
    SELECT c.id, c.arete, c.ciclo_actual,
           ROUND(AVG(p.nacidos_vivos)::numeric,2) AS prom_nacidos_vivos,
           COUNT(p.id) AS partos_evaluados
    FROM cerdas c JOIN partos p ON p.cerda_id = c.id
    WHERE c.activo=TRUE
    GROUP BY c.id, c.arete, c.ciclo_actual
    HAVING COUNT(p.id) >= 2 AND AVG(p.nacidos_vivos) < $1
    ORDER BY AVG(p.nacidos_vivos)`, [nvMin])).rows;

  // CRITERIO A — Vacías sin servir: hembras en estado 'vacia' cuyo destete fue hace
  // más de N días y aún no han sido servidas después de ese destete.
  const vaciasSinServir = (await pool.query(`
    SELECT id, arete, ciclo_actual,
           fecha_ultimo_destete,
           (CURRENT_DATE - fecha_ultimo_destete) AS dias_desde_destete
    FROM cerdas
    WHERE activo=TRUE AND estado='vacia'
      AND fecha_ultimo_destete IS NOT NULL
      AND (CURRENT_DATE - fecha_ultimo_destete) > $1
      AND (fecha_ultimo_servicio IS NULL OR fecha_ultimo_servicio <= fecha_ultimo_destete)
    ORDER BY (CURRENT_DATE - fecha_ultimo_destete) DESC`, [diasIntervalo])).rows;

  // CRITERIO B — Intervalo histórico destete-servicio > N días en el último ciclo:
  // hembras que fueron servidas después de su destete, pero pasaron más de N días
  // entre ese destete y el servicio siguiente.
  const intervaloHistorico = (await pool.query(`
    SELECT id, arete, ciclo_actual, estado,
           fecha_ultimo_destete, fecha_ultimo_servicio,
           (fecha_ultimo_servicio - fecha_ultimo_destete) AS intervalo_dias
    FROM cerdas
    WHERE activo=TRUE
      AND fecha_ultimo_destete IS NOT NULL
      AND fecha_ultimo_servicio IS NOT NULL
      AND fecha_ultimo_servicio > fecha_ultimo_destete
      AND (fecha_ultimo_servicio - fecha_ultimo_destete) > $1
    ORDER BY (fecha_ultimo_servicio - fecha_ultimo_destete) DESC`, [diasIntervalo])).rows;

  res.json({
    criterios: { ciclo_max: cicloMax, nacidos_vivos_min: nvMin, dias_intervalo: diasIntervalo },
    por_ciclo_alto: porCiclo,
    por_bajo_rendimiento: porRendimiento.map(r => ({
      ...r, prom_nacidos_vivos: Number(r.prom_nacidos_vivos), partos_evaluados: Number(r.partos_evaluados)
    })),
    vacias_sin_servir: vaciasSinServir.map(r => ({
      ...r, dias_desde_destete: Number(r.dias_desde_destete),
      fecha_ultimo_destete: r.fecha_ultimo_destete
    })),
    intervalo_historico: intervaloHistorico.map(r => ({
      ...r, intervalo_dias: Number(r.intervalo_dias)
    })),
  });
});

// ============================================================
//  BANDAS (crear / listar)
// ============================================================
router.get('/bandas', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bandas ORDER BY fecha_parto DESC NULLS LAST, nombre');
  res.json(rows);
});
router.post('/bandas', async (req, res) => {
  const { nombre, fecha_servicio, fecha_parto, fecha_destete, observaciones } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre de la banda es obligatorio' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO bandas (nombre, fecha_servicio, fecha_parto, fecha_destete, observaciones)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [nombre.trim(), fecha_servicio||null, fecha_parto||null, fecha_destete||null, observaciones||null]);
    res.json(rows[0]);
  } catch { res.status(400).json({ error: 'Ya existe una banda con ese nombre' }); }
});

// ============================================================
//  CONSUMO DE ALIMENTO (registrar / listar)
// ============================================================
router.get('/consumos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ca.*, b.nombre AS banda FROM consumos_alimento ca
     LEFT JOIN bandas b ON b.id = ca.banda_id ORDER BY ca.fecha DESC LIMIT 200`);
  res.json(rows);
});
router.post('/consumos', async (req, res) => {
  const { fecha, fase, banda_id, tipo_alimento, bultos, kg_por_bulto, costo_bulto, observaciones } = req.body;
  if (!fecha || !fase || bultos == null)
    return res.status(400).json({ error: 'Fecha, fase y bultos son obligatorios' });
  const { rows } = await pool.query(
    `INSERT INTO consumos_alimento (fecha, fase, banda_id, tipo_alimento, bultos, kg_por_bulto, costo_bulto, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,40),$7,$8,$9) RETURNING *`,
    [fecha, fase, banda_id||null, tipo_alimento||null, bultos, kg_por_bulto||null,
     costo_bulto||null, observaciones||null, req.usuario?.id||null]);
  res.json(rows[0]);
});

export default router;
