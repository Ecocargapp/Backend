-- ============================================================
--  AgroSoft — Módulo de TAREAS Y VACUNACIÓN
--  Calendario de tareas de operarios según estado reproductivo
-- ============================================================

-- ---------- CATÁLOGO DE TAREAS ----------
-- Cada tarea se define por: tipo de animal + evento de referencia + días.
-- El sistema calcula la fecha en que le toca a cada animal.
CREATE TABLE IF NOT EXISTS tareas_catalogo (
  id             SERIAL PRIMARY KEY,
  tipo_tarea     TEXT NOT NULL,              -- Sanidad | Operacional
  tarea          TEXT NOT NULL,              -- "Vacuna - Micoflex", "CHEQUEO 30 DIAS", etc.
  tipo_animal    TEXT NOT NULL,              -- Reemplazo | Gestante | Madre | Lechones | Ceba
  -- Evento desde el que se cuentan los días:
  --   nacimiento | servicio | parto | destete
  evento_ref     TEXT NOT NULL,
  dias           INTEGER NOT NULL,           -- días después del evento
  cantidad       TEXT,                        -- dosis (puede ser "1", "10 ml", "-")
  observacion    TEXT,
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  creada_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tareas_animal ON tareas_catalogo(tipo_animal);
CREATE INDEX IF NOT EXISTS idx_tareas_evento ON tareas_catalogo(evento_ref);

-- ---------- REGISTRO DE TAREAS APLICADAS ----------
-- Cuando el operario marca una tarea como hecha, se registra aquí.
CREATE TABLE IF NOT EXISTS tareas_aplicadas (
  id             SERIAL PRIMARY KEY,
  tarea_id       INTEGER REFERENCES tareas_catalogo(id),
  cerda_id       INTEGER REFERENCES cerdas(id),   -- para tareas de reproductoras
  identificacion TEXT,                             -- para lechones/ceba (arete o lote)
  fecha_programada DATE,
  fecha_aplicada DATE NOT NULL DEFAULT CURRENT_DATE,
  operario       TEXT,
  observacion    TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creada_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aplicadas_cerda ON tareas_aplicadas(cerda_id);
CREATE INDEX IF NOT EXISTS idx_aplicadas_fecha ON tareas_aplicadas(fecha_aplicada);
