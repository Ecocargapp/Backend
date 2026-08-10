// ============================================================
//  AgroSoft — Ceba (engorde) — REDISEÑO POR LOTE
//  El lote es la unidad central: inventario, consumo y ventas por lote.
// ============================================================
import express from 'express';
import pool from './db.js';
import { calcularCosteoBanda } from './costeo_banda.js';

const router = express.Router();
const KG_POR_BULTO = 40;

// ---------- GRANJAS ----------
router.get('/granjas', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM granjas_ceba WHERE activa=TRUE ORDER BY nombre');
  res.json(rows);
});
router.post('/granjas', async (req, res) => {
  const { nombre, ubicacion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const { rows } = await pool.query(
    `INSERT INTO granjas_ceba (nombre, ubicacion) VALUES ($1,$2)
     ON CONFLICT (nombre) DO UPDATE SET ubicacion=EXCLUDED.ubicacion RETURNING *`,
    [nombre, ubicacion||null]);
  res.json(rows[0]);
});

// ---------- INVENTARIO DE UN LOTE ----------
async function calcularInventarioLote(loteId, hasta=null) {
  const lote = (await pool.query('SELECT * FROM lotes_destete WHERE id=$1', [loteId])).rows[0];
  if (!lote) return null;
  const filtroFecha = hasta ? 'AND fecha <= $2' : '';
  const params = hasta ? [loteId, hasta] : [loteId];
  const mov = (await pool.query(
    `SELECT tipo, SUM(cantidad) AS animales, SUM(cantidad*COALESCE(peso_promedio,0)) AS peso,
            SUM(COALESCE(valor_venta,0)) AS valor_venta
     FROM movimientos_ceba WHERE lote_id=$1 ${filtroFecha} GROUP BY tipo`, params)).rows;
  let muertes=0, ventas=0, peso_venta=0, valor_ventas=0;
  for (const m of mov) {
    const n = Number(m.animales);
    if (m.tipo==='muerte') muertes=n;
    else if (m.tipo==='venta') { ventas=n; peso_venta=Number(m.peso); valor_ventas=Number(m.valor_venta); }
  }
  const ingresados = Number(lote.lechones);
  const costo_lechon_unit = Number(lote.costo_por_lechon) || 0;
  return {
    lote, ingresados, muertes, ventas,
    inventario_actual: ingresados - muertes - ventas,
    peso_entrada_total: Number(lote.peso_total) || 0,
    peso_entrada_prom: ingresados > 0 ? (Number(lote.peso_total)||0) / ingresados : 0,
    peso_venta_total: peso_venta,
    costo_lechon_unit, costo_lechones_total: costo_lechon_unit * ingresados,
    valor_ventas,
  };
}
async function consumoLote(loteId, hasta=null) {
  const filtro = hasta ? 'AND fecha <= $2' : '';
  const params = hasta ? [loteId, hasta] : [loteId];
  const c = (await pool.query(
    `SELECT COALESCE(SUM(bultos),0) AS bultos, COALESCE(SUM(bultos*COALESCE(costo_bulto,0)),0) AS costo
     FROM consumo_ceba WHERE lote_id=$1 ${filtro}`, params)).rows[0];
  return { bultos: Number(c.bultos), costo: Number(c.costo) };
}

router.get('/lote-inventario/:loteId', async (req, res) => {
  const inv = await calcularInventarioLote(Number(req.params.loteId));
  if (!inv) return res.status(404).json({ error: 'Lote no encontrado' });
  const cons = await consumoLote(Number(req.params.loteId));
  res.json({ ...inv, bultos_consumidos: cons.bultos, kg_alimento: cons.bultos*KG_POR_BULTO, costo_alimento: cons.costo });
});

router.get('/inventario/:granjaId', async (req, res) => {
  const granjaId = Number(req.params.granjaId);
  const lotes = (await pool.query('SELECT id FROM lotes_destete WHERE granja_ceba_id=$1 AND activo=TRUE', [granjaId])).rows;
  let ingresados=0, muertes=0, ventas=0, bultos=0, costoAlim=0;
  for (const l of lotes) {
    const inv = await calcularInventarioLote(l.id);
    const cons = await consumoLote(l.id);
    ingresados += inv.ingresados; muertes += inv.muertes; ventas += inv.ventas;
    bultos += cons.bultos; costoAlim += cons.costo;
  }
  res.json({ ingresos: ingresados, muertes, ventas, inventario_actual: ingresados-muertes-ventas,
    lotes_activos: lotes.length, bultos_consumidos: bultos, kg_alimento: bultos*KG_POR_BULTO, costo_alimento: costoAlim });
});

// ---------- MOVIMIENTOS (por lote) ----------
router.get('/movimientos/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.*, l.nombre AS lote_nombre FROM movimientos_ceba m
     LEFT JOIN lotes_destete l ON l.id=m.lote_id
     WHERE m.granja_id=$1 ORDER BY m.fecha DESC, m.id DESC`, [Number(req.params.granjaId)]);
  res.json(rows);
});

router.post('/movimientos', async (req, res) => {
  const { granja_id, lote_id, fecha, tipo, cantidad, peso_promedio, valor_venta, causa, observaciones } = req.body;
  if (!lote_id || !fecha || !tipo || !cantidad)
    return res.status(400).json({ error: 'Lote, fecha, tipo y cantidad son obligatorios' });
  if (!['muerte','venta'].includes(tipo))
    return res.status(400).json({ error: 'Tipo inválido (solo muerte o venta)' });
  const inv = await calcularInventarioLote(lote_id);
  if (!inv) return res.status(404).json({ error: 'Lote no encontrado' });
  if (cantidad > inv.inventario_actual)
    return res.status(400).json({ error: `El lote solo tiene ${inv.inventario_actual} animales; no puedes registrar ${cantidad}.` });

  let costeoVenta = {};
  if (tipo === 'venta') {
    const invActual = inv.inventario_actual;
    const alim = await consumoLote(lote_id, fecha);
    const yaAsignado = (await pool.query(
      `SELECT COALESCE(SUM(bultos_alimento_asignado),0) AS bultos, COALESCE(SUM(costo_alimento_asignado),0) AS costo
       FROM movimientos_ceba WHERE lote_id=$1 AND tipo='venta'`, [lote_id])).rows[0];
    const bultosPendientes = alim.bultos - Number(yaAsignado.bultos);
    const costoPendiente = alim.costo - Number(yaAsignado.costo);
    const bultosAsignados = invActual > 0 ? (bultosPendientes / invActual) * cantidad : 0;
    const costoAlimentoAsignado = invActual > 0 ? (costoPendiente / invActual) * cantidad : 0;
    const costoLechonesVenta = inv.costo_lechon_unit * cantidad;
    const pesoEntradaProm = inv.peso_entrada_prom;
    const kgProducidos = peso_promedio ? (Number(peso_promedio) - pesoEntradaProm) * cantidad : 0;
    const kgAlimento = bultosAsignados * KG_POR_BULTO;
    const conversion = kgProducidos > 0 ? kgAlimento / kgProducidos : null;
    const costoTotalVenta = costoAlimentoAsignado + costoLechonesVenta;
    const costoPorKg = kgProducidos > 0 ? costoTotalVenta / kgProducidos : null;
    costeoVenta = { peso_entrada_prom: pesoEntradaProm, bultos_alimento_asignado: bultosAsignados,
      costo_alimento_asignado: costoAlimentoAsignado, costo_lechones_venta: costoLechonesVenta,
      kg_producidos_venta: kgProducidos, conversion_venta: conversion, costo_por_kg_venta: costoPorKg };
  }
  const peso_total = (peso_promedio && cantidad) ? Number(peso_promedio)*Number(cantidad) : null;
  const { rows } = await pool.query(
    `INSERT INTO movimientos_ceba (granja_id, lote_id, fecha, tipo, cantidad, peso_promedio, peso_total,
       valor_venta, causa, observaciones, peso_entrada_prom, costo_alimento_asignado, bultos_alimento_asignado,
       costo_lechones_venta, kg_producidos_venta, conversion_venta, costo_por_kg_venta, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [granja_id||inv.lote.granja_ceba_id, lote_id, fecha, tipo, cantidad, peso_promedio||null, peso_total,
     valor_venta||null, causa||null, observaciones||null,
     costeoVenta.peso_entrada_prom||null, costeoVenta.costo_alimento_asignado||null,
     costeoVenta.bultos_alimento_asignado||null, costeoVenta.costo_lechones_venta||null,
     costeoVenta.kg_producidos_venta||null, costeoVenta.conversion_venta||null,
     costeoVenta.costo_por_kg_venta||null, req.usuario?.id||null]);
  res.json(rows[0]);
});

router.delete('/movimientos/:id', async (req, res) => {
  await pool.query('DELETE FROM movimientos_ceba WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- CONSUMO (por lote) ----------
router.get('/consumo/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cc.*, l.nombre AS lote_nombre FROM consumo_ceba cc
     LEFT JOIN lotes_destete l ON l.id=cc.lote_id
     WHERE cc.granja_id=$1 ORDER BY cc.fecha DESC, cc.id DESC`, [Number(req.params.granjaId)]);
  res.json(rows);
});
router.post('/consumo', async (req, res) => {
  const { granja_id, lote_id, fecha, bultos, costo_bulto, tipo_alimento, observaciones } = req.body;
  if (!lote_id || !fecha || bultos==null)
    return res.status(400).json({ error: 'Lote, fecha y bultos son obligatorios' });
  const { rows } = await pool.query(
    `INSERT INTO consumo_ceba (granja_id, lote_id, fecha, bultos, costo_bulto, tipo_alimento, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [granja_id||null, lote_id, fecha, bultos, costo_bulto||null, tipo_alimento||null, observaciones||null, req.usuario?.id||null]);
  res.json(rows[0]);
});
router.delete('/consumo/:id', async (req, res) => {
  await pool.query('DELETE FROM consumo_ceba WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- LIQUIDACIÓN DE UN LOTE ----------
router.post('/liquidar', async (req, res) => {
  const { lote_id, peso_promedio_salida, guardar, observaciones } = req.body;
  if (!lote_id || !peso_promedio_salida)
    return res.status(400).json({ error: 'Lote y peso promedio de salida son obligatorios' });
  const inv = await calcularInventarioLote(lote_id);
  if (!inv) return res.status(404).json({ error: 'Lote no encontrado' });
  const cons = await consumoLote(lote_id);
  const kg_alimento = cons.bultos * KG_POR_BULTO;
  const costo_alimento = cons.costo;
  const costo_lechones = inv.costo_lechones_total;
  const peso_prom_entrada = inv.peso_entrada_prom;
  const peso_salida = Number(peso_promedio_salida);
  const animales_finales = inv.inventario_actual;
  const kg_ganados_vivos = (peso_salida - peso_prom_entrada) * animales_finales;
  const kg_ganados_vendidos = inv.ventas > 0 ? (inv.peso_venta_total - peso_prom_entrada * inv.ventas) : 0;
  const kg_producidos = kg_ganados_vivos + kg_ganados_vendidos;
  const conversion = kg_producidos > 0 ? kg_alimento / kg_producidos : null;
  const costo_total = costo_alimento + costo_lechones;
  const costo_por_kg = kg_producidos > 0 ? costo_total / kg_producidos : null;
  const resultado = {
    lote: { id: inv.lote.id, nombre: inv.lote.nombre },
    animales: { ingresados: inv.ingresados, muertos: inv.muertes, vendidos: inv.ventas, inventario_actual: animales_finales },
    pesos: { promedio_entrada: Number(peso_prom_entrada.toFixed(2)), promedio_salida: peso_salida, kg_producidos: Number(kg_producidos.toFixed(2)) },
    alimento: { bultos: Number(cons.bultos.toFixed(2)), kg: Number(kg_alimento.toFixed(2)), costo: Number(costo_alimento.toFixed(2)) },
    conversion: conversion ? Number(conversion.toFixed(3)) : null,
    costos: { alimento: Number(costo_alimento.toFixed(2)), lechones: Number(costo_lechones.toFixed(2)),
      total: Number(costo_total.toFixed(2)), por_kg: costo_por_kg ? Number(costo_por_kg.toFixed(2)) : null },
    nota: 'Conversión = kg alimento del lote ÷ kg producidos. Costo/kg = (alimento del lote + lechones) ÷ kg producidos.',
  };
  if (guardar) {
    await pool.query(
      `INSERT INTO liquidaciones_ceba (granja_id, fecha_inicio, fecha_fin, peso_promedio_salida, animales_ingresados,
         animales_muertos, animales_vendidos, peso_entrada_total, peso_salida_total, kg_producidos, kg_alimento,
         conversion, costo_alimento, costo_lechones, costo_total, costo_por_kg, observaciones, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [inv.lote.granja_ceba_id, inv.lote.trasladado_en||new Date().toISOString().slice(0,10),
       new Date().toISOString().slice(0,10), peso_salida, inv.ingresados, inv.muertes, inv.ventas,
       inv.peso_entrada_total, peso_salida*animales_finales, kg_producidos, kg_alimento, conversion,
       costo_alimento, costo_lechones, costo_total, costo_por_kg, observaciones||null, req.usuario?.id||null]);
    resultado.guardada = true;
  }
  res.json(resultado);
});
router.get('/liquidaciones/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM liquidaciones_ceba WHERE granja_id=$1 ORDER BY fecha_fin DESC`, [Number(req.params.granjaId)]);
  res.json(rows);
});

// ---------- LOTES (integración cría→ceba) ----------
async function calcularValoresLote(bandaId) {
  const banda = (await pool.query('SELECT * FROM bandas WHERE id=$1', [bandaId])).rows[0];
  if (!banda) return null;
  const dest = (await pool.query(
    `SELECT COALESCE(SUM(d.lechones_destetados),0) AS lechones, COALESCE(SUM(d.peso_camada),0) AS peso_total,
            MAX(d.fecha_destete) AS fecha_destete
     FROM destetes d JOIN cerdas c ON c.id=d.cerda_id WHERE c.banda_id=$1`, [bandaId])).rows[0];
  const lechones = Number(dest.lechones);
  const peso_total = Number(dest.peso_total);
  let costo_por_lechon = null;
  try { const c = await calcularCosteoBanda(bandaId); costo_por_lechon = c && c.costo_por_lechon ? c.costo_por_lechon : null; } catch (e) {}
  return { banda: { id: banda.id, nombre: banda.nombre }, fecha_destete: dest.fecha_destete, lechones,
    peso_total: Number(peso_total.toFixed(2)), peso_promedio_lechon: lechones>0?Number((peso_total/lechones).toFixed(2)):null,
    costo_por_lechon, costo_total: costo_por_lechon ? Number((costo_por_lechon*lechones).toFixed(2)) : null };
}
router.get('/lote-preview/:bandaId', async (req, res) => {
  const v = await calcularValoresLote(Number(req.params.bandaId));
  if (!v) return res.status(404).json({ error: 'Banda no encontrada' });
  res.json(v);
});
router.post('/lotes', async (req, res) => {
  const { nombre, banda_id, fecha_destete, lechones, peso_total, costo_por_lechon } = req.body;
  if (!nombre || !lechones) return res.status(400).json({ error: 'Nombre y número de lechones son obligatorios' });
  const costo_total = (costo_por_lechon && lechones) ? Number(costo_por_lechon)*Number(lechones) : null;
  const peso_entrada_prom = (peso_total && lechones) ? Number(peso_total)/Number(lechones) : null;
  const { rows } = await pool.query(
    `INSERT INTO lotes_destete (nombre, banda_id, fecha_destete, lechones, peso_total, peso_entrada_prom, costo_por_lechon, costo_total, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [nombre, banda_id||null, fecha_destete||null, lechones, peso_total||null, peso_entrada_prom, costo_por_lechon||null, costo_total, req.usuario?.id||null]);
  res.json(rows[0]);
});
router.get('/lotes', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, b.nombre AS banda_nombre, g.nombre AS granja_nombre FROM lotes_destete l
     LEFT JOIN bandas b ON b.id=l.banda_id LEFT JOIN granjas_ceba g ON g.id=l.granja_ceba_id
     ORDER BY l.creado_en DESC`);
  res.json(rows);
});
router.get('/lotes-granja/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, b.nombre AS banda_nombre FROM lotes_destete l LEFT JOIN bandas b ON b.id=l.banda_id
     WHERE l.granja_ceba_id=$1 AND l.activo=TRUE ORDER BY l.trasladado_en DESC`, [Number(req.params.granjaId)]);
  res.json(rows);
});
router.post('/lotes/:id/trasladar', async (req, res) => {
  const loteId = Number(req.params.id);
  const { granja_id } = req.body;
  if (!granja_id) return res.status(400).json({ error: 'Debes elegir la granja de ceba' });
  const lote = (await pool.query('SELECT * FROM lotes_destete WHERE id=$1', [loteId])).rows[0];
  if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });
  if (lote.granja_ceba_id) return res.status(400).json({ error: 'Este lote ya fue trasladado' });
  await pool.query('UPDATE lotes_destete SET granja_ceba_id=$1, trasladado_en=now() WHERE id=$2', [granja_id, loteId]);
  res.json({ ok: true, lote_id: loteId, granja_id });
});
router.delete('/lotes/:id', async (req, res) => {
  const loteId = Number(req.params.id);
  const mov = Number((await pool.query('SELECT COUNT(*) AS n FROM movimientos_ceba WHERE lote_id=$1', [loteId])).rows[0].n);
  const con = Number((await pool.query('SELECT COUNT(*) AS n FROM consumo_ceba WHERE lote_id=$1', [loteId])).rows[0].n);
  if (mov > 0 || con > 0) return res.status(400).json({ error: 'No se puede eliminar: el lote ya tiene movimientos o consumo.' });
  await pool.query('DELETE FROM lotes_destete WHERE id=$1', [loteId]);
  res.json({ ok: true });
});

export default router;
