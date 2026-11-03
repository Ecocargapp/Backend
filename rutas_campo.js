// ============================================================
//  AgroSoft — Rutas de la APP DE CAMPO (móvil)
//  GET  /api/campo/datos    → todo lo que la app necesita para trabajar sin señal
//  POST /api/campo/recelos  → recelo AM/PM de una cerda (confirmación de preñez)
// ============================================================
import express from 'express';
import pool from './db.js';

const router = express.Router();

router.get('/datos', async (req, res) => {
  try {
    const cerdas = (await pool.query(`
      SELECT c.id, c.arete, c.estado, c.ciclo_actual, c.ubicacion, c.banda_id, r.nombre AS raza,
             to_char(c.fecha_ultimo_servicio,'YYYY-MM-DD') AS fecha_ultimo_servicio,
             to_char(c.fecha_ultimo_parto,'YYYY-MM-DD')    AS fecha_ultimo_parto,
             to_char(c.fecha_ultimo_destete,'YYYY-MM-DD')  AS fecha_ultimo_destete,
             p.id AS ultimo_parto_id, p.nacidos_vivos AS ultimo_parto_vivos,
             s.id AS ultimo_servicio_id,
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

    const bandas = (await pool.query(
      'SELECT id, nombre FROM bandas WHERE activa = TRUE ORDER BY fecha_parto DESC NULLS LAST, nombre')).rows;

    const granjas = (await pool.query(
      'SELECT id, nombre FROM granjas_ceba WHERE activa = TRUE ORDER BY nombre')).rows;

    const lotes = (await pool.query(`
      SELECT l.id, l.nombre, l.granja_ceba_id, g.nombre AS granja, l.lechones,
             l.lechones - COALESCE((SELECT SUM(m.cantidad) FROM movimientos_ceba m
                                    WHERE m.lote_id = l.id AND m.tipo IN ('muerte','venta')), 0) AS inventario
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

    res.json({ generado: new Date().toISOString(), cerdas, bandas, granjas, lotes,
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

export default router;
