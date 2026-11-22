// Permisos por nivel. El admin siempre puede todo; lo que ven líderes y staff lo decide el admin en Ajustes.
import { fallo } from "./util.js";

// [clave, descripción, grupo, por defecto para líder, por defecto para staff]
export const PERMISOS = [
  ["ver_mercado", "Ver el mercado de tareas", "Mercado", true, true],
  ["tomar_tareas", "Tomar tareas del mercado", "Mercado", true, true],
  ["ver_nombres", "Ver quién tiene cada tarea (si no, sale \"Ocupado\")", "Mercado", true, true],
  ["ver_ranking", "Ver el ranking", "Ranking y personas", true, true],
  ["ver_puntos_otros", "Ver los puntos de los demás en el ranking (si no, solo el puesto)", "Ranking y personas", true, true],
  ["ver_tareas_otros", "Ver las tareas de otra persona (cd!tareas @usuario)", "Ranking y personas", true, true],
  ["ver_resumen", "Ver el resumen", "Gestión", true, false],
  ["revisar_solicitudes", "Aprobar o rechazar extensiones y cancelaciones", "Gestión", true, false],
  ["asignar_tareas", "Asignar y quitar tareas a otros", "Gestión", true, false],
  ["gestionar_proyectos", "Crear proyectos, capítulos y marcar publicados", "Gestión", true, false],
  ["ver_staff", "Ver la lista del staff y la ficha de cada persona", "Staff", true, false],
  ["editar_staff", "Añadir y editar miembros (roles, hiatus, activar)", "Staff", true, false],
  ["ajustar_puntos", "Dar bonos o penalizaciones de puntos", "Staff", true, false],
  ["ver_actividad", "Ver el registro de actividad", "Staff", true, false],
];
export const CLAVES = PERMISOS.map((p) => p[0]);

export function porDefecto() {
  return {
    lider: Object.fromEntries(PERMISOS.map((p) => [p[0], p[3]])),
    staff: Object.fromEntries(PERMISOS.map((p) => [p[0], p[4]])),
  };
}

// Lee los permisos guardados en config (JSON) y rellena con los valores por defecto lo que falte
export function leerPermisos(cfg) {
  const base = porDefecto();
  try {
    const g = JSON.parse(cfg.permisos || "{}");
    for (const nivel of ["lider", "staff"]) for (const k of CLAVES) if (typeof g[nivel]?.[k] === "boolean") base[nivel][k] = g[nivel][k];
  } catch { /* si el JSON está dañado, se usan los valores por defecto */ }
  return base;
}

export const permisosDe = (persona, permisos) =>
  persona.nivel === "admin" ? Object.fromEntries(CLAVES.map((k) => [k, true])) : permisos[persona.nivel] || permisos.staff;

export function exigir(persona, permisos, clave) {
  if (!permisosDe(persona, permisos)[clave]) fallo("No tienes permiso para esto. Pídeselo a un admin.", 403);
}

export function validarPermisos(b) {
  const limpio = {};
  for (const nivel of ["lider", "staff"]) {
    limpio[nivel] = {};
    for (const k of CLAVES) limpio[nivel][k] = !!b?.[nivel]?.[k];
  }
  return limpio;
}
