-- ============================================================
--  AgroSoft — Granja de cría: BANDAS y CONSUMO DE ALIMENTO
--  Amplía el módulo de cría para habilitar informes productivos y de costos
-- ============================================================

-- ---------- BANDAS / LOTES ----------
-- Grupos de cerdas que paren juntas en una ventana definida.
CREATE TABLE IF NOT EXISTS bandas (
  id             SERIAL PRIMARY KEY,
  nombre         TEXT NOT NULL UNIQUE,          -- p.ej. "G3 2026-1"
  fecha_servicio DATE,                          -- fecha (o inicio) de servicios de la banda
  fecha_parto    DATE,                          -- fecha probable/real de partos
  observaciones  TEXT,
  activa         BOOLEAN NOT NULL DEFAULT TRUE,
  creada_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relación de cada cerda con su banda (una cerda puede pasar por varias bandas
-- a lo largo de su vida, una por ciclo).
ALTER TABLE cerdas ADD COLUMN IF NOT EXISTS banda_id INTEGER REFERENCES bandas(id);

-- Los partos y servicios pueden referenciar su banda (para agrupar informes).
ALTER TABLE partos    ADD COLUMN IF NOT EXISTS banda_id INTEGER REFERENCES bandas(id);
ALTER TABLE servicios ADD COLUMN IF NOT EXISTS banda_id INTEGER REFERENCES bandas(id);

-- ---------- CONSUMO DE ALIMENTO ----------
-- Registra los bultos de alimento consumidos por fase, con su costo.
-- Esto alimenta los informes de bultos/lactancia, bultos/gestación y costo del lechón.
CREATE TABLE IF NOT EXISTS consumos_alimento (
  id             SERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  fase           TEXT NOT NULL,                 -- gestacion | lactancia | reemplazo | preinicio
  banda_id       INTEGER REFERENCES bandas(id), -- opcional: consumo atribuido a una banda
  tipo_alimento  TEXT,                          -- nombre del concentrado
  bultos         NUMERIC(12,3) NOT NULL,        -- cantidad de bultos
  kg_por_bulto   NUMERIC(8,2) DEFAULT 40,       -- peso de cada bulto (kg)
  costo_bulto    NUMERIC(14,2),                 -- costo unitario del bulto
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consumo_fase ON consumos_alimento(fase);
CREATE INDEX IF NOT EXISTS idx_consumo_fecha ON consumos_alimento(fecha);
CREATE INDEX IF NOT EXISTS idx_consumo_banda ON consumos_alimento(banda_id);
