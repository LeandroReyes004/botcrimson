// Lógica del mercado de tareas (la usan la web y el bot)
import { exigirArchivos } from "./archivos.js";
import {
  fallo, ROLES, ROL_NOMBRE, ahoraISO, sumarDias, textoRestante, config, registrar, avisar, mencion, inicioMesISO,
} from "./util.js";

const SELECT_TAREA = `
  SELECT t.*, c.numero AS cap, c.proyecto_id, p.nombre AS obra,
         s.nombre AS staff_nombre, s.discord_id
  FROM tareas t
  JOIN capitulos c ON c.id = t.capitulo_id
  JOIN proyectos p ON p.id = c.proyecto_id
  JOIN staff s ON s.id = t.staff_id`;

const decorar = (t) => t && { ...t, rol_nombre: ROL_NOMBRE[t.rol], restante: t.estado === "activa" ? textoRestante(t.limite) : null };

export async function obtenerTarea(env, id) {
  return decorar(await env.DB.prepare(`${SELECT_TAREA} WHERE t.id = ?`).bind(id).first());
}

export const puedeHacerRol = (staff, rol) =>
  staff.nivel === "admin" || staff.nivel === "lider" || staff.roles.split(",").includes(rol);

export const enHiatus = (staff) => staff.hiatus_hasta && new Date(staff.hiatus_hasta) > new Date();

// Mercado: capítulos de proyectos activos que no están publicados, con quién tiene cada rol
export async function mercado(env, staff) {
  const { results: caps } = await env.DB.prepare(`
    SELECT c.id, c.numero, c.estado, p.id AS proyecto_id, p.nombre AS obra,
      (SELECT COUNT(*) FROM archivos a WHERE a.capitulo_id = c.id AND a.etapa = 'raw') AS raws
    FROM capitulos c JOIN proyectos p ON p.id = c.proyecto_id
    WHERE p.estado = 'activo' AND c.estado IN ('pendiente','en_proceso','listo')
    ORDER BY p.nombre COLLATE NOCASE, c.orden`).all();
  const { results: tareas } = await env.DB.prepare(`
    SELECT t.capitulo_id, t.rol, t.estado, t.limite, s.nombre
    FROM tareas t JOIN staff s ON s.id = t.staff_id
    WHERE t.estado IN ('activa','entregada')`).all();
  const mapa = {};
  for (const t of tareas) (mapa[t.capitulo_id] ??= {})[t.rol] = { estado: t.estado, nombre: t.nombre };
  return caps.map((c) => ({
    ...c,
    roles: Object.fromEntries(ROLES.map((r) => {
      const t = mapa[c.id]?.[r];
      return [r, t ? t : { estado: "libre", puedo: staff ? puedeHacerRol(staff, r) : false }];
    })),
  }));
}

export async function tomarTarea(env, staff, capituloId, rol, origen = "web") {
  if (!ROLES.includes(rol)) fallo("Rol inválido");
  if (!staff.activo) fallo("Tu cuenta está desactivada", 403);
  if (enHiatus(staff)) fallo("No puedes tomar tareas mientras estás en hiatus", 403);
  if (!puedeHacerRol(staff, rol)) fallo(`No tienes el rol de ${ROL_NOMBRE[rol]}`, 403);

  const cap = await env.DB.prepare(`
    SELECT c.*, p.nombre AS obra, p.estado AS proyecto_estado
    FROM capitulos c JOIN proyectos p ON p.id = c.proyecto_id WHERE c.id = ?`).bind(capituloId).first();
  if (!cap) fallo("Capítulo no encontrado", 404);
  if (cap.proyecto_estado !== "activo") fallo("El proyecto no está activo");
  if (!["pendiente", "en_proceso"].includes(cap.estado)) fallo("Ese capítulo ya está terminado");

  const hecha = await env.DB.prepare("SELECT 1 FROM tareas WHERE capitulo_id = ? AND rol = ? AND estado = 'entregada'").bind(capituloId, rol).first();
  if (hecha) fallo(`La ${ROL_NOMBRE[rol]} de ese capítulo ya fue entregada`, 409);

  const cfg = await config(env);
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM tareas WHERE staff_id = ? AND estado = 'activa'").bind(staff.id).first();
  if (n >= Number(cfg.max_tareas_activas || 5)) fallo(`Ya tienes ${n} tareas activas. Entrega alguna antes de tomar otra.`);

  const limite = sumarDias(ahoraISO(), Number(cfg.dias_limite || 3));
  let id;
  try {
    // Los índices únicos garantizan que nadie más la tome al mismo tiempo ni se repita una entregada
    const r = await env.DB.prepare("INSERT INTO tareas (capitulo_id, rol, staff_id, limite) VALUES (?, ?, ?, ?)")
      .bind(capituloId, rol, staff.id, limite).run();
    id = r.meta.last_row_id;
  } catch (e) {
    if (String(e).includes("UNIQUE")) fallo("Esa tarea ya la tomó otra persona o ya fue entregada", 409);
    throw e;
  }
  await env.DB.prepare("UPDATE capitulos SET estado = 'en_proceso' WHERE id = ? AND estado = 'pendiente'").bind(capituloId).run();
  await registrar(env, staff.id, "tarea_tomada", { tarea: id, origen });
  const t = await obtenerTarea(env, id);
  await avisar(env, `📌 ${mencion(staff)} tomó **${t.obra} cap. ${t.cap}** (${t.rol_nombre}). Vence en ${cfg.dias_limite || 3} días.`);
  return t;
}

async function tareaPropiaActiva(env, staff, tareaId) {
  const t = await obtenerTarea(env, tareaId);
  if (!t) fallo("Tarea no encontrada", 404);
  if (t.staff_id !== staff.id) fallo("Esa tarea no es tuya", 403);
  if (t.estado !== "activa") fallo("La tarea ya no está activa");
  return t;
}

export async function entregarTarea(env, staff, tareaId) {
  const t = await tareaPropiaActiva(env, staff, tareaId);
  await exigirArchivos(env, t.capitulo_id, t.rol);
  const cfg = await config(env);
  const pts = Number(cfg.puntos_entrega || 1);
  const ahora = ahoraISO();
  await env.DB.batch([
    env.DB.prepare("UPDATE tareas SET estado = 'entregada', cerrada = ?, solicitud = NULL WHERE id = ? AND estado = 'activa'").bind(ahora, t.id),
    env.DB.prepare("INSERT INTO puntos (staff_id, tarea_id, puntos, motivo) VALUES (?, ?, ?, 'entrega')").bind(staff.id, t.id, pts),
    // Si ya se entregaron los 3 roles (trad, clean, type), el capítulo queda listo para publicar
    env.DB.prepare(`UPDATE capitulos SET estado = 'listo' WHERE id = ? AND
      (SELECT COUNT(DISTINCT rol) FROM tareas WHERE capitulo_id = ? AND estado = 'entregada') = 3`).bind(t.capitulo_id, t.capitulo_id),
  ]);
  await registrar(env, staff.id, "tarea_entregada", { tarea: t.id });
  const atrasada = new Date(t.limite) < new Date();
  await avisar(env, `✅ ${mencion(staff)} entregó **${t.obra} cap. ${t.cap}** (${t.rol_nombre})${atrasada ? " con retraso" : ""}. +${pts} pts`);
  return obtenerTarea(env, t.id);
}

export async function solicitar(env, staff, tareaId, tipo, dias, motivo) {
  if (!["extension", "cancelacion"].includes(tipo)) fallo("Solicitud inválida");
  const t = await tareaPropiaActiva(env, staff, tareaId);
  if (t.solicitud) fallo("Ya tienes una solicitud pendiente para esta tarea");
  if (tipo === "extension" && !(Number.isInteger(dias) && dias >= 1 && dias <= 14)) fallo("Pide entre 1 y 14 días");
  await env.DB.prepare("UPDATE tareas SET solicitud = ?, solicitud_dias = ?, solicitud_motivo = ? WHERE id = ?")
    .bind(tipo, tipo === "extension" ? dias : null, motivo ? String(motivo).slice(0, 300) : null, t.id).run();
  await registrar(env, staff.id, `solicitud_${tipo}`, { tarea: t.id, dias, motivo });
  const que = tipo === "extension" ? `**${dias} días más**` : "**cancelar**";
  await avisar(env, `⚠️ ${mencion(staff)} pide ${que} en **${t.obra} cap. ${t.cap}** (${t.rol_nombre})${motivo ? `: ${motivo}` : ""}. Revísalo en el panel.`, "lideres");
  return obtenerTarea(env, t.id);
}

export async function resolverSolicitud(env, lider, tareaId, aprobar, diasOverride) {
  const t = await obtenerTarea(env, tareaId);
  if (!t || t.estado !== "activa" || !t.solicitud) fallo("No hay solicitud pendiente para esa tarea", 404);
  const persona = { nombre: t.staff_nombre, discord_id: t.discord_id };
  if (t.solicitud === "extension") {
    if (aprobar) {
      const dias = diasOverride ?? t.solicitud_dias;
      // Se suma desde el límite actual o desde ahora si ya venció, para que la extensión sea real
      const base = new Date(t.limite) > new Date() ? t.limite : ahoraISO();
      await env.DB.prepare("UPDATE tareas SET limite = ?, solicitud = NULL, solicitud_dias = NULL, solicitud_motivo = NULL WHERE id = ?")
        .bind(sumarDias(base, dias), t.id).run();
      await avisar(env, `✅ Extensión de **${dias} días** aprobada para ${mencion(persona)} en **${t.obra} cap. ${t.cap}** (${t.rol_nombre}).`);
    } else {
      await env.DB.prepare("UPDATE tareas SET solicitud = NULL, solicitud_dias = NULL, solicitud_motivo = NULL WHERE id = ?").bind(t.id).run();
      await avisar(env, `❌ Extensión rechazada para ${mencion(persona)} en **${t.obra} cap. ${t.cap}** (${t.rol_nombre}).`);
    }
  } else {
    if (aprobar) {
      await env.DB.prepare("UPDATE tareas SET estado = 'cancelada', cerrada = ?, solicitud = NULL WHERE id = ?").bind(ahoraISO(), t.id).run();
      await liberarCapitulo(env, t.capitulo_id);
      await avisar(env, `🔓 Se canceló la tarea de ${mencion(persona)} en **${t.obra} cap. ${t.cap}** (${t.rol_nombre}). Queda libre en el mercado.`);
    } else {
      await env.DB.prepare("UPDATE tareas SET solicitud = NULL, solicitud_motivo = NULL WHERE id = ?").bind(t.id).run();
      await avisar(env, `❌ Cancelación rechazada para ${mencion(persona)} en **${t.obra} cap. ${t.cap}** (${t.rol_nombre}).`);
    }
  }
  await registrar(env, lider.id, aprobar ? "solicitud_aprobada" : "solicitud_rechazada", { tarea: t.id, tipo: t.solicitud });
  return obtenerTarea(env, t.id);
}

// Un líder puede asignar directamente o quitar una tarea
export async function asignarTarea(env, lider, capituloId, rol, staffId, dias) {
  const staff = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(staffId).first();
  if (!staff) fallo("Miembro no encontrado", 404);
  const t = await tomarTarea(env, { ...staff, nivel: "lider" }, capituloId, rol, `asignada por ${lider.nombre}`);
  if (dias) {
    await env.DB.prepare("UPDATE tareas SET limite = ? WHERE id = ?").bind(sumarDias(ahoraISO(), dias), t.id).run();
  }
  return obtenerTarea(env, t.id);
}

export async function quitarTarea(env, lider, tareaId) {
  const t = await obtenerTarea(env, tareaId);
  if (!t || t.estado !== "activa") fallo("Tarea no activa", 404);
  await env.DB.prepare("UPDATE tareas SET estado = 'cancelada', cerrada = ?, solicitud = NULL WHERE id = ?").bind(ahoraISO(), t.id).run();
  await liberarCapitulo(env, t.capitulo_id);
  await registrar(env, lider.id, "tarea_quitada", { tarea: t.id });
  return obtenerTarea(env, t.id);
}

async function liberarCapitulo(env, capituloId) {
  await env.DB.prepare(`UPDATE capitulos SET estado = 'pendiente' WHERE id = ? AND estado = 'en_proceso'
    AND NOT EXISTS (SELECT 1 FROM tareas WHERE capitulo_id = ? AND estado IN ('activa','entregada'))`).bind(capituloId, capituloId).run();
}

export async function tareasDe(env, staffId, soloActivas = true) {
  const { results } = await env.DB.prepare(
    `${SELECT_TAREA} WHERE t.staff_id = ? ${soloActivas ? "AND t.estado = 'activa'" : ""} ORDER BY t.estado = 'activa' DESC, t.limite LIMIT 100`
  ).bind(staffId).all();
  return results.map(decorar);
}

export async function tareasActivas(env, filtro = "") {
  const where = filtro === "solicitudes" ? "AND t.solicitud IS NOT NULL" : "";
  const { results } = await env.DB.prepare(`${SELECT_TAREA} WHERE t.estado = 'activa' ${where} ORDER BY t.limite`).all();
  return results.map(decorar);
}

export async function ranking(env, mesOffset = 0) {
  const zona = env.ZONA_HORARIA || "America/Santo_Domingo";
  const desde = inicioMesISO(zona, mesOffset);
  const hasta = inicioMesISO(zona, mesOffset + 1);
  const { results } = await env.DB.prepare(`
    SELECT s.id, s.nombre, s.discord_id,
      COALESCE(SUM(p.puntos), 0) AS puntos,
      COUNT(CASE WHEN p.motivo = 'entrega' THEN 1 END) AS entregas,
      COUNT(CASE WHEN p.motivo = 'vencida' THEN 1 END) AS vencidas
    FROM staff s JOIN puntos p ON p.staff_id = s.id AND p.fecha >= ? AND p.fecha < ?
    GROUP BY s.id ORDER BY puntos DESC, entregas DESC LIMIT 50`).bind(desde, hasta).all();
  return results;
}

export async function perfil(env, staff) {
  const zona = env.ZONA_HORARIA || "America/Santo_Domingo";
  const desde = inicioMesISO(zona);
  const cfg = await config(env);
  const mes = await env.DB.prepare(`
    SELECT COALESCE(SUM(puntos),0) AS puntos, COUNT(CASE WHEN motivo='entrega' THEN 1 END) AS entregas
    FROM puntos WHERE staff_id = ? AND fecha >= ?`).bind(staff.id, desde).first();
  const total = await env.DB.prepare(`
    SELECT COUNT(CASE WHEN estado='entregada' THEN 1 END) AS entregadas,
           COUNT(CASE WHEN estado='vencida' THEN 1 END) AS vencidas,
           COUNT(CASE WHEN estado='entregada' AND cerrada <= limite THEN 1 END) AS a_tiempo,
           COALESCE((SELECT SUM(puntos) FROM puntos WHERE staff_id = ?), 0) AS puntos_total
    FROM tareas WHERE staff_id = ?`).bind(staff.id, staff.id).first();
  const { results: movimientos } = await env.DB.prepare(`
    SELECT p.puntos, p.motivo, p.nota, p.fecha, c.numero AS cap, pr.nombre AS obra, t.rol, a.nombre AS autor
    FROM puntos p LEFT JOIN tareas t ON t.id = p.tarea_id LEFT JOIN capitulos c ON c.id = t.capitulo_id
    LEFT JOIN proyectos pr ON pr.id = c.proyecto_id LEFT JOIN staff a ON a.id = p.autor_id
    WHERE p.staff_id = ? ORDER BY p.id DESC LIMIT 30`).bind(staff.id).all();
  const cuota = Number(cfg.cuota_mensual || 3);
  const cerradas = total.entregadas + total.vencidas;
  return {
    id: staff.id, nombre: staff.nombre, usuario: staff.usuario, discord_id: staff.discord_id, nivel: staff.nivel, roles: staff.roles,
    activo: staff.activo, hiatus_hasta: staff.hiatus_hasta, creado: staff.creado,
    puntos_mes: mes.puntos, entregas_mes: mes.entregas, puntos_total: total.puntos_total,
    entregas_total: total.entregadas, vencidas_total: total.vencidas,
    // Porcentaje de tareas entregadas antes del límite (sobre las que ya se cerraron)
    puntualidad: cerradas ? Math.round((total.a_tiempo / cerradas) * 100) : null,
    cuota, cumple_cuota: mes.entregas >= cuota,
    activas: await tareasDe(env, staff.id),
    movimientos: movimientos.map((m) => ({ ...m, rol_nombre: m.rol ? ROL_NOMBRE[m.rol] : null })),
  };
}

// ---------- Recortes según permisos ----------
export function filtrarMercado(caps, puedo) {
  return caps.map((c) => ({
    ...c,
    roles: Object.fromEntries(Object.entries(c.roles).map(([r, x]) => {
      if (x.estado === "libre") return [r, { ...x, puedo: x.puedo && !!puedo.tomar_tareas }];
      return [r, puedo.ver_nombres ? x : { estado: x.estado, nombre: x.estado === "entregada" ? "Entregado" : "Ocupado" }];
    })),
  }));
}

export function filtrarRanking(filas, miId, puedo) {
  if (puedo.ver_puntos_otros) return filas;
  return filas.map((f) => (f.id === miId ? f : { id: f.id, nombre: f.nombre, oculto: true }));
}
