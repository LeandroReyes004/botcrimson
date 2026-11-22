// Crimson Scan: panel de gestión en Cloudflare Workers + D1 (+ R2 para subidas en la siguiente fase)
import { ApiError, fallo, json, texto, entero, hashPassword, verificarPassword, tokenAleatorio, ahoraISO, sumarDias, config, registrar } from "./util.js";
import * as T from "./tareas.js";
import * as A from "./admin.js";
import { rutasBot } from "./bot.js";
import { ejecutarCron, reporteDiario, vencerTareas } from "./cron.js";

const DIAS_SESION = 7;
const MAX_INTENTOS = 5;

const cookie = (req, n) => (req.headers.get("cookie") || "").match(new RegExp(`(?:^|; )${n}=([^;]+)`))?.[1];

async function usuarioActual(req, env) {
  const tok = cookie(req, "sid");
  if (!tok) return null;
  return env.DB.prepare(`SELECT s.* FROM sesiones x JOIN staff s ON s.id = x.staff_id
    WHERE x.token = ? AND x.expira > ? AND s.activo = 1`).bind(tok, ahoraISO()).first();
}
async function crearSesion(env, staffId) {
  const tok = tokenAleatorio();
  await env.DB.prepare("INSERT INTO sesiones (token, staff_id, expira) VALUES (?, ?, ?)").bind(tok, staffId, sumarDias(ahoraISO(), DIAS_SESION)).run();
  return `sid=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DIAS_SESION * 86400}`;
}
const publico = (s) => ({ id: s.id, usuario: s.usuario, nombre: s.nombre, discord_id: s.discord_id, nivel: s.nivel, roles: s.roles, hiatus_hasta: s.hiatus_hasta });
const esLider = (s) => s.nivel === "admin" || s.nivel === "lider";

async function api(req, env, url) {
  const ruta = url.pathname.replace(/^\/api\//, "");
  const m = req.method;
  if (ruta.startsWith("bot/")) return rutasBot(req, env, ruta.slice(4), url);

  // Las escrituras solo se aceptan desde el mismo sitio (protección CSRF)
  if (m !== "GET") {
    const origen = req.headers.get("origin");
    if (!origen || origen !== url.origin) fallo("Origen no permitido", 403);
  }
  const body = m === "POST" || m === "PATCH" ? await req.json().catch(() => ({})) : {};

  // ---------- Configuración inicial: crear el primer admin ----------
  if (ruta === "setup") {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE usuario IS NOT NULL").first();
    if (m === "GET") return json({ necesitaSetup: n === 0 });
    if (n > 0) fallo("El panel ya está configurado", 403);
    if (String(body.password || "").length < 10) fallo("La contraseña del admin debe tener al menos 10 caracteres");
    const id = await A.crearStaff(env, { id: null, nivel: "admin" }, { ...body, nivel: "admin", roles: "trad,clean,type" });
    return json({ ok: true }, 200, { "set-cookie": await crearSesion(env, id) });
  }

  // ---------- Login con bloqueo por intentos ----------
  if (ruta === "login" && m === "POST") {
    const usuario = texto(body.usuario, "el usuario", 40).toLowerCase();
    const s = await env.DB.prepare("SELECT * FROM staff WHERE usuario = ?").bind(usuario).first();
    const ip = req.headers.get("cf-connecting-ip") || "";
    if (s?.bloqueado_hasta && new Date(s.bloqueado_hasta) > new Date()) fallo("Cuenta bloqueada por intentos fallidos. Prueba en 15 minutos.", 429);
    if (!s || !s.activo || !(await verificarPassword(String(body.password || ""), s.password_hash))) {
      if (s) {
        const intentos = s.intentos + 1;
        await env.DB.prepare("UPDATE staff SET intentos = ?, bloqueado_hasta = ? WHERE id = ?")
          .bind(intentos >= MAX_INTENTOS ? 0 : intentos, intentos >= MAX_INTENTOS ? new Date(Date.now() + 15 * 60000).toISOString() : null, s.id).run();
        await registrar(env, s.id, "login_fallido", { ip });
      }
      fallo("Usuario o contraseña incorrectos", 401);
    }
    await env.DB.prepare("UPDATE staff SET intentos = 0, bloqueado_hasta = NULL WHERE id = ?").bind(s.id).run();
    await registrar(env, s.id, "login", { ip });
    return json(publico(s), 200, { "set-cookie": await crearSesion(env, s.id) });
  }

  // ---------- Enlace de acceso (creado por el bot con cd!acceso) ----------
  if (ruta === "acceso" && m === "POST") {
    const a = await env.DB.prepare(`SELECT s.* FROM accesos a JOIN staff s ON s.id = a.staff_id
      WHERE a.token = ? AND a.expira > ? AND s.activo = 1`).bind(String(body.token || ""), ahoraISO()).first();
    if (!a) fallo("El enlace no es válido o ya venció. Pide otro con cd!acceso en Discord.", 403);
    if (String(body.password || "").length < 8) fallo("La contraseña debe tener al menos 8 caracteres");
    const cambios = { password: body.password };
    if (!a.usuario) cambios.usuario = texto(body.usuario, "el usuario", 40);
    await A.editarStaff(env, { id: a.id, nivel: "admin" }, a.id, cambios);
    await env.DB.prepare("DELETE FROM accesos WHERE staff_id = ?").bind(a.id).run();
    return json({ ok: true }, 200, { "set-cookie": await crearSesion(env, a.id) });
  }

  const yo = await usuarioActual(req, env);
  if (!yo) fallo("Inicia sesión", 401);

  if (ruta === "logout" && m === "POST") {
    await env.DB.prepare("DELETE FROM sesiones WHERE token = ?").bind(cookie(req, "sid")).run();
    return json({ ok: true }, 200, { "set-cookie": "sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
  }
  if (ruta === "yo") return json({ ...publico(yo), config: await config(env) });
  if (ruta === "yo/password" && m === "POST") {
    if (!(await verificarPassword(String(body.actual || ""), yo.password_hash))) fallo("La contraseña actual no es correcta", 403);
    if (String(body.nueva || "").length < 8) fallo("La nueva contraseña debe tener al menos 8 caracteres");
    await env.DB.prepare("UPDATE staff SET password_hash = ? WHERE id = ?").bind(await hashPassword(String(body.nueva)), yo.id).run();
    await env.DB.prepare("DELETE FROM sesiones WHERE staff_id = ? AND token != ?").bind(yo.id, cookie(req, "sid")).run();
    return json({ ok: true });
  }

  // ---------- Staff: mercado y mis tareas ----------
  if (ruta === "mercado") return json(await T.mercado(env, yo));
  if (ruta === "perfil") return json(await T.perfil(env, yo));
  if (ruta === "mis-tareas") return json(await T.tareasDe(env, yo.id, url.searchParams.get("todas") !== "1"));
  if (ruta === "ranking") return json(await T.ranking(env, Number(url.searchParams.get("mes") || 0)));
  if (ruta === "tareas/tomar" && m === "POST") return json(await T.tomarTarea(env, yo, entero(body.capitulo_id, "capitulo_id", 1, 1e9), String(body.rol)));
  let r = ruta.match(/^tareas\/(\d+)\/(entregar|solicitar)$/);
  if (r && m === "POST") {
    const id = Number(r[1]);
    if (r[2] === "entregar") return json(await T.entregarTarea(env, yo, id));
    return json(await T.solicitar(env, yo, id, body.tipo, Number(body.dias), body.motivo));
  }

  // ---------- Líderes y admins ----------
  if (!esLider(yo)) fallo("Solo para líderes", 403);

  if (ruta === "admin/tareas") return json(await T.tareasActivas(env, url.searchParams.get("filtro") || ""));
  r = ruta.match(/^admin\/tareas\/(\d+)\/(resolver|quitar)$/);
  if (r && m === "POST") {
    const id = Number(r[1]);
    if (r[2] === "quitar") return json(await T.quitarTarea(env, yo, id));
    return json(await T.resolverSolicitud(env, yo, id, !!body.aprobar, body.dias ? entero(body.dias, "días", 1, 30) : undefined));
  }
  if (ruta === "admin/asignar" && m === "POST") {
    return json(await T.asignarTarea(env, yo, entero(body.capitulo_id, "capítulo", 1, 1e9), String(body.rol), entero(body.staff_id, "miembro", 1, 1e9),
      body.dias ? entero(body.dias, "días", 1, 60) : undefined));
  }
  if (ruta === "admin/staff" && m === "GET") return json(await A.listarStaff(env));
  if (ruta === "admin/staff" && m === "POST") return json({ id: await A.crearStaff(env, yo, body) });
  r = ruta.match(/^admin\/staff\/(\d+)$/);
  if (r && m === "PATCH") { await A.editarStaff(env, yo, Number(r[1]), body); return json({ ok: true }); }

  if (ruta === "admin/proyectos" && m === "GET") return json(await A.listarProyectos(env));
  if (ruta === "admin/proyectos" && m === "POST") return json({ id: await A.crearProyecto(env, yo, body) });
  r = ruta.match(/^admin\/proyectos\/(\d+)$/);
  if (r && m === "PATCH") { await A.editarProyecto(env, yo, Number(r[1]), body); return json({ ok: true }); }
  r = ruta.match(/^admin\/proyectos\/(\d+)\/capitulos$/);
  if (r && m === "GET") return json(await A.listarCapitulos(env, Number(r[1])));
  if (r && m === "POST") return json(await A.crearCapitulos(env, yo, Number(r[1]), body.capitulos));
  r = ruta.match(/^admin\/capitulos\/(\d+)$/);
  if (r && m === "PATCH") { await A.cambiarEstadoCapitulo(env, yo, Number(r[1]), body.estado); return json({ ok: true }); }
  if (r && m === "DELETE") { await A.borrarCapitulo(env, yo, Number(r[1])); return json({ ok: true }); }

  if (ruta === "admin/eventos") return json(await A.eventos(env));

  // ---------- Solo admin ----------
  if (yo.nivel !== "admin") fallo("Solo para administradores", 403);
  if (ruta === "admin/config" && m === "POST") { await A.guardarConfig(env, yo, body); return json(await config(env)); }
  if (ruta === "admin/revisar-vencidas" && m === "POST") return json({ vencidas: await vencerTareas(env, await config(env)) });
  if (ruta === "admin/reporte" && m === "POST") return json({ enviado: await reporteDiario(env, await config(env), true) });

  fallo("Ruta no encontrada", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Error interno del servidor" }, 500);
    }
  },
  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(ejecutarCron(env).catch((e) => console.error("cron", e)));
  },
};
