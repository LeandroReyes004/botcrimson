# migrar.py — ejecutar una sola vez
import json, pymysql
from datetime import datetime

DB = dict(host="134.209.74.99", port=3306, user="nvto", password="apolo9090",
          database="crimson_scan", charset="utf8mb4")

with open("database_crimson.json", encoding="utf-8") as f:
    datos = json.load(f)

conn = pymysql.connect(**DB)
cur  = conn.cursor()

# Migrar staff
for uid, info in datos.get("staff", {}).items():
    cur.execute(
        "INSERT IGNORE INTO staff_discord (discord_id, usuario_form) VALUES (%s, %s)",
        (int(uid), info.get("usuario_form"))
    )

# Migrar usuario_form_map
for nombre_form, uid in datos.get("usuario_form_map", {}).items():
    if uid.startswith("<@"):
        continue  # saltar entradas inválidas
    cur.execute(
        "INSERT INTO staff_discord (discord_id, usuario_form) VALUES (%s, %s) "
        "ON DUPLICATE KEY UPDATE usuario_form=%s",
        (int(uid), nombre_form, nombre_form)
    )

# Migrar series → proyectos + capítulos
for nombre, caps in datos.get("series", {}).items():
    cur.execute(
        "INSERT IGNORE INTO proyectos (nombre, nombre_upper) VALUES (%s, %s)",
        (nombre, nombre.upper())
    )
    cur.execute("SELECT id FROM proyectos WHERE nombre_upper=%s", (nombre.upper(),))
    pid = cur.fetchone()[0]
    for num, info in caps.items():
        cur.execute(
            "INSERT IGNORE INTO capitulos "
            "(proyecto_id, numero, traduccion, limpieza, typer, proof, estado) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (pid, num,
             int(info.get("traduccion", False)),
             int(info.get("limpieza",   False)),
             int(info.get("typer",      False)),
             int(info.get("proof",      False)),
             info.get("estado", "Pendiente"))
        )

# Migrar expedientes del mes actual
ahora = datetime.now()
for uid, puntos in datos.get("expedientes", {}).items():
    cur.execute(
        "INSERT IGNORE INTO staff_discord (discord_id) VALUES (%s)", (int(uid),)
    )
    cur.execute(
        "INSERT INTO expedientes (discord_id, puntos, mes, anio) VALUES (%s,%s,%s,%s) "
        "ON DUPLICATE KEY UPDATE puntos=%s",
        (int(uid), puntos, ahora.month, ahora.year, puntos)
    )

# Migrar errores
for uid, errores in datos.get("errores_hist", {}).items():
    cur.execute(
        "INSERT IGNORE INTO staff_discord (discord_id) VALUES (%s)", (int(uid),)
    )
    for e in errores:
        fecha_raw = e.get("fecha", str(datetime.now()))
        try:
            fecha = datetime.strptime(fecha_raw[:10], "%d/%m/%Y").strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            fecha = str(datetime.now())[:19]
        cur.execute(
            "INSERT INTO errores_hist (discord_id, error, fecha) VALUES (%s,%s,%s)",
            (int(uid), e.get("error", ""), fecha)
        )

# Migrar formularios procesados
for ts in datos.get("procesados_formulario", []):
    cur.execute(
        "INSERT IGNORE INTO formularios_procesados (timestamp_form) VALUES (%s)", (ts,)
    )

conn.commit()
cur.close()
conn.close()
print("✅ Migración completa.")