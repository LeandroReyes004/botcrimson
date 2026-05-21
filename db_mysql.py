# ============================================================
#  db_mysql.py — Módulo de conexión MySQL para CrimsonBot
#  Reemplaza el database_crimson.json y las llamadas a Sheets
#  Coloca este archivo en la raíz del bot (junto a main.py)
# ============================================================

import pymysql
import pymysql.cursors
import logging
import os
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)


def get_conn():
    """Abre y devuelve una conexión MySQL leyendo vars del entorno en cada llamada."""
    return pymysql.connect(
        host=os.getenv("DB_HOST"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASS"),
        database=os.getenv("DB_NAME"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
        connect_timeout=10,
    )


def _exec(sql, params=(), fetch="none"):
    """Ejecuta SQL y opcionalmente devuelve filas. fetch: 'one'|'all'|'none'"""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if fetch == "one":
                result = cur.fetchone()
            elif fetch == "all":
                result = cur.fetchall()
            else:
                result = cur.lastrowid
        conn.commit()
        return result
    except Exception as e:
        conn.rollback()
        log.error(f"[DB] Error: {e} | SQL: {sql[:80]}")
        raise
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════
#  CONFIG BOT
# ══════════════════════════════════════════════════════════════

def config_get(clave, default=None):
    row = _exec("SELECT valor FROM config_bot WHERE clave=%s", (clave,), fetch="one")
    return row["valor"] if row else default

def config_set(clave, valor):
    _exec(
        "INSERT INTO config_bot (clave, valor) VALUES (%s,%s) "
        "ON DUPLICATE KEY UPDATE valor=VALUES(valor)",
        (clave, str(valor))
    )


# ══════════════════════════════════════════════════════════════
#  STAFF DISCORD
# ══════════════════════════════════════════════════════════════

def staff_registrar(discord_id: int, usuario_form, nombre_display: str, rol: str = None):
    """
    Vincula o actualiza un miembro de Discord.
    Si usuario_form es None, solo actualiza nombre_display sin pisar el apodo existente.
    Si rol es None, no pisa el rol existente.
    """
    if usuario_form is not None:
        uf = usuario_form.lower().strip()
        if rol:
            _exec(
                "INSERT INTO staff_discord (discord_id, usuario_form, nombre_display, rol) "
                "VALUES (%s, %s, %s, %s) "
                "ON DUPLICATE KEY UPDATE usuario_form=%s, nombre_display=%s, rol=%s",
                (discord_id, uf, nombre_display, rol, uf, nombre_display, rol)
            )
        else:
            _exec(
                "INSERT INTO staff_discord (discord_id, usuario_form, nombre_display) "
                "VALUES (%s, %s, %s) "
                "ON DUPLICATE KEY UPDATE usuario_form=%s, nombre_display=%s",
                (discord_id, uf, nombre_display, uf, nombre_display)
            )
    else:
        if rol:
            _exec(
                "INSERT INTO staff_discord (discord_id, nombre_display, rol) "
                "VALUES (%s, %s, %s) "
                "ON DUPLICATE KEY UPDATE nombre_display=%s, rol=%s",
                (discord_id, nombre_display, rol, nombre_display, rol)
            )
        else:
            _exec(
                "INSERT INTO staff_discord (discord_id, nombre_display) "
                "VALUES (%s, %s) "
                "ON DUPLICATE KEY UPDATE nombre_display=%s",
                (discord_id, nombre_display, nombre_display)
            )

def staff_get_by_form(usuario_form: str):
    return _exec(
        "SELECT * FROM staff_discord WHERE usuario_form=%s",
        (usuario_form.lower().strip(),), fetch="one"
    )

def staff_get_by_id(discord_id: int):
    return _exec(
        "SELECT * FROM staff_discord WHERE discord_id=%s",
        (discord_id,), fetch="one"
    )

def staff_listar():
    return _exec(
        "SELECT discord_id, usuario_form, nombre_display, activo FROM staff_discord ORDER BY nombre_display",
        fetch="all"
    )

def staff_toggle(discord_id: int, activo: int):
    _exec("UPDATE staff_discord SET activo=%s WHERE discord_id=%s", (activo, discord_id))


# ══════════════════════════════════════════════════════════════
#  PROYECTOS
# ══════════════════════════════════════════════════════════════

def proyecto_crear(nombre: str, carpeta_drive_id: str = None):
    _exec(
        "INSERT IGNORE INTO proyectos (nombre, nombre_upper, carpeta_drive_id) "
        "VALUES (%s, %s, %s)",
        (nombre.strip(), nombre.strip().upper(), carpeta_drive_id)
    )

def proyecto_listar(solo_activos=True):
    if solo_activos:
        return _exec(
            "SELECT * FROM proyectos WHERE estado='activo' ORDER BY nombre", fetch="all"
        )
    return _exec("SELECT * FROM proyectos ORDER BY nombre", fetch="all")

def proyecto_get(nombre: str):
    return _exec(
        "SELECT * FROM proyectos WHERE nombre_upper=%s",
        (nombre.strip().upper(),), fetch="one"
    )

def proyecto_cambiar_estado(nombre: str, estado: str):
    _exec(
        "UPDATE proyectos SET estado=%s WHERE nombre_upper=%s",
        (estado, nombre.strip().upper())
    )


# ══════════════════════════════════════════════════════════════
#  CAPÍTULOS
# ══════════════════════════════════════════════════════════════

def capitulo_crear_o_obtener(obra: str, cap_numero: str) -> int:
    """Crea proyecto+capítulo si no existen; devuelve el id del capítulo."""
    proyecto = _exec(
        "SELECT id FROM proyectos WHERE nombre_upper=%s",
        (obra.upper(),), fetch="one"
    )
    if not proyecto:
        _exec(
            "INSERT IGNORE INTO proyectos (nombre, nombre_upper) VALUES (%s,%s)",
            (obra, obra.upper())
        )
        proyecto = _exec(
            "SELECT id FROM proyectos WHERE nombre_upper=%s",
            (obra.upper(),), fetch="one"
        )

    proyecto_id = proyecto["id"]

    cap = _exec(
        "SELECT id FROM capitulos WHERE proyecto_id=%s AND numero=%s",
        (proyecto_id, str(cap_numero)), fetch="one"
    )
    if cap:
        return cap["id"]

    _exec(
        "INSERT IGNORE INTO capitulos (proyecto_id, numero, estado) VALUES (%s,%s,'Pendiente')",
        (proyecto_id, str(cap_numero))
    )
    return _exec(
        "SELECT id FROM capitulos WHERE proyecto_id=%s AND numero=%s",
        (proyecto_id, str(cap_numero)), fetch="one"
    )["id"]



def cap_importar(nombre_proyecto: str, numeros: list):
    """Importa una lista de números de capítulo a un proyecto."""
    proy = proyecto_get(nombre_proyecto)
    if not proy:
        return 0, "Proyecto no encontrado"
    conn = get_conn()
    agregados = 0
    try:
        with conn.cursor() as cur:
            for num in numeros:
                cur.execute(
                    "INSERT IGNORE INTO capitulos (proyecto_id, numero) VALUES (%s, %s)",
                    (proy["id"], str(num))
                )
                if cur.rowcount:
                    agregados += 1
        conn.commit()
    except Exception as e:
        conn.rollback()
        return 0, str(e)
    finally:
        conn.close()
    return agregados, None

def cap_listar_pendientes(nombre_proyecto: str):
    proy = proyecto_get(nombre_proyecto)
    if not proy:
        return []
    return _exec(
        "SELECT * FROM capitulos WHERE proyecto_id=%s AND estado='Pendiente' ORDER BY CAST(numero AS UNSIGNED)",
        (proy["id"],), fetch="all"
    )

def cap_marcar_etapa(nombre_proyecto: str, numero: str, etapa: str):
    """Marca una etapa (traduccion, limpieza, typer, proof) como completada."""
    proy = proyecto_get(nombre_proyecto)
    if not proy:
        return
    etapas_validas = {"traduccion", "limpieza", "typer", "proof"}
    if etapa not in etapas_validas:
        return
    _exec(
        f"UPDATE capitulos SET {etapa}=1 WHERE proyecto_id=%s AND numero=%s",
        (proy["id"], numero)
    )
    # Si todas las etapas están completas, marcar como Terminado
    _exec(
        "UPDATE capitulos SET estado='Terminado' "
        "WHERE proyecto_id=%s AND numero=%s "
        "AND traduccion=1 AND limpieza=1 AND typer=1 AND proof=1",
        (proy["id"], numero)
    )

def cap_get(nombre_proyecto: str, numero: str):
    proy = proyecto_get(nombre_proyecto)
    if not proy:
        return None
    return _exec(
        "SELECT * FROM capitulos WHERE proyecto_id=%s AND numero=%s",
        (proy["id"], numero), fetch="one"
    )


# ══════════════════════════════════════════════════════════════
#  TAREAS
# ══════════════════════════════════════════════════════════════

def tarea_crear(tarea_id: str, discord_id: int, obra: str, cap: str,
                rol: str, limite: datetime, canal_id: int = None):
    capitulo_id = capitulo_crear_o_obtener(obra, cap)
    _exec(
        "INSERT INTO tareas (id, discord_id, capitulo_id, obra, cap, rol, limite, canal_id) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (tarea_id, discord_id, capitulo_id, obra, cap, rol, limite, canal_id)
    )

def tarea_completar(tarea_id: str):
    """Marca tarea como entregada y suma punto al expediente del mes."""
    tarea = tarea_get(tarea_id)
    if not tarea:
        return None
    _exec(
        "UPDATE tareas SET estado='entregada' WHERE id=%s",
        (tarea_id,)
    )
    # Sumar punto al ranking del mes
    ahora = datetime.now()
    _exec(
        "INSERT INTO expedientes (discord_id, puntos, mes, anio) VALUES (%s,1,%s,%s) "
        "ON DUPLICATE KEY UPDATE puntos=puntos+1",
        (tarea["discord_id"], ahora.month, ahora.year)
    )
    # Marcar etapa del capítulo si existe
    if tarea.get("capitulo_id"):
        etapa_map = {
            "Traductor":   ("traduccion", "trad_fecha"),
            "Cleaner":     ("limpieza",   "clean_fecha"),
            "Typer":       ("typer",      "type_fecha"),
            "Proofreader": ("proof",      "proof_fecha"),
        }
        campos = etapa_map.get(tarea["rol"])
        if campos:
            campo_bool, campo_fecha = campos
            _exec(
                f"UPDATE capitulos SET {campo_bool}=1, {campo_fecha}=NOW() WHERE id=%s",
                (tarea["capitulo_id"],)
            )
            # Si todas las etapas tienen fecha, marcar capítulo como Terminado
            cap = _exec(
                "SELECT trad_fecha, clean_fecha, type_fecha, proof_fecha "
                "FROM capitulos WHERE id=%s",
                (tarea["capitulo_id"],), fetch="one"
            )
            if cap and all(cap[f] for f in ("trad_fecha", "clean_fecha", "type_fecha", "proof_fecha")):
                _exec(
                    "UPDATE capitulos SET estado='Terminado' WHERE id=%s",
                    (tarea["capitulo_id"],)
                )
    puntos = _exec(
        "SELECT puntos FROM expedientes WHERE discord_id=%s AND mes=%s AND anio=%s",
        (tarea["discord_id"], ahora.month, ahora.year), fetch="one"
    )
    return puntos["puntos"] if puntos else 1

def tarea_cancelar(tarea_id: str):
    _exec("UPDATE tareas SET estado='cancelada' WHERE id=%s", (tarea_id,))

def tarea_get(tarea_id: str):
    return _exec("SELECT * FROM tareas WHERE id=%s", (tarea_id,), fetch="one")

def tarea_get_por_usuario(discord_id: int):
    return _exec(
        "SELECT * FROM tareas WHERE discord_id=%s AND estado='activa' ORDER BY limite ASC",
        (discord_id,), fetch="all"
    )

def tarea_get_todas_activas():
    return _exec(
        "SELECT t.*, sd.nombre_display FROM tareas t "
        "JOIN staff_discord sd ON sd.discord_id=t.discord_id "
        "WHERE t.estado='activa' ORDER BY t.limite ASC",
        fetch="all"
    )

def tarea_extender(tarea_id: str, dias: int):
    _exec(
        "UPDATE tareas SET limite = DATE_ADD(limite, INTERVAL %s DAY) WHERE id=%s",
        (dias, tarea_id)
    )

def tarea_get_por_usuario_y_obra(discord_id: int, obra: str, cap: str = None):
    """Busca tarea activa de un usuario en una obra (y opcionalmente capítulo)."""
    if cap:
        return _exec(
            "SELECT * FROM tareas WHERE discord_id=%s AND obra=%s AND cap=%s AND estado='activa' LIMIT 1",
            (discord_id, obra.upper(), cap), fetch="one"
        )
    return _exec(
        "SELECT * FROM tareas WHERE discord_id=%s AND obra=%s AND estado='activa' LIMIT 1",
        (discord_id, obra.upper()), fetch="one"
    )

def tarea_urgentes(horas=24):
    return _exec(
        "SELECT t.*, sd.nombre_display FROM tareas t "
        "JOIN staff_discord sd ON sd.discord_id=t.discord_id "
        "WHERE t.estado='activa' AND t.limite <= DATE_ADD(NOW(), INTERVAL %s HOUR) "
        "ORDER BY t.limite ASC",
        (horas,), fetch="all"
    )


# ══════════════════════════════════════════════════════════════
#  RANKING / EXPEDIENTES
# ══════════════════════════════════════════════════════════════

def ranking_mes(mes=None, anio=None):
    ahora = datetime.now()
    mes   = mes  or ahora.month
    anio  = anio or ahora.year
    return _exec(
        "SELECT sd.discord_id, sd.nombre_display, COALESCE(e.puntos,0) as puntos "
        "FROM staff_discord sd "
        "LEFT JOIN expedientes e ON e.discord_id=sd.discord_id AND e.mes=%s AND e.anio=%s "
        "WHERE sd.activo=1 "
        "ORDER BY puntos DESC LIMIT 10",
        (mes, anio), fetch="all"
    )

def ranking_resetear():
    ahora = datetime.now()
    # No borramos — los puntos históricos quedan. Solo actualizamos mes_actual en config.
    config_set("mes_actual", ahora.month)

def puntos_get(discord_id: int):
    ahora = datetime.now()
    row = _exec(
        "SELECT puntos FROM expedientes WHERE discord_id=%s AND mes=%s AND anio=%s",
        (discord_id, ahora.month, ahora.year), fetch="one"
    )
    return row["puntos"] if row else 0


# ══════════════════════════════════════════════════════════════
#  ERRORES / EXPEDIENTE DISCIPLINARIO
# ══════════════════════════════════════════════════════════════

def error_registrar(discord_id: int, descripcion: str, reportado_por: int = None):
    _exec(
        "INSERT INTO errores_hist (discord_id, error, reportado_por) VALUES (%s,%s,%s)",
        (discord_id, descripcion, reportado_por)
    )

def errores_get(discord_id: int, limite=15):
    return _exec(
        "SELECT fecha, error FROM errores_hist WHERE discord_id=%s ORDER BY fecha DESC LIMIT %s",
        (discord_id, limite), fetch="all"
    )


# ══════════════════════════════════════════════════════════════
#  FORMULARIOS PROCESADOS
# ══════════════════════════════════════════════════════════════

def formulario_ya_procesado(timestamp_str: str) -> bool:
    row = _exec(
        "SELECT 1 FROM formularios_procesados WHERE timestamp_form=%s",
        (timestamp_str,), fetch="one"
    )
    return row is not None

def formulario_marcar(timestamp_str: str):
    _exec(
        "INSERT IGNORE INTO formularios_procesados (timestamp_form) VALUES (%s)",
        (timestamp_str,)
    )

def formularios_marcar_todos(lista: list):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for ts in lista:
                cur.execute(
                    "INSERT IGNORE INTO formularios_procesados (timestamp_form) VALUES (%s)",
                    (ts,)
                )
        conn.commit()
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════
#  ESTADÍSTICAS GLOBALES
# ══════════════════════════════════════════════════════════════

def estadisticas_globales():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) as total FROM tareas")
            total_asig = cur.fetchone()["total"]
            cur.execute("SELECT COUNT(*) as total FROM tareas WHERE estado='entregada'")
            total_entre = cur.fetchone()["total"]
            cur.execute("SELECT COUNT(*) as total FROM tareas WHERE estado='activa' AND limite < NOW()")
            total_retra = cur.fetchone()["total"]
            cur.execute("SELECT COUNT(*) as total FROM tareas WHERE estado='activa' AND limite >= NOW()")
            total_pend  = cur.fetchone()["total"]
            cur.execute("SELECT COUNT(*) as total FROM tareas WHERE estado='activa'")
            tareas_activas = cur.fetchone()["total"]
            cur.execute(
                "SELECT COUNT(*) as total FROM tareas WHERE estado='activa' "
                "AND limite <= DATE_ADD(NOW(), INTERVAL 24 HOUR)"
            )
            urgentes_24h = cur.fetchone()["total"]
        return {
            "total_asig":    total_asig,
            "total_entre":   total_entre,
            "total_retra":   total_retra,
            "total_pend":    total_pend,
            "tareas_activas":tareas_activas,
            "urgentes_24h":  urgentes_24h,
        }
    finally:
        conn.close()
