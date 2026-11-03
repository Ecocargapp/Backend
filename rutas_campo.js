// ============================================================
//  AgroSoft — Rutas de la APP DE CAMPO (móvil)
//  GET  /api/campo/datos    → todo lo que la app necesita para trabajar sin señal
//  POST /api/campo/recelos  → recelo AM/PM de una cerda (confirmación de preñez)
// ============================================================
import express from 'express';
import pool from './db.js';
import { calcularInventario } from './rutas_planta.js';

const router = express.Router();

router.get('/datos', async (req, res) => {
  try {
    const cerdas = (await pool.query(`
      SELECT c.id, c.arete, c.estado, c.ciclo_actual, c.ubicacion, c.banda_id, r.nombre AS raza,
             to_char(c.fecha_ultimo_servicio,'YYYY-MM-DD') AS fecha_ultimo_servicio,
             to_char(c.fecha_ultimo_parto,'YYYY-MM-DD')    AS fecha_ultimo_parto,
             to_char(c.fecha_ultimo_destete,'YYYY-MM-DD')  AS fecha_ultimo_destete,
             p.id AS ultimo_parto_id, p.nacidos_vivos AS ultimo_parto_vivos,
             COALESCE((SELECT SUM(m.cantidad) FROM mortalidad_lactancia m WHERE m.parto_id = p.id), 0)::int AS mort_lactancia,
             s.id AS ultimo_servicio_id,
             (SELECT json_build_object('fecha', to_char(w.fecha,'YYYY-MM-DD'), 'peso', w.peso_promedio)
                FROM pesajes w WHERE w.cerda_id = c.id ORDER BY w.fecha DESC, w.id DESC LIMIT 1) AS ultimo_peso,
             COALESCE((SELECT json_agg(json_build_object(
                         'fecha', to_char(rc.fecha,'YYYY-MM-DD'), 'jornada', rc.jornada, 'resultado', rc.resultado)
                         ORDER BY rc.fecha, rc.jornada)
                       FROM recelos rc
                       WHERE rc.cerda_id = c.id
                         AND (c.fecha_ultimo_servicio IS NULL OR rc.fecha >= c.fecha_ultimo_servicio)), '[]') AS recelos
      FROM cerdas c
      LEFT JOIN razas r ON r.id = c.raza_id
      LEFT JOIN LATERAL (SELECT id, nacidos_vivos FROM partos WHERE cerda_id = c.id
                         ORDER BY fecha_parto DESC, id DESC LIMIT 1) p ON TRUE
      LEFT JOIN LATERAL (SELECT id FROM servicios WHERE cerda_id = c.id
                         ORDER BY fecha_servicio DESC, id DESC LIMIT 1) s ON TRUE
      WHERE c.activo = TRUE
      ORDER BY c.arete`)).rows;

    const razas = (await pool.query('SELECT id, nombre FROM razas WHERE activo = TRUE ORDER BY nombre')).rows;

    const bandas = (await pool.query(
      'SELECT id, nombre FROM bandas WHERE activa = TRUE ORDER BY fecha_parto DESC NULLS LAST, nombre')).rows;

    const granjas = (await pool.query(
      'SELECT id, nombre FROM granjas_ceba WHERE activa = TRUE ORDER BY nombre')).rows;

    const lotes = (await pool.query(`
      SELECT l.id, l.nombre, l.granja_ceba_id, g.nombre AS granja, l.lechones,
             l.lechones - COALESCE((SELECT SUM(m.cantidad) FROM movimientos_ceba m
                                    WHERE m.lote_id = l.id AND m.tipo IN ('muerte','venta')), 0) AS inventario,
             (SELECT json_build_object('fecha', to_char(w.fecha,'YYYY-MM-DD'), 'peso', w.peso_promedio, 'cantidad', w.cantidad)
                FROM pesajes w WHERE w.lote_id = l.id ORDER BY w.fecha DESC, w.id DESC LIMIT 1) AS ultimo_pesaje
      FROM lotes_destete l
      JOIN granjas_ceba g ON g.id = l.granja_ceba_id
      WHERE l.activo = TRUE
      ORDER BY g.nombre, l.nombre`)).rows
      .filter(l => Number(l.inventario) > 0);

    // Nombres de alimento usados recientemente (para sugerir en los formularios)
    const alimCria = (await pool.query(
      `SELECT DISTINCT tipo_alimento FROM consumos_alimento
       WHERE tipo_alimento IS NOT NULL AND tipo_alimento <> '' AND fecha > CURRENT_DATE - 365
       ORDER BY tipo_alimento`)).rows.map(r => r.tipo_alimento);
    const alimCeba = (await pool.query(
      `SELECT DISTINCT tipo_alimento FROM consumo_ceba
       WHERE tipo_alimento IS NOT NULL AND tipo_alimento <> '' AND fecha > CURRENT_DATE - 365
       ORDER BY tipo_alimento`)).rows.map(r => r.tipo_alimento);

    // Inventario de alimento por granja y referencia (la app lo descarga y lo ajusta con lo pendiente)
    const hoyCliente = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hoy || '') ? req.query.hoy : undefined;
    const alimento = await calcularInventario(hoyCliente);
    const referencias = (await pool.query('SELECT id, nombre FROM alimento_referencias WHERE activa = TRUE ORDER BY orden, nombre')).rows;
    const granjasAlimento = (await pool.query('SELECT id, nombre, tipo, granja_ceba_id FROM alimento_granjas WHERE activa = TRUE ORDER BY tipo, nombre')).rows;

    res.json({ generado: new Date().toISOString(), cerdas, razas, bandas, granjas, lotes, alimento, referencias, granjas_alimento: granjasAlimento,
               alimentos_cria: alimCria, alimentos_ceba: alimCeba });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error preparando los datos de campo' });
  }
});

router.post('/recelos', async (req, res) => {
  try {
    const { cerda_id, fecha, jornada, resultado, observaciones } = req.body;
    if (!cerda_id || !fecha || !jornada || !resultado)
      return res.status(400).json({ error: 'Cerda, fecha, jornada y resultado son obligatorios' });
    if (!['AM', 'PM'].includes(jornada))
      return res.status(400).json({ error: 'Jornada inválida (AM o PM)' });
    if (!['en_celo', 'sin_celo'].includes(resultado))
      return res.status(400).json({ error: 'Resultado inválido (en_celo o sin_celo)' });

    const cerda = (await pool.query('SELECT id, estado FROM cerdas WHERE id=$1', [cerda_id])).rows[0];
    if (!cerda) return res.status(404).json({ error: 'Cerda no encontrada' });

    const serv = (await pool.query(
      'SELECT id FROM servicios WHERE cerda_id=$1 ORDER BY fecha_servicio DESC, id DESC LIMIT 1', [cerda_id])).rows[0];

    // Si ya hay un registro de esa cerda/fecha/jornada, se actualiza (corrección)
    const { rows } = await pool.query(
      `INSERT INTO recelos (cerda_id, servicio_id, fecha, jornada, resultado, observaciones, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (cerda_id, fecha, jornada)
       DO UPDATE SET resultado=EXCLUDED.resultado, observaciones=EXCLUDED.observaciones,
                     usuario_id=EXCLUDED.usuario_id, servicio_id=EXCLUDED.servicio_id
       RETURNING *`,
      [cerda_id, serv?.id || null, fecha, jornada, resultado, observaciones || null, req.usuario?.id || null]);

    res.json({ ...rows[0],
      alerta: (resultado === 'en_celo' && cerda.estado === 'servida') ? 'posible_retorno_a_celo' : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error registrando el recelo' });
  }
});

// ------------------------------------------------------------
//  MORTALIDAD EN LACTANCIA (lechones que mueren antes del destete)
// ------------------------------------------------------------
router.post('/mortalidad-lactancia', async (req, res) => {
  try {
    const { cerda_id, fecha, cantidad, causa, observaciones } = req.body;
    const n = Number(cantidad);
    if (!cerda_id || !fecha || !Number.isInteger(n) || n < 1)
      return res.status(400).json({ error: 'Hembra, fecha y cantidad (entero mayor que 0) son obligatorios' });
    const cerda = (await pool.query('SELECT id, estado FROM cerdas WHERE id=$1', [cerda_id])).rows[0];
    if (!cerda) return res.status(404).json({ error: 'Cerda no encontrada' });
    if (cerda.estado !== 'lactante')
      return res.status(400).json({ error: 'Solo se registra mortalidad de lactancia en hembras lactantes' });
    const parto = (await pool.query(
      `SELECT id, nacidos_vivos, to_char(fecha_parto,'YYYY-MM-DD') AS fecha_parto
       FROM partos WHERE cerda_id=$1 ORDER BY fecha_parto DESC, id DESC LIMIT 1`, [cerda_id])).rows[0];
    if (!parto) return res.status(400).json({ error: 'La hembra no tiene un parto registrado' });
    if (String(fecha).slice(0, 10) < parto.fecha_parto)
      return res.status(400).json({ error: 'La fecha no puede ser anterior al parto (' + parto.fecha_parto + ')' });
    const previos = Number((await pool.query(
      'SELECT COALESCE(SUM(cantidad),0) AS n FROM mortalidad_lactancia WHERE parto_id=$1', [parto.id])).rows[0].n);
    const vivos = parto.nacidos_vivos - previos;
    if (n > vivos)
      return res.status(400).json({ error: `La camada solo tiene ${vivos} lechones vivos; no puedes registrar ${n} muertos.` });
    const { rows } = await pool.query(
      `INSERT INTO mortalidad_lactancia (cerda_id, parto_id, fecha, cantidad, causa, observaciones, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cerda_id, parto.id, fecha, n, causa || null, observaciones || null, req.usuario?.id || null]);
    res.json({ ...rows[0], lechones_actuales: vivos - n });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error registrando la mortalidad' }); }
});

// ------------------------------------------------------------
//  ENTRADA DE REEMPLAZOS (hembras nuevas al plantel)
// ------------------------------------------------------------
router.post('/reemplazos', async (req, res) => {
  const cliente = await pool.connect();
  try {
    const { arete, arete_secundario, raza_id, fecha_nacimiento, fecha_ingreso, origen,
            proveedor, ubicacion, peso_ingreso, observaciones } = req.body;
    const a = String(arete || '').trim();
    if (!a) return res.status(400).json({ error: 'El arete es obligatorio' });
    if (origen && !['compra', 'reposicion_interna', 'nacida'].includes(origen))
      return res.status(400).json({ error: 'Origen inválido' });
    const peso = peso_ingreso === '' || peso_ingreso == null ? null : Number(peso_ingreso);
    if (peso != null && !(peso > 0 && peso < 400)) return res.status(400).json({ error: 'El peso de ingreso es inválido' });

    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `INSERT INTO cerdas (arete, arete_secundario, raza_id, fecha_nacimiento, fecha_ingreso, origen,
                           estado, ubicacion, peso_ingreso, proveedor, observaciones)
       VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),COALESCE($6,'compra'),'reemplazo',$7,$8,$9,$10) RETURNING *`,
      [a, arete_secundario || null, raza_id || null, fecha_nacimiento || null, fecha_ingreso || null,
       origen || null, ubicacion || null, peso, proveedor || null, observaciones || null]);
    if (peso != null)
      await cliente.query(
        `INSERT INTO pesajes (tipo, cerda_id, fecha, cantidad, peso_total, peso_promedio, observaciones, usuario_id)
         VALUES ('hembra',$1,COALESCE($2,CURRENT_DATE),1,$3,$3,'Peso de ingreso',$4)`,
        [rows[0].id, fecha_ingreso || null, peso, req.usuario?.id || null]);
    await cliente.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe una hembra con ese arete' });
    console.error(e); res.status(500).json({ error: 'Error registrando el reemplazo' });
  } finally { cliente.release(); }
});

// ------------------------------------------------------------
//  PESAJES (una hembra, o una muestra de un lote de ceba)
// ------------------------------------------------------------
router.post('/pesajes', async (req, res) => {
  try {
    const { tipo, cerda_id, lote_id, fecha, cantidad, peso_total, observaciones } = req.body;
    if (!['hembra', 'lote'].includes(tipo)) return res.status(400).json({ error: 'Tipo de pesaje inválido' });
    if (!fecha) return res.status(400).json({ error: 'La fecha es obligatoria' });
    const total = Number(peso_total);
    if (!(total > 0)) return res.status(400).json({ error: 'El peso debe ser mayor que 0' });
    let n = 1;
    if (tipo === 'hembra') {
      if (!cerda_id) return res.status(400).json({ error: 'Elige la hembra' });
      if (!(total >= 5 && total <= 400)) return res.status(400).json({ error: 'El peso de la hembra parece incorrecto (5 a 400 kg)' });
      const c = (await pool.query('SELECT id FROM cerdas WHERE id=$1', [cerda_id])).rows[0];
      if (!c) return res.status(404).json({ error: 'Cerda no encontrada' });
    } else {
      n = Number(cantidad);
      if (!lote_id) return res.status(400).json({ error: 'Elige el lote' });
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'Escribe cuántos animales pesaste' });
      const prom = total / n;
      if (!(prom >= 3 && prom <= 200)) return res.status(400).json({ error: `El promedio (${prom.toFixed(1)} kg por animal) parece incorrecto. Revisa el peso total y la cantidad.` });
      const l = (await pool.query('SELECT id FROM lotes_destete WHERE id=$1', [lote_id])).rows[0];
      if (!l) return res.status(404).json({ error: 'Lote no encontrado' });
    }
    const promedio = Number((total / n).toFixed(2));
    const { rows } = await pool.query(
      `INSERT INTO pesajes (tipo, cerda_id, lote_id, fecha, cantidad, peso_total, peso_promedio, observaciones, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [tipo, tipo === 'hembra' ? cerda_id : null, tipo === 'lote' ? lote_id : null, fecha, n, total, promedio,
       observaciones || null, req.usuario?.id || null]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error registrando el pesaje' }); }
});

// ------------------------------------------------------------
//  RECELOS — vista para el software (matriz por día, AM/PM)
//  GET /api/campo/recelos-resumen?dias=7&hasta=2026-11-03
// ------------------------------------------------------------
const VENTANA_DESDE = 18, VENTANA_HASTA = 24;   // días del servicio en que se espera el retorno a celo
function sumaDiasISO(f, n) { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diasEntre(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }

router.get('/recelos-resumen', async (req, res) => {
  try {
    const okF = f => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
    const hasta = okF(req.query.hasta) ? req.query.hasta : new Date().toISOString().slice(0, 10);
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 7, 1), 31);
    const desde = sumaDiasISO(hasta, -(dias - 1));
    const fechas = Array.from({ length: dias }, (_, i) => sumaDiasISO(desde, i));

    const cerdas = (await pool.query(`
      SELECT c.id, c.arete, c.estado, c.ciclo_actual, c.ubicacion, r.nombre AS raza,
             to_char(c.fecha_ultimo_servicio,'YYYY-MM-DD') AS fecha_ultimo_servicio,
             to_char(c.fecha_ultimo_destete,'YYYY-MM-DD')  AS fecha_ultimo_destete
      FROM cerdas c LEFT JOIN razas r ON r.id = c.raza_id
      WHERE c.activo = TRUE`)).rows;

    const marcasRows = (await pool.query(
      `SELECT cerda_id, to_char(fecha,'YYYY-MM-DD') AS fecha, jornada, resultado
       FROM recelos WHERE fecha >= $1::date - 45 AND fecha <= $2::date`, [desde, hasta])).rows;
    const porCerda = new Map();
    for (const m of marcasRows) { if (!porCerda.has(m.cerda_id)) porCerda.set(m.cerda_id, []); porCerda.get(m.cerda_id).push(m); }

    const filas = [];
    for (const c of cerdas) {
      const todas = porCerda.get(c.id) || [];
      const enPeriodo = todas.filter(m => m.fecha >= desde && m.fecha <= hasta);
      if (!enPeriodo.length && c.estado !== 'servida') continue;     // solo servidas o con marcas en el período
      const marcas = {};
      for (const m of enPeriodo) (marcas[m.fecha] = marcas[m.fecha] || {})[m.jornada] = m.resultado;

      const diasServ = (c.fecha_ultimo_servicio && ['servida', 'gestante'].includes(c.estado)) ? diasEntre(c.fecha_ultimo_servicio, hasta) : null;
      const desdeServ = c.fecha_ultimo_servicio ? todas.filter(m => m.fecha >= c.fecha_ultimo_servicio) : todas;
      let situacion = 'sin_marcas', etiqueta = 'Sin revisar en el período';
      if (c.estado === 'servida' || c.estado === 'gestante') {
        const celos = desdeServ.filter(m => m.resultado === 'en_celo');
        const ventana = desdeServ.filter(m => { const d = diasEntre(c.fecha_ultimo_servicio, m.fecha); return d >= VENTANA_DESDE && d <= VENTANA_HASTA; });
        const diasSin = new Set(ventana.filter(m => m.resultado === 'sin_celo').map(m => m.fecha));
        if (celos.length) { situacion = 'retorno'; etiqueta = 'Posible retorno a celo'; }
        else if (diasSin.size >= 2) { situacion = 'prenez_probable'; etiqueta = 'Sin celo: preñez probable'; }
        else if (enPeriodo.length) { situacion = 'en_seguimiento'; etiqueta = 'En seguimiento'; }
        else if (diasServ != null && diasServ >= 17) { situacion = 'sin_revisar'; etiqueta = 'Falta revisar recelo'; }
        else { situacion = 'sin_marcas'; etiqueta = 'Aún no es ventana'; }
      } else if (c.estado === 'vacia') {
        const ult = enPeriodo.slice().sort((a, b) => (a.fecha + a.jornada).localeCompare(b.fecha + b.jornada)).pop();
        if (ult && ult.resultado === 'en_celo') { situacion = 'celo_vacia'; etiqueta = 'En celo: lista para servir'; }
        else { situacion = 'en_seguimiento'; etiqueta = 'En seguimiento'; }
      } else { situacion = 'en_seguimiento'; etiqueta = 'En seguimiento'; }

      filas.push({ id: c.id, arete: c.arete, raza: c.raza, estado: c.estado, ciclo_actual: c.ciclo_actual,
                   fecha_ultimo_servicio: c.fecha_ultimo_servicio, dias_servicio: diasServ,
                   marcas, situacion, etiqueta });
    }
    const orden = { retorno: 0, celo_vacia: 1, sin_revisar: 2, en_seguimiento: 3, prenez_probable: 4, sin_marcas: 5 };
    filas.sort((a, b) => (orden[a.situacion] - orden[b.situacion]) || ((b.dias_servicio ?? -1) - (a.dias_servicio ?? -1)) || a.arete.localeCompare(b.arete, 'es', { numeric: true }));

    const cuenta = k => filas.filter(f => f.situacion === k).length;
    const marcadasHoy = { AM: 0, PM: 0 };
    for (const f of filas) { const h = f.marcas[hasta] || {}; if (h.AM) marcadasHoy.AM++; if (h.PM) marcadasHoy.PM++; }
    res.json({ desde, hasta, dias, fechas, filas,
      ventana: { desde: VENTANA_DESDE, hasta: VENTANA_HASTA },
      resumen: { hembras: filas.length, retorno: cuenta('retorno'), prenez_probable: cuenta('prenez_probable'),
                 sin_revisar: cuenta('sin_revisar'), celo_vacia: cuenta('celo_vacia'), marcadas_hoy: marcadasHoy } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error consultando los recelos' }); }
});

export default router;
