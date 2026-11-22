"""
CrimsonScan bot — asistente de Discord del panel de Crimson Scan.
El bot es solo para CONSULTAR: tomar, entregar y subir archivos se hace en el panel web.
Los avisos y el reporte diario a líderes los manda el panel por webhook; el bot también mantiene la lista de staff.
"""
import os
import logging
import discord
from discord.ext import commands, tasks
from dotenv import load_dotenv

from api_client import PanelAPI, ApiError

load_dotenv()
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("crimson")

intents = discord.Intents.default()
intents.message_content = True
intents.members = True  # necesario para saber quién está en el servidor

bot = commands.Bot(command_prefix="cd!", intents=intents, help_command=None, case_insensitive=True)
api = PanelAPI()
COLOR = 0x660000
PANEL = os.getenv("PANEL_URL", "").rstrip("/")


def emoji_tiempo(t):
    r = t.get("restante") or ""
    if r.startswith("atrasada"):
        return "🔴"
    if "faltan" in r and " d " not in r:
        return "🟠"  # menos de un día
    return "🟢"


@bot.event
async def on_ready():
    log.info(f"✅ Conectado como {bot.user}")
    if not sincronizacion_diaria.is_running():
        sincronizacion_diaria.start()


@bot.event
async def on_command_error(ctx, error):
    error = getattr(error, "original", error)
    if isinstance(error, ApiError):
        await ctx.send(f"⚠️ {error}")
    elif isinstance(error, commands.MissingPermissions):
        await ctx.send("⛔ Solo administradores pueden usar ese comando.")
    elif isinstance(error, (commands.MissingRequiredArgument, commands.BadArgument)):
        await ctx.send(f"Uso incorrecto. Escribe `cd!help` para ver cómo se usa `cd!{ctx.command}`.")
    elif isinstance(error, commands.CommandNotFound):
        return
    else:
        log.exception("Error en comando", exc_info=error)
        await ctx.send("❌ Ocurrió un error inesperado.")


@bot.event
async def on_member_remove(member):
    try:
        r = await api.miembro_salio(member.id)
        if r.get("cambios"):
            log.info(f"👤 {member.display_name} salió; desactivado en el panel ({r.get('liberadas', 0)} tareas liberadas).")
    except ApiError as e:
        log.warning(f"No se pudo desactivar a {member.id}: {e}")


# ───────────────────────── Comandos ─────────────────────────

@bot.command(name="tomar", aliases=["entregar", "extension", "extensión"])
async def solo_panel(ctx, *_):
    await ctx.send(f"🔒 Eso ahora se hace en el panel: {PANEL}\nAquí solo se consulta (`cd!help`).")


@bot.command(name="help", aliases=["ayuda"])
async def ayuda(ctx):
    e = discord.Embed(title="📚 Comandos de Crimson Scan", color=COLOR,
                      description=f"Aquí solo se consulta. Para tomar, entregar o subir archivos entra al panel: {PANEL}")
    e.add_field(name="`cd!mis_tareas`", value="Tus tareas activas, cuánto te queda y si ya tienen RAW.", inline=False)
    e.add_field(name="`cd!tareas @usuario`", value="Las tareas activas de otra persona.", inline=False)
    e.add_field(name="`cd!mercado`", value="Capítulos con roles libres.", inline=False)
    e.add_field(name="`cd!raws`", value="Capítulos a los que todavía les falta subir la RAW.", inline=False)
    e.add_field(name="`cd!mi_perfil`", value="Tus puntos y cuota del mes.", inline=False)
    e.add_field(name="`cd!ranking`", value="Top del mes.", inline=False)
    e.add_field(name="`cd!acceso`", value="Te mando por privado un enlace para crear o cambiar tu contraseña del panel.", inline=False)
    await ctx.send(embed=e)


@bot.command(name="mis_tareas", aliases=["mistareas"])
async def mis_tareas(ctx):
    await _mostrar_tareas(ctx, ctx.author)


@bot.command(name="tareas")
async def tareas_de(ctx, usuario: discord.Member):
    await _mostrar_tareas(ctx, usuario)


async def _mostrar_tareas(ctx, miembro):
    lista = await api.tareas(miembro.id, ctx.author.id)
    if not lista:
        await ctx.send(f"✅ **{miembro.display_name}** no tiene tareas pendientes.")
        return
    e = discord.Embed(title=f"📋 Tareas de {miembro.display_name}", color=COLOR)
    for t in lista[:25]:
        extra = ""
        if t.get("solicitud") == "extension":
            extra = f"\n⏳ Pidió +{t['solicitud_dias']} días"
        elif t.get("solicitud") == "cancelacion":
            extra = "\n⏳ Pidió cancelar"
        raw = "📦 RAW lista" if t.get("raws") else "📭 Sin RAW todavía"
        e.add_field(name=f"#{t['id']} · {t['obra']} cap. {t['cap']} ({t['rol_nombre']})",
                    value=f"{emoji_tiempo(t)} {t['restante']} · {raw}{extra}", inline=False)
    await ctx.send(embed=e)


@bot.command(name="mercado")
async def mercado(ctx):
    caps = await api.mercado(ctx.author.id)
    if not caps:
        await ctx.send("No hay tareas libres ahora mismo.")
        return
    lineas = []
    for c in caps:
        libres = [r for r, x in c["roles"].items() if x["estado"] == "libre"]
        mias = [r for r in libres if c["roles"][r].get("puedo")]
        marca = "⭐ " if mias else ""
        raw = " 📦" if c.get("raws") else ""
        lineas.append(f"{marca}**{c['obra']}** cap. {c['numero']}{raw}: {', '.join(libres)}")
    texto = "\n".join(lineas)
    e = discord.Embed(title="🛒 Mercado de tareas", color=COLOR, description=texto[:4000])
    e.set_footer(text="⭐ = hay un rol que puedes tomar · Tómalo en el panel")
    await ctx.send(embed=e)




@bot.command(name="raws", aliases=["faltan_raws"])
async def raws(ctx):
    obras = await api.faltan_raws(ctx.author.id)
    if not obras:
        await ctx.send("✅ Todos los capítulos en proceso ya tienen su RAW en el panel.")
        return
    def rangos(caps):
        # 1,2,3,5 -> "1–3, 5" (solo junta enteros seguidos)
        out, ini, prev = [], None, None
        for c in caps:
            try:
                n = float(c)
            except ValueError:
                n = None
            if ini is not None and n is not None and prev is not None and n == prev + 1 and n.is_integer():
                prev = n
                continue
            if ini is not None:
                out.append(ini if ini == fmt(prev) else f"{ini}–{fmt(prev)}")
            ini, prev = c, n
        if ini is not None:
            out.append(ini if ini == fmt(prev) else f"{ini}–{fmt(prev)}")
        return ", ".join(out)
    def fmt(n):
        return "" if n is None else (str(int(n)) if float(n).is_integer() else str(n))
    total = sum(len(o["caps"]) for o in obras)
    e = discord.Embed(title=f"📭 Faltan RAWs: {total} capítulos", color=COLOR,
                      description="Súbelas en el panel: Proyectos → la obra → Subir RAWs.")
    for o in obras[:25]:
        e.add_field(name=f"{o['obra']} ({len(o['caps'])})", value=rangos(o["caps"])[:1024], inline=False)
    await ctx.send(embed=e)


@bot.command(name="mi_perfil", aliases=["perfil"])
async def mi_perfil(ctx):
    p = await api.perfil(ctx.author.id)
    e = discord.Embed(title=f"👤 {p['nombre']}", color=COLOR)
    e.set_thumbnail(url=ctx.author.display_avatar.url)
    e.add_field(name="🏆 Puntos del mes", value=f"**{p['puntos_mes']}**", inline=True)
    e.add_field(name="📘 Entregas del mes", value=f"**{p['entregas_mes']}** / {p['cuota']}", inline=True)
    e.add_field(name="📚 Totales", value=f"**{p['entregas_total']}**", inline=True)
    falta = p["cuota"] - p["entregas_mes"]
    e.add_field(name="📊 Cuota", value="✅ ¡Cumpliendo la cuota!" if p["cumple_cuota"] else f"⚠️ Te faltan **{falta}** entregas este mes.", inline=False)
    await ctx.send(embed=e)


@bot.command(name="ranking", aliases=["top"])
async def ranking(ctx):
    filas = await api.ranking(ctx.author.id)
    if not filas:
        await ctx.send("Todavía no hay puntos este mes.")
        return
    medallas = ["🥇", "🥈", "🥉"]
    def linea(i, r):
        puesto = medallas[i] if i < 3 else f"**{i+1}.**"
        if r.get("oculto"):  # el admin decidió no mostrar los puntos de los demás
            return f"{puesto} {r['nombre']}"
        return f"{puesto} {r['nombre']}: **{r['puntos']} pts** ({r['entregas']} entregas)"
    texto = "\n".join(linea(i, r) for i, r in enumerate(filas[:10]))
    await ctx.send(embed=discord.Embed(title="🏆 Ranking del mes", color=COLOR, description=texto))


@bot.command(name="acceso", aliases=["clave", "password"])
async def acceso(ctx):
    r = await api.enlace_acceso(ctx.author.id)
    try:
        usuario = f"Tu usuario es **{r['usuario']}**.\n" if r.get("usuario") else "Elige un usuario al abrir el enlace.\n"
        await ctx.author.send(f"🔑 Enlace para crear o cambiar tu contraseña del panel (vale {r['minutos']} min y sirve una vez):\n{r['url']}\n{usuario}No lo compartas con nadie.")
        if ctx.guild:
            await ctx.send("📬 Te mandé el enlace por mensaje privado.")
    except discord.Forbidden:
        await ctx.send("No pude mandarte un mensaje privado. Activa los DMs del servidor y vuelve a intentarlo.")


@bot.command(name="sincronizar_staff")
@commands.has_permissions(administrator=True)
async def sincronizar_staff(ctx):
    r = await _sincronizar(ctx.guild)
    nombres = r.get("desactivados", [])
    await ctx.send(f"✅ Sincronizado. Desactivados: **{len(nombres)}**" + (f" ({', '.join(nombres)})" if nombres else ""))


async def _sincronizar(guild):
    if not guild.chunked:
        await guild.chunk()  # asegura tener la lista completa de miembros antes de comparar
    return await api.sincronizar([m.id for m in guild.members])


@tasks.loop(hours=24)
async def sincronizacion_diaria():
    for guild in bot.guilds:
        try:
            r = await _sincronizar(guild)
            if r.get("desactivados"):
                log.info(f"[Sync] {guild.name}: desactivados {r['desactivados']}")
        except ApiError as e:
            log.warning(f"[Sync] {guild.name}: {e}")


@sincronizacion_diaria.before_loop
async def antes_de_sync():
    await bot.wait_until_ready()


if __name__ == "__main__":
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        log.critical("❌ Falta DISCORD_TOKEN en el .env")
        raise SystemExit(1)
    bot.run(token)
