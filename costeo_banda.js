// ============================================================
//  AgroSoft — Cálculo de costeo de banda (módulo compartido)
//  Usado por rutas_costeo.js (endpoint) y rutas_ceba.js (lotes).
// ============================================================
import pool from './db.js';

// Calcula el costeo completo de una banda: gestación prorrateada + lactancia
// por ventana. Devuelve el objeto con costos, lechones y costo por lechón.
export async function calcularCosteoBanda(bandaId) {
  const banda = (await pool.query('SELECT * FROM bandas WHERE id=$1', [bandaId])).rows[0];
  if (!banda) return null;

  const hembras = (await pool.query(
    `SELECT id, arete, fecha_ultimo_servicio, fecha_ultimo_parto, fecha_ultimo_destete
     FROM cerdas WHERE banda_id=$1`, [bandaId])).rows;

  const fServicios = hembras.map(h=>h.fecha_ultimo_servicio).filter(Boolean).sort();
  const fDestetes  = hembras.map(h=>h.fecha_ultimo_destete).filter(Boolean).sort();
  const corte_inicio = banda.fecha_servicio || fServicios[0] || null;
  const corte_fin    = banda.fecha_destete  || fDestetes[fDestetes.length-1] || null;

  // ---- GESTACIÓN PRORRATEADA ----
  let bultos_gestacion_banda = 0, costo_gestacion_banda = 0, dias_gestacion_calculados = 0;
  if (corte_inicio && corte_fin) {
    const diario = (await pool.query(
      `SELECT fecha, bultos_gestacion, costo_bulto_gestacion
       FROM consumo_diario WHERE fecha BETWEEN $1 AND $2 AND bultos_gestacion > 0`,
      [corte_inicio, corte_fin])).rows;
    for (const dia of diario) {
      const f = dia.fecha.toISOString().slice(0,10);
      const granjaGest = Number((await pool.query(
        `SELECT COUNT(*) AS n FROM cerdas
         WHERE fecha_ultimo_servicio IS NOT NULL AND fecha_ultimo_servicio <= $1
           AND (fecha_ultimo_parto IS NULL OR fecha_ultimo_parto > $1)`, [f])).rows[0].n);
      if (granjaGest === 0) continue;
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

  // ---- LACTANCIA AUTOMÁTICA POR VENTANA ----
  const fPartos = hembras.map(h=>h.fecha_ultimo_parto).filter(Boolean).sort();
  const lact_inicio = banda.fecha_parto || fPartos[0] || null;
  const lact_fin    = banda.fecha_destete || fDestetes[fDestetes.length-1] || null;
  let bultos_lactancia_banda = 0, costo_lactancia_banda = 0;
  if (lact_inicio && lact_fin) {
    const lactDiaria = (await pool.query(
      `SELECT COALESCE(SUM(bultos_lactancia),0) AS bultos,
              COALESCE(SUM(bultos_lactancia*COALESCE(costo_bulto_lactancia,0)),0) AS costo
       FROM consumo_diario WHERE fecha BETWEEN $1 AND $2`, [lact_inicio, lact_fin])).rows[0];
    bultos_lactancia_banda = Number(lactDiaria.bultos);
    costo_lactancia_banda = Number(lactDiaria.costo);
  }
  const lactManual = (await pool.query(
    `SELECT COALESCE(SUM(bultos),0) AS bultos,
            COALESCE(SUM(bultos*COALESCE(costo_bulto,0)),0) AS costo
     FROM lactancia_banda WHERE banda_id=$1`, [bandaId])).rows[0];
  bultos_lactancia_banda += Number(lactManual.bultos);
  costo_lactancia_banda += Number(lactManual.costo);

  // ---- LECHONES DESTETADOS ----
  const destetados = Number((await pool.query(
    `SELECT COALESCE(SUM(d.lechones_destetados),0) AS n
     FROM destetes d JOIN cerdas c ON c.id=d.cerda_id WHERE c.banda_id=$1`, [bandaId])).rows[0].n);

  const costo_total = costo_gestacion_banda + costo_lactancia_banda;

  return {
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
  };
}
