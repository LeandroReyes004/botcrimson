import discord
from discord.ext import commands, tasks
import os
import logging
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()
import db_mysql as db

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
CANAL_LIDERES_ID = 1503832157729198203

@bot.event
async def on_ready():
    log.info(f"✅ Conectado como {bot.user} en modo Solo Consulta.")
    if not alerta_lideres.is_running():
        alerta_lideres.start()

# --- COMANDOS DE CONSULTA ---

@bot.command(name="help")
async def help_cmd(ctx):
    embed = discord.Embed(title="📚 Comandos del Bot (Modo Consulta)", color=COLOR_CRIMSON)
    embed.add_description("El bot ahora funciona como asistente de consulta rápida. Todas las asignaciones, entregas y creación de proyectos se hacen exclusivamente desde la Web.")
    embed.add_field(name="`cd!mis_tareas`", value="Mira qué tareas tienes pendientes y sus fechas límite.", inline=False)
    embed.add_field(name="`cd!tareas @usuario`", value="Mira las tareas pendientes de algún otro miembro del staff.", inline=False)
    embed.add_field(name="`cd!mi_perfil`", value="Mira tu historial de entregas y averigua si estás cumpliendo tu cuota.", inline=False)
    embed.add_field(name="`cd!ranking`", value="El salón de la fama del scan basado en el sistema de puntos.", inline=False)
    await ctx.send(embed=embed)

@bot.command()
async def mis_tareas(ctx):
    await ver_tareas_usuario(ctx, ctx.author)

@bot.command(name="tareas")
async def ver_tareas_usuario(ctx, usuario: discord.Member):
    filas = db._exec("SELECT id, obra, cap, rol, limite FROM tareas WHERE discord_id=%s AND estado='activa' ORDER BY limite ASC", (usuario.id,), fetch="all")
    if not filas:
        await ctx.send(f"✅ **{usuario.display_name}** no tiene ninguna tarea pendiente. ¡Todo limpio!")
        return
        
    embed = discord.Embed(title=f"📋 Tareas Pendientes de {usuario.display_name}", color=COLOR_CRIMSON)
    for t in filas:
        dias = (t['limite'] - datetime.now()).days if t['limite'] else 0
        estado = f"🟢 Faltan {dias}d" if dias > 1 else (f"🟠 Faltan {dias}d" if dias >= 0 else f"🔴 ¡Atrasado por {abs(dias)}d!")
        fecha_str = t['limite'].strftime('%d/%m/%Y') if t['limite'] else "Sin límite"
        
        embed.add_field(
            name=f"{t['obra']} - Cap {t['cap']} ({t['rol']})", 
            value=f"📅 Vence: {fecha_str} | {estado}", 
            inline=False
        )
    await ctx.send(embed=embed)

@bot.command()
async def mi_perfil(ctx):
    # Cuántas ha entregado este mes
    res_mes = db._exec("SELECT COUNT(*) as c FROM tareas WHERE discord_id=%s AND estado='entregada' AND MONTH(creado) = MONTH(CURRENT_DATE()) AND YEAR(creado) = YEAR(CURRENT_DATE())", (ctx.author.id,), fetch="one")
    # Cuántas ha entregado en total
    res_tot = db._exec("SELECT COUNT(*) as c FROM tareas WHERE discord_id=%s AND estado='entregada'", (ctx.author.id,), fetch="one")
    # Ranking
    res_rank = db._exec("SELECT puntos_totales FROM v_ranking_mes WHERE discord_id=%s", (ctx.author.id,), fetch="one")
    
    entregadas_mes = res_mes['c'] if res_mes else 0
    entregadas_tot = res_tot['c'] if res_tot else 0
    pts = res_rank['puntos_totales'] if res_rank else 0
    
    embed = discord.Embed(title=f"👤 Perfil de {ctx.author.display_name}", color=COLOR_CRIMSON)
    
    avatar_url = ctx.author.avatar.url if ctx.author.avatar else ctx.author.default_avatar.url
    embed.set_thumbnail(url=avatar_url)
    
    embed.add_field(name="🏆 Puntos del mes", value=f"**{pts} pts**", inline=True)
    embed.add_field(name="📘 Caps. este mes", value=f"**{entregadas_mes}** entregados", inline=True)
    embed.add_field(name="📚 Caps. totales", value=f"**{entregadas_tot}** entregados", inline=True)
    
    # Check cuota (ejemplo: 3 al mes)
    if entregadas_mes >= 3:
        cuota_msg = "✅ **¡Cumpliendo cuota mensual!** Buen trabajo."
    else:
        cuota_msg = f"⚠️ Te faltan **{3 - entregadas_mes}** capítulos para la cuota mínima mensual (3)."
        
    embed.add_field(name="📊 Estado de Cuota", value=cuota_msg, inline=False)
    
    await ctx.send(embed=embed)

@bot.command()
async def ranking(ctx):
    filas = db._exec("SELECT * FROM v_ranking_mes ORDER BY puntos_totales DESC LIMIT 10", fetch="all")
    if not filas:
        await ctx.send("Todavía no hay suficientes datos para el ranking de este mes.")
        return
        
    embed = discord.Embed(title="🏆 Ranking de Staff del Mes", color=COLOR_CRIMSON)
    texto = ""
    for i, r in enumerate(filas):
        texto += f"**{i+1}. {r['nombre']}** - {r['puntos_totales']} pts ({r['tareas_completadas']} capítulos)\n"
    embed.description = texto
    await ctx.send(embed=embed)


# --- ALERTA DIARIA A LIDERES ---
@tasks.loop(hours=24)
async def alerta_lideres():
    canal = bot.get_channel(CANAL_LIDERES_ID)
    if not canal: 
        log.warning(f"No se pudo encontrar el canal de líderes con ID {CANAL_LIDERES_ID}")
        return
    
    filas = db._exec("SELECT id, discord_id, obra, cap, rol, limite FROM tareas WHERE estado='activa' ORDER BY limite ASC", fetch="all")
    if not filas: return
    
    hoy = datetime.now()
    atrasadas = []
    riesgo = []
    
    for t in filas:
        if not t['limite']: continue
        dias = (t['limite'] - hoy).days
        if dias < 0:
            atrasadas.append(t)
        elif dias <= 1:
            riesgo.append(t)
            
    if not atrasadas and not riesgo:
        return
        
    embed = discord.Embed(title="🚨 Reporte Diario de Tareas en Riesgo", color=0xFF0000)
    
    if atrasadas:
        txt = ""
        for t in atrasadas:
            miembro = bot.get_user(t['discord_id'])
            nom = miembro.mention if miembro else f"<@{t['discord_id']}>"
            txt += f"🔴 {nom} - {t['obra']} {t['cap']} ({t['rol']}) [Retraso: {abs((t['limite']-hoy).days)}d]\n"
        embed.add_field(name="⚠️ TAREAS VENCIDAS", value=txt[:1024], inline=False)
        
    if riesgo:
        txt = ""
        for t in riesgo:
            miembro = bot.get_user(t['discord_id'])
            nom = miembro.mention if miembro else f"<@{t['discord_id']}>"
            txt += f"🟠 {nom} - {t['obra']} {t['cap']} ({t['rol']}) [Vence pronto]\n"
        embed.add_field(name="⏳ VENCEN HOY/MAÑANA", value=txt[:1024], inline=False)
        
    await canal.send("¡Atención líderes! Resumen automático del sistema sobre entregas:", embed=embed)

@alerta_lideres.before_loop
async def before_alerta_lideres():
    await bot.wait_until_ready()

# --- ARRANQUE ---
if __name__ == "__main__":
    TOKEN = os.getenv('DISCORD_TOKEN')
    if not TOKEN:
        log.critical("❌ DISCORD_TOKEN no encontrado en .env")
        exit(1)
    bot.run(TOKEN)
