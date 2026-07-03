-- ============================================================
--  CRIMSON SCAN — Esquema MySQL Unificado
--  Servidor: VPS propio
--  Cubre: Panel Web (PHP) + Bot Discord (Python)
-- ============================================================

CREATE DATABASE IF NOT EXISTS crimson_scan
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE crimson_scan;

-- ─────────────────────────────────────────────
--  1. USUARIOS DEL PANEL WEB (ya existe, extendida)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    usuario         VARCHAR(50)  NOT NULL UNIQUE,
    password        VARCHAR(255) NOT NULL,
    rol             ENUM('admin','staff') DEFAULT 'staff',
    activo          TINYINT(1)   DEFAULT 1,
    intentos        INT          DEFAULT 0,
    bloqueado_hasta DATETIME     NULL,
    creado          DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  2. STAFF DISCORD (miembros del equipo)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_discord (
    discord_id      BIGINT       PRIMARY KEY,           -- ID numérico de Discord
    usuario_form    VARCHAR(80)  NULL,                  -- nombre que usan en el formulario
    nombre_display  VARCHAR(150) NULL,                  -- nickname en Discord
    rol             VARCHAR(100) NULL,
    activo          TINYINT(1)   DEFAULT 1,
    hiatus_hasta    DATETIME     NULL,
    creado          DATETIME     DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_usuario_form (usuario_form)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  3. PROYECTOS (series/mangas)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proyectos (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    nombre          VARCHAR(150) NOT NULL UNIQUE,
    nombre_upper    VARCHAR(150) NOT NULL,              -- guardado en MAYÚSCULAS para búsquedas
    estado          ENUM('activo','pausado','terminado') DEFAULT 'activo',
    carpeta_drive_id VARCHAR(100) NULL,                 -- ID de la carpeta raíz en Drive
    creado          DATETIME     DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_nombre_upper (nombre_upper)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  4. CAPÍTULOS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capitulos (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id     INT          NOT NULL,
    numero          VARCHAR(20)  NOT NULL,              -- "1", "12", "12.5"
    traduccion      TINYINT(1)   DEFAULT 0,
    limpieza        TINYINT(1)   DEFAULT 0,
    typer           TINYINT(1)   DEFAULT 0,
    proof           TINYINT(1)   DEFAULT 0,
    estado          ENUM('Pendiente','En proceso','Terminado') DEFAULT 'Pendiente',
    creado          DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
    UNIQUE KEY uq_cap (proyecto_id, numero)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  5. TAREAS (asignaciones activas del bot)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tareas (
    id              VARCHAR(30)  PRIMARY KEY,           -- ej. T-1775083273
    discord_id      BIGINT       NOT NULL,
    capitulo_id     INT          NULL,                  -- FK a capitulos (puede ser NULL si el cap no está importado)
    obra            VARCHAR(150) NOT NULL,              -- nombre del proyecto
    cap             VARCHAR(20)  NOT NULL,              -- número del capítulo
    rol             VARCHAR(40)  NOT NULL,              -- Traductor, Cleaner, Typer, Proofreader
    limite          DATETIME     NOT NULL,
    canal_id        BIGINT       NULL,                  -- ID del canal de Discord donde se asignó
    estado          ENUM('activa','entregada','cancelada') DEFAULT 'activa',
    creado          DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (discord_id) REFERENCES staff_discord(discord_id) ON UPDATE CASCADE,
    FOREIGN KEY (capitulo_id) REFERENCES capitulos(id) ON DELETE SET NULL,
    INDEX idx_estado (estado),
    INDEX idx_discord (discord_id),
    INDEX idx_limite (limite)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  6. EXPEDIENTES / RANKING (puntos por mes)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expedientes (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    discord_id      BIGINT       NOT NULL,
    puntos          INT          DEFAULT 0,
    mes             TINYINT      NOT NULL,              -- 1-12
    anio            YEAR         NOT NULL,
    FOREIGN KEY (discord_id) REFERENCES staff_discord(discord_id) ON UPDATE CASCADE,
    UNIQUE KEY uq_exp (discord_id, mes, anio),
    INDEX idx_mes_anio (mes, anio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  7. HISTORIAL DE ERRORES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS errores_hist (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    discord_id      BIGINT       NOT NULL,
    error           TEXT         NOT NULL,
    reportado_por   BIGINT       NULL,                  -- Discord ID del admin que reportó
    fecha           DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (discord_id) REFERENCES staff_discord(discord_id) ON UPDATE CASCADE,
    INDEX idx_discord (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  8. CORRECCIONES (reportes de calidad)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS correcciones (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    discord_id      BIGINT       NOT NULL,
    tarea_id        VARCHAR(30)  NULL,
    descripcion     TEXT         NOT NULL,
    estado          ENUM('pendiente','resuelta') DEFAULT 'pendiente',
    fecha           DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (discord_id) REFERENCES staff_discord(discord_id) ON UPDATE CASCADE,
    FOREIGN KEY (tarea_id)   REFERENCES tareas(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  9. FORMULARIOS PROCESADOS (evitar duplicados)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS formularios_procesados (
    timestamp_form  VARCHAR(30) PRIMARY KEY            -- "15/03/2026 18:01:21"
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────
--  10. CONFIGURACIÓN DEL BOT
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_bot (
    clave           VARCHAR(60)  PRIMARY KEY,
    valor           TEXT         NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Valores iniciales
INSERT IGNORE INTO config_bot (clave, valor) VALUES
    ('canal_alertas',       '0'),
    ('canal_anuncios',      '0'),
    ('rol_staff',           '0'),
    ('mes_actual',          MONTH(NOW())),
    ('ultimo_recordatorio', CURDATE());

-- ─────────────────────────────────────────────
--  USUARIO ADMIN INICIAL DEL PANEL WEB
--  Contraseña: crimson2026  (cambiar en primer login)
-- ─────────────────────────────────────────────
INSERT IGNORE INTO usuarios (usuario, password, rol)
VALUES ('admin', '$2y$12$placeholder_hash_change_on_first_run', 'admin');

-- ─────────────────────────────────────────────
--  VISTAS ÚTILES
-- ─────────────────────────────────────────────

-- Ranking del mes actual
CREATE OR REPLACE VIEW v_ranking_mes AS
SELECT
    sd.discord_id,
    sd.nombre_display,
    sd.usuario_form,
    COALESCE(e.puntos, 0) AS puntos,
    e.mes,
    e.anio
FROM staff_discord sd
LEFT JOIN expedientes e
    ON sd.discord_id = e.discord_id
    AND e.mes  = MONTH(NOW())
    AND e.anio = YEAR(NOW())
WHERE sd.activo = 1
ORDER BY puntos DESC;

-- Resumen de tareas por proyecto
CREATE OR REPLACE VIEW v_resumen_proyectos AS
SELECT
    p.id,
    p.nombre,
    p.estado,
    COUNT(c.id)                                          AS total_capitulos,
    SUM(CASE WHEN c.estado = 'Terminado'  THEN 1 ELSE 0 END) AS terminados,
    SUM(CASE WHEN c.estado = 'Pendiente'  THEN 1 ELSE 0 END) AS pendientes,
    SUM(CASE WHEN c.estado = 'En proceso' THEN 1 ELSE 0 END) AS en_proceso
FROM proyectos p
LEFT JOIN capitulos c ON c.proyecto_id = p.id
GROUP BY p.id, p.nombre, p.estado;

-- Tareas activas con info del staff
CREATE OR REPLACE VIEW v_tareas_activas AS
SELECT
    t.id,
    t.obra,
    t.cap,
    t.rol,
    t.limite,
    t.estado,
    sd.nombre_display,
    sd.discord_id,
    TIMESTAMPDIFF(HOUR, NOW(), t.limite) AS horas_restantes
FROM tareas t
JOIN staff_discord sd ON sd.discord_id = t.discord_id
WHERE t.estado = 'activa'
ORDER BY t.limite ASC;
