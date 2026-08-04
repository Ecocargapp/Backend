-- ============================================================
--  AgroSoft — Módulo de CEBA (engorde)
--  Inventario por granja, movimientos, consumo y liquidación
-- ============================================================

-- ---------- GRANJAS DE CEBA ----------
CREATE TABLE IF NOT EXISTS granjas_ceba (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL UNIQUE,       -- Barrancas, Barro
  ubicacion   TEXT,
  activa      BOOLEAN NOT NULL DEFAULT TRUE,
  creada_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- MOVIMIENTOS DE INVENTARIO ----------
-- tipo: ingreso | muerte | venta
CREATE TABLE IF NOT EXISTS movimientos_ceba (
  id             SERIAL PRIMARY KEY,
  granja_id      INTEGER NOT NULL REFERENCES granjas_ceba(id),
  fecha          DATE NOT NULL,
  tipo           TEXT NOT NULL,             -- ingreso | muerte | venta
  cantidad       INTEGER NOT NULL,          -- número de animales
  peso_promedio  NUMERIC(10,2),             -- kg/animal (entrada en ingresos, salida en ventas)
  peso_total     NUMERIC(12,2),             -- kg totales del movimiento (opcional)
  costo_lechon   NUMERIC(14,2),             -- costo por animal (solo ingresos)
  valor_venta    NUMERIC(14,2),             -- valor total de la venta (solo ventas)
  causa          TEXT,                       -- causa de muerte, comprador, etc.
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mov_ceba_granja ON movimientos_ceba(granja_id);
CREATE INDEX IF NOT EXISTS idx_mov_ceba_fecha ON movimientos_ceba(fecha);

-- ---------- CONSUMO DE ALIMENTO DE CEBA ----------
CREATE TABLE IF NOT EXISTS consumo_ceba (
  id             SERIAL PRIMARY KEY,
  granja_id      INTEGER NOT NULL REFERENCES granjas_ceba(id),
  fecha          DATE NOT NULL,
  bultos         NUMERIC(10,2) NOT NULL,     -- bultos consumidos (40 kg c/u)
  costo_bulto    NUMERIC(14,2),
  tipo_alimento  TEXT,                        -- Levante, Finalizador, etc.
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consumo_ceba_granja ON consumo_ceba(granja_id);

-- ---------- LIQUIDACIONES ----------
-- Cierre de un periodo: consolida inventario, consumo y produce indicadores
CREATE TABLE IF NOT EXISTS liquidaciones_ceba (
  id                 SERIAL PRIMARY KEY,
  granja_id          INTEGER NOT NULL REFERENCES granjas_ceba(id),
  fecha_inicio       DATE NOT NULL,
  fecha_fin          DATE NOT NULL,
  peso_promedio_salida NUMERIC(10,2),          -- kg/animal al liquidar
  -- Snapshot de resultados al momento de liquidar (para histórico)
  animales_ingresados  INTEGER,
  animales_muertos     INTEGER,
  animales_vendidos    INTEGER,
  peso_entrada_total   NUMERIC(14,2),
  peso_salida_total    NUMERIC(14,2),
  kg_producidos        NUMERIC(14,2),
  kg_alimento          NUMERIC(14,2),
  conversion           NUMERIC(10,3),
  costo_alimento       NUMERIC(16,2),
  costo_lechones       NUMERIC(16,2),
  costo_total          NUMERIC(16,2),
  costo_por_kg         NUMERIC(14,2),
  observaciones        TEXT,
  usuario_id           INTEGER REFERENCES usuarios(id),
  creada_en            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liq_ceba_granja ON liquidaciones_ceba(granja_id);
