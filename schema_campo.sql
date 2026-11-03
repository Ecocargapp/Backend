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
