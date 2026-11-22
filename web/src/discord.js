// Login con Discord (OAuth2, scope "identify"). Solo entra quien ya está en el staff con ese ID de Discord.
import { tokenAleatorio, registrar } from "./util.js";

const cookie = (req, n) => (req.headers.get("cookie") || "").match(new RegExp(`(?:^|; )${n}=([^;]+)`))?.[1];
const BORRAR_ESTADO = "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0";

function redirigir(destino, cookies = []) {
  const h = new Headers({ location: destino, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

export const discordActivo = (env) => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);

export async function rutasDiscord(req, env, ruta, url, crearSesion) {
  const redirectUri = `${url.origin}/api/auth/discord/callback`;
  const base = env.DISCORD_API_BASE || "https://discord.com/api"; // se puede cambiar solo para pruebas

  if (!discordActivo(env)) return redirigir("/#error=discord-off");

  // 1) Mandar a Discord a autorizar
  if (ruta === "auth/discord") {
    const estado = tokenAleatorio();
    const u = new URL("https://discord.com/oauth2/authorize");
    u.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: "code", scope: "identify",
      redirect_uri: redirectUri, state: estado, prompt: "none" }).toString();
    return redirigir(u.toString(), [`oauth_state=${estado}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600`]);
  }

  // 2) Discord vuelve aquí con ?code=...&state=...
  if (ruta === "auth/discord/callback") {
    const code = url.searchParams.get("code");
    const estado = url.searchParams.get("state");
    if (url.searchParams.get("error")) return redirigir("/#error=cancelado", [BORRAR_ESTADO]);
    if (!code || !estado || estado !== cookie(req, "oauth_state")) return redirigir("/#error=estado", [BORRAR_ESTADO]);

    const rt = await fetch(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    if (!rt.ok) { console.error("discord token", rt.status, await rt.text()); return redirigir("/#error=discord", [BORRAR_ESTADO]); }
    const { access_token } = await rt.json();
    const ru = await fetch(`${base}/users/@me`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!ru.ok) return redirigir("/#error=discord", [BORRAR_ESTADO]);
    const du = await ru.json();
    const id = String(du.id || "");
    if (!/^\d{15,22}$/.test(id)) return redirigir("/#error=discord", [BORRAR_ESTADO]);

    const s = await env.DB.prepare("SELECT * FROM staff WHERE discord_id = ?").bind(id).first();
    const ip = req.headers.get("cf-connecting-ip") || "";
    if (!s) {
      await registrar(env, null, "login_discord_rechazado", { discord_id: id, usuario: du.username, ip });
      return redirigir("/#error=no-registrado", [BORRAR_ESTADO]);
    }
    if (!s.activo) return redirigir("/#error=desactivado", [BORRAR_ESTADO]);
    await registrar(env, s.id, "login", { ip, via: "discord" });
    return redirigir("/", [BORRAR_ESTADO, await crearSesion(env, s.id)]);
  }
  return redirigir("/");
}
