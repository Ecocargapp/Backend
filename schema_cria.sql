-- ============================================================
--  AgroSoft — Módulo GRANJA DE CRÍA (porcina)
--  Ciclo reproductivo con control individual por cerda
--  Inspirado en el flujo de Agriness S4
-- ============================================================

-- ---------- RAZAS / LÍNEAS GENÉTICAS ----------
CREATE TABLE IF NOT EXISTS razas (
  id        SERIAL PRIMARY KEY,
  nombre    TEXT NOT NULL UNIQUE,      -- Camborough, Franpabel, etc.
  activo    BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- CERDAS (la ficha de cada hembra reproductora) ----------
CREATE TABLE IF NOT EXISTS cerdas (
  id                SERIAL PRIMARY KEY,
  arete             TEXT NOT NULL UNIQUE,        -- ID primaria (número/arete único)
  arete_secundario  TEXT,                        -- ID secundaria opcional
  raza_id           INTEGER REFERENCES razas(id),
  fecha_nacimiento  DATE,
  fecha_ingreso     DATE NOT NULL DEFAULT CURRENT_DATE,  -- entrada a la granja
  origen            TEXT NOT NULL DEFAULT 'compra',  -- compra | reposicion_interna | nacida
  -- Estado reproductivo actual (se actualiza con cada evento):
  --   reemplazo | vacia | servida | gestante | lactante | descartada | muerta | vendida
  estado            TEXT NOT NULL DEFAULT 'reemplazo',
  ciclo_actual      INTEGER NOT NULL DEFAULT 0,   -- número de partos que lleva
  ubicacion         TEXT,                          -- corral / galpón
  -- Datos de ingreso (si fue comprada):
  valor_compra      NUMERIC(14,2),
  peso_ingreso      NUMERIC(8,2),
  proveedor         TEXT,
  observaciones     TEXT,
  activo            BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE cuando sale del hato
  creada_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cerdas_estado ON cerdas(estado);
CREATE INDEX IF NOT EXISTS idx_cerdas_activo ON cerdas(activo);

-- ---------- SERVICIOS / INSEMINACIONES ----------
CREATE TABLE IF NOT EXISTS servicios (
  id              SERIAL PRIMARY KEY,
  cerda_id        INTEGER NOT NULL REFERENCES cerdas(id),
  ciclo           INTEGER NOT NULL,               -- a qué ciclo pertenece
  fecha_servicio  DATE NOT NULL,
  tipo            TEXT NOT NULL DEFAULT 'IA',      -- IA | monta
  verraco         TEXT,                            -- identificación del semen/verraco
  dosis           INTEGER,                         -- nº de dosis aplicadas
  operario        TEXT,                            -- quién insemina
  -- Fecha probable de parto = fecha_servicio + 114 días (se calcula en la app)
  observaciones   TEXT,
  usuario_id      INTEGER REFERENCES usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_serv_cerda ON servicios(cerda_id);
CREATE INDEX IF NOT EXISTS idx_serv_fecha ON servicios(fecha_servicio);

-- ---------- DIAGNÓSTICOS DE PREÑEZ ----------
CREATE TABLE IF NOT EXISTS diagnosticos (
  id             SERIAL PRIMARY KEY,
  servicio_id    INTEGER REFERENCES servicios(id),
  cerda_id       INTEGER NOT NULL REFERENCES cerdas(id),
  fecha          DATE NOT NULL,
  resultado      TEXT NOT NULL,                    -- positivo | negativo | dudoso
  metodo         TEXT,                             -- ecografia | retorno_celo | otro
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- PARTOS ----------
CREATE TABLE IF NOT EXISTS partos (
  id                  SERIAL PRIMARY KEY,
  cerda_id            INTEGER NOT NULL REFERENCES cerdas(id),
  servicio_id         INTEGER REFERENCES servicios(id),
  ciclo               INTEGER NOT NULL,
  fecha_parto         DATE NOT NULL,
  nacidos_vivos       INTEGER NOT NULL DEFAULT 0,
  nacidos_muertos     INTEGER NOT NULL DEFAULT 0,
  momificados         INTEGER NOT NULL DEFAULT 0,
  lechones_totales    INTEGER GENERATED ALWAYS AS
                        (nacidos_vivos + nacidos_muertos + momificados) STORED,
  peso_camada         NUMERIC(8,2),                -- peso total de la camada al nacer
  observaciones       TEXT,
  usuario_id          INTEGER REFERENCES usuarios(id),
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partos_cerda ON partos(cerda_id);
CREATE INDEX IF NOT EXISTS idx_partos_fecha ON partos(fecha_parto);

-- ---------- DESTETES ----------
CREATE TABLE IF NOT EXISTS destetes (
  id                 SERIAL PRIMARY KEY,
  parto_id           INTEGER NOT NULL REFERENCES partos(id),
  cerda_id           INTEGER NOT NULL REFERENCES cerdas(id),
  ciclo              INTEGER NOT NULL,
  fecha_destete      DATE NOT NULL,
  lechones_destetados INTEGER NOT NULL DEFAULT 0,
  peso_camada        NUMERIC(8,2),                 -- peso total al destete
  observaciones      TEXT,
  usuario_id         INTEGER REFERENCES usuarios(id),
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- SALIDAS (muerte, descarte, venta de la cerda) ----------
CREATE TABLE IF NOT EXISTS salidas_cerda (
  id             SERIAL PRIMARY KEY,
  cerda_id       INTEGER NOT NULL REFERENCES cerdas(id),
  fecha          DATE NOT NULL,
  tipo           TEXT NOT NULL,                    -- muerte | descarte | venta
  causa          TEXT,
  valor_venta    NUMERIC(14,2),                    -- solo si es venta
  peso           NUMERIC(8,2),
  comprador      TEXT,
  observaciones  TEXT,
  usuario_id     INTEGER REFERENCES usuarios(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
