// Tareas automáticas (se ejecutan cada hora con el Cron Trigger de Cloudflare)
import { config, ahoraISO, avisar, mencion, registrar, horaLocal, fechaLocal, textoRestante, ROL_NOMBRE } from "./util.js";

export async function ejecutarCron(env) {
  const cfg = await config(env);
  const vencidas = await vencerTareas(env, cfg);
  await reporteDiario(env, cfg);
  await env.DB.prepare("DELETE FROM sesiones WHERE expira < ?").bind(ahoraISO()).run();
  return { vencidas };
}

// Pasado el límite + horas de gracia, la tarea vence: se resta el punto y el capítulo vuelve al mercado.
// Si la persona pidió una extensión que aún no se ha revisado, se espera a que un líder decida.
export async function vencerTareas(env, cfg) {
  const gracia = Number(cfg.horas_gracia ?? 24);
  const corte = new Date(Date.now() - gracia * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const { results } = await env.DB.prepare(`
    SELECT t.id, t.capitulo_id, t.rol, t.staff_id, c.numero AS cap, p.nombre AS obra, s.nombre, s.discord_id
    FROM tareas t JOIN capitulos c ON c.id = t.capitulo_id JOIN proyectos p ON p.id = c.proyecto_id
    JOIN staff s ON s.id = t.staff_id
    WHERE t.estado = 'activa' AND t.limite < ? AND (t.solicitud IS NULL OR t.solicitud = 'cancelacion')`).bind(corte).all();
  if (!results.length) return 0;
  const pts = Number(cfg.puntos_vencida ?? -1);
  const ahora = ahoraISO();
  const stmts = [];
  for (const t of results) {
    stmts.push(env.DB.prepare("UPDATE tareas SET estado = 'vencida', cerrada = ?, solicitud = NULL WHERE id = ? AND estado = 'activa'").bind(ahora, t.id));
    if (pts) stmts.push(env.DB.prepare("INSERT INTO puntos (staff_id, tarea_id, puntos, motivo) VALUES (?, ?, ?, 'vencida')").bind(t.staff_id, t.id, pts));
    stmts.push(env.DB.prepare(`UPDATE capitulos SET estado = 'pendiente' WHERE id = ? AND estado = 'en_proceso'
      AND NOT EXISTS (SELECT 1 FROM tareas WHERE capitulo_id = ? AND estado IN ('activa','entregada'))`).bind(t.capitulo_id, t.capitulo_id));
  }
  await env.DB.batch(stmts);
  await registrar(env, null, "tareas_vencidas", { tareas: results.map((t) => t.id) });
  await avisar(env, `⛔ **Tareas vencidas** (${pts} pts cada una). Vuelven al mercado:\n` +
    results.map((t) => `• ${mencion(t)}: ${t.obra} cap. ${t.cap} (${ROL_NOMBRE[t.rol]})`).join("\n"));
  return results.length;
}

export async function reporteDiario(env, cfg, forzar = false) {
  const zona = env.ZONA_HORARIA || "America/Santo_Domingo";
  const hoy = fechaLocal(zona);
  if (!forzar && (horaLocal(zona) !== Number(cfg.hora_reporte ?? 9) || cfg.ultimo_reporte === hoy)) return false;
  await env.DB.prepare("INSERT INTO config (clave, valor) VALUES ('ultimo_reporte', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").bind(hoy).run();

  const en24 = new Date(Date.now() + 24 * 3600000).toISOString();
  const { results } = await env.DB.prepare(`
    SELECT t.*, c.numero AS cap, p.nombre AS obra, s.nombre, s.discord_id
    FROM tareas t JOIN capitulos c ON c.id = t.capitulo_id JOIN proyectos p ON p.id = c.proyecto_id
    JOIN staff s ON s.id = t.staff_id
    WHERE t.estado = 'activa' AND (t.limite < ? OR t.solicitud IS NOT NULL) ORDER BY t.limite`).bind(en24).all();
  if (!results.length) return true;

  const linea = (t) => `• ${mencion(t)}: ${t.obra} cap. ${t.cap} (${ROL_NOMBRE[t.rol]}), ${textoRestante(t.limite)}`;
  const atrasadas = results.filter((t) => new Date(t.limite) < new Date());
  const pronto = results.filter((t) => new Date(t.limite) >= new Date() && new Date(t.limite) < new Date(en24));
  const solicitudes = results.filter((t) => t.solicitud);
  const fields = [];
  if (atrasadas.length) fields.push({ name: "🔴 Atrasadas", value: atrasadas.map(linea).join("\n").slice(0, 1024) });
  if (pronto.length) fields.push({ name: "🟠 Vencen en menos de 24 h", value: pronto.map(linea).join("\n").slice(0, 1024) });
  if (solicitudes.length) fields.push({
    name: "📝 Solicitudes por revisar",
    value: solicitudes.map((t) => `• ${t.nombre}: ${t.solicitud === "extension" ? `+${t.solicitud_dias} días` : "cancelar"} en ${t.obra} cap. ${t.cap}`).join("\n").slice(0, 1024),
  });
  await avisar(env, { content: "📋 **Reporte diario de tareas**", embeds: [{ color: 0x660000, fields }] }, "lideres");
  return true;
}
