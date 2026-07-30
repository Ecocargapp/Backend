import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pool from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FALTA la variable JWT_SECRET. Defínela en el archivo .env');
  process.exit(1);
}

// CORS: permite que el frontend (en otro dominio) hable con este backend.
// FRONTEND_URL se define en .env, p.ej. https://app.agrofranpabel.com
const origenesPermitidos = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map(s => s.trim());

app.use(cors({
  origin: origenesPermitidos,
  credentials: true,
}));
app.use(express.json());

// ---------- Autenticación por token (enviado en encabezado Authorization) ----------
function requiereLogin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

function requiereAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin')
    return res.status(403).json({ error: 'Requiere permisos de administrador' });
  next();
}

// ============================================================
//  AUTENTICACIÓN
// ============================================================

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email y contraseña son obligatorios' });

    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1 AND activo = TRUE',
      [email.trim().toLowerCase()]
    );
    const usuario = rows[0];

    // Mensaje genérico: no revela si el correo existe.
    if (!usuario || !bcrypt.compareSync(password, usuario.password_hash))
      return res.status(401).json({ error: 'Credenciales incorrectas' });

    await pool.query('UPDATE usuarios SET ultimo_acceso = now() WHERE id = $1', [usuario.id]);

    const token = jwt.sign(
      { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, usuario: { nombre: usuario.nombre, email: usuario.email, rol: usuario.rol } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/yo', requiereLogin, (req, res) => {
  res.json({ id: req.usuario.id, nombre: req.usuario.nombre, email: req.usuario.email, rol: req.usuario.rol });
});

app.post('/api/cambiar-password', requiereLogin, async (req, res) => {
  try {
    const { actual, nueva } = req.body;
    if (!nueva || nueva.length < 8)
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });

    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.usuario.id]);
    const usuario = rows[0];
    if (!bcrypt.compareSync(actual || '', usuario.password_hash))
      return res.status(400).json({ error: 'La contraseña actual no es correcta' });

    const hash = bcrypt.hashSync(nueva, 10);
    await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, usuario.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================================
//  MÓDULO ADMINISTRATIVO — USUARIOS  (solo admin)
// ============================================================

app.get('/api/usuarios', requiereLogin, requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nombre, email, rol, activo, creado_en, ultimo_acceso FROM usuarios ORDER BY nombre'
  );
  res.json(rows);
});

app.post('/api/usuarios', requiereLogin, requiereAdmin, async (req, res) => {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password)
      return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios' });
    if (password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    const emailNorm = email.trim().toLowerCase();
    const dup = await pool.query('SELECT id FROM usuarios WHERE email = $1', [emailNorm]);
    if (dup.rowCount > 0)
      return res.status(400).json({ error: 'Ya existe un usuario con ese correo' });

    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [nombre.trim(), emailNorm, hash, rol === 'admin' ? 'admin' : 'operador']
    );
    res.json({ id: rows[0].id, nombre, email: emailNorm, rol });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/usuarios/:id/estado', requiereLogin, requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id)
    return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
  await pool.query('UPDATE usuarios SET activo = $1 WHERE id = $2', [!!req.body.activo, id]);
  res.json({ ok: true });
});

app.post('/api/usuarios/:id/password', requiereLogin, requiereAdmin, async (req, res) => {
  const { nueva } = req.body;
  if (!nueva || nueva.length < 8)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const hash = bcrypt.hashSync(nueva, 10);
  await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, Number(req.params.id)]);
  res.json({ ok: true });
});

// Salud del servicio (útil para verificar despliegue)
app.get('/api/salud', (req, res) => res.json({ ok: true, servicio: 'agrosoft-backend' }));

app.listen(PORT, () => {
  console.log(`AgroSoft backend corriendo en el puerto ${PORT}`);
});
