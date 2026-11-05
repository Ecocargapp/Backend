// ============================================================
//  AgroSoft — Ceba (engorde) — INVENTARIO POR GRANJA
//  Cada traslado de un lote desde cría suma sus animales al inventario de la granja.
//  Consumo de alimento, mortalidad, ventas y liquidación se manejan sobre el total de la granja.
// ============================================================
import express from 'express';
import pool from './db.js';
import { calcularCosteoBanda } from './costeo_banda.js';

const router = express.Router();
const KG_POR_BULTO = 40;
const hoyCO = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);   // hora de Colombia

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

// ---------- INVENTARIO DE UNA GRANJA ----------
// Animales = ingresos (traslados de lotes) − muertes − ventas, todos sobre la granja.
async function statsGranja(granjaId, hasta = null) {
  const params = hasta ? [granjaId, hasta] : [granjaId];
  const filtroFecha = hasta ? 'AND fecha <= $2' : '';
  const mov = (await pool.query(
    `SELECT tipo, SUM(cantidad) AS animales,
            SUM(CASE WHEN peso_total IS NOT NULL THEN peso_total ELSE cantidad*COALESCE(peso_promedio,0) END) AS peso,
            SUM(COALESCE(valor_venta,0)) AS valor_venta,
            SUM(cantidad*COALESCE(costo_lechon,0)) AS costo_lechones
     FROM movimientos_ceba WHERE granja_id=$1 ${filtroFecha} GROUP BY tipo`, params)).rows;
  const s = { ingresados: 0, muertes: 0, ventas: 0, peso_entrada_total: 0, peso_venta_total: 0, valor_ventas: 0, costo_lechones_total: 0 };
  for (const m of mov) {
    const n = Number(m.animales);
    if (m.tipo === 'ingreso') { s.ingresados = n; s.peso_entrada_total = Number(m.peso); s.costo_lechones_total = Number(m.costo_lechones); }
    else if (m.tipo === 'muerte') s.muertes = n;
    else if (m.tipo === 'venta') { s.ventas = n; s.peso_venta_total = Number(m.peso); s.valor_ventas = Number(m.valor_venta); }
  }
  s.inventario_actual = s.ingresados - s.muertes - s.ventas;
  s.peso_entrada_prom = s.ingresados > 0 ? s.peso_entrada_total / s.ingresados : 0;
  s.costo_lechon_unit = s.ingresados > 0 ? s.costo_lechones_total / s.ingresados : 0;
  return s;
}
async function consumoGranja(granjaId, hasta = null) {
  const params = hasta ? [granjaId, hasta] : [granjaId];
  const filtro = hasta ? 'AND fecha <= $2' : '';
  const c = (await pool.query(
    `SELECT COALESCE(SUM(bultos),0) AS bultos, COALESCE(SUM(bultos*COALESCE(costo_bulto,0)),0) AS costo
     FROM consumo_ceba WHERE granja_id=$1 ${filtro}`, params)).rows[0];
  return { bultos: Number(c.bultos), costo: Number(c.costo) };
}

router.get('/inventario/:granjaId', async (req, res) => {
  try {
    const granjaId = Number(req.params.granjaId);
    const st = await statsGranja(granjaId), cons = await consumoGranja(granjaId);
    const lotes = Number((await pool.query(
      `SELECT COUNT(*) AS n FROM movimientos_ceba WHERE granja_id=$1 AND tipo='ingreso'`, [granjaId])).rows[0].n);
    res.json({ ingresos: st.ingresados, muertes: st.muertes, ventas: st.ventas, inventario_actual: st.inventario_actual,
      traslados: lotes, peso_entrada_prom: Number(st.peso_entrada_prom.toFixed(2)), costo_lechon_prom: Number(st.costo_lechon_unit.toFixed(2)),
      bultos_consumidos: cons.bultos, kg_alimento: cons.bultos * KG_POR_BULTO, costo_alimento: cons.costo });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error calculando el inventario' }); }
});

// ---------- MOVIMIENTOS (por granja) ----------
router.get('/movimientos/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.*, to_char(m.fecha,'YYYY-MM-DD') AS fecha, l.nombre AS lote_nombre FROM movimientos_ceba m
     LEFT JOIN lotes_destete l ON l.id=m.lote_id
     WHERE m.granja_id=$1 ORDER BY m.fecha DESC, m.id DESC`, [Number(req.params.granjaId)]);
  res.json(rows);
});

// Ayuda: granja de un registro viejo que aún trae lote_id
async function granjaDe(body) {
  if (body.granja_id) return Number(body.granja_id);
  if (body.lote_id) {
    const l = (await pool.query('SELECT granja_ceba_id FROM lotes_destete WHERE id=$1', [body.lote_id])).rows[0];
    return l?.granja_ceba_id || null;
  }
  return null;
}

router.post('/movimientos', async (req, res) => {
  try {
    const { fecha, tipo, cantidad, peso_promedio, valor_venta, causa, observaciones } = req.body;
    const granjaId = await granjaDe(req.body);
    if (!granjaId || !fecha || !tipo || !cantidad)
      return res.status(400).json({ error: 'Granja, fecha, tipo y cantidad son obligatorios' });
    if (!['muerte', 'venta'].includes(tipo))
      return res.status(400).json({ error: 'Tipo inválido (solo muerte o venta)' });
    const n = Number(cantidad);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor que 0' });
    const g = (await pool.query('SELECT id FROM granjas_ceba WHERE id=$1', [granjaId])).rows[0];
    if (!g) return res.status(404).json({ error: 'Granja no encontrada' });
    const inv = await statsGranja(granjaId);
    if (n > inv.inventario_actual)
      return res.status(400).json({ error: `La granja solo tiene ${inv.inventario_actual} animales; no puedes registrar ${n}.` });

    let costeoVenta = {};
    if (tipo === 'venta') {
      const invActual = inv.inventario_actual;
      const alim = await consumoGranja(granjaId, fecha);
      const yaAsignado = (await pool.query(
        `SELECT COALESCE(SUM(bultos_alimento_asignado),0) AS bultos, COALESCE(SUM(costo_alimento_asignado),0) AS costo
         FROM movimientos_ceba WHERE granja_id=$1 AND tipo='venta'`, [granjaId])).rows[0];
      const bultosPendientes = alim.bultos - Number(yaAsignado.bultos);
      const costoPendiente = alim.costo - Number(yaAsignado.costo);
      const bultosAsignados = invActual > 0 ? (bultosPendientes / invActual) * n : 0;
      const costoAlimentoAsignado = invActual > 0 ? (costoPendiente / invActual) * n : 0;
      const costoLechonesVenta = inv.costo_lechon_unit * n;
      const pesoEntradaProm = inv.peso_entrada_prom;
      const kgProducidos = peso_promedio ? (Number(peso_promedio) - pesoEntradaProm) * n : 0;
      const kgAlimento = bultosAsignados * KG_POR_BULTO;
      const conversion = kgProducidos > 0 ? kgAlimento / kgProducidos : null;
      const costoTotalVenta = costoAlimentoAsignado + costoLechonesVenta;
      const costoPorKg = kgProducidos > 0 ? costoTotalVenta / kgProducidos : null;
      costeoVenta = { peso_entrada_prom: pesoEntradaProm, bultos_alimento_asignado: bultosAsignados,
        costo_alimento_asignado: costoAlimentoAsignado, costo_lechones_venta: costoLechonesVenta,
        kg_producidos_venta: kgProducidos, conversion_venta: conversion, costo_por_kg_venta: costoPorKg };
    }
    const peso_total = (peso_promedio && n) ? Number(peso_promedio) * n : null;
    const { rows } = await pool.query(
      `INSERT INTO movimientos_ceba (granja_id, lote_id, fecha, tipo, cantidad, peso_promedio, peso_total,
         valor_venta, causa, observaciones, peso_entrada_prom, costo_alimento_asignado, bultos_alimento_asignado,
         costo_lechones_venta, kg_producidos_venta, conversion_venta, costo_por_kg_venta, usuario_id)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [granjaId, fecha, tipo, n, peso_promedio || null, peso_total,
       valor_venta || null, causa || null, observaciones || null,
       costeoVenta.peso_entrada_prom || null, costeoVenta.costo_alimento_asignado || null,
       costeoVenta.bultos_alimento_asignado || null, costeoVenta.costo_lechones_venta || null,
       costeoVenta.kg_producidos_venta || null, costeoVenta.conversion_venta || null,
       costeoVenta.costo_por_kg_venta || null, req.usuario?.id || null]);
    res.json({ ...rows[0], inventario_actual: inv.inventario_actual - n });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error registrando el movimiento' }); }
});

router.delete('/movimientos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const m = (await pool.query('SELECT * FROM movimientos_ceba WHERE id=$1', [id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Movimiento no encontrado' });
    if (m.tipo === 'ingreso') {
      // Eliminar el ingreso deshace el traslado del lote (vuelve a quedar disponible)
      const inv = await statsGranja(m.granja_id);
      if (inv.inventario_actual - m.cantidad < 0)
        return res.status(400).json({ error: 'No se puede deshacer este traslado: ya hay muertes o ventas registradas que dependen de esos animales.' });
      await pool.query('UPDATE lotes_destete SET granja_ceba_id=NULL, trasladado_en=NULL, movimiento_id=NULL WHERE movimiento_id=$1 OR id=$2', [id, m.lote_id]);
    }
    await pool.query('DELETE FROM movimientos_ceba WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error eliminando el movimiento' }); }
});

// ---------- CONSUMO (por granja) ----------
router.get('/consumo/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cc.*, to_char(cc.fecha,'YYYY-MM-DD') AS fecha, l.nombre AS lote_nombre FROM consumo_ceba cc
     LEFT JOIN lotes_destete l ON l.id=cc.lote_id
     WHERE cc.granja_id=$1 ORDER BY cc.fecha DESC, cc.id DESC`, [Number(req.params.granjaId)]);
  res.json(rows);
});
router.post('/consumo', async (req, res) => {
  try {
    const { fecha, bultos, costo_bulto, observaciones, referencia_id } = req.body;
    let { tipo_alimento } = req.body;
    const granjaId = await granjaDe(req.body);
    if (!granjaId || !fecha || bultos == null)
      return res.status(400).json({ error: 'Granja, fecha y bultos son obligatorios' });
    if (!(Number(bultos) > 0)) return res.status(400).json({ error: 'Los bultos deben ser mayores que 0' });
    const g = (await pool.query('SELECT id FROM granjas_ceba WHERE id=$1', [granjaId])).rows[0];
    if (!g) return res.status(404).json({ error: 'Granja no encontrada' });
    // Referencia de alimento (descuenta del inventario de la granja); si no se indica el nombre, se usa el de la referencia
    if (referencia_id) {
      const rf = (await pool.query('SELECT nombre FROM alimento_referencias WHERE id=$1', [referencia_id])).rows[0];
      if (!rf) return res.status(400).json({ error: 'Referencia de alimento inválida' });
      if (!tipo_alimento) tipo_alimento = rf.nombre;
    }
    // Si no se indica el costo del bulto (p. ej. registro desde la app de campo),
    // se usa el último costo conocido del mismo alimento, empezando por esta granja.
    let costo = costo_bulto || null;
    if (!costo) {
      const ult = (await pool.query(
        `SELECT costo_bulto FROM consumo_ceba
         WHERE costo_bulto IS NOT NULL AND costo_bulto > 0
           AND ($1::text IS NULL OR tipo_alimento = $1)
         ORDER BY (granja_id = $2) DESC, fecha DESC, id DESC LIMIT 1`, [tipo_alimento || null, granjaId])).rows[0];
      costo = ult ? ult.costo_bulto : null;
    }
    const { rows } = await pool.query(
      `INSERT INTO consumo_ceba (granja_id, lote_id, fecha, bultos, costo_bulto, tipo_alimento, observaciones, usuario_id, referencia_id)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [granjaId, fecha, bultos, costo, tipo_alimento || null, observaciones || null, req.usuario?.id || null, referencia_id || null]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error registrando el consumo' }); }
});
router.delete('/consumo/:id', async (req, res) => {
  await pool.query('DELETE FROM consumo_ceba WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- LIQUIDACIÓN DE UNA GRANJA ----------
router.post('/liquidar', async (req, res) => {
  try {
    const { peso_promedio_salida, guardar, observaciones } = req.body;
    const granjaId = await granjaDe(req.body);
    if (!granjaId || !peso_promedio_salida)
      return res.status(400).json({ error: 'Granja y peso promedio de salida son obligatorios' });
    const g = (await pool.query('SELECT id, nombre FROM granjas_ceba WHERE id=$1', [granjaId])).rows[0];
    if (!g) return res.status(404).json({ error: 'Granja no encontrada' });
    const inv = await statsGranja(granjaId);
    const cons = await consumoGranja(granjaId);
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
      granja: { id: g.id, nombre: g.nombre },
      animales: { ingresados: inv.ingresados, muertos: inv.muertes, vendidos: inv.ventas, inventario_actual: animales_finales },
      pesos: { promedio_entrada: Number(peso_prom_entrada.toFixed(2)), promedio_salida: peso_salida, kg_producidos: Number(kg_producidos.toFixed(2)) },
      alimento: { bultos: Number(cons.bultos.toFixed(2)), kg: Number(kg_alimento.toFixed(2)), costo: Number(costo_alimento.toFixed(2)) },
      conversion: conversion ? Number(conversion.toFixed(3)) : null,
      costos: { alimento: Number(costo_alimento.toFixed(2)), lechones: Number(costo_lechones.toFixed(2)),
        total: Number(costo_total.toFixed(2)), por_kg: costo_por_kg ? Number(costo_por_kg.toFixed(2)) : null },
      nota: 'Conversión = kg de alimento de la granja ÷ kg producidos. Costo/kg = (alimento de la granja + lechones) ÷ kg producidos. Usa todo el historial de la granja.',
    };
    if (guardar) {
      const ini = (await pool.query(`SELECT MIN(fecha) AS f FROM movimientos_ceba WHERE granja_id=$1 AND tipo='ingreso'`, [granjaId])).rows[0].f;
      await pool.query(
        `INSERT INTO liquidaciones_ceba (granja_id, fecha_inicio, fecha_fin, peso_promedio_salida, animales_ingresados,
           animales_muertos, animales_vendidos, peso_entrada_total, peso_salida_total, kg_producidos, kg_alimento,
           conversion, costo_alimento, costo_lechones, costo_total, costo_por_kg, observaciones, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [granjaId, ini || hoyCO(), hoyCO(), peso_salida, inv.ingresados, inv.muertes, inv.ventas,
         inv.peso_entrada_total, peso_salida * animales_finales, kg_producidos, kg_alimento, conversion,
         costo_alimento, costo_lechones, costo_total, costo_por_kg, observaciones || null, req.usuario?.id || null]);
      resultado.guardada = true;
    }
    res.json(resultado);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error calculando la liquidación' }); }
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
  const { granja_id, fecha } = req.body;
  if (!granja_id) return res.status(400).json({ error: 'Debes elegir la granja de ceba' });
  const cliente = await pool.connect();
  try {
    const lote = (await pool.query('SELECT * FROM lotes_destete WHERE id=$1', [loteId])).rows[0];
    if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });
    if (lote.granja_ceba_id) return res.status(400).json({ error: 'Este lote ya fue trasladado' });
    const g = (await pool.query('SELECT id FROM granjas_ceba WHERE id=$1', [granja_id])).rows[0];
    if (!g) return res.status(404).json({ error: 'Granja no encontrada' });
    const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : hoyCO();
    await cliente.query('BEGIN');
    // El traslado alimenta el inventario de animales de la granja
    const mov = (await cliente.query(
      `INSERT INTO movimientos_ceba (granja_id, lote_id, fecha, tipo, cantidad, peso_promedio, peso_total, costo_lechon, causa, observaciones, usuario_id)
       VALUES ($1,$2,$3,'ingreso',$4,$5,$6,$7,'Traslado desde cría',$8,$9) RETURNING id`,
      [granja_id, loteId, f, lote.lechones, lote.peso_entrada_prom || (lote.peso_total && lote.lechones ? lote.peso_total / lote.lechones : null),
       lote.peso_total || null, lote.costo_por_lechon || null, 'Lote ' + lote.nombre, req.usuario?.id || null])).rows[0];
    await cliente.query('UPDATE lotes_destete SET granja_ceba_id=$1, trasladado_en=now(), movimiento_id=$2 WHERE id=$3', [granja_id, mov.id, loteId]);
    await cliente.query('COMMIT');
    const inv = await statsGranja(Number(granja_id));
    res.json({ ok: true, lote_id: loteId, granja_id, inventario_actual: inv.inventario_actual });
  } catch (e) { await cliente.query('ROLLBACK').catch(() => {}); console.error(e); res.status(500).json({ error: 'Error trasladando el lote' }); }
  finally { cliente.release(); }
});
router.delete('/lotes/:id', async (req, res) => {
  const loteId = Number(req.params.id);
  const mov = Number((await pool.query('SELECT COUNT(*) AS n FROM movimientos_ceba WHERE lote_id=$1', [loteId])).rows[0].n);
  const con = Number((await pool.query('SELECT COUNT(*) AS n FROM consumo_ceba WHERE lote_id=$1', [loteId])).rows[0].n);
  if (mov > 0 || con > 0) return res.status(400).json({ error: 'No se puede eliminar: el lote ya tiene movimientos o consumo.' });
  // Liberar los destetes que estaban en este lote (vuelven a estar disponibles)
  await pool.query('UPDATE destetes SET lote_id=NULL WHERE lote_id=$1', [loteId]);
  await pool.query('DELETE FROM lotes_destete WHERE id=$1', [loteId]);
  res.json({ ok: true });
});

// ---------- LOTES POR DESTETE (sin depender de banda) ----------

// Lista los destetes disponibles (que aún no están en ningún lote)
router.get('/destetes-disponibles', async (req, res) => {
  const { desde, hasta } = req.query;
  let sql = `
    SELECT d.id AS destete_id, d.cerda_id, d.fecha_destete, d.lechones_destetados,
           d.peso_camada, d.ciclo, c.arete, b.nombre AS banda_nombre
    FROM destetes d
    JOIN cerdas c ON c.id = d.cerda_id
    LEFT JOIN bandas b ON b.id = c.banda_id
    WHERE d.lote_id IS NULL AND d.lechones_destetados > 0`;
  const params = [];
  if (desde) { params.push(desde); sql += ` AND d.fecha_destete >= $${params.length}`; }
  if (hasta) { params.push(hasta); sql += ` AND d.fecha_destete <= $${params.length}`; }
  sql += ' ORDER BY d.fecha_destete DESC, c.arete';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// Preview de un lote a partir de una lista de destetes (o un rango de fechas)
router.post('/lote-preview-destetes', async (req, res) => {
  const { destete_ids, desde, hasta } = req.body;
  let sql, params;
  if (destete_ids && destete_ids.length) {
    sql = `SELECT COALESCE(SUM(lechones_destetados),0) AS lechones,
                  COALESCE(SUM(peso_camada),0) AS peso_total, MAX(fecha_destete) AS fecha_destete,
                  COUNT(*) AS n_destetes
           FROM destetes WHERE lote_id IS NULL AND id = ANY($1)`;
    params = [destete_ids];
  } else {
    sql = `SELECT COALESCE(SUM(lechones_destetados),0) AS lechones,
                  COALESCE(SUM(peso_camada),0) AS peso_total, MAX(fecha_destete) AS fecha_destete,
                  COUNT(*) AS n_destetes
           FROM destetes WHERE lote_id IS NULL AND lechones_destetados > 0
             AND fecha_destete >= $1 AND fecha_destete <= $2`;
    params = [desde, hasta];
  }
  const r = (await pool.query(sql, params)).rows[0];
  const lechones = Number(r.lechones);
  const peso_total = Number(r.peso_total);
  res.json({
    lechones, peso_total: Number(peso_total.toFixed(2)),
    peso_promedio_lechon: lechones > 0 ? Number((peso_total/lechones).toFixed(2)) : null,
    fecha_destete: r.fecha_destete, n_destetes: Number(r.n_destetes),
    nota: 'Costo por lechón: ingrésalo manualmente o déjalo para calcularlo después. Este lote agrupa destetes por fecha/selección, sin depender de banda.',
  });
});

// Crear lote desde destetes (marca esos destetes como incluidos)
router.post('/lotes-destete', async (req, res) => {
  const { nombre, destete_ids, desde, hasta, costo_por_lechon } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre del lote es obligatorio' });

  // Resolver qué destetes entran
  let destetes;
  if (destete_ids && destete_ids.length) {
    destetes = (await pool.query(
      'SELECT * FROM destetes WHERE lote_id IS NULL AND id = ANY($1)', [destete_ids])).rows;
  } else if (desde && hasta) {
    destetes = (await pool.query(
      `SELECT * FROM destetes WHERE lote_id IS NULL AND lechones_destetados > 0
       AND fecha_destete >= $1 AND fecha_destete <= $2`, [desde, hasta])).rows;
  } else {
    return res.status(400).json({ error: 'Debes indicar destetes o un rango de fechas' });
  }
  if (!destetes.length) return res.status(400).json({ error: 'No hay destetes disponibles para agrupar' });

  const lechones = destetes.reduce((s,d)=>s+Number(d.lechones_destetados),0);
  const peso_total = destetes.reduce((s,d)=>s+Number(d.peso_camada||0),0);
  const fecha_destete = destetes.reduce((mx,d)=> d.fecha_destete>mx?d.fecha_destete:mx, destetes[0].fecha_destete);
  const costo_total = (costo_por_lechon && lechones) ? Number(costo_por_lechon)*lechones : null;
  const peso_entrada_prom = lechones > 0 ? peso_total/lechones : null;

  const lote = (await pool.query(
    `INSERT INTO lotes_destete (nombre, fecha_destete, lechones, peso_total, peso_entrada_prom, costo_por_lechon, costo_total, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [nombre, fecha_destete, lechones, peso_total, peso_entrada_prom, costo_por_lechon||null, costo_total, req.usuario?.id||null])).rows[0];

  // Marcar los destetes como incluidos en este lote
  await pool.query('UPDATE destetes SET lote_id=$1 WHERE id = ANY($2)', [lote.id, destetes.map(d=>d.id)]);

  res.json(lote);
});

// Renombrar un lote
router.patch('/lotes/:id', async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const { rows } = await pool.query(
    'UPDATE lotes_destete SET nombre=$1 WHERE id=$2 RETURNING *', [nombre, Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: 'Lote no encontrado' });
  res.json(rows[0]);
});

export default router;
