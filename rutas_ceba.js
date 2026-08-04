// ============================================================
//  AgroSoft — Ceba (engorde)
//  Inventario por granja, movimientos, consumo y liquidación
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

  // ---- COSTEO DE VENTA PARCIAL ----
  // Prorratea el alimento por cabeza sobre el inventario actual,
  // descontando el alimento ya cobrado en ventas/movimientos previos.
  let costeoVenta = {};
  if (tipo === 'venta') {
    const inv = await calcularInventario(granja_id);
    const invActual = inv.inventario_actual; // vivos ANTES de esta venta

    // Alimento acumulado del lote a la fecha de la venta
    const alim = (await pool.query(
      `SELECT COALESCE(SUM(bultos),0) AS bultos,
              COALESCE(SUM(bultos*COALESCE(costo_bulto,0)),0) AS costo
       FROM consumo_ceba WHERE granja_id=$1 AND fecha <= $2`, [granja_id, fecha])).rows[0];
    const bultosAcum = Number(alim.bultos);
    const costoAcum = Number(alim.costo);

    // Alimento ya asignado a ventas previas (para no cobrar doble)
    const yaAsignado = (await pool.query(
      `SELECT COALESCE(SUM(bultos_alimento_asignado),0) AS bultos,
              COALESCE(SUM(costo_alimento_asignado),0) AS costo
       FROM movimientos_ceba WHERE granja_id=$1 AND tipo='venta'`, [granja_id])).rows[0];
    const bultosPendientes = bultosAcum - Number(yaAsignado.bultos);
    const costoPendiente = costoAcum - Number(yaAsignado.costo);

    // Prorrateo por cabeza sobre el inventario actual
    const bultosAsignados = invActual > 0 ? (bultosPendientes / invActual) * cantidad : 0;
    const costoAlimentoAsignado = invActual > 0 ? (costoPendiente / invActual) * cantidad : 0;

    // Costo de lechones de estos animales (usa el costo de lechón del ingreso del lote)
    const costoLechonUnit = inv.ingresos > 0 ? inv.costo_lechones / inv.ingresos : (costo_lechon || 0);
    const costoLechonesVenta = costoLechonUnit * cantidad;

    // Estadísticas: conversión de esta venta
    const pesoEntradaProm = inv.ingresos > 0 ? inv.peso_entrada_total / inv.ingresos : 0;
    const kgProducidos = peso_promedio ? (Number(peso_promedio) - pesoEntradaProm) * cantidad : 0;
    const kgAlimento = bultosAsignados * 40;
    const conversion = kgProducidos > 0 ? kgAlimento / kgProducidos : null;
    const costoTotalVenta = costoAlimentoAsignado + costoLechonesVenta;
    const costoPorKg = kgProducidos > 0 ? costoTotalVenta / kgProducidos : null;

    costeoVenta = {
      peso_entrada_prom: pesoEntradaProm,
      bultos_alimento_asignado: bultosAsignados,
      costo_alimento_asignado: costoAlimentoAsignado,
      costo_lechones_venta: costoLechonesVenta,
      kg_producidos_venta: kgProducidos,
      conversion_venta: conversion,
      costo_por_kg_venta: costoPorKg,
    };
  }

  const peso_total = (peso_promedio && cantidad) ? Number(peso_promedio)*Number(cantidad) : null;
  const { rows } = await pool.query(
    `INSERT INTO movimientos_ceba (granja_id, fecha, tipo, cantidad, peso_promedio, peso_total,
       costo_lechon, valor_venta, causa, observaciones,
       peso_entrada_prom, costo_alimento_asignado, bultos_alimento_asignado,
       costo_lechones_venta, kg_producidos_venta, conversion_venta, costo_por_kg_venta, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [granja_id, fecha, tipo, cantidad, peso_promedio||null, peso_total, costo_lechon||null,
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

// ============================================================
//  LOTES DESTETADOS (integración cría → ceba)
// ============================================================

// Calcula los valores de un lote a partir de una banda destetada (sin guardar).
// Devuelve lechones, peso total (suma de camadas) y costo por lechón.
async function calcularValoresLote(bandaId) {
  const banda = (await pool.query('SELECT * FROM bandas WHERE id=$1', [bandaId])).rows[0];
  if (!banda) return null;

  // Lechones destetados y peso total (suma de pesos de camada) de la banda
  const dest = (await pool.query(
    `SELECT COALESCE(SUM(d.lechones_destetados),0) AS lechones,
            COALESCE(SUM(d.peso_camada),0) AS peso_total,
            MAX(d.fecha_destete) AS fecha_destete
     FROM destetes d JOIN cerdas c ON c.id=d.cerda_id
     WHERE c.banda_id=$1`, [bandaId])).rows[0];

  const lechones = Number(dest.lechones);
  const peso_total = Number(dest.peso_total);

  // Costo por lechón: reutiliza la lógica del costeo de banda (gestación + lactancia)
  let costo_por_lechon = null;
  try {
    const costeo = await calcularCosteoBanda(bandaId);
    costo_por_lechon = costeo && costeo.costo_por_lechon ? costeo.costo_por_lechon : null;
  } catch (e) { /* si no hay datos de costeo, queda null */ }

  return {
    banda: { id: banda.id, nombre: banda.nombre },
    fecha_destete: dest.fecha_destete,
    lechones,
    peso_total: Number(peso_total.toFixed(2)),
    peso_promedio_lechon: lechones > 0 ? Number((peso_total/lechones).toFixed(2)) : null,
    costo_por_lechon,
    costo_total: costo_por_lechon ? Number((costo_por_lechon * lechones).toFixed(2)) : null,
  };
}

// Vista previa: valores calculados de un lote desde una banda (para confirmar/ajustar)
router.get('/lote-preview/:bandaId', async (req, res) => {
  const v = await calcularValoresLote(Number(req.params.bandaId));
  if (!v) return res.status(404).json({ error: 'Banda no encontrada' });
  res.json(v);
});

// Crear el lote (con valores confirmados/ajustados por el usuario)
router.post('/lotes', async (req, res) => {
  const { nombre, banda_id, fecha_destete, lechones, peso_total, costo_por_lechon } = req.body;
  if (!nombre || !lechones) return res.status(400).json({ error: 'Nombre y número de lechones son obligatorios' });
  const costo_total = (costo_por_lechon && lechones) ? Number(costo_por_lechon) * Number(lechones) : null;
  const { rows } = await pool.query(
    `INSERT INTO lotes_destete (nombre, banda_id, fecha_destete, lechones, peso_total, costo_por_lechon, costo_total, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [nombre, banda_id||null, fecha_destete||null, lechones, peso_total||null,
     costo_por_lechon||null, costo_total, req.usuario?.id||null]);
  res.json(rows[0]);
});

// Listar lotes (opcionalmente solo los no trasladados)
router.get('/lotes', async (req, res) => {
  const soloDisponibles = req.query.disponibles === '1';
  const filtro = soloDisponibles ? 'WHERE l.granja_ceba_id IS NULL' : '';
  const { rows } = await pool.query(
    `SELECT l.*, b.nombre AS banda_nombre, g.nombre AS granja_nombre
     FROM lotes_destete l
     LEFT JOIN bandas b ON b.id=l.banda_id
     LEFT JOIN granjas_ceba g ON g.id=l.granja_ceba_id
     ${filtro} ORDER BY l.creado_en DESC`);
  res.json(rows);
});

// Trasladar un lote a una granja de ceba → genera el ingreso automáticamente
router.post('/lotes/:id/trasladar', async (req, res) => {
  const loteId = Number(req.params.id);
  const { granja_id, fecha } = req.body;
  if (!granja_id) return res.status(400).json({ error: 'Debes elegir la granja de ceba' });

  const lote = (await pool.query('SELECT * FROM lotes_destete WHERE id=$1', [loteId])).rows[0];
  if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });
  if (lote.granja_ceba_id) return res.status(400).json({ error: 'Este lote ya fue trasladado' });

  const fechaMov = fecha || new Date().toISOString().slice(0,10);
  // Peso promedio de entrada por animal = peso_total / lechones
  const pesoPromEntrada = (lote.peso_total && lote.lechones)
    ? Number(lote.peso_total) / Number(lote.lechones) : null;

  // Crear el movimiento de ingreso en ceba
  const mov = (await pool.query(
    `INSERT INTO movimientos_ceba (granja_id, fecha, tipo, cantidad, peso_promedio, peso_total, costo_lechon, causa, usuario_id)
     VALUES ($1,$2,'ingreso',$3,$4,$5,$6,$7,$8) RETURNING *`,
    [granja_id, fechaMov, lote.lechones, pesoPromEntrada, lote.peso_total,
     lote.costo_por_lechon, `Lote ${lote.nombre} (banda ${lote.banda_id||'—'})`, req.usuario?.id||null])).rows[0];

  // Actualizar el lote con el traslado
  await pool.query(
    `UPDATE lotes_destete SET granja_ceba_id=$1, movimiento_id=$2, trasladado_en=now() WHERE id=$3`,
    [granja_id, mov.id, loteId]);

  res.json({ ok: true, movimiento: mov, peso_promedio_entrada: pesoPromEntrada });
});

router.delete('/lotes/:id', async (req, res) => {
  const lote = (await pool.query('SELECT * FROM lotes_destete WHERE id=$1', [Number(req.params.id)])).rows[0];
  if (lote && lote.movimiento_id)
    return res.status(400).json({ error: 'No se puede eliminar: el lote ya fue trasladado a ceba. Elimina primero el ingreso en la granja.' });
  await pool.query('DELETE FROM lotes_destete WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

export default router;
