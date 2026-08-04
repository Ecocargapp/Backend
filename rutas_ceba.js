// ============================================================
//  AgroSoft — Ceba (engorde)
//  Inventario por granja, movimientos, consumo y liquidación
// ============================================================
import express from 'express';
import pool from './db.js';

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

// ---------- INVENTARIO ACTUAL DE UNA GRANJA ----------
async function calcularInventario(granjaId, hasta=null) {
  const filtroFecha = hasta ? 'AND fecha <= $2' : '';
  const params = hasta ? [granjaId, hasta] : [granjaId];
  const mov = (await pool.query(
    `SELECT tipo, SUM(cantidad) AS animales,
            SUM(cantidad*COALESCE(peso_promedio,0)) AS peso,
            SUM(COALESCE(costo_lechon,0)*cantidad) AS costo_lechon,
            SUM(COALESCE(valor_venta,0)) AS valor_venta
     FROM movimientos_ceba WHERE granja_id=$1 ${filtroFecha} GROUP BY tipo`, params)).rows;

  let ingresos=0, muertes=0, ventas=0, peso_entrada=0, peso_venta=0, costo_lechones=0, valor_ventas=0;
  for (const m of mov) {
    const n = Number(m.animales);
    if (m.tipo==='ingreso') { ingresos=n; peso_entrada=Number(m.peso); costo_lechones=Number(m.costo_lechon); }
    else if (m.tipo==='muerte') muertes=n;
    else if (m.tipo==='venta') { ventas=n; peso_venta=Number(m.peso); valor_ventas=Number(m.valor_venta); }
  }
  return {
    ingresos, muertes, ventas,
    inventario_actual: ingresos - muertes - ventas,
    peso_entrada_total: peso_entrada,
    peso_venta_total: peso_venta,
    costo_lechones, valor_ventas,
  };
}

router.get('/inventario/:granjaId', async (req, res) => {
  const inv = await calcularInventario(Number(req.params.granjaId));
  // consumo acumulado
  const cons = (await pool.query(
    `SELECT COALESCE(SUM(bultos),0) AS bultos,
            COALESCE(SUM(bultos*COALESCE(costo_bulto,0)),0) AS costo
     FROM consumo_ceba WHERE granja_id=$1`, [Number(req.params.granjaId)])).rows[0];
  res.json({
    ...inv,
    bultos_consumidos: Number(cons.bultos),
    kg_alimento: Number(cons.bultos) * KG_POR_BULTO,
    costo_alimento: Number(cons.costo),
  });
});

// ---------- MOVIMIENTOS ----------
router.get('/movimientos/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM movimientos_ceba WHERE granja_id=$1 ORDER BY fecha DESC, id DESC`,
    [Number(req.params.granjaId)]);
  res.json(rows);
});

router.post('/movimientos', async (req, res) => {
  const { granja_id, fecha, tipo, cantidad, peso_promedio, costo_lechon, valor_venta, causa, observaciones } = req.body;
  if (!granja_id || !fecha || !tipo || !cantidad)
    return res.status(400).json({ error: 'Granja, fecha, tipo y cantidad son obligatorios' });
  if (!['ingreso','muerte','venta'].includes(tipo))
    return res.status(400).json({ error: 'Tipo inválido' });

  // Validar que no queden animales negativos en muertes/ventas
  if (tipo === 'muerte' || tipo === 'venta') {
    const inv = await calcularInventario(granja_id);
    if (cantidad > inv.inventario_actual)
      return res.status(400).json({ error: `Solo hay ${inv.inventario_actual} animales en inventario; no puedes registrar ${cantidad}.` });
  }

  const peso_total = (peso_promedio && cantidad) ? Number(peso_promedio)*Number(cantidad) : null;
  const { rows } = await pool.query(
    `INSERT INTO movimientos_ceba (granja_id, fecha, tipo, cantidad, peso_promedio, peso_total, costo_lechon, valor_venta, causa, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [granja_id, fecha, tipo, cantidad, peso_promedio||null, peso_total, costo_lechon||null, valor_venta||null, causa||null, observaciones||null, req.usuario?.id||null]);
  res.json(rows[0]);
});

router.delete('/movimientos/:id', async (req, res) => {
  await pool.query('DELETE FROM movimientos_ceba WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- CONSUMO DE ALIMENTO ----------
router.get('/consumo/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM consumo_ceba WHERE granja_id=$1 ORDER BY fecha DESC, id DESC`,
    [Number(req.params.granjaId)]);
  res.json(rows);
});

router.post('/consumo', async (req, res) => {
  const { granja_id, fecha, bultos, costo_bulto, tipo_alimento, observaciones } = req.body;
  if (!granja_id || !fecha || bultos==null)
    return res.status(400).json({ error: 'Granja, fecha y bultos son obligatorios' });
  const { rows } = await pool.query(
    `INSERT INTO consumo_ceba (granja_id, fecha, bultos, costo_bulto, tipo_alimento, observaciones, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [granja_id, fecha, bultos, costo_bulto||null, tipo_alimento||null, observaciones||null, req.usuario?.id||null]);
  res.json(rows[0]);
});

router.delete('/consumo/:id', async (req, res) => {
  await pool.query('DELETE FROM consumo_ceba WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================
//  LIQUIDACIÓN
//  Calcula conversión y costo por kilo con el peso de salida.
// ============================================================
router.post('/liquidar', async (req, res) => {
  const { granja_id, fecha_inicio, fecha_fin, peso_promedio_salida, guardar, observaciones } = req.body;
  if (!granja_id || !peso_promedio_salida)
    return res.status(400).json({ error: 'Granja y peso promedio de salida son obligatorios' });

  const inv = await calcularInventario(granja_id, fecha_fin || null);

  // Consumo del periodo
  let sqlCons = `SELECT COALESCE(SUM(bultos),0) AS bultos,
                        COALESCE(SUM(bultos*COALESCE(costo_bulto,0)),0) AS costo
                 FROM consumo_ceba WHERE granja_id=$1`;
  const paramsCons = [granja_id];
  if (fecha_inicio) { paramsCons.push(fecha_inicio); sqlCons += ` AND fecha >= $${paramsCons.length}`; }
  if (fecha_fin) { paramsCons.push(fecha_fin); sqlCons += ` AND fecha <= $${paramsCons.length}`; }
  const cons = (await pool.query(sqlCons, paramsCons)).rows[0];

  const bultos = Number(cons.bultos);
  const kg_alimento = bultos * KG_POR_BULTO;
  const costo_alimento = Number(cons.costo);
  const costo_lechones = inv.costo_lechones;

  // Peso promedio de entrada (por animal ingresado)
  const peso_prom_entrada = inv.ingresos > 0 ? inv.peso_entrada_total / inv.ingresos : 0;
  const peso_salida = Number(peso_promedio_salida);

  // Animales que llegan al final (los que quedan vivos + los vendidos ya salieron con su peso)
  // kg producidos = ganancia de peso de todos los animales que pasaron por la granja
  // Se calcula sobre los animales que salieron/quedan: (peso salida - peso entrada) * animales vivos al final,
  // más lo ya producido por los vendidos (peso venta - peso entrada).
  const animales_finales = inv.inventario_actual; // vivos al liquidar
  const kg_ganados_vivos = (peso_salida - peso_prom_entrada) * animales_finales;
  const kg_ganados_vendidos = inv.ventas > 0
    ? (inv.peso_venta_total - peso_prom_entrada * inv.ventas)
    : 0;
  const kg_producidos = kg_ganados_vivos + kg_ganados_vendidos;

  const conversion = kg_producidos > 0 ? kg_alimento / kg_producidos : null;
  const costo_total = costo_alimento + costo_lechones;
  const costo_por_kg = kg_producidos > 0 ? costo_total / kg_producidos : null;

  const resultado = {
    granja_id,
    periodo: { inicio: fecha_inicio||null, fin: fecha_fin||null },
    animales: {
      ingresados: inv.ingresos, muertos: inv.muertes, vendidos: inv.ventas,
      inventario_actual: inv.inventario_actual,
    },
    pesos: {
      promedio_entrada: Number(peso_prom_entrada.toFixed(2)),
      promedio_salida: peso_salida,
      kg_producidos: Number(kg_producidos.toFixed(2)),
    },
    alimento: {
      bultos: Number(bultos.toFixed(2)),
      kg: Number(kg_alimento.toFixed(2)),
      costo: Number(costo_alimento.toFixed(2)),
    },
    conversion: conversion ? Number(conversion.toFixed(3)) : null,
    costos: {
      alimento: Number(costo_alimento.toFixed(2)),
      lechones: Number(costo_lechones.toFixed(2)),
      total: Number(costo_total.toFixed(2)),
      por_kg: costo_por_kg ? Number(costo_por_kg.toFixed(2)) : null,
    },
    nota: 'Conversión = kg alimento ÷ kg producidos (ganancia de peso). Costo/kg = (alimento + lechones) ÷ kg producidos.',
  };

  // Guardar la liquidación si se solicita
  if (guardar) {
    await pool.query(
      `INSERT INTO liquidaciones_ceba
        (granja_id, fecha_inicio, fecha_fin, peso_promedio_salida, animales_ingresados,
         animales_muertos, animales_vendidos, peso_entrada_total, peso_salida_total,
         kg_producidos, kg_alimento, conversion, costo_alimento, costo_lechones,
         costo_total, costo_por_kg, observaciones, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [granja_id, fecha_inicio||inv, fecha_fin||new Date().toISOString().slice(0,10),
       peso_salida, inv.ingresos, inv.muertes, inv.ventas, inv.peso_entrada_total,
       peso_salida*animales_finales, kg_producidos, kg_alimento, conversion,
       costo_alimento, costo_lechones, costo_total, costo_por_kg, observaciones||null,
       req.usuario?.id||null]);
    resultado.guardada = true;
  }

  res.json(resultado);
});

// ---------- HISTORIAL DE LIQUIDACIONES ----------
router.get('/liquidaciones/:granjaId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM liquidaciones_ceba WHERE granja_id=$1 ORDER BY fecha_fin DESC`,
    [Number(req.params.granjaId)]);
  res.json(rows);
});

export default router;
