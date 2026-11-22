# Crimson Scan: panel + bot

Sistema de gestión del scan: mercado de tareas, staff, proyectos, capítulos, ranking y avisos en Discord.

```
web/   Panel web y API (Cloudflare Workers + D1). También manda los avisos y el reporte diario por webhook.
main.py, api_client.py   Bot de Discord (Python). Solo habla con la API del panel, nunca con la base de datos.
```

## Cómo funciona

- **Una sola base de datos (D1)**. El bot y la web usan la misma API, así que no se desincronizan.
- **Mercado de tareas**: cada capítulo tiene 3 roles (traducción, limpieza y typeo); cuando los 3 se entregan, pasa a "Listo". Cada miembro toma las de su rol.
  Nadie puede tomar una tarea ya tomada ni una ya entregada (lo garantiza la base de datos, no solo el código).
- **Plazos**: 3 días por defecto. Pasado el límite más las horas de gracia, la tarea vence sola: resta puntos y vuelve al mercado.
  Si la persona pidió extensión, se espera a que un líder decida.
- **Puntos**: cada suma o resta queda registrada con su motivo. El ranking se calcula por mes en la zona horaria del scan.
- **Avisos**: tareas tomadas, entregadas, vencidas, extensiones y cancelaciones van al canal de avisos. El reporte diario va al canal de líderes.
- **Contraseñas**: nadie necesita que un admin le dé una. Con `cd!acceso` el bot manda por privado un enlace de un solo uso (30 min).

## Desplegar el panel

```bash
cd web
npm install
npx wrangler login
npx wrangler d1 create crimson-panel-db            # copia el database_id a wrangler.toml
npx wrangler r2 bucket create crimson-archivos
npm run db:remote                            # crea las tablas
npx wrangler secret put BOT_API_KEY          # inventa una clave larga; el bot usa la misma
npx wrangler secret put DISCORD_WEBHOOK_URL  # webhook del canal de avisos
npx wrangler secret put DISCORD_WEBHOOK_LIDERES   # webhook del canal de líderes
npm run deploy
```

Después descomenta `routes` en `web/wrangler.toml` con tu subdominio (por ejemplo `panel.scancrimson.com`), vuelve a hacer `npm run deploy`
y entra enseguida para crear el administrador (la primera pantalla lo pide).

### Pasar los datos del MySQL viejo

```bash
pip install PyMySQL
DB_HOST=... DB_USER=... DB_PASS=... DB_NAME=crimson_scan python web/scripts/migrar_desde_mysql.py > migracion.sql
npx wrangler d1 execute crimson-panel-db --remote --file=migracion.sql
```

Hazlo antes de crear el administrador si quieres conservar tu usuario viejo. Las contraseñas viejas no se migran: cada uno usa `cd!acceso`.

## Bot de Discord

Copia `.env.example` a `.env` y rellena `DISCORD_TOKEN`, `PANEL_URL` y `BOT_API_KEY`. Activa el intent **Server Members** en el portal de Discord.

```bash
pip install -r requirements.txt
python main.py
```

Comandos: `cd!help`, `cd!mis_tareas`, `cd!tareas @usuario`, `cd!mercado`, `cd!tomar <id> <rol>`, `cd!entregar <id>`,
`cd!extension <id> <días> [motivo]`, `cd!mi_perfil`, `cd!ranking`, `cd!acceso`, `cd!sincronizar_staff` (admin).

## Probar en local

```bash
cd web
npm install
npm run db:local
echo 'BOT_API_KEY=prueba' > .dev.vars
npm run dev     # http://localhost:8787
```
