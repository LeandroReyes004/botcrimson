import discord
from discord.ext import commands, tasks
import os
import re

import api_client as db
import asyncio
import logging
import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

# --- LOGGING ---
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger(__name__)

# --- CONFIGURACIÓN DEL BOT ---
intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix='cd!', intents=intents, help_command=None)

COLOR_CRIMSON = 0x660000

CANAL_ALERTAS_ID = int(os.getenv("CANAL_ALERTAS_ID", "0")) or None

ETAPA_ROL_MAP = {
    "raws":          "Cleaner",
    "limpieza":      "Cleaner",
    "clean":         "Cleaner",
    "traduccion":    "Traductor",
    "traducción":    "Traductor",
    "translation":   "Traductor",
    "typeo":         "Typer",
    "tipeo":         "Typer",
    "type":          "Typer",
    "proof":         "Proofreader",
    "proofreading":  "Proofreader",
    "revision":      "Proofreader",
}

# --- GOOGLE SHEETS & DRIVE ---
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]
SHEET_ID        = os.getenv("GOOGLE_SHEET_ID")
CREDS_FILE      = os.getenv("CREDENCIALES_JSON", "credenciales.json")
CARPETA_RAIZ_ID = os.getenv("CARPETA_RAIZ_ID", "")

SUBCARPETAS_PROYECTO = [
    "01. RAWs",
    "02. Traducción",
    "03. Limpieza y Redibujo",
    "04. Typos",
    "05. Control de Calidad",
    "06. Listo para Subir"
]

ROL_ETAPA_DRIVE = {
    "Traductor":   "02. Traducción",
    "Cleaner":     "01. RAWs",
    "Typer":       "04. Typos",
    "Proofreader": "05. Control de Calidad",
}

sheet_client      = None
hoja_asignaciones = None
hoja_ranking      = None
hoja_formulario   = None
drive_service     = None

# ── Google Drive API ──────────────────────────────────────────────────────────

def conectar_drive():
    global drive_service
    try:
        creds = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
        drive_service = build('drive', 'v3', credentials=creds, cache_discovery=False)
        log.info("✅ Google Drive API conectado.")
        return True
    except Exception as e:
        log.error(f"❌ Error conectando Drive: {e}")
        return False

def drive_buscar_o_crear_carpeta(nombre, padre_id):
    try:
        nombre_escaped = nombre.replace("'", "\\'")
        query = (
            f"name='{nombre_escaped}' and "
            f"'{padre_id}' in parents and "
            f"mimeType='application/vnd.google-apps.folder' and "
            f"trashed=false"
        )
        results = drive_service.files().list(q=query, fields="files(id)").execute()
        items = results.get("files", [])
        if items:
            return items[0]["id"]
        metadata = {
            "name": nombre,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [padre_id]
        }
        carpeta = drive_service.files().create(body=metadata, fields="id").execute()
        return carpeta.get("id")
    except Exception as e:
        log.error(f"[Drive] buscar_o_crear '{nombre}': {e}")
        return None

def drive_crear_proyecto(nombre_proyecto):
    if not drive_service or not CARPETA_RAIZ_ID:
        return False, "Drive no conectado o CARPETA_RAIZ_ID vacío."
    try:
        proyecto_id = drive_buscar_o_crear_carpeta(nombre_proyecto, CARPETA_RAIZ_ID)
        if not proyecto_id:
            return False, "No se pudo crear la carpeta del proyecto."
        for sub in SUBCARPETAS_PROYECTO:
            drive_buscar_o_crear_carpeta(sub, proyecto_id)
        return True, proyecto_id
    except Exception as e:
        return False, str(e)

def drive_listar_proyectos():
    if not drive_service or not CARPETA_RAIZ_ID:
        return None, "Drive no conectado."
    try:
        query = (
            f"'{CARPETA_RAIZ_ID}' in parents and "
            f"mimeType='application/vnd.google-apps.folder' and "
            f"trashed=false"
        )
        results = drive_service.files().list(
            q=query, fields="files(id, name)", orderBy="name"
        ).execute()
        return results.get("files", []), None
    except Exception as e:
        return None, str(e)

def drive_listar_capitulos(proyecto_nombre):
    if not drive_service or not CARPETA_RAIZ_ID:
        return None, "Drive no conectado."
    try:
        query = (
            f"name='{proyecto_nombre.replace(chr(39), chr(92)+chr(39))}' and "
            f"'{CARPETA_RAIZ_ID}' in parents and "
            f"mimeType='application/vnd.google-apps.folder' and trashed=false"
        )
        res = drive_service.files().list(q=query, fields="files(id,name)").execute()
        items = res.get("files", [])
        if not items:
            return None, f"No se encontró la carpeta `{proyecto_nombre}` en Drive."
        proyecto_id = items[0]["id"]

        sub_query = (
            f"'{proyecto_id}' in parents and "
            f"mimeType='application/vnd.google-apps.folder' and trashed=false"
        )
        etapas = drive_service.files().list(
            q=sub_query, fields="files(id,name)", orderBy="name"
        ).execute().get("files", [])

        resumen = {}
        for etapa in etapas:
            cap_query = (
                f"'{etapa['id']}' in parents and "
                f"mimeType='application/vnd.google-apps.folder' and trashed=false"
            )
            caps = drive_service.files().list(
                q=cap_query, fields="files(name)", orderBy="name"
            ).execute().get("files", [])
            if caps:
                resumen[etapa["name"]] = [c["name"] for c in caps]
        return resumen, None
    except Exception as e:
        return None, str(e)

# ── Google Sheets ─────────────────────────────────────────────────────────────

def conectar_sheets():
    global sheet_client, hoja_asignaciones, hoja_ranking, hoja_formulario
    try:
        creds = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
        sheet_client = gspread.authorize(creds)
        spreadsheet = sheet_client.open_by_key(SHEET_ID)

        try:
            hoja_formulario = spreadsheet.worksheet("Respuestas de formulario 1")
            log.info("Pestaña 'Respuestas de formulario 1' conectada.")
        except gspread.WorksheetNotFound:
            log.warning("⚠️ No se encontró 'Respuestas de formulario 1'.")

        try:
            hoja_asignaciones = spreadsheet.worksheet("Asignaciones")
        except gspread.WorksheetNotFound:
            hoja_asignaciones = spreadsheet.add_worksheet("Asignaciones", rows=1000, cols=10)
            hoja_asignaciones.append_row([
                "ID Tarea", "Discord ID", "Nombre", "Obra",
                "Capítulo", "Rol", "Fecha Asignación", "Fecha Límite",
                "Estado", "Fecha Entrega"
            ])
            log.info("Pestaña 'Asignaciones' creada.")

        try:
            hoja_ranking = spreadsheet.worksheet("Ranking")
        except gspread.WorksheetNotFound:
            hoja_ranking = spreadsheet.add_worksheet("Ranking", rows=500, cols=4)
            hoja_ranking.append_row(["Discord ID", "Nombre", "Caps Entregados", "Último Activo"])
            log.info("Pestaña 'Ranking' creada.")

        log.info("✅ Google Sheets conectado correctamente.")
        return True
    except Exception as e:
        log.error(f"❌ Error conectando Sheets: {e}")
        return False

def sheets_agregar_asignacion(tid, user, obra, cap, rol, limite):
    if not hoja_asignaciones: return
    try:
        hoja_asignaciones.append_row([
            tid, str(user.id), user.display_name, obra, cap, rol,
            datetime.now().strftime("%d/%m/%Y %H:%M"),
            limite.strftime("%d/%m/%Y %H:%M"),
            "Pendiente", ""
        ])
    except Exception as e:
        log.error(f"[Sheets] agregar_asignacion: {e}")

def sheets_marcar_entregado(tid):
    if not hoja_asignaciones: return
    try:
        celda = hoja_asignaciones.find(tid, in_column=1)
        if celda:
            hoja_asignaciones.update_cell(celda.row, 9, "Entregado")
            hoja_asignaciones.update_cell(celda.row, 10, datetime.now().strftime("%d/%m/%Y %H:%M"))
    except Exception as e:
        log.error(f"[Sheets] marcar_entregado (TID={tid}): {e}")

def sheets_marcar_retrasado(tid):
    if not hoja_asignaciones: return
    try:
        celda = hoja_asignaciones.find(tid, in_column=1)
        if celda:
            hoja_asignaciones.update_cell(celda.row, 9, "🔴 Retrasado")
    except Exception as e:
        log.error(f"[Sheets] marcar_retrasado (TID={tid}): {e}")

def sheets_marcar_cancelado(tid):
    if not hoja_asignaciones: return
    try:
        celda = hoja_asignaciones.find(tid, in_column=1)
        if celda:
            hoja_asignaciones.update_cell(celda.row, 9, "❌ Cancelado")
            hoja_asignaciones.update_cell(celda.row, 10, datetime.now().strftime("%d/%m/%Y %H:%M"))
    except Exception as e:
        log.error(f"[Sheets] marcar_cancelado (TID={tid}): {e}")

def sheets_actualizar_ranking(user_id, nombre, puntos_totales):
    if not hoja_ranking: return
    try:
        ids_existentes = hoja_ranking.col_values(1)
        uid_str = str(user_id)
        if uid_str in ids_existentes:
            fila = ids_existentes.index(uid_str) + 1
            hoja_ranking.update_cell(fila, 2, nombre)
            hoja_ranking.update_cell(fila, 3, puntos_totales)
            hoja_ranking.update_cell(fila, 4, datetime.now().strftime("%m/%Y"))
        else:
            hoja_ranking.append_row([uid_str, nombre, puntos_totales, datetime.now().strftime("%m/%Y")])
    except Exception as e:
        log.error(f"[Sheets] actualizar_ranking: {e}")

def sheets_leer_resumen():
    if not hoja_asignaciones:
        return None, "Sheets no conectado"
    try:
        filas = hoja_asignaciones.get_all_values()
        if len(filas) <= 1:
            return {}, None
        resumen = {}
        for fila in filas[1:]:
            if len(fila) < 9:
                continue
            obra = fila[3].strip().upper() if len(fila) > 3 else ""
            if not obra:
                continue
            if obra not in resumen:
                resumen[obra] = {"total": 0, "entregado": 0, "retrasado": 0, "pendiente": 0}
            resumen[obra]["total"] += 1
            estado = fila[8].strip().lower() if len(fila) > 8 else ""
            if "entregado" in estado:
                resumen[obra]["entregado"] += 1
            elif "retrasado" in estado or "retraso" in estado:
                resumen[obra]["retrasado"] += 1
            else:
                resumen[obra]["pendiente"] += 1
        return resumen, None
    except Exception as e:
        log.error(f"[Sheets] leer_resumen: {e}")
        return None, str(e)

def sheets_marcar_todos_historicos():
    """Marca todos los timestamps del formulario como procesados en MySQL."""
    if not hoja_formulario: return
    try:
        all_values = hoja_formulario.get_all_values()
        if len(all_values) < 2: return
        headers = all_values[0]
        timestamp_col = next((i for i, h in enumerate(headers) if h == "Marca temporal"), None)
        if timestamp_col is None: return
        timestamps = []
        for row in all_values[1:]:
            ts = row[timestamp_col].strip() if timestamp_col < len(row) else ""
            if ts:
                timestamps.append(ts)
        if timestamps:
            db.formularios_marcar_todos(timestamps)
        log.info(f"[Form] Historial marcado: {len(timestamps)} registros anteriores ignorados.")
    except Exception as e:
        log.error(f"[Sheets] marcar_historicos: {e}")

def sheets_leer_formulario_nuevas():
    """Lee el formulario y retorna solo las filas NO procesadas en MySQL."""
    if not hoja_formulario: return []
    try:
        all_values = hoja_formulario.get_all_values()
        if len(all_values) < 2:
            return []
        headers = all_values[0]
        nuevas = []
        for row in all_values[1:]:
            registro = {}
            for i, header in enumerate(headers):
                if header and header not in registro:
                    registro[header] = row[i] if i < len(row) else ""
            timestamp = str(registro.get("Marca temporal", "")).strip()
            if timestamp and not db.formulario_ya_procesado(timestamp):
                nuevas.append(registro)
        return nuevas
    except Exception as e:
        log.error(f"[Sheets] leer_formulario: {e}")
        return []


sheets_ok = conectar_sheets()
drive_ok  = conectar_drive()

# Primera ejecución: marcar historial del formulario para no reprocesarlo
if sheets_ok and not db.formulario_ya_procesado("__init__"):
    log.info("[Form] Primera ejecución detectada — marcando historial como procesado...")
    sheets_marcar_todos_historicos()
    db.formulario_marcar("__init__")


@bot.event
async def on_ready():
    global CANAL_ALERTAS_ID
    if not monitor_tiempos.is_running():
        monitor_tiempos.start()
    if not recordatorio_diario.is_running():
        recordatorio_diario.start()

    canal_db = db.config_get("canal_alertas", "0")
    if canal_db and canal_db != "0":
        CANAL_ALERTAS_ID = int(canal_db)

    estado_s = "✅ Sheets OK"  if sheets_ok else "⚠️ Sheets SIN conexión"
    estado_d = "✅ Drive OK"   if drive_ok  else "⚠️ Drive SIN conexión"
    print(f"✅ Crimson Manager Online | {estado_s} | {estado_d} | MySQL ✅")
    log.info(f"Online | {estado_s} | {estado_d}")

# --- HELPER: canal de alertas ────────────────────────────────────────────────

def get_canal_alertas_id():
    canal_db = db.config_get("canal_alertas", "0")
    if canal_db and canal_db != "0":
        return int(canal_db)
    return CANAL_ALERTAS_ID

# --- VERIFICAR FORMULARIO ────────────────────────────────────────────────────

async def verificar_formulario_y_procesar():
    loop = asyncio.get_event_loop()
    nuevas = await loop.run_in_executor(None, sheets_leer_formulario_nuevas)
    if not nuevas:
        return

    for registro in nuevas:
        timestamp     = str(registro.get("Marca temporal", "")).strip()
        usuario_form  = str(registro.get("Usuario", "")).strip().lower()
        proyecto_form = str(registro.get("Proyecto", "")).strip().upper()
        cap_form      = str(registro.get("Capítulo", "")).strip()

        if timestamp:
            db.formulario_marcar(timestamp)

        if not usuario_form or not proyecto_form or not cap_form:
            continue

        staff = db.staff_get_by_form(usuario_form)
        discord_id_str = str(staff["discord_id"]) if staff else None

        matched_tarea = None
        tareas_activas = db.tarea_get_todas_activas()

        for tarea in tareas_activas:
            obra_task   = str(tarea.get("obra", "")).strip().upper()
            cap_task    = str(tarea.get("cap", "")).strip()
            uid_task    = str(tarea.get("discord_id", ""))
            nombre_task = str(tarea.get("nombre_display", "")).strip().lower()

            obra_ok = (proyecto_form == obra_task)
            cap_ok  = (cap_form == cap_task)

            if discord_id_str:
                user_ok = (uid_task == discord_id_str)
            else:
                user_ok = (
                    usuario_form == nombre_task or
                    usuario_form in nombre_task or
                    nombre_task in usuario_form
                )

            if obra_ok and cap_ok and user_ok:
                matched_tarea = tarea
                break

        if not matched_tarea:
            log.info(f"[Form] Sin match → {usuario_form} | {proyecto_form} | Cap {cap_form}")
            canal_id = get_canal_alertas_id()
            if canal_id:
                canal = bot.get_channel(canal_id)
                if canal:
                    await canal.send(
                        f"⚠️ **Entrega sin tarea registrada**\n"
                        f"Usuario en formulario: `{usuario_form}` | Proyecto: `{proyecto_form}` Cap `{cap_form}`\n"
                        f"Si es staff tuyo, pídele que use `cd!mi_usuario {usuario_form}`"
                    )
            continue

        obra = matched_tarea["obra"]
        cap  = matched_tarea["cap"]
        rol  = matched_tarea["rol"]
        tid  = matched_tarea["id"]

        puntos = db.tarea_completar(tid)
        nombre_display = matched_tarea.get("nombre_display", "Desconocido")

        await loop.run_in_executor(None, sheets_marcar_entregado, tid)
        await loop.run_in_executor(
            None, sheets_actualizar_ranking,
            matched_tarea["discord_id"], nombre_display, puntos
        )

        canal_id = matched_tarea.get("canal_id") or get_canal_alertas_id()
        if canal_id:
            canal = bot.get_channel(canal_id)
            if canal:
                embed = discord.Embed(
                    title="📬 ENTREGA DETECTADA VÍA FORMULARIO",
                    description=(
                        f"**{nombre_display}** entregó `{rol}` de **{obra}** Cap {cap}.\n"
                        f"📂 Archivo ya movido a Drive automáticamente.\n"
                        f"🏅 Ranking actualizado: **{puntos} cap{'s' if puntos != 1 else ''}**"
                    ),
                    color=0x00cc66
                )
                embed.set_footer(text="Detectado desde Respuestas de formulario ✅")
                await canal.send(embed=embed)
        log.info(f"[Form] Entrega procesada: {nombre_display} | {obra} Cap {cap}")

# --- MONITOR PRINCIPAL ───────────────────────────────────────────────────────

@tasks.loop(minutes=5)
async def monitor_tiempos():
    ahora = datetime.now()
    loop  = asyncio.get_event_loop()

    # Reinicio mensual (los puntos históricos se conservan en MySQL)
    mes_actual = db.config_get("mes_actual", "0")
    if str(ahora.month) != mes_actual:
        db.config_set("mes_actual", ahora.month)
        log.info("Mes actualizado en config MySQL.")

    await verificar_formulario_y_procesar()

    tareas_activas = db.tarea_get_todas_activas()
    for tarea in tareas_activas:
        try:
            limite = tarea["limite"] if isinstance(tarea["limite"], datetime) \
                     else datetime.fromisoformat(str(tarea["limite"]))
            if ahora >= limite:
                tid      = tarea["id"]
                canal_id = tarea.get("canal_id") or get_canal_alertas_id()
                user     = bot.get_user(tarea["discord_id"])

                if canal_id:
                    canal = bot.get_channel(canal_id)
                    if canal and user:
                        embed = discord.Embed(
                            title="🔴 TAREA RETRASADA",
                            description=(
                                f"{user.mention}, el plazo de **{tarea['obra']}** "
                                f"Cap {tarea['cap']} (`{tarea['rol']}`) ha **vencido**.\n"
                                f"Por favor contacta a un administrador."
                            ),
                            color=0xff0000
                        )
                        await canal.send(content=user.mention, embed=embed)

                await loop.run_in_executor(None, sheets_marcar_retrasado, tid)
                db.tarea_cancelar(tid)

        except Exception as e:
            log.error(f"[Monitor Tareas] {tarea.get('id')}: {e}")
            continue

@monitor_tiempos.error
async def monitor_error(error):
    log.error(f"[Monitor] Error crítico: {error}")

# --- RECORDATORIO DIARIO (9:00 AM) ───────────────────────────────────────────

@tasks.loop(minutes=1)
async def recordatorio_diario():
    ahora = datetime.now()
    if ahora.hour != 9 or ahora.minute != 0:
        return
    ultimo = db.config_get("ultimo_recordatorio")
    hoy = ahora.strftime("%Y-%m-%d")
    if ultimo == hoy:
        return
    db.config_set("ultimo_recordatorio", hoy)

    canal_id = get_canal_alertas_id()
    if not canal_id:
        return
    canal = bot.get_channel(canal_id)
    if not canal:
        return

    pendientes = db.tarea_get_todas_activas()
    if not pendientes:
        return

    embed = discord.Embed(
        title="☀️ RESUMEN DIARIO DE TAREAS PENDIENTES",
        description=f"**{ahora.strftime('%d/%m/%Y')}** — Tareas activas en el sistema:",
        color=COLOR_CRIMSON,
        timestamp=ahora
    )
    urgentes_hoy = []
    normales = []
    for tarea in pendientes:
        limite = tarea["limite"] if isinstance(tarea["limite"], datetime) \
                 else datetime.fromisoformat(str(tarea["limite"]))
        horas_restantes = (limite - ahora).total_seconds() / 3600
        entrada = (
            f"• <@{tarea['discord_id']}> — **{tarea['obra']}** Cap {tarea['cap']} "
            f"(`{tarea['rol']}`) — vence <t:{int(limite.timestamp())}:R>"
        )
        if horas_restantes <= 24:
            urgentes_hoy.append(entrada)
        else:
            normales.append(entrada)

    if urgentes_hoy:
        embed.add_field(name="🔴 URGENTES (vencen hoy)", value="\n".join(urgentes_hoy[:10]), inline=False)
    if normales:
        embed.add_field(name="🟡 En curso", value="\n".join(normales[:15]), inline=False)
    embed.set_footer(text=f"Total: {len(pendientes)} tarea(s) activa(s)")
    await canal.send(embed=embed)

@recordatorio_diario.error
async def recordatorio_error(error):
    log.error(f"[Recordatorio] Error: {error}")

# --- COMANDOS DE ADMINISTRACIÓN ──────────────────────────────────────────────

@bot.command()
@commands.has_permissions(administrator=True)
async def set_canal(ctx, canal: discord.TextChannel = None):
    """Configura el canal de alertas de retraso. cd!set_canal #canal"""
    canal = canal or ctx.channel
    db.config_set("canal_alertas", canal.id)
    await ctx.send(f"✅ Canal de alertas configurado: {canal.mention}", delete_after=10)

@bot.command()
async def mi_usuario(ctx, *, nombre_form: str):
    """
    Vincula tu usuario del formulario con tu cuenta de Discord.
    Uso: cd!mi_usuario nvto
    """
    nombre_form = nombre_form.strip().lower()
    uid = ctx.author.id
    try:
        db.staff_registrar(
            discord_id=uid,
            usuario_form=nombre_form,
            nombre_display=ctx.author.display_name
        )
        await ctx.send(
            f"✅ **{ctx.author.mention}** registrado como `{nombre_form}`.\n"
            f"El bot te reconocerá automáticamente cuando entregues.",
            delete_after=15
        )
    except Exception as e:
        log.error(f"mi_usuario: {e}")
        await ctx.send("❌ Error al registrar. Intenta de nuevo.", delete_after=10)

@bot.command()
@commands.has_permissions(administrator=True)
async def ver_usuarios(ctx):
    """Muestra el staff registrado en MySQL (solo admin)"""
    lista = db.staff_listar()
    if not lista:
        return await ctx.send("⚠️ Ningún staff registrado aún.", delete_after=10)
    lineas = [
        f"{'✅' if m['activo'] else '❌'} `{m['usuario_form'] or '—'}` → <@{m['discord_id']}>"
        for m in lista
    ]
    embed = discord.Embed(
        title="👥 Staff registrado",
        description="\n".join(lineas),
        color=COLOR_CRIMSON
    )
    await ctx.send(embed=embed)

@bot.command()
@commands.has_permissions(administrator=True)
async def nueva_obra(ctx, *, nombre: str):
    """Registra una serie y crea su carpeta en Google Drive automáticamente"""
    await ctx.message.delete()
    nombre_up    = nombre.strip().upper()
    nombre_drive = nombre.strip()

    existente = db.proyecto_get(nombre_up)
    if existente:
        return await ctx.send(f"⚠️ `{nombre_up}` ya está en la base de datos.", delete_after=5)

    embed = discord.Embed(
        title="🆕 NUEVA SERIE AGREGADA",
        description=f"La obra **{nombre_up}** ha sido registrada.",
        color=0x00cc66
    )
    loop = asyncio.get_event_loop()
    exito, resultado = await loop.run_in_executor(None, drive_crear_proyecto, nombre_drive)
    carpeta_id = resultado if exito else None

    db.proyecto_crear(nombre_drive, carpeta_id)

    if exito:
        embed.add_field(name="📁 Google Drive", value="Carpeta creada con 6 subcarpetas ✅", inline=False)
    else:
        embed.add_field(name="📁 Google Drive", value=f"⚠️ No se pudo crear en Drive: {resultado}", inline=False)
        log.warning(f"[Drive] nueva_obra '{nombre_drive}': {resultado}")
    await ctx.send(embed=embed)

@bot.command()
async def carpetas(ctx, *, proyecto: str = None):
    """
    Muestra las carpetas de Drive.
    Sin argumento → lista todos los proyectos.
    Con argumento → muestra los capítulos de ese proyecto.
    """
    await ctx.message.delete()
    loop = asyncio.get_event_loop()

    if not drive_ok:
        return await ctx.send("❌ Google Drive no está conectado.", delete_after=7)

    if not proyecto:
        proyectos, error = await loop.run_in_executor(None, drive_listar_proyectos)
        if error:
            return await ctx.send(f"❌ Error al leer Drive: {error}", delete_after=10)
        if not proyectos:
            return await ctx.send("📭 No hay proyectos en la carpeta raíz de Drive.", delete_after=7)

        embed = discord.Embed(
            title="📂 PROYECTOS EN GOOGLE DRIVE",
            description=f"Total: **{len(proyectos)}** proyectos\nUsa `cd!carpetas <nombre>` para ver sus capítulos.",
            color=COLOR_CRIMSON
        )
        nombres = "\n".join([f"• {p['name']}" for p in proyectos])
        if len(nombres) <= 1024:
            embed.add_field(name="📁 Proyectos", value=nombres, inline=False)
        else:
            chunks = [proyectos[i:i+20] for i in range(0, len(proyectos), 20)]
            for i, chunk in enumerate(chunks):
                embed.add_field(
                    name=f"📁 Proyectos ({i*20+1}-{i*20+len(chunk)})",
                    value="\n".join([f"• {p['name']}" for p in chunk]),
                    inline=False
                )
        await ctx.send(embed=embed)
    else:
        resumen, error = await loop.run_in_executor(None, drive_listar_capitulos, proyecto)
        if error:
            return await ctx.send(f"❌ {error}", delete_after=10)
        if not resumen:
            return await ctx.send(f"📭 No hay capítulos en `{proyecto}` aún.", delete_after=7)

        embed = discord.Embed(
            title=f"📂 {proyecto.upper()} — Capítulos en Drive",
            color=COLOR_CRIMSON
        )
        for etapa, caps in resumen.items():
            embed.add_field(
                name=f"📁 {etapa}",
                value="\n".join([f"• {c}" for c in caps]) or "—",
                inline=True
            )
        embed.set_footer(text="Datos en tiempo real desde Google Drive")
        await ctx.send(embed=embed)

@bot.command()
async def series(ctx):
    """Catálogo de obras leido en tiempo real desde Drive + MySQL"""
    msg_cargando = await ctx.send("🔄 Cargando datos desde Drive...")
    loop = asyncio.get_running_loop()

    proyectos_drive, err_drive = await loop.run_in_executor(None, drive_listar_proyectos)
    resumen_sheets, _          = await loop.run_in_executor(None, sheets_leer_resumen)
    await msg_cargando.delete()

    if err_drive or proyectos_drive is None:
        return await ctx.send(f"❌ Error al leer Drive: {err_drive}", delete_after=10)
    if not proyectos_drive:
        return await ctx.send("💭 No hay proyectos en Drive todavía.", delete_after=7)

    resumen = resumen_sheets or {}
    embed = discord.Embed(
        title="📖 CATÁLOGO CRIMSON SCAN",
        description=f"**{len(proyectos_drive)} proyecto(s)** en Drive — datos en tiempo real",
        color=COLOR_CRIMSON,
        timestamp=datetime.now()
    )
    MEDALLAS = ["🥇", "🥈", "🥉"]
    for i, p in enumerate(proyectos_drive):
        nombre    = p["name"]
        info      = resumen.get(nombre.upper(), {})
        total     = info.get("total", 0)
        entregado = info.get("entregado", 0)
        retrasado = info.get("retrasado", 0)
        pendiente = info.get("pendiente", 0)

        if total > 0:
            pct    = entregado / total
            barras = int(pct * 8)
            barra  = "█" * barras + "░" * (8 - barras)
            pct_txt = f"{int(pct*100)}%"
        else:
            barra   = "░" * 8
            pct_txt = "Sin datos"

        icono = MEDALLAS[i] if i < 3 else "📘"
        parts = [f"`{barra}` {pct_txt}"]
        if total:     parts.append(f"📌 Asignaciones: **{total}**")
        if entregado: parts.append(f"✅ Entregadas: **{entregado}**")
        if retrasado: parts.append(f"🔴 Retrasadas: **{retrasado}**")
        if pendiente: parts.append(f"⏳ Pendientes: **{pendiente}**")

        embed.add_field(
            name=f"{icono} {nombre}",
            value="\n".join(parts) if parts else "Sin asignaciones aún",
            inline=False
        )
        if len(embed.fields) == 24 and i < len(proyectos_drive) - 1:
            await ctx.send(embed=embed)
            embed = discord.Embed(color=COLOR_CRIMSON)

    embed.set_footer(text="Fuente: Google Drive + MySQL  |  En tiempo real")
    await ctx.send(embed=embed)

@bot.command()
@commands.has_permissions(administrator=True)
async def importar(ctx, *, contenido: str):
    """Importa capítulos a una serie. Formato: cd!importar Obra 1 2 3"""
    await ctx.message.delete()
    match = re.search(r'\d', contenido)
    if not match:
        return await ctx.send("❌ No indicaste los números de capítulo.", delete_after=5)

    indice = match.start()
    if '"' in contenido:
        partes = contenido.split('"')
        nombre_obra = partes[1].strip().upper()
        numeros_raw = partes[2] if len(partes) > 2 else ""
    else:
        nombre_obra = contenido[:indice].strip().upper()
        numeros_raw = contenido[indice:]

    if not nombre_obra:
        return await ctx.send("❌ No se pudo leer el nombre.", delete_after=5)

    caps = re.findall(r'\d+', numeros_raw)
    if not caps:
        return await ctx.send("❌ No hay números válidos.", delete_after=5)

    agregados, error = db.cap_importar(nombre_obra, caps)
    if error:
        return await ctx.send(f"❌ Error: {error}", delete_after=10)

    await ctx.send(f"📥 **{agregados} capítulos** importados a `{nombre_obra}`.", delete_after=10)

# --- SISTEMA DE ORDEN ────────────────────────────────────────────────────────

ROLES_DISP = ["Traductor", "Cleaner", "Typer", "Proofreader"]

@bot.command()
async def orden(ctx):
    """Asignación de tareas paso a paso (proyectos desde Google Drive)"""
    def check(m):
        return m.author == ctx.author and m.channel == ctx.channel

    try:
        # Paso 1: Rol
        desc_roles = "\n".join([f"**{i+1}**. {r}" for i, r in enumerate(ROLES_DISP)])
        q1 = await ctx.send(embed=discord.Embed(title="🎭 PASO 1: ROL", description=desc_roles, color=COLOR_CRIMSON))
        msg_r = await bot.wait_for('message', check=check, timeout=30)
        await msg_r.delete(); await q1.delete()
        if not msg_r.content.isdigit() or not (1 <= int(msg_r.content) <= len(ROLES_DISP)):
            return await ctx.send(f"❌ Número inválido (1-{len(ROLES_DISP)}).", delete_after=7)
        rol = ROLES_DISP[int(msg_r.content) - 1]

        # Paso 2: Obra — desde Google Drive en tiempo real
        cargando = await ctx.send("🔄 Cargando proyectos desde Drive...")
        loop = asyncio.get_event_loop()
        proyectos_drive, drive_err = await loop.run_in_executor(None, drive_listar_proyectos)
        await cargando.delete()

        if drive_err or not proyectos_drive:
            return await ctx.send(
                f"❌ No se pudieron cargar los proyectos de Drive: {drive_err or 'lista vacía'}.",
                delete_after=10
            )

        obras_list = [p["name"] for p in proyectos_drive]
        desc_obras = "\n".join([f"**{i+1}**. {o}" for i, o in enumerate(obras_list)])
        if len(desc_obras) > 3900:
            obras_list = obras_list[:30]
            desc_obras = "\n".join([f"**{i+1}**. {o}" for i, o in enumerate(obras_list)]) + "\n*(mostrando primeros 30)*"
        q2 = await ctx.send(embed=discord.Embed(title="📖 PASO 2: OBRA", description=desc_obras, color=COLOR_CRIMSON))
        msg_o = await bot.wait_for('message', check=check, timeout=60)
        await msg_o.delete(); await q2.delete()
        if not msg_o.content.isdigit() or not (1 <= int(msg_o.content) <= len(obras_list)):
            return await ctx.send(f"❌ Número inválido (1-{len(obras_list)}).", delete_after=7)
        obra = obras_list[int(msg_o.content) - 1]

        # Paso 3: Capítulo
        q3 = await ctx.send(embed=discord.Embed(
            title="🔢 PASO 3: CAPÍTULO",
            description=f"Número de capítulo para `{obra}`:",
            color=COLOR_CRIMSON
        ))
        msg_c = await bot.wait_for('message', check=check, timeout=30)
        cap = msg_c.content.strip()
        await msg_c.delete(); await q3.delete()
        if not re.match(r'^\d+$', cap):
            return await ctx.send("❌ El capítulo debe ser un número.", delete_after=7)

        # Paso 4: Usuario
        q4 = await ctx.send(embed=discord.Embed(
            title="👤 PASO 4: RESPONSABLE",
            description="Menciona al staff (@Usuario):",
            color=COLOR_CRIMSON
        ))
        msg_u = await bot.wait_for('message', check=check, timeout=30)
        await msg_u.delete(); await q4.delete()
        if not msg_u.mentions:
            return await ctx.send("❌ No mencionaste a nadie.", delete_after=7)
        user = msg_u.mentions[0]

        # Registrar en MySQL
        vence = datetime.now() + timedelta(days=3)
        tid   = f"T-{int(datetime.now().timestamp())}"

        db.staff_registrar(user.id, None, user.display_name)
        db.tarea_crear(
            tarea_id=tid,
            discord_id=user.id,
            obra=obra,
            cap=cap,
            rol=rol,
            limite=vence,
            canal_id=ctx.channel.id,
        )

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, sheets_agregar_asignacion, tid, user, obra, cap, rol, vence)

        # DM automático
        try:
            dm_embed = discord.Embed(
                title="📬 NUEVA TAREA ASIGNADA",
                description="Se te ha asignado una tarea en **Crimson Scan**.",
                color=COLOR_CRIMSON,
                timestamp=datetime.now()
            )
            dm_embed.add_field(name="📖 Obra",        value=obra, inline=True)
            dm_embed.add_field(name="🔢 Capítulo",    value=cap,  inline=True)
            dm_embed.add_field(name="🎭 Rol",         value=rol,  inline=True)
            dm_embed.add_field(name="⏳ Fecha límite", value=f"<t:{int(vence.timestamp())}:F>", inline=False)
            dm_embed.set_footer(text="Entrega tu trabajo por el Formulario de Google 📝")
            await user.send(embed=dm_embed)
        except discord.Forbidden:
            log.warning(f"[DM] No se pudo enviar DM a {user.display_name} (DMs cerrados)")
        except Exception as e:
            log.warning(f"[DM] Error DM a {user.display_name}: {e}")

        embed_orden = discord.Embed(title="📜 NUEVA ORDEN DE TRABAJO", color=COLOR_CRIMSON)
        embed_orden.add_field(name="👤 Staff",    value=user.mention, inline=True)
        embed_orden.add_field(name="📖 Obra",     value=obra,         inline=True)
        embed_orden.add_field(name="🔢 Capítulo", value=cap,          inline=True)
        embed_orden.add_field(name="🎭 Rol",      value=rol,          inline=True)
        embed_orden.add_field(name="⏳ Vence",    value=f"<t:{int(vence.timestamp())}:R>", inline=True)
        embed_orden.set_footer(text="📋 Registrado en MySQL y Sheets  |  Entrega por formulario o cd!terminado")
        await ctx.send(content=user.mention, embed=embed_orden)

    except asyncio.TimeoutError:
        await ctx.send("⏱️ Tiempo agotado. Usa `cd!orden` de nuevo.", delete_after=10)
    except Exception as e:
        log.error(f"[orden] {e}")
        await ctx.send("❌ Error inesperado.", delete_after=10)

# --- REPORTES Y STAFF ────────────────────────────────────────────────────────

@bot.command()
async def reportar(ctx, usuario: discord.Member, *, error: str):
    """Registra un error a un miembro del staff"""
    db.staff_registrar(usuario.id, None, usuario.display_name)
    db.error_registrar(usuario.id, error, reportado_por=ctx.author.id)
    embed = discord.Embed(
        title="⚠️ ERROR REGISTRADO",
        description=(
            f"{usuario.mention}, se reportó un error:\n\n"
            f"**Error:** `{error}`\n\n"
            f"Reportado por {ctx.author.mention}."
        ),
        color=0xffa500
    )
    await ctx.send(content=usuario.mention, embed=embed)

@bot.command()
async def listo(ctx):
    """Marca tu tarea activa como entregada."""
    uid    = ctx.author.id
    tareas = db.tarea_get_por_usuario(uid)
    if not tareas:
        return await ctx.send("⚠️ No tienes tareas activas.", delete_after=7)

    tarea  = tareas[0]
    puntos = db.tarea_completar(tarea["id"])

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, sheets_marcar_entregado, tarea["id"])
    await loop.run_in_executor(None, sheets_actualizar_ranking, uid, ctx.author.display_name, puntos)

    embed = discord.Embed(
        title="✅ ¡Tarea entregada!",
        description=(
            f"**Obra:** {tarea['obra']}\n"
            f"**Capítulo:** {tarea['cap']} — {tarea['rol']}\n"
            f"**Puntos del mes:** {puntos} 🏅"
        ),
        color=0x00b300
    )
    await ctx.send(embed=embed)

@bot.command()
async def terminado(ctx):
    """Alias de cd!listo."""
    await ctx.invoke(bot.get_command("listo"))

@bot.command()
async def mis_tareas(ctx):
    """Muestra tus tareas activas."""
    tareas = db.tarea_get_por_usuario(ctx.author.id)
    if not tareas:
        return await ctx.send("✨ No tienes tareas activas ahora mismo.", delete_after=10)

    embed = discord.Embed(title="📋 Tus tareas activas", color=COLOR_CRIMSON)
    for t in tareas:
        limite_dt = t["limite"] if isinstance(t["limite"], datetime) \
                    else datetime.fromisoformat(str(t["limite"]))
        diff  = limite_dt - datetime.now()
        horas = int(diff.total_seconds() // 3600)
        estado_tiempo = f"🔴 ¡{abs(horas)}h de retraso!" if horas < 0 else f"⏰ {horas}h restantes"
        embed.add_field(
            name=f"📖 {t['obra']} — Cap. {t['cap']} ({t['rol']})",
            value=estado_tiempo,
            inline=False
        )
    await ctx.send(embed=embed)

@bot.command()
async def ranking(ctx):
    """Ranking mensual de productividad."""
    top = db.ranking_mes()
    if not top or all(m["puntos"] == 0 for m in top):
        return await ctx.send("📊 El ranking está vacío este mes.")

    medallas = ["🥇", "🥈", "🥉"]
    lista = ""
    for i, m in enumerate(top[:10]):
        if m["puntos"] == 0:
            continue
        medalla = medallas[i] if i < 3 else f"**#{i+1}**"
        nombre  = m["nombre_display"] or f"<@{m['discord_id']}>"
        lista  += f"{medalla} {nombre} — {m['puntos']} cap{'s' if m['puntos'] != 1 else ''}\n"

    embed = discord.Embed(
        title="📊 RANKING MENSUAL CRIMSON SCAN",
        description=lista,
        color=COLOR_CRIMSON
    )
    embed.set_footer(text="Se reinicia cada mes automáticamente.")
    await ctx.send(embed=embed)

@bot.command()
async def llamar_atencion(ctx, usuario: discord.Member):
    """Historial de errores de un miembro."""
    hist = db.errores_get(usuario.id)
    if not hist:
        return await ctx.send(f"✨ {usuario.mention} no tiene errores registrados.")

    txt = "\n".join([f"• [{str(e['fecha'])[:10]}] {e['error']}" for e in hist])
    embed = discord.Embed(
        title=f"🚫 EXPEDIENTE: {usuario.display_name}",
        description=txt,
        color=0xff0000
    )
    embed.set_footer(text=f"Total errores: {len(hist)}")
    await ctx.send(embed=embed)

@bot.command()
async def estadisticas(ctx):
    """Muestra estadísticas globales en tiempo real desde MySQL."""
    msg  = await ctx.send("🔄 Consultando base de datos...")
    loop = asyncio.get_running_loop()

    stats = await loop.run_in_executor(None, db.estadisticas_globales)
    top   = await loop.run_in_executor(None, db.ranking_mes)
    await msg.delete()

    ahora  = datetime.now()
    tasa   = round((stats["total_entre"] / stats["total_asig"] * 100), 1) if stats["total_asig"] else 0
    barras = int((tasa / 100) * 10)
    barra  = "█" * barras + "░" * (10 - barras)

    embed = discord.Embed(
        title="📊 ESTADÍSTICAS GLOBALES — CRIMSON SCAN",
        description=f"Mes: **{ahora.strftime('%B %Y')}**",
        color=COLOR_CRIMSON,
        timestamp=ahora
    )
    embed.add_field(
        name="━━━ 📌 RESUMEN GENERAL ━━━",
        value=(
            f"📋 Total asignaciones: **{stats['total_asig']}**\n"
            f"✅ Entregadas: **{stats['total_entre']}**\n"
            f"🔴 Retrasadas: **{stats['total_retra']}**\n"
            f"⏳ Pendientes: **{stats['total_pend']}**\n"
            f"📈 Tasa de entrega: `{barra}` **{tasa}%**"
        ),
        inline=False
    )
    embed.add_field(
        name="━━━ 🎯 TAREAS ACTIVAS ━━━",
        value=(
            f"🟡 En curso ahora: **{stats['tareas_activas']}**\n"
            f"🔴 Urgentes (24h): **{stats['urgentes_24h']}**"
        ),
        inline=True
    )
    if top:
        MEDALLAS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"]
        top5_txt = "\n".join([
            f"{MEDALLAS[i]} **{m['nombre_display'] or '<@' + str(m['discord_id']) + '>'}** — {m['puntos']} pts"
            for i, m in enumerate(top[:5]) if m["puntos"] > 0
        ])
        if top5_txt:
            embed.add_field(name="━━━ 🏅 TOP 5 STAFF ━━━", value=top5_txt, inline=False)

    embed.set_footer(text="Fuente: MySQL  |  Datos en tiempo real")
    await ctx.send(embed=embed)

@bot.command()
@commands.has_permissions(administrator=True)
async def aviso_staff(ctx, *, mensaje: str):
    """Anuncio global al staff"""
    await ctx.message.delete()
    embed = discord.Embed(
        title="⚠️ AVISO GENERAL DEL STAFF",
        description=mensaje, color=0xff0000,
        timestamp=datetime.now()
    )
    embed.set_footer(text=f"Enviado por {ctx.author.display_name}")
    await ctx.send(content="@everyone", embed=embed)

# --- COMANDOS DE GESTIÓN ─────────────────────────────────────────────────────

@bot.command()
async def urgentes(ctx):
    """Muestra capítulos con límite en las próximas 24h."""
    lista = db.tarea_urgentes(horas=24)
    if not lista:
        return await ctx.send("✅ No hay capítulos urgentes en las próximas 24h.")

    embed = discord.Embed(title="🔴 CAPÍTULOS URGENTES (24h)", color=0xff0000)
    for t in lista:
        limite = t["limite"] if isinstance(t["limite"], datetime) \
                 else datetime.fromisoformat(str(t["limite"]))
        horas = int((limite - datetime.now()).total_seconds() // 3600)
        embed.add_field(
            name=f"📖 {t['obra']} — Cap. {t['cap']} ({t['rol']})",
            value=f"<@{t['discord_id']}> | {'🔴 VENCIDO' if horas < 0 else f'⏰ {horas}h'}",
            inline=False
        )
    await ctx.send(embed=embed)

@bot.command()
async def estado(ctx, *, args: str):
    """
    Muestra el estado de los roles para un capítulo.
    Uso: cd!estado Naruto 5
    """
    partes = args.rsplit(' ', 1)
    if len(partes) < 2 or not partes[1].isdigit():
        return await ctx.send("Uso: `cd!estado <Obra> <Capitulo>`\nEj: `cd!estado Naruto 5`", delete_after=7)
    obra_raw = partes[0].strip().upper()
    cap      = partes[1].strip()

    cap_data   = db.cap_get(obra_raw, cap)
    tareas_cap = [
        t for t in db.tarea_get_todas_activas()
        if t["obra"].upper() == obra_raw and t["cap"] == cap
    ]

    embed = discord.Embed(title=f"📊 ESTADO — {obra_raw} Cap {cap}", color=COLOR_CRIMSON)

    ROLES_STATUS = {
        "Traductor":   ("traduccion", "🗒️ Traducción"),
        "Cleaner":     ("limpieza",   "✨ Limpieza"),
        "Typer":       ("typer",      "⌨️ Typeo"),
        "Proofreader": ("proof",      "✅ Proofreading"),
    }

    completados = 0
    total_roles = len(ROLES_STATUS)

    if cap_data:
        for rol, (campo, etiqueta) in ROLES_STATUS.items():
            hecho    = cap_data.get(campo, False)
            asignado = next((t for t in tareas_cap if t["rol"] == rol), None)
            if hecho:
                val = "✅ Completado"
                completados += 1
            elif asignado:
                limite = asignado["limite"] if isinstance(asignado["limite"], datetime) \
                         else datetime.fromisoformat(str(asignado["limite"]))
                horas  = (limite - datetime.now()).total_seconds() / 3600
                alerta = " 🔴" if horas <= 24 else ""
                val = f"⏳ En proceso — <@{asignado['discord_id']}> (vence <t:{int(limite.timestamp())}:R>){alerta}"
            else:
                val = "❏ Sin asignar"
            embed.add_field(name=etiqueta, value=val, inline=False)

        barras = int((completados / total_roles) * 10)
        barra  = "█" * barras + "░" * (10 - barras)
        embed.add_field(
            name="📊 Progreso General",
            value=f"`{barra}` {completados}/{total_roles} etapas completadas",
            inline=False
        )
        embed.set_footer(text=f"Estado general: {cap_data.get('estado', 'Pendiente')}")
    elif tareas_cap:
        for t in tareas_cap:
            limite = t["limite"] if isinstance(t["limite"], datetime) \
                     else datetime.fromisoformat(str(t["limite"]))
            horas  = (limite - datetime.now()).total_seconds() / 3600
            alerta = " 🔴" if horas <= 24 else ""
            embed.add_field(
                name=f"🎭 {t['rol']}",
                value=f"⏳ En proceso — <@{t['discord_id']}> (vence <t:{int(limite.timestamp())}:R>){alerta}",
                inline=False
            )
        embed.set_footer(text="Capítulo con tareas activas (sin registro local)")
    else:
        embed.description = f"No hay datos para **{obra_raw}** Cap **{cap}** en el sistema."
    await ctx.send(embed=embed)

@bot.command(name="tareas")
@commands.has_permissions(administrator=True)
async def ver_tareas_usuario(ctx, usuario: discord.Member):
    """(Admin) Muestra todas las tareas activas de un miembro especifico"""
    sus_tareas = db.tarea_get_por_usuario(usuario.id)
    if not sus_tareas:
        return await ctx.send(f"💭 {usuario.mention} no tiene tareas activas.", delete_after=7)
    embed = discord.Embed(title=f"📋 Tareas de {usuario.display_name}", color=COLOR_CRIMSON)
    for t in sus_tareas:
        limite = t["limite"] if isinstance(t["limite"], datetime) \
                 else datetime.fromisoformat(str(t["limite"]))
        horas  = (limite - datetime.now()).total_seconds() / 3600
        icono  = "🔴" if horas <= 24 else "🟡" if horas <= 72 else "🟢"
        embed.add_field(
            name=f"{icono} {t['obra']} — Cap {t['cap']} ({t['rol']})",
            value=f"Vence: <t:{int(limite.timestamp())}:R> | ID: `{t['id']}`",
            inline=False
        )
    embed.set_footer(text=f"Total: {len(sus_tareas)} tarea(s)")
    await ctx.send(embed=embed)

@bot.command()
@commands.has_permissions(administrator=True)
async def cancelar(ctx, usuario: discord.Member):
    """(Admin) Cancela todas las tareas activas de un miembro"""
    await ctx.message.delete()
    tareas = db.tarea_get_por_usuario(usuario.id)
    if not tareas:
        return await ctx.send(f"❌ {usuario.mention} no tiene tareas activas.", delete_after=7)

    loop = asyncio.get_running_loop()
    for t in tareas:
        db.tarea_cancelar(t["id"])
        await loop.run_in_executor(None, sheets_marcar_cancelado, t["id"])

    embed = discord.Embed(
        title="🗑️ TAREAS CANCELADAS",
        description=f"Se cancelaron **{len(tareas)} tarea(s)** de {usuario.mention}.",
        color=0xff6600
    )
    await ctx.send(embed=embed)

@bot.command()
@commands.has_permissions(administrator=True)
async def extender(ctx, usuario: discord.Member, dias: int = 1):
    """
    (Admin) Extiende el plazo de las tareas de un miembro X días.
    Uso: cd!extender @usuario 2
    """
    await ctx.message.delete()
    tareas = db.tarea_get_por_usuario(usuario.id)
    if not tareas:
        return await ctx.send(f"❌ {usuario.mention} no tiene tareas activas.", delete_after=7)
    if dias < 1 or dias > 30:
        return await ctx.send("❌ Los días deben estar entre 1 y 30.", delete_after=7)

    for t in tareas:
        db.tarea_extender(t["id"], dias)

    plural = "día" if dias == 1 else "días"
    embed  = discord.Embed(
        title="⏰ PLAZO EXTENDIDO",
        description=(
            f"Se extendió **{dias} {plural}** más a las tareas de {usuario.mention}.\n"
            f"Tareas afectadas: **{len(tareas)}**"
        ),
        color=0x00aaff
    )
    await ctx.send(embed=embed)

@bot.command(name="help")
async def help_cmd(ctx):
    """Muestra todos los comandos disponibles del bot"""
    embed = discord.Embed(
        title="📖 CRIMSON SCAN BOT — Comandos",
        description="Prefijo: `cd!`",
        color=COLOR_CRIMSON
    )
    embed.add_field(name="━━━ 📋 OBRAS & DRIVE ━━━", value="​", inline=False)
    embed.add_field(name="`cd!nueva_obra <nombre>`",   value="Crea obra + carpetas en Drive *(admin)*", inline=True)
    embed.add_field(name="`cd!importar <Obra> 1 2 3`", value="Importa capítulos a una obra *(admin)*", inline=True)
    embed.add_field(name="`cd!series`",                value="Catálogo de obras del bot", inline=True)
    embed.add_field(name="`cd!carpetas`",              value="Lista proyectos en Drive", inline=True)
    embed.add_field(name="`cd!carpetas <nombre>`",     value="Capítulos de un proyecto en Drive", inline=True)
    embed.add_field(name="​",                          value="​", inline=True)

    embed.add_field(name="━━━ 📜 TAREAS & STAFF ━━━", value="​", inline=False)
    embed.add_field(name="`cd!orden`",                 value="Asignar tarea paso a paso", inline=True)
    embed.add_field(name="`cd!estado <Obra> <Cap>`",   value="Progreso por rol de un cap.", inline=True)
    embed.add_field(name="`cd!urgentes`",              value="Tareas que vencen en 24h 🔴", inline=True)
    embed.add_field(name="`cd!mis_tareas`",            value="Tus tareas activas", inline=True)
    embed.add_field(name="`cd!terminado`",             value="Marcar tu tarea como hecha", inline=True)
    embed.add_field(name="`cd!ranking`",               value="Ranking mensual del staff", inline=True)
    embed.add_field(name="`cd!mi_usuario <nombre>`",   value="Vincular apodo del formulario", inline=True)

    embed.set_footer(text="Continua en el siguiente mensaje ⤵️")
    await ctx.send(embed=embed)

    embed2 = discord.Embed(title="📖 CRIMSON SCAN BOT — Comandos (2/2)", color=COLOR_CRIMSON)
    embed2.add_field(name="━━━ ⚙️ ADMINISTRACIÓN *(solo admin)* ━━━", value="​", inline=False)
    embed2.add_field(name="`cd!tareas @usuario`",       value="Ver tareas de cualquier miembro", inline=True)
    embed2.add_field(name="`cd!cancelar @usuario`",     value="Cancela todas las tareas de un miembro", inline=True)
    embed2.add_field(name="`cd!extender @usuario <N>`", value="Extiende plazo N días", inline=True)
    embed2.add_field(name="`cd!set_canal #canal`",      value="Canal para alertas y recordatorios", inline=True)
    embed2.add_field(name="`cd!ver_usuarios`",          value="Staff registrado en MySQL", inline=True)
    embed2.add_field(name="`cd!aviso_staff <msg>`",     value="Anuncio general al servidor", inline=True)

    embed2.add_field(name="━━━ ⚠️ REPORTES DE ERRORES ━━━", value="​", inline=False)
    embed2.add_field(name="`cd!reportar @usuario <error>`", value="Registra un error en el expediente", inline=True)
    embed2.add_field(name="`cd!listo`",                      value="Marca tu tarea como entregada", inline=True)
    embed2.add_field(name="`cd!llamar_atencion @usuario`",   value="Historial de errores de un miembro", inline=True)

    embed2.set_footer(text="🤖 Crimson Scan Manager  |  Recordatorio automático todos los días a las 9am ☀️")
    await ctx.send(embed=embed2)

# --- ERRORES DE COMANDOS ─────────────────────────────────────────────────────

@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.MissingPermissions):
        await ctx.send("🚫 No tienes permisos para usar ese comando.", delete_after=7)
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"❌ Falta un argumento: `{error.param.name}`. Usa `cd!help` para ver el uso correcto.", delete_after=10)
    elif isinstance(error, commands.MemberNotFound):
        await ctx.send("❌ Miembro no encontrado. Asegúrate de mencionarlo con @.", delete_after=7)
    elif isinstance(error, commands.BadArgument):
        await ctx.send("❌ Argumento inválido. Ejemplo: `cd!extender @usuario 3`", delete_after=7)
    elif isinstance(error, commands.CommandNotFound):
        pass
    else:
        log.error(f"[Error] {ctx.command}: {error}")
        await ctx.send(f"❌ Ocurrió un error inesperado: `{str(error)[:100]}`", delete_after=10)

# --- ARRANQUE ─────────────────────────────────────────────────────────────────
TOKEN = os.getenv('DISCORD_TOKEN')
if not TOKEN:
    log.critical("❌ DISCORD_TOKEN no encontrado en .env")
    exit(1)

bot.run(TOKEN)
