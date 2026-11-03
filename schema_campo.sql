-- ============================================================
--  AgroSoft — App de campo (móvil)
--  Recelos AM/PM para confirmar preñeces + claves de idempotencia
--  (evitan duplicar registros cuando el celular reintenta el envío)
-- ============================================================
CREATE TABLE IF NOT EXISTS recelos (
  id             SERIAL PRIMARY KEY,
  cerda_id       INTEGER NOT NULL REFERENCES cerdas(id),
  servicio_id    INTEGER REFERENCES servicios(id),
  fecha          DATE NOT NULL,
  jornada        TEXT NOT NULL CHECK (jornada IN ('AM','PM')),
  resultado      TEXT NOT NULL CHECK (resultado IN ('en_celo','sin_celo')),
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cerda_id, fecha, jornada)
);
CREATE INDEX IF NOT EXISTS idx_recelos_cerda ON recelos(cerda_id);
CREATE INDEX IF NOT EXISTS idx_recelos_fecha ON recelos(fecha);

CREATE TABLE IF NOT EXISTS claves_idempotencia (
  clave        TEXT PRIMARY KEY,
  usuario_id   INTEGER,
  status       INTEGER,
  respuesta    JSONB,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- MORTALIDAD EN LACTANCIA ----------
-- Lechones que mueren mientras la hembra amamanta (después del parto, antes del destete).
CREATE TABLE IF NOT EXISTS mortalidad_lactancia (
  id             SERIAL PRIMARY KEY,
  cerda_id       INTEGER NOT NULL REFERENCES cerdas(id),
  parto_id       INTEGER NOT NULL REFERENCES partos(id),
  fecha          DATE NOT NULL,
  cantidad       INTEGER NOT NULL CHECK (cantidad > 0),
  causa          TEXT,                              -- aplastados, diarrea, bajo peso, etc.
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mort_lact_parto ON mortalidad_lactancia(parto_id);
CREATE INDEX IF NOT EXISTS idx_mort_lact_fecha ON mortalidad_lactancia(fecha);

-- ---------- PESAJES ----------
-- tipo 'hembra': una cerda (reemplazos, gestantes…). tipo 'lote': muestra de un lote de ceba.
CREATE TABLE IF NOT EXISTS pesajes (
  id             SERIAL PRIMARY KEY,
  tipo           TEXT NOT NULL CHECK (tipo IN ('hembra','lote')),
  cerda_id       INTEGER REFERENCES cerdas(id),
  lote_id        INTEGER REFERENCES lotes_destete(id),
  fecha          DATE NOT NULL,
  cantidad       INTEGER NOT NULL DEFAULT 1 CHECK (cantidad > 0),   -- animales pesados
  peso_total     NUMERIC(10,2) NOT NULL CHECK (peso_total > 0),     -- kg de todos los pesados
  peso_promedio  NUMERIC(8,2)  NOT NULL,                             -- kg por animal
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pesajes_cerda ON pesajes(cerda_id);
CREATE INDEX IF NOT EXISTS idx_pesajes_lote  ON pesajes(lote_id);
