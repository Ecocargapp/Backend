-- ============================================================
--  AgroSoft — Planta de concentrados e inventario de alimento
--  Producción diaria → despachos (venta / granjas) → consumo diario en granja.
--  El inventario de cada granja, por referencia, = despachos recibidos
--  − consumo registrado (con referencia) + ajustes.
-- ============================================================

-- Referencias de alimento (se pueden agregar más)
CREATE TABLE IF NOT EXISTS alimento_referencias (
  id       SERIAL PRIMARY KEY,
  nombre   TEXT NOT NULL UNIQUE,
  orden    INTEGER NOT NULL DEFAULT 0,
  activa   BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO alimento_referencias (nombre, orden) VALUES
  ('Gestación', 1), ('Lactancia', 2), ('Preinicio', 3), ('Inicio', 4), ('Levante', 5), ('Finalizador', 6)
ON CONFLICT (nombre) DO NOTHING;

-- Granjas que reciben alimento: El Tres (cría) y las granjas de ceba (Barro, Barrancas…)
CREATE TABLE IF NOT EXISTS alimento_granjas (
  id              SERIAL PRIMARY KEY,
  nombre          TEXT NOT NULL UNIQUE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('cria','ceba')),
  granja_ceba_id  INTEGER REFERENCES granjas_ceba(id),
  activa          BOOLEAN NOT NULL DEFAULT TRUE
);

-- Producción diaria de la planta (bultos de 40 kg)
CREATE TABLE IF NOT EXISTS planta_produccion (
  id             SERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  referencia_id  INTEGER NOT NULL REFERENCES alimento_referencias(id),
  bultos         NUMERIC(12,2) NOT NULL CHECK (bultos > 0),
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_planta_prod_fecha ON planta_produccion(fecha);

-- Despachos: a una granja (carga su inventario) o a una venta
CREATE TABLE IF NOT EXISTS planta_despachos (
  id             SERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  referencia_id  INTEGER NOT NULL REFERENCES alimento_referencias(id),
  bultos         NUMERIC(12,2) NOT NULL CHECK (bultos > 0),
  destino        TEXT NOT NULL CHECK (destino IN ('venta','granja')),
  granja_id      INTEGER REFERENCES alimento_granjas(id),
  cliente        TEXT,
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (destino = 'venta' OR granja_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_planta_desp_fecha ON planta_despachos(fecha);
CREATE INDEX IF NOT EXISTS idx_planta_desp_granja ON planta_despachos(granja_id);

-- Ajustes de inventario (inventario inicial o correcciones). granja_id NULL = la planta.
CREATE TABLE IF NOT EXISTS alimento_ajustes (
  id             SERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  granja_id      INTEGER REFERENCES alimento_granjas(id),
  referencia_id  INTEGER NOT NULL REFERENCES alimento_referencias(id),
  bultos         NUMERIC(12,2) NOT NULL CHECK (bultos <> 0),   -- positivo suma, negativo resta
  motivo         TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El consumo diario de cría y de ceba indica qué referencia se dio
ALTER TABLE consumos_alimento ADD COLUMN IF NOT EXISTS referencia_id INTEGER REFERENCES alimento_referencias(id);
ALTER TABLE consumo_ceba      ADD COLUMN IF NOT EXISTS referencia_id INTEGER REFERENCES alimento_referencias(id);
CREATE INDEX IF NOT EXISTS idx_consumo_ref      ON consumos_alimento(referencia_id);
CREATE INDEX IF NOT EXISTS idx_consumo_ceba_ref ON consumo_ceba(referencia_id);

-- ============================================================
--  Materias primas, recepciones, baches de producción
-- ============================================================
INSERT INTO alimento_referencias (nombre, orden) VALUES ('Agroleche', 7) ON CONFLICT (nombre) DO NOTHING;

CREATE TABLE IF NOT EXISTS materias_primas (
  id      SERIAL PRIMARY KEY,
  nombre  TEXT NOT NULL UNIQUE,
  orden   INTEGER NOT NULL DEFAULT 0,
  activa  BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO materias_primas (nombre, orden) VALUES
  ('Maíz', 1), ('Torta de soya', 2), ('Soya extruida', 3), ('Aceite de soya', 4), ('Palmiste', 5),
  ('Galleta', 6), ('Destilado de maíz', 7), ('Mogolla', 8), ('Carbonato de calcio', 9),
  ('Núcleo levante', 10), ('Núcleo finalizador', 11), ('Núcleo inicio', 12), ('Núcleo preinicio', 13),
  ('Núcleo agroleche', 14), ('Núcleo gestación', 15), ('Núcleo lactancia', 16),
  ('Metionina', 17), ('Triptófano', 18), ('Tiamina', 19), ('Sal de mar', 20), ('Melaza', 21), ('Urea', 22)
ON CONFLICT (nombre) DO NOTHING;

-- Lo que llega a la planta (kg)
CREATE TABLE IF NOT EXISTS mp_recepciones (
  id               SERIAL PRIMARY KEY,
  fecha            DATE NOT NULL,
  materia_prima_id INTEGER NOT NULL REFERENCES materias_primas(id),
  kg               NUMERIC(14,2) NOT NULL CHECK (kg > 0),
  lote             TEXT,
  proveedor        TEXT,
  color            TEXT,
  temperatura      NUMERIC(5,1),
  humedad          NUMERIC(5,1),
  observaciones    TEXT,
  usuario_id       INTEGER REFERENCES usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mp_rec_fecha ON mp_recepciones(fecha);

-- Cada bache: qué alimento se hizo, cuántos bultos salieron, y los kg de cada materia prima usada
CREATE TABLE IF NOT EXISTS planta_baches (
  id             SERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  referencia_id  INTEGER NOT NULL REFERENCES alimento_referencias(id),
  bultos         NUMERIC(12,2) NOT NULL CHECK (bultos > 0),
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baches_fecha ON planta_baches(fecha);
CREATE TABLE IF NOT EXISTS planta_bache_insumos (
  id               SERIAL PRIMARY KEY,
  bache_id         INTEGER NOT NULL REFERENCES planta_baches(id) ON DELETE CASCADE,
  materia_prima_id INTEGER NOT NULL REFERENCES materias_primas(id),
  kg               NUMERIC(14,2) NOT NULL CHECK (kg > 0)
);
CREATE INDEX IF NOT EXISTS idx_bache_ins_bache ON planta_bache_insumos(bache_id);
CREATE INDEX IF NOT EXISTS idx_bache_ins_mp ON planta_bache_insumos(materia_prima_id);

-- Ajustes de materia prima (inventario inicial o correcciones), en kg
CREATE TABLE IF NOT EXISTS mp_ajustes (
  id               SERIAL PRIMARY KEY,
  fecha            DATE NOT NULL,
  materia_prima_id INTEGER NOT NULL REFERENCES materias_primas(id),
  kg               NUMERIC(14,2) NOT NULL CHECK (kg <> 0),
  motivo           TEXT,
  usuario_id       INTEGER REFERENCES usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
