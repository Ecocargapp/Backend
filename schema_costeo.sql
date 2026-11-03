-- ============================================================
--  AgroSoft — Consumo diario de la granja y costeo por banda
--  Gestación: prorrateada automáticamente por hembras/día
--  Lactancia: consumo real ingresado por banda
-- ============================================================

-- ---------- CONSUMO DIARIO DE LA GRANJA ----------
-- Un registro por día: bultos totales de gestación y de lactancia
-- que consumió TODA la granja ese día, con su costo por bulto.
CREATE TABLE IF NOT EXISTS consumo_diario (
  id                     SERIAL PRIMARY KEY,
  fecha                  DATE NOT NULL UNIQUE,       -- un registro por día
  bultos_gestacion       NUMERIC(12,3) NOT NULL DEFAULT 0,
  costo_bulto_gestacion  NUMERIC(14,2),
  bultos_lactancia       NUMERIC(12,3) NOT NULL DEFAULT 0,
  costo_bulto_lactancia  NUMERIC(14,2),
  observaciones          TEXT,
  usuario_id             INTEGER REFERENCES usuarios(id),
  creado_en              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consumo_diario_fecha ON consumo_diario(fecha);

-- ---------- CONSUMO DE LACTANCIA POR BANDA (real, manual) ----------
-- Bultos reales que consumió una banda durante su lactancia.
CREATE TABLE IF NOT EXISTS lactancia_banda (
  id             SERIAL PRIMARY KEY,
  banda_id       INTEGER NOT NULL REFERENCES bandas(id),
  fecha          DATE NOT NULL,
  bultos         NUMERIC(12,3) NOT NULL,
  costo_bulto    NUMERIC(14,2),
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lactancia_banda ON lactancia_banda(banda_id);

-- ---------- FECHAS DE CICLO A NIVEL DE CERDA (para el prorrateo) ----------
-- Guardamos en la cerda las fechas de su ciclo actual, para poder saber
-- día a día en qué fase estaba (gestación / lactancia).
-- Estas se llenan con los eventos (servicio, parto, destete) o con la
-- importación de fechas históricas desde Agriness.
ALTER TABLE cerdas ADD COLUMN IF NOT EXISTS fecha_ultimo_servicio DATE;
ALTER TABLE cerdas ADD COLUMN IF NOT EXISTS fecha_ultimo_parto    DATE;
ALTER TABLE cerdas ADD COLUMN IF NOT EXISTS fecha_ultimo_destete  DATE;

-- Fechas de la banda para delimitar su corte (servicio → destete)
ALTER TABLE bandas ADD COLUMN IF NOT EXISTS fecha_destete DATE;
