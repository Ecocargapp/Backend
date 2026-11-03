// ============================================================
//  AgroSoft — Planta de concentrados e inventario de alimento
//  Producción → despachos (venta / granjas) → consumo en granja.
//  El inventario por granja y referencia se descarga con el consumo diario
//  y genera alertas cuando quedan menos de 3 días (promedio de la última semana).
// ============================================================
import express from 'express';
import pool from './db.js';

const router = express.Router();
export const UMBRAL_DIAS = 3;

const okFecha = f => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
const sumaDias = (f, n) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hoyServidor = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);   // hora de Colombia (UTC-5)
const num = v => Number(v || 0);
const r2 = v => Number(Number(v).toFixed(2));
const esAdmin = req => req.usuario?.rol === 'admin';

// Crea (si faltan) las granjas de alimento: El Tres (cría) y una por cada granja de ceba.
export async function sincronizarGranjas() {
  await pool.query(
    `INSERT INTO alimento_granjas (nombre, tipo)
     SELECT 'El Tres', 'cria' WHERE NOT EXISTS (SELECT 1 FROM alimento_granjas WHERE tipo = 'cria')`);
  await pool.query(
    `INSERT INTO alimento_granjas (nombre, tipo, granja_ceba_id)
     SELECT g.nombre, 'ceba', g.id FROM granjas_ceba g
     WHERE NOT EXISTS (SELECT 1 FROM alimento_granjas a WHERE a.granja_ceba_id = g.id)
     ON CONFLICT (nombre) DO NOTHING`);
}

// ------------------------------------------------------------
//  Cálculo del inventario por granja y referencia
// ------------------------------------------------------------
export async function calcularInventario(hoy, umbral = UMBRAL_DIAS) {
  hoy = okFecha(hoy) ? hoy : hoyServidor();
  const desdeSemana = sumaDias(hoy, -6);                      // últimos 7 días, incluido hoy
  await sincronizarGranjas();

  const granjas = (await pool.query(
    'SELECT id, nombre, tipo, granja_ceba_id FROM alimento_granjas WHERE activa = TRUE ORDER BY tipo, nombre')).rows;
  const refs = (await pool.query(
    'SELECT id, nombre FROM alimento_referencias WHERE activa = TRUE ORDER BY orden, nombre')).rows;

  const recibido = (await pool.query(
    `SELECT granja_id, referencia_id, SUM(bultos) AS n FROM planta_despachos
     WHERE destino = 'granja' GROUP BY 1, 2`)).rows;
  const ajustes = (await pool.query(
    'SELECT granja_id, referencia_id, SUM(bultos) AS n FROM alimento_ajustes GROUP BY 1, 2')).rows;
  const consCria = (await pool.query(
    `SELECT referencia_id, SUM(bultos) AS total,
            SUM(CASE WHEN fecha BETWEEN $1::date AND $2::date THEN bultos ELSE 0 END) AS semana
     FROM consumos_alimento WHERE referencia_id IS NOT NULL GROUP BY 1`, [desdeSemana, hoy])).rows;
  const consCeba = (await pool.query(
    `SELECT granja_id, referencia_id, SUM(bultos) AS total,
            SUM(CASE WHEN fecha BETWEEN $1::date AND $2::date THEN bultos ELSE 0 END) AS semana
     FROM consumo_ceba WHERE referencia_id IS NOT NULL GROUP BY 1, 2`, [desdeSemana, hoy])).rows;
  const prod = (await pool.query('SELECT referencia_id, SUM(bultos) AS n FROM planta_produccion GROUP BY 1')).rows;
  const despTodos = (await pool.query('SELECT referencia_id, SUM(bultos) AS n FROM planta_despachos GROUP BY 1')).rows;

  const mapa = (rows, ...keys) => { const m = new Map(); for (const r of rows) m.set(keys.map(k => r[k]).join('|'), r); return m; };
  const mRec = mapa(recibido, 'granja_id', 'referencia_id');
  const mAju = mapa(ajustes, 'granja_id', 'referencia_id');
  const mCria = mapa(consCria, 'referencia_id');
  const mCeba = mapa(consCeba, 'granja_id', 'referencia_id');

  const resultadoGranjas = [];
  const alertas = [];
  for (const g of granjas) {
    const items = [];
    for (const rf of refs) {
      const rec = num(mRec.get(`${g.id}|${rf.id}`)?.n);
      const aju = num(mAju.get(`${g.id}|${rf.id}`)?.n);
      const c = g.tipo === 'cria' ? mCria.get(String(rf.id)) : mCeba.get(`${g.granja_ceba_id}|${rf.id}`);
      const cons = num(c?.total), sem = num(c?.semana);
      if (!rec && !aju && !cons) continue;                     // sin movimiento: no se lista
      const inv = rec - cons + aju, prom = sem / 7;
      let dias = null, estado = 'sin_consumo';
      if (prom > 0) {
        dias = inv > 0 ? inv / prom : 0;
        estado = inv <= 0 ? 'agotado' : dias < umbral ? 'alerta' : dias < umbral * 2 ? 'atencion' : 'ok';
      }
      const it = { referencia_id: rf.id, referencia: rf.nombre, recibido: r2(rec), consumido: r2(cons), ajustes: r2(aju),
                   inventario: r2(inv), consumo_semana: r2(sem), prom_dia: r2(prom), dias: dias == null ? null : r2(dias), estado };
      items.push(it);
      if (estado === 'agotado' || estado === 'alerta')
        alertas.push({ granja_id: g.id, granja: g.nombre, referencia_id: rf.id, referencia: rf.nombre,
                       inventario: it.inventario, prom_dia: it.prom_dia, dias: it.dias, estado });
    }
    resultadoGranjas.push({ id: g.id, nombre: g.nombre, tipo: g.tipo, items });
  }
  alertas.sort((a, b) => (a.dias ?? 0) - (b.dias ?? 0));

  const mProd = mapa(prod, 'referencia_id'), mDesp = mapa(despTodos, 'referencia_id');
  const planta = [];
  for (const rf of refs) {
    const p = num(mProd.get(String(rf.id))?.n), d = num(mDesp.get(String(rf.id))?.n);
    const a = num(mAju.get(`|${rf.id}`)?.n);                  // ajustes de la planta (granja_id NULL)
    if (!p && !d && !a) continue;
    planta.push({ referencia_id: rf.id, referencia: rf.nombre, producido: r2(p), despachado: r2(d), ajustes: r2(a), inventario: r2(p - d + a) });
  }
  return { hoy, umbral, planta, granjas: resultadoGranjas, alertas };
}

// ------------------------------------------------------------
//  Catálogos
// ------------------------------------------------------------
router.get('/referencias', async (req, res) => {
  res.json((await pool.query('SELECT id, nombre, orden, activa FROM alimento_referencias ORDER BY orden, nombre')).rows);
});
router.post('/referencias', async (req, res) => {
  if (!esAdmin(req)) return res.status(403).json({ error: 'Solo el administrador puede crear referencias' });
  const nombre = String(req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO alimento_referencias (nombre, orden)
       VALUES ($1, COALESCE((SELECT MAX(orden) + 1 FROM alimento_referencias), 1)) RETURNING *`, [nombre]);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe esa referencia' });
    console.error(e); res.status(500).json({ error: 'Error creando la referencia' });
  }
});
router.get('/granjas', async (req, res) => {
  await sincronizarGranjas();
  res.json((await pool.query('SELECT id, nombre, tipo FROM alimento_granjas WHERE activa = TRUE ORDER BY tipo, nombre')).rows);
});

// ------------------------------------------------------------
//  Inventario y alertas
// ------------------------------------------------------------
router.get('/inventario', async (req, res) => {
  try { res.json(await calcularInventario(req.query.hoy, Number(req.query.umbral) || UMBRAL_DIAS)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Error calculando el inventario' }); }
});
router.get('/alertas', async (req, res) => {
  try {
    const inv = await calcularInventario(req.query.hoy);
    res.json({ hoy: inv.hoy, umbral: inv.umbral, alertas: inv.alertas });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error calculando las alertas' }); }
});

// ------------------------------------------------------------
//  Producción
// ------------------------------------------------------------
function validarBase(body) {
  const { fecha, referencia_id, bultos } = body;
  if (!okFecha(String(fecha || '').slice(0, 10))) return 'La fecha es obligatoria';
  if (!referencia_id) return 'Elige la referencia';
  const n = Number(bultos);
  if (!(n > 0) || n > 5000) return 'Los bultos deben ser mayores que 0 (máximo 5000)';
  return '';
}
router.get('/produccion', async (req, res) => {
  const desde = okFecha(req.query.desde) ? req.query.desde : '1900-01-01';
  const hasta = okFecha(req.query.hasta) ? req.query.hasta : '2999-12-31';
  const { rows } = await pool.query(
    `SELECT p.id, to_char(p.fecha,'YYYY-MM-DD') AS fecha, r.nombre AS referencia, p.referencia_id, p.bultos,
            p.observaciones, u.nombre AS usuario
     FROM planta_produccion p JOIN alimento_referencias r ON r.id = p.referencia_id
     LEFT JOIN usuarios u ON u.id = p.usuario_id
     WHERE p.fecha BETWEEN $1::date AND $2::date ORDER BY p.fecha DESC, p.id DESC LIMIT 500`, [desde, hasta]);
  res.json(rows);
});
router.post('/produccion', async (req, res) => {
  try {
    const e = validarBase(req.body); if (e) return res.status(400).json({ error: e });
    const { fecha, referencia_id, bultos, observaciones } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO planta_produccion (fecha, referencia_id, bultos, observaciones, usuario_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [fecha, referencia_id, bultos, observaciones || null, req.usuario?.id || null]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error registrando la producción' }); }
});
router.delete('/produccion/:id', async (req, res) => {
  if (!esAdmin(req)) return res.status(403).json({ error: 'Solo el administrador puede eliminar registros' });
  await pool.query('DELETE FROM planta_produccion WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true });
});

// ------------------------------------------------------------
//  Despachos (venta o granja)
// ------------------------------------------------------------
router.get('/despachos', async (req, res) => {
  const desde = okFecha(req.query.desde) ? req.query.desde : '1900-01-01';
  const hasta = okFecha(req.query.hasta) ? req.query.hasta : '2999-12-31';
  const { rows } = await pool.query(
    `SELECT d.id, to_char(d.fecha,'YYYY-MM-DD') AS fecha, r.nombre AS referencia, d.referencia_id, d.bultos, d.destino,
            g.nombre AS granja, d.granja_id, d.cliente, d.observaciones, u.nombre AS usuario
     FROM planta_despachos d JOIN alimento_referencias r ON r.id = d.referencia_id
     LEFT JOIN alimento_granjas g ON g.id = d.granja_id LEFT JOIN usuarios u ON u.id = d.usuario_id
     WHERE d.fecha BETWEEN $1::date AND $2::date ORDER BY d.fecha DESC, d.id DESC LIMIT 500`, [desde, hasta]);
  res.json(rows);
});
router.post('/despachos', async (req, res) => {
  try {
    const e = validarBase(req.body); if (e) return res.status(400).json({ error: e });
    const { fecha, referencia_id, bultos, destino, granja_id, cliente, observaciones } = req.body;
    if (!['venta', 'granja'].includes(destino)) return res.status(400).json({ error: 'Elige el destino (venta o granja)' });
    if (destino === 'granja') {
      const g = (await pool.query('SELECT id FROM alimento_granjas WHERE id=$1 AND activa=TRUE', [granja_id])).rows[0];
      if (!g) return res.status(400).json({ error: 'Elige la granja de destino' });
    }
    const { rows } = await pool.query(
      `INSERT INTO planta_despachos (fecha, referencia_id, bultos, destino, granja_id, cliente, observaciones, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [fecha, referencia_id, bultos, destino, destino === 'granja' ? granja_id : null,
       destino === 'venta' ? (cliente || null) : null, observaciones || null, req.usuario?.id || null]);
    // Aviso (no bloquea): si la planta queda con inventario negativo
    const inv = await calcularInventario(String(fecha).slice(0, 10));
    const p = inv.planta.find(x => x.referencia_id === Number(referencia_id));
    res.json({ ...rows[0], planta_inventario: p ? p.inventario : null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error registrando el despacho' }); }
});
router.delete('/despachos/:id', async (req, res) => {
  if (!esAdmin(req)) return res.status(403).json({ error: 'Solo el administrador puede eliminar registros' });
  await pool.query('DELETE FROM planta_despachos WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true });
});

// ------------------------------------------------------------
//  Ajustes de inventario (inventario inicial o correcciones)
// ------------------------------------------------------------
router.get('/ajustes', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, to_char(a.fecha,'YYYY-MM-DD') AS fecha, COALESCE(g.nombre,'Planta') AS ubicacion, a.granja_id,
            r.nombre AS referencia, a.referencia_id, a.bultos, a.motivo, u.nombre AS usuario
     FROM alimento_ajustes a JOIN alimento_referencias r ON r.id = a.referencia_id
     LEFT JOIN alimento_granjas g ON g.id = a.granja_id LEFT JOIN usuarios u ON u.id = a.usuario_id
     ORDER BY a.fecha DESC, a.id DESC LIMIT 300`);
  res.json(rows);
});
router.post('/ajustes', async (req, res) => {
  try {
    const { fecha, granja_id, referencia_id, bultos, motivo } = req.body;
    if (!okFecha(String(fecha || '').slice(0, 10))) return res.status(400).json({ error: 'La fecha es obligatoria' });
    if (!referencia_id) return res.status(400).json({ error: 'Elige la referencia' });
    const n = Number(bultos);
    if (!n || Math.abs(n) > 100000) return res.status(400).json({ error: 'Escribe los bultos (positivo suma, negativo resta)' });
    if (granja_id) {
      const g = (await pool.query('SELECT id FROM alimento_granjas WHERE id=$1', [granja_id])).rows[0];
      if (!g) return res.status(400).json({ error: 'Granja inválida' });
    }
    const { rows } = await pool.query(
      `INSERT INTO alimento_ajustes (fecha, granja_id, referencia_id, bultos, motivo, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fecha, granja_id || null, referencia_id, n, motivo || null, req.usuario?.id || null]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error registrando el ajuste' }); }
});
router.delete('/ajustes/:id', async (req, res) => {
  if (!esAdmin(req)) return res.status(403).json({ error: 'Solo el administrador puede eliminar registros' });
  await pool.query('DELETE FROM alimento_ajustes WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true });
});

export default router;
