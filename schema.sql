-- ============================================================
--  AgroSoft — Esquema de base de datos (PostgreSQL)
--  Sistema integrado: Planta de concentrados + Granjas porcinas
-- ============================================================

-- ---------- USUARIOS Y ACCESO ----------
CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  rol           TEXT        NOT NULL DEFAULT 'operador',   -- admin | operador
  activo        BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_acceso TIMESTAMPTZ
);

-- ---------- UBICACIONES (planta y granjas) ----------
CREATE TABLE IF NOT EXISTS ubicaciones (
  id        SERIAL PRIMARY KEY,
  nombre    TEXT        NOT NULL,
  tipo      TEXT        NOT NULL,   -- planta | granja_cria | granja_ceba
  activo    BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- CATÁLOGO DE ITEMS (materias primas y prod. terminado) ----------
CREATE TABLE IF NOT EXISTS items (
  id        SERIAL PRIMARY KEY,
  nombre    TEXT        NOT NULL,
  tipo      TEXT        NOT NULL,   -- materia_prima | producto_terminado
  unidad    TEXT        NOT NULL DEFAULT 'kg',
  activo    BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- INVENTARIO (existencias por ubicación e item) ----------
CREATE TABLE IF NOT EXISTS inventario (
  id           SERIAL PRIMARY KEY,
  ubicacion_id INTEGER NOT NULL REFERENCES ubicaciones(id),
  item_id      INTEGER NOT NULL REFERENCES items(id),
  cantidad     NUMERIC(14,3) NOT NULL DEFAULT 0,
  UNIQUE (ubicacion_id, item_id)
);

-- ---------- MOVIMIENTOS (trazabilidad de todo lo que entra y sale) ----------
CREATE TABLE IF NOT EXISTS movimientos (
  id           SERIAL PRIMARY KEY,
  fecha        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tipo         TEXT        NOT NULL,   -- entrada | produccion | despacho | consumo | ajuste
  item_id      INTEGER     NOT NULL REFERENCES items(id),
  ubicacion_id INTEGER     NOT NULL REFERENCES ubicaciones(id),
  cantidad     NUMERIC(14,3) NOT NULL,  -- positivo entra, negativo sale
  referencia   TEXT,                    -- p.ej. nº de lote de producción
  usuario_id   INTEGER     REFERENCES usuarios(id),
  nota         TEXT
);

CREATE INDEX IF NOT EXISTS idx_mov_fecha ON movimientos(fecha);
CREATE INDEX IF NOT EXISTS idx_inv_ubic ON inventario(ubicacion_id);
