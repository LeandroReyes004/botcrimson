-- Crimson Scan: esquema D1
-- Fechas en UTC con formato ISO (YYYY-MM-DDTHH:MM:SSZ). Los IDs de Discord se guardan como TEXT
-- porque superan el entero seguro de JavaScript.

CREATE TABLE staff (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario         TEXT UNIQUE COLLATE NOCASE,          -- login del panel (puede ser NULL si solo usa Discord)
  password_hash   TEXT,
  nombre          TEXT NOT NULL,
  discord_id      TEXT UNIQUE,
  nivel           TEXT NOT NULL DEFAULT 'staff' CHECK (nivel IN ('admin','lider','staff')),
  roles           TEXT NOT NULL DEFAULT '',            -- lista separada por comas: trad,clean,type
  activo          INTEGER NOT NULL DEFAULT 1,
  hiatus_hasta    TEXT,
  intentos        INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta TEXT,
  creado          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE sesiones (
  token    TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expira   TEXT NOT NULL
);
CREATE INDEX idx_sesiones_staff ON sesiones(staff_id);

-- Enlaces de un solo uso para crear o recuperar la contraseña (los genera el bot con cd!acceso)
CREATE TABLE accesos (
  token    TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expira   TEXT NOT NULL
);

CREATE TABLE proyectos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  estado  TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado','terminado')),
  creado  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE capitulos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
  numero      TEXT NOT NULL,                 -- "12", "12.5"
  orden       REAL NOT NULL,                 -- número para ordenar bien (12.5 después de 12)
  estado      TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_proceso','listo','publicado')),
  creado      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (proyecto_id, numero)
);
CREATE INDEX idx_capitulos_proyecto ON capitulos(proyecto_id, orden);

CREATE TABLE tareas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  capitulo_id    INTEGER NOT NULL REFERENCES capitulos(id) ON DELETE CASCADE,
  rol            TEXT NOT NULL CHECK (rol IN ('trad','clean','type')),
  staff_id       INTEGER NOT NULL REFERENCES staff(id),
  estado         TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','entregada','cancelada','vencida')),
  limite         TEXT NOT NULL,
  solicitud      TEXT CHECK (solicitud IN ('extension','cancelacion')),
  solicitud_dias INTEGER,
  solicitud_motivo TEXT,
  creado         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  cerrada        TEXT
);
-- Solo puede haber una tarea activa por capítulo y rol (evita que dos personas tomen la misma)
CREATE UNIQUE INDEX uq_tarea_activa ON tareas(capitulo_id, rol) WHERE estado = 'activa';
-- Y solo una entrega por capítulo y rol
CREATE UNIQUE INDEX uq_tarea_entregada ON tareas(capitulo_id, rol) WHERE estado = 'entregada';
CREATE INDEX idx_tareas_staff ON tareas(staff_id, estado);
CREATE INDEX idx_tareas_estado ON tareas(estado, limite);

-- Libro de puntos: cada suma o resta queda registrada con su motivo
CREATE TABLE puntos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  tarea_id INTEGER REFERENCES tareas(id) ON DELETE SET NULL,
  puntos   INTEGER NOT NULL,
  motivo   TEXT NOT NULL,
  fecha    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_puntos_fecha ON puntos(fecha, staff_id);

CREATE TABLE config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
INSERT INTO config (clave, valor) VALUES
  ('dias_limite', '3'),
  ('max_tareas_activas', '5'),
  ('puntos_entrega', '1'),
  ('puntos_vencida', '-1'),
  ('cuota_mensual', '3'),
  ('hora_reporte', '9'),
  ('horas_gracia', '24'),
  ('ultimo_reporte', '');

-- Registro de todo lo que pasa (quién hizo qué)
CREATE TABLE eventos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER,
  accion   TEXT NOT NULL,
  detalle  TEXT,
  fecha    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_eventos_fecha ON eventos(fecha);
