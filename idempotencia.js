// ============================================================
//  AgroSoft — Idempotencia para la app de campo
//  Si el celular reenvía una petición POST con el mismo encabezado
//  X-Clave-Cliente (porque se cortó la señal antes de recibir la
//  respuesta), el servidor devuelve la respuesta original en lugar
//  de registrar el dato otra vez.
// ============================================================
import pool from './db.js';

export default async function idempotencia(req, res, next) {
  const clave = req.headers['x-clave-cliente'];
  if (req.method !== 'POST' || !clave) return next();
  const k = `${req.usuario?.id || 0}:${String(clave).slice(0, 80)}`;
  try {
    const ins = await pool.query(
      'INSERT INTO claves_idempotencia (clave, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING clave',
      [k, req.usuario?.id || null]);
    if (!ins.rowCount) {
      const prev = (await pool.query('SELECT status, respuesta FROM claves_idempotencia WHERE clave=$1', [k])).rows[0];
      if (prev && prev.status) return res.status(prev.status).json({ ...(prev.respuesta || {}), repetido: true });
      return res.status(409).json({ error: 'Registro en proceso, intenta de nuevo' });
    }
    // Interceptar la respuesta para guardarla (o liberar la clave si falló)
    const jsonOriginal = res.json.bind(res);
    res.json = (cuerpo) => {
      const ok = res.statusCode < 400;
      const q = ok
        ? pool.query('UPDATE claves_idempotencia SET status=$2, respuesta=$3 WHERE clave=$1', [k, res.statusCode, JSON.stringify(cuerpo ?? null)])
        : pool.query('DELETE FROM claves_idempotencia WHERE clave=$1', [k]);
      // Se guarda la clave ANTES de responder: si el celular reintenta enseguida, ya existe.
      q.catch(e => console.error('idempotencia:', e.message)).finally(() => jsonOriginal(cuerpo));
      return res;
    };
    next();
  } catch (e) {
    console.error('idempotencia:', e.message);
    next();
  }
}
