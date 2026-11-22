"""
Migra los datos del MySQL viejo de Crimson Scan al D1 nuevo.

Uso (en tu computadora, con acceso al MySQL):
    pip install PyMySQL
    set DB_HOST=... DB_USER=... DB_PASS=... DB_NAME=crimson_scan   (en Linux/Mac: export ...)
    python scripts/migrar_desde_mysql.py > migracion.sql
    npx wrangler d1 execute crimson-db --remote --file=migracion.sql

Las contraseñas viejas NO se migran (eran bcrypt o texto plano). Cada persona crea la suya
con `cd!acceso` en Discord, que le manda un enlace privado de un solo uso.
Las fechas del MySQL se interpretan en la zona TZ_ORIGEN (por defecto la del servidor viejo, UTC).
"""
import os
import sys
import re
from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

ROL_DE_TEXTO = [
    ("trad", ("trad", "t/c", "tl")),
    ("clean", ("clean", "limpia", "t/c", "redraw")),
    ("type", ("type", "typer", "typeset", "edito")),
]


def roles_desde(texto):
    t = (texto or "").lower()
    return ",".join(r for r, claves in ROL_DE_TEXTO if any(c in t for c in claves))


def rol_tarea(texto):
    r = roles_desde(texto).split(",")[0]
    return r or None


def nivel_desde(texto, es_admin_panel):
    t = (texto or "").lower()
    if es_admin_panel or "admin" in t:
        return "admin"
    if "lider" in t or "líder" in t:
        return "lider"
    return "staff"


def a_utc(valor, zona):
    if not valor:
        return None
    if isinstance(valor, str):
        valor = datetime.fromisoformat(valor)
    if valor.tzinfo is None:
        valor = valor.replace(tzinfo=zona)
    return valor.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def q(v):
    """Escapa un valor para SQL."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def usuario_limpio(u):
    u = re.sub(r"[^a-z0-9._-]", "", (u or "").lower())
    return u if len(u) >= 3 else None


def numero_cap(n):
    s = str(n).strip()
    try:
        f = float(s)
        return (str(int(f)) if f.is_integer() else str(f)), f  # "12.50" -> "12.5", igual que el panel
    except ValueError:
        return s, 0.0


def generar_sql(datos, zona=timezone.utc):
    """datos: dict con listas de filas (dicts) de cada tabla vieja. Devuelve el SQL como texto."""
    out = ["-- Migración automática desde MySQL", "PRAGMA foreign_keys = OFF;"]
    staff_id = {}      # discord_id -> id nuevo
    usuarios_vistos = set()
    admins_panel = {u["usuario"].lower() for u in datos.get("usuarios", []) if (u.get("rol") or "") == "admin"}
    sig = 1

    for s in datos.get("staff_discord", []):
        did = str(s["discord_id"])
        if not re.fullmatch(r"\d{15,22}", did) or did in staff_id:
            continue
        usuario = usuario_limpio(s.get("usuario_form"))
        if usuario in usuarios_vistos:
            usuario = None
        if usuario:
            usuarios_vistos.add(usuario)
        nombre = s.get("nombre_display") or s.get("usuario_form") or f"Staff {did[-4:]}"
        nivel = nivel_desde(s.get("rol"), (s.get("usuario_form") or "").lower() in admins_panel)
        hiatus = a_utc(s.get("hiatus_hasta") or s.get("fecha_hiatus"), zona) if (s.get("en_hiatus") or s.get("hiatus_hasta")) else None
        out.append(f"INSERT INTO staff (id, usuario, nombre, discord_id, nivel, roles, activo, hiatus_hasta) VALUES "
                   f"({sig}, {q(usuario)}, {q(nombre)}, {q(did)}, {q(nivel)}, {q(roles_desde(s.get('rol')))}, {1 if s.get('activo', 1) else 0}, {q(hiatus)});")
        staff_id[did] = sig
        sig += 1

    # Cuentas del panel que no estaban vinculadas a Discord (por ejemplo, el admin)
    for u in datos.get("usuarios", []):
        usuario = usuario_limpio(u.get("usuario"))
        if not usuario or usuario in usuarios_vistos:
            continue
        usuarios_vistos.add(usuario)
        out.append(f"INSERT INTO staff (id, usuario, nombre, nivel, roles, activo) VALUES "
                   f"({sig}, {q(usuario)}, {q(u['usuario'])}, {q('admin' if u.get('rol') == 'admin' else 'staff')}, '', {1 if u.get('activo', 1) else 0});")
        sig += 1

    proyecto_id = {}   # nombre en mayúsculas -> id
    for p in datos.get("proyectos", []):
        clave = p["nombre"].strip().upper()
        if clave in proyecto_id:
            continue
        estado = (p.get("estado") or "activo").lower()
        estado = estado if estado in ("activo", "pausado", "terminado") else ("pausado" if "hiatus" in estado or "paus" in estado else "activo")
        out.append(f"INSERT INTO proyectos (id, nombre, estado) VALUES ({p['id']}, {q(p['nombre'].strip())}, {q(estado)});")
        proyecto_id[clave] = p["id"]

    cap_id = {}        # (proyecto_id, numero) -> id
    proyectos_por_id = {p["id"] for p in datos.get("proyectos", [])}
    for c in datos.get("capitulos", []):
        if c["proyecto_id"] not in proyectos_por_id:
            continue
        num, orden = numero_cap(c["numero"])
        if (c["proyecto_id"], num) in cap_id:
            continue
        eg = (c.get("estado_general") or c.get("estado") or "Pendiente").lower()
        if "public" in eg:
            estado = "publicado"
        elif all(c.get(k) for k in ("traduccion", "limpieza", "typer")) or "terminado" in eg:
            estado = "listo"
        elif "proceso" in eg or "retras" in eg:
            estado = "en_proceso"
        else:
            estado = "pendiente"
        out.append(f"INSERT INTO capitulos (id, proyecto_id, numero, orden, estado) VALUES ({c['id']}, {c['proyecto_id']}, {q(num)}, {orden}, {q(estado)});")
        cap_id[(c["proyecto_id"], num)] = c["id"]

    sig_cap = max([c["id"] for c in datos.get("capitulos", [])] + [0]) + 1
    sig_proy = max([p["id"] for p in datos.get("proyectos", [])] + [0]) + 1
    ocupadas, entregadas = set(), set()
    omitidas = 0
    mapa_estado = {"activa": "activa", "entregada": "entregada", "cancelada": "cancelada", "penalizada": "vencida", "vencida": "vencida"}
    for t in datos.get("tareas", []):
        did = str(t["discord_id"])
        rol = rol_tarea(t.get("rol"))
        estado = mapa_estado.get((t.get("estado") or "").lower())
        if did not in staff_id or not rol or not estado:
            omitidas += 1
            continue
        cid = t.get("capitulo_id")
        if not cid:
            # Tareas viejas sin capítulo: se busca o se crea por obra + número
            clave = (t.get("obra") or "").strip().upper()
            if clave not in proyecto_id:
                out.append(f"INSERT INTO proyectos (id, nombre, estado) VALUES ({sig_proy}, {q(t['obra'].strip())}, 'activo');")
                proyecto_id[clave] = sig_proy
                sig_proy += 1
            pid = proyecto_id[clave]
            num, orden = numero_cap(t.get("cap"))
            if (pid, num) not in cap_id:
                out.append(f"INSERT INTO capitulos (id, proyecto_id, numero, orden, estado) VALUES ({sig_cap}, {pid}, {q(num)}, {orden}, 'en_proceso');")
                cap_id[(pid, num)] = sig_cap
                sig_cap += 1
            cid = cap_id[(pid, num)]
        clave_t = (cid, rol)
        # Respeta las reglas nuevas: una activa y una entregada por capítulo y rol
        if (estado == "activa" and clave_t in ocupadas) or (estado == "entregada" and clave_t in entregadas):
            omitidas += 1
            continue
        if estado == "activa":
            ocupadas.add(clave_t)
        if estado == "entregada":
            entregadas.add(clave_t)
        limite = a_utc(t.get("limite"), zona) or a_utc(datetime.now(), zona)
        creado = a_utc(t.get("creado"), zona) or limite
        solicitud = "extension" if t.get("extension_solicitada") else ("cancelacion" if t.get("cancelacion_solicitada") else None)
        out.append(f"INSERT INTO tareas (capitulo_id, rol, staff_id, estado, limite, solicitud, solicitud_dias, creado, cerrada) VALUES "
                   f"({cid}, {q(rol)}, {staff_id[did]}, {q(estado)}, {q(limite)}, {q(solicitud if estado == 'activa' else None)}, "
                   f"{2 if solicitud == 'extension' and estado == 'activa' else 'NULL'}, {q(creado)}, {q(None if estado == 'activa' else creado)});")

    # Puntos: un registro por persona y mes con el total que tenían
    for e in datos.get("expedientes", []):
        did = str(e["discord_id"])
        if did not in staff_id or not e.get("puntos"):
            continue
        fecha = f"{int(e['anio']):04d}-{int(e['mes']):02d}-15T12:00:00Z"
        out.append(f"INSERT INTO puntos (staff_id, puntos, motivo, fecha) VALUES ({staff_id[did]}, {int(e['puntos'])}, 'migrado', {q(fecha)});")

    out.append("PRAGMA foreign_keys = ON;")
    out.append(f"-- Staff: {len(staff_id)} · Proyectos: {len(proyecto_id)} · Capítulos: {len(cap_id)} · Tareas omitidas: {omitidas}")
    return "\n".join(out) + "\n"


def leer_mysql():
    import pymysql
    import pymysql.cursors
    conn = pymysql.connect(
        host=os.environ["DB_HOST"], port=int(os.getenv("DB_PORT", "3306")),
        user=os.environ["DB_USER"], password=os.environ["DB_PASS"], database=os.getenv("DB_NAME", "crimson_scan"),
        charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor,
    )
    datos = {}
    with conn.cursor() as cur:
        for tabla in ("usuarios", "staff_discord", "proyectos", "capitulos", "tareas", "expedientes"):
            try:
                cur.execute(f"SELECT * FROM {tabla}")
                datos[tabla] = cur.fetchall()
            except Exception as e:
                print(f"-- Aviso: no se pudo leer {tabla}: {e}", file=sys.stderr)
                datos[tabla] = []
    conn.close()
    return datos


if __name__ == "__main__":
    nombre_zona = os.getenv("TZ_ORIGEN", "UTC")
    zona = ZoneInfo(nombre_zona) if ZoneInfo and nombre_zona != "UTC" else timezone.utc
    sys.stdout.write(generar_sql(leer_mysql(), zona))
