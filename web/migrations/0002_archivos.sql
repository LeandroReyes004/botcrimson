-- Archivos de cada capítulo guardados en R2: RAWs y el trabajo de cada rol
CREATE TABLE archivos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  capitulo_id INTEGER NOT NULL REFERENCES capitulos(id) ON DELETE CASCADE,
  etapa       TEXT NOT NULL CHECK (etapa IN ('raw','trad','clean','type')),
  nombre      TEXT NOT NULL,
  clave       TEXT NOT NULL UNIQUE,          -- ruta del objeto en R2
  bytes       INTEGER NOT NULL,
  tipo        TEXT NOT NULL,
  staff_id    INTEGER REFERENCES staff(id),
  creado      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (capitulo_id, etapa, nombre)
);
CREATE INDEX idx_archivos_cap ON archivos(capitulo_id, etapa);

-- 1 = para entregar hay que subir al menos un archivo del trabajo
INSERT OR IGNORE INTO config (clave, valor) VALUES ('exigir_archivos', '1');
