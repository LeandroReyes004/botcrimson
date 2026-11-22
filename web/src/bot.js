// API para el bot de Discord. Se autentica con: Authorization: Bearer <BOT_API_KEY>
import { fallo, json, iguales, discordId, entero, ROLES, tokenAleatorio, ahoraISO, config } from "./util.js";
import { perfil, tareasDe, ranking, mercado, tomarTarea, entregarTarea, solicitar, filtrarMercado, filtrarRanking } from "./tareas.js";
import { leerPermisos, permisosDe } from "./permisos.js";
import { liberarTareasDe } from "./admin.js";

async function staffPorDiscord(env, id) {
  const s = await env.DB.prepare("SELECT * FROM staff WHERE discord_id = ?").bind(discordId(id)).first();
  if (!s) fallo("Esa persona no está registrada en el panel", 404);
  return s;
}

export async function rutasBot(req, env, ruta, url) {
  const clave = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.BOT_API_KEY || !iguales(clave, env.BOT_API_KEY)) fallo("Clave del bot inválida", 401);
  const m = req.method;
  const q = (k) => url.searchParams.get(k);
  const body = m === "POST" ? await req.json().catch(() => ({})) : {};

  // Permisos de quien escribe el comando (pide = ID de Discord del autor)
  const permisos = leerPermisos(await config(env));
  const permisosDePide = async (id) => {
    const s = await staffPorDiscord(env, id);
    return { s, puedo: permisosDe(s, permisos) };
  };
  const exigeBot = (puedo, clave) => { if (!puedo[clave]) fallo("No tienes permiso para esto. Pídeselo a un admin.", 403); };

  if (ruta === "perfil" && m === "GET") return json(await perfil(env, await staffPorDiscord(env, q("discord_id"))));
  if (ruta === "tareas" && m === "GET") {
    const objetivo = await staffPorDiscord(env, q("discord_id"));
    if (q("pide") && q("pide") !== q("discord_id")) exigeBot((await permisosDePide(q("pide"))).puedo, "ver_tareas_otros");
    return json(await tareasDe(env, objetivo.id));
  }
  if (ruta === "ranking" && m === "GET") {
    const { s, puedo } = await permisosDePide(q("pide"));
    exigeBot(puedo, "ver_ranking");
    return json(filtrarRanking(await ranking(env, Number(q("mes") || 0)), s.id, puedo));
  }
  if (ruta === "mercado" && m === "GET") {
    const { s, puedo } = await permisosDePide(q("discord_id"));
    exigeBot(puedo, "ver_mercado");
    const caps = filtrarMercado(await mercado(env, s), puedo);
    return json(caps.filter((c) => ROLES.some((r) => c.roles[r].estado === "libre")));
  }
  if (ruta === "tomar" && m === "POST") {
    const { s, puedo } = await permisosDePide(body.discord_id);
    exigeBot(puedo, "tomar_tareas");
    return json(await tomarTarea(env, s, entero(body.capitulo_id, "capitulo_id", 1, 1e9), String(body.rol), "discord"));
  }
  if (ruta === "entregar" && m === "POST") {
    const s = await staffPorDiscord(env, body.discord_id);
    return json(await entregarTarea(env, s, entero(body.tarea_id, "tarea_id", 1, 1e9)));
  }
  if (ruta === "solicitar" && m === "POST") {
    const s = await staffPorDiscord(env, body.discord_id);
    return json(await solicitar(env, s, entero(body.tarea_id, "tarea_id", 1, 1e9), body.tipo, Number(body.dias), body.motivo));
  }
  // Enlace de un solo uso (30 min) para crear o cambiar la contraseña del panel; el bot lo manda por DM
  if (ruta === "enlace-acceso" && m === "POST") {
    const s = await staffPorDiscord(env, body.discord_id);
    if (!s.activo) fallo("Tu cuenta está desactivada. Habla con un líder.", 403);
    const token = tokenAleatorio();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM accesos WHERE staff_id = ? OR expira < ?").bind(s.id, ahoraISO()),
      env.DB.prepare("INSERT INTO accesos (token, staff_id, expira) VALUES (?, ?, ?)")
        .bind(token, s.id, new Date(Date.now() + 30 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z")),
    ]);
    return json({ url: `${url.origin}/#acceso=${token}`, usuario: s.usuario, minutos: 30 });
  }
  if (ruta === "miembro-salio" && m === "POST") {
    const s = await env.DB.prepare("SELECT * FROM staff WHERE discord_id = ?").bind(discordId(body.discord_id)).first();
    if (!s || !s.activo) return json({ ok: true, cambios: 0 });
    await env.DB.batch([
      env.DB.prepare("UPDATE staff SET activo = 0 WHERE id = ?").bind(s.id),
      env.DB.prepare("DELETE FROM sesiones WHERE staff_id = ?").bind(s.id),
    ]);
    const liberadas = await liberarTareasDe(env, null, s, "salió del servidor");
    return json({ ok: true, cambios: 1, liberadas });
  }
  // El bot manda la lista completa de IDs del servidor; se desactiva a quien ya no esté
  if (ruta === "sincronizar" && m === "POST") {
    const ids = new Set((body.discord_ids || []).map(String));
    if (ids.size < 2) fallo("Lista de miembros vacía; no se sincroniza por seguridad");
    const { results } = await env.DB.prepare("SELECT * FROM staff WHERE activo = 1 AND discord_id IS NOT NULL").all();
    const fuera = results.filter((s) => !ids.has(s.discord_id) && s.nivel !== "admin");
    // Si faltaría más de la mitad, seguramente el bot no cargó bien los miembros: no tocar nada
    if (fuera.length > Math.max(3, results.length / 2) && !body.forzar) fallo(`Se desactivarían ${fuera.length} de ${results.length}. Revisa el intent de miembros del bot.`, 409);
    for (const s of fuera) {
      await env.DB.prepare("UPDATE staff SET activo = 0 WHERE id = ?").bind(s.id).run();
      await env.DB.prepare("DELETE FROM sesiones WHERE staff_id = ?").bind(s.id).run();
      await liberarTareasDe(env, null, s, "ya no está en el servidor");
    }
    return json({ ok: true, desactivados: fuera.map((s) => s.nombre) });
  }
  fallo("Ruta del bot no encontrada", 404);
}
