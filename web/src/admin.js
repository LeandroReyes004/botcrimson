// Gestión: staff, proyectos, capítulos y configuración
import { fallo, texto, entero, discordId, normalizarRoles, hashPassword, registrar, ahoraISO, sumarDias, avisar, mencion } from "./util.js";

const CAMPOS_STAFF = "id, usuario, nombre, discord_id, nivel, roles, activo, hiatus_hasta, creado";
const NIVELES = ["admin", "lider", "staff"];

export async function listarStaff(env) {
  const { results } = await env.DB.prepare(`
    SELECT ${CAMPOS_STAFF},
      (SELECT COUNT(*) FROM tareas t WHERE t.staff_id = s.id AND t.estado = 'activa') AS activas
    FROM staff s ORDER BY activo DESC, nombre COLLATE NOCASE`).all();
  return results;
}

export async function crearStaff(env, actor, b) {
  const nombre = texto(b.nombre, "el nombre", 80);
  const usuario = b.usuario ? texto(b.usuario, "el usuario", 40).toLowerCase() : null;
  if (usuario && !/^[a-z0-9._-]{3,40}$/.test(usuario)) fallo("El usuario solo puede tener letras, números, punto, guion y guion bajo (mínimo 3)");
  const did = b.discord_id ? discordId(b.discord_id) : null;
  const nivel = b.nivel || "staff";
  if (!NIVELES.includes(nivel)) fallo("Nivel inválido");
  if (nivel === "admin" && actor.nivel !== "admin") fallo("Solo un admin puede crear otro admin", 403);
  if (usuario && !b.password) fallo("Pon una contraseña para el usuario del panel");
  if (b.password && String(b.password).length < 8) fallo("La contraseña debe tener al menos 8 caracteres");
  try {
    const r = await env.DB.prepare("INSERT INTO staff (usuario, password_hash, nombre, discord_id, nivel, roles) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(usuario, b.password ? await hashPassword(String(b.password)) : null, nombre, did, nivel, normalizarRoles(b.roles)).run();
    await registrar(env, actor.id, "staff_creado", { id: r.meta.last_row_id, nombre });
    return r.meta.last_row_id;
  } catch (e) {
    if (String(e).includes("UNIQUE")) fallo("Ya existe alguien con ese usuario o ese ID de Discord", 409);
    throw e;
  }
}

export async function editarStaff(env, actor, id, b) {
  const s = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first();
  if (!s) fallo("Miembro no encontrado", 404);
  if (s.nivel === "admin" && actor.nivel !== "admin") fallo("Solo un admin puede editar a otro admin", 403);
  const sets = [], vals = [];
  const set = (campo, valor) => { sets.push(`${campo} = ?`); vals.push(valor); };
  if (b.nombre !== undefined) set("nombre", texto(b.nombre, "el nombre", 80));
  if (b.discord_id !== undefined) set("discord_id", b.discord_id ? discordId(b.discord_id) : null);
  if (b.roles !== undefined) set("roles", normalizarRoles(b.roles));
  if (b.nivel !== undefined) {
    if (!NIVELES.includes(b.nivel)) fallo("Nivel inválido");
    if (actor.nivel !== "admin") fallo("Solo un admin puede cambiar niveles", 403);
    if (s.id === actor.id && b.nivel !== "admin") fallo("No puedes quitarte el nivel de admin");
    set("nivel", b.nivel);
  }
  if (b.activo !== undefined) {
    if (s.id === actor.id && !b.activo) fallo("No puedes desactivarte a ti mismo");
    set("activo", b.activo ? 1 : 0);
  }
  if (b.hiatus_dias !== undefined) {
    const d = Number(b.hiatus_dias);
    set("hiatus_hasta", d > 0 ? sumarDias(ahoraISO(), entero(d, "los días de hiatus", 1, 365)) : null);
  }
  if (b.password) {
    if (String(b.password).length < 8) fallo("La contraseña debe tener al menos 8 caracteres");
    set("password_hash", await hashPassword(String(b.password)));
    set("intentos", 0); set("bloqueado_hasta", null);
  }
  if (b.usuario !== undefined) {
    const u = b.usuario ? texto(b.usuario, "el usuario", 40).toLowerCase() : null;
    if (u && !/^[a-z0-9._-]{3,40}$/.test(u)) fallo("Usuario inválido");
    set("usuario", u);
  }
  if (!sets.length) fallo("No hay cambios");
  try {
    await env.DB.prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) fallo("Ese usuario o ID de Discord ya lo tiene otra persona", 409);
    throw e;
  }
  if (b.activo === false || b.password) await env.DB.prepare("DELETE FROM sesiones WHERE staff_id = ?").bind(id).run();
  if (b.activo === false) await liberarTareasDe(env, actor, s, "desactivado");
  await registrar(env, actor.id, "staff_editado", { id, cambios: Object.keys(b).filter((k) => k !== "password") });
}

// Cuando alguien se va o se desactiva, sus tareas activas vuelven al mercado
export async function liberarTareasDe(env, actor, staff, motivo) {
  const { results } = await env.DB.prepare(`
    SELECT t.id, t.capitulo_id, t.rol, c.numero, p.nombre AS obra FROM tareas t
    JOIN capitulos c ON c.id = t.capitulo_id JOIN proyectos p ON p.id = c.proyecto_id
    WHERE t.staff_id = ? AND t.estado = 'activa'`).bind(staff.id).all();
  if (!results.length) return 0;
  await env.DB.prepare("UPDATE tareas SET estado = 'cancelada', cerrada = ?, solicitud = NULL WHERE staff_id = ? AND estado = 'activa'")
    .bind(ahoraISO(), staff.id).run();
  await env.DB.prepare(`UPDATE capitulos SET estado = 'pendiente' WHERE estado = 'en_proceso' AND id IN (${results.map(() => "?").join(",")})
    AND NOT EXISTS (SELECT 1 FROM tareas t WHERE t.capitulo_id = capitulos.id AND t.estado IN ('activa','entregada'))`)
    .bind(...results.map((r) => r.capitulo_id)).run();
  await registrar(env, actor?.id, "tareas_liberadas", { staff: staff.id, motivo, tareas: results.map((r) => r.id) });
  await avisar(env, `🔓 ${mencion(staff)} (${motivo}): ${results.length} tarea(s) volvieron al mercado:\n` +
    results.map((r) => `• ${r.obra} cap. ${r.numero} (${r.rol})`).join("\n"), "lideres");
  return results.length;
}

// ---------- Proyectos ----------
export async function listarProyectos(env) {
  const { results } = await env.DB.prepare(`
    SELECT p.*,
      COUNT(c.id) AS total,
      SUM(c.estado = 'pendiente') AS pendientes,
      SUM(c.estado = 'en_proceso') AS en_proceso,
      SUM(c.estado = 'listo') AS listos,
      SUM(c.estado = 'publicado') AS publicados
    FROM proyectos p LEFT JOIN capitulos c ON c.proyecto_id = p.id
    GROUP BY p.id ORDER BY p.estado = 'activo' DESC, p.nombre COLLATE NOCASE`).all();
  return results;
}

export async function crearProyecto(env, actor, b) {
  const nombre = texto(b.nombre, "el nombre del proyecto", 150);
  try {
    const r = await env.DB.prepare("INSERT INTO proyectos (nombre) VALUES (?)").bind(nombre).run();
    await registrar(env, actor.id, "proyecto_creado", { nombre });
    return r.meta.last_row_id;
  } catch (e) {
    if (String(e).includes("UNIQUE")) fallo("Ya existe un proyecto con ese nombre", 409);
    throw e;
  }
}

export async function editarProyecto(env, actor, id, b) {
  if (b.estado && !["activo", "pausado", "terminado"].includes(b.estado)) fallo("Estado inválido");
  if (b.nombre !== undefined) texto(b.nombre, "el nombre", 150);
  await env.DB.prepare("UPDATE proyectos SET nombre = COALESCE(?, nombre), estado = COALESCE(?, estado) WHERE id = ?")
    .bind(b.nombre?.trim() ?? null, b.estado ?? null, id).run();
  await registrar(env, actor.id, "proyecto_editado", { id, ...b });
}

// ---------- Capítulos ----------
const NUM = /^\d{1,4}(\.\d{1,2})?$/;

export async function listarCapitulos(env, proyectoId) {
  const { results } = await env.DB.prepare(`
    SELECT c.*,
      (SELECT json_group_object(t.rol, json_object('estado', t.estado, 'nombre', s.nombre))
       FROM tareas t JOIN staff s ON s.id = t.staff_id
       WHERE t.capitulo_id = c.id AND t.estado IN ('activa','entregada')) AS roles
    FROM capitulos c WHERE c.proyecto_id = ? ORDER BY c.orden`).bind(proyectoId).all();
  return results.map((c) => ({ ...c, roles: c.roles ? JSON.parse(c.roles) : {} }));
}

// Acepta "12", "1-10", "1-10, 12.5, 15"
export function parsearCapitulos(entrada) {
  const nums = new Set();
  for (const parte of String(entrada || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const rango = parte.match(/^(\d{1,4})\s*-\s*(\d{1,4})$/);
    if (rango) {
      const [a, b] = [Number(rango[1]), Number(rango[2])];
      if (b < a || b - a > 500) fallo(`Rango inválido: ${parte}`);
      for (let i = a; i <= b; i++) nums.add(String(i));
    } else if (NUM.test(parte)) {
      nums.add(String(Number(parte)));
    } else fallo(`Número de capítulo inválido: ${parte}`);
  }
  if (!nums.size) fallo("Escribe al menos un capítulo");
  return [...nums];
}

export async function crearCapitulos(env, actor, proyectoId, entrada) {
  const p = await env.DB.prepare("SELECT id FROM proyectos WHERE id = ?").bind(proyectoId).first();
  if (!p) fallo("Proyecto no encontrado", 404);
  const nums = parsearCapitulos(entrada);
  const stmts = nums.map((n) => env.DB.prepare("INSERT OR IGNORE INTO capitulos (proyecto_id, numero, orden) VALUES (?, ?, ?)").bind(proyectoId, n, Number(n)));
  const res = await env.DB.batch(stmts);
  const creados = res.reduce((a, r) => a + (r.meta.changes || 0), 0);
  await registrar(env, actor.id, "capitulos_creados", { proyecto: proyectoId, creados });
  return { creados, repetidos: nums.length - creados };
}

export async function cambiarEstadoCapitulo(env, actor, id, estado) {
  if (!["pendiente", "en_proceso", "listo", "publicado"].includes(estado)) fallo("Estado inválido");
  const c = await env.DB.prepare("SELECT c.*, p.nombre AS obra FROM capitulos c JOIN proyectos p ON p.id = c.proyecto_id WHERE c.id = ?").bind(id).first();
  if (!c) fallo("Capítulo no encontrado", 404);
  await env.DB.prepare("UPDATE capitulos SET estado = ? WHERE id = ?").bind(estado, id).run();
  await registrar(env, actor.id, "capitulo_estado", { id, estado });
  if (estado === "publicado") await avisar(env, `🎉 ¡Publicado **${c.obra} cap. ${c.numero}**!`);
}

export async function borrarCapitulo(env, actor, id) {
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM tareas WHERE capitulo_id = ?").bind(id).first();
  if (n) fallo("Ese capítulo ya tiene tareas; márcalo como publicado en vez de borrarlo");
  await env.DB.prepare("DELETE FROM capitulos WHERE id = ?").bind(id).run();
  await registrar(env, actor.id, "capitulo_borrado", { id });
}

// ---------- Config ----------
const CLAVES_CONFIG = {
  dias_limite: [1, 30], max_tareas_activas: [1, 50], puntos_entrega: [0, 100],
  puntos_vencida: [-100, 0], cuota_mensual: [0, 100], hora_reporte: [0, 23], horas_gracia: [0, 168],
};
export async function guardarConfig(env, actor, b) {
  const stmts = [];
  for (const [k, v] of Object.entries(b)) {
    if (!CLAVES_CONFIG[k]) fallo(`Opción desconocida: ${k}`);
    const [min, max] = CLAVES_CONFIG[k];
    stmts.push(env.DB.prepare("INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
      .bind(k, String(entero(v, k, min, max))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await registrar(env, actor.id, "config", b);
}

export async function eventos(env, limite = 100) {
  const { results } = await env.DB.prepare(`
    SELECT e.*, s.nombre FROM eventos e LEFT JOIN staff s ON s.id = e.staff_id ORDER BY e.id DESC LIMIT ?`).bind(limite).all();
  return results;
}
