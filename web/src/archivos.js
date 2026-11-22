// Archivos de los capítulos en R2 (binding FILES): RAWs y el trabajo entregado por cada rol.
import { fallo, json, registrar, config, ROLES } from "./util.js";

export const ETAPAS = ["raw", ...ROLES];
const IMAGENES = ["jpg", "jpeg", "png", "webp", "gif", "zip", "rar", "7z"];
// Qué se puede subir en cada etapa
export const FORMATOS = {
  raw: IMAGENES,
  trad: ["docx", "doc", "odt", "txt", "pdf", "zip"],
  clean: [...IMAGENES, "psd"],
  type: [...IMAGENES, "psd"],
};
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB por archivo
const TIPOS = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed", pdf: "application/pdf",
  txt: "text/plain; charset=utf-8", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword", odt: "application/vnd.oasis.opendocument.text", psd: "image/vnd.adobe.photoshop" };

export function limpiarNombre(n) {
  const base = String(n || "").split(/[\\/]/).pop().normalize("NFC").replace(/[^\p{L}\p{N}._ ()-]+/gu, "_").replace(/^\.+/, "").trim().slice(0, 120);
  if (!base || !base.includes(".")) fallo("Nombre de archivo inválido");
  return base;
}
const extension = (n) => n.split(".").pop().toLowerCase();
const ordenNatural = (a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true, sensitivity: "base" });

async function capitulo(env, id) {
  const c = await env.DB.prepare("SELECT c.*, p.nombre AS obra FROM capitulos c JOIN proyectos p ON p.id = c.proyecto_id WHERE c.id = ?").bind(id).first();
  if (!c) fallo("Capítulo no encontrado", 404);
  return c;
}
// ¿Tiene o tuvo esta persona una tarea en el capítulo?
async function tareaEn(env, staffId, capId, rol) {
  return env.DB.prepare(`SELECT id, rol, estado FROM tareas WHERE staff_id = ? AND capitulo_id = ? AND estado IN ('activa','entregada')
    ${rol ? "AND rol = ?" : ""} ORDER BY estado = 'activa' DESC LIMIT 1`).bind(...[staffId, capId, rol].filter((x) => x !== undefined)).first();
}

export async function puedeVer(env, yo, puedo, capId) {
  if (puedo.subir_raws || puedo.asignar_tareas || puedo.gestionar_proyectos) return true;
  return Boolean(await tareaEn(env, yo.id, capId));
}
// RAW: quien tenga el permiso subir_raws. Trabajo de un rol: quien tenga esa tarea activa (o un líder con subir_raws).
async function puedeSubir(env, yo, puedo, capId, etapa) {
  if (puedo.subir_raws) return true;
  if (etapa === "raw") return false;
  const t = await tareaEn(env, yo.id, capId, etapa);
  return Boolean(t && t.estado === "activa");
}

export async function listar(env, capId) {
  const { results } = await env.DB.prepare(`SELECT a.id, a.etapa, a.nombre, a.bytes, a.tipo, a.creado, s.nombre AS subio
    FROM archivos a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.capitulo_id = ?`).bind(capId).all();
  const por = Object.fromEntries(ETAPAS.map((e) => [e, []]));
  for (const a of results.sort(ordenNatural)) por[a.etapa].push(a);
  return por;
}

export async function subir(req, env, yo, puedo, capId, etapa, nombreCrudo) {
  if (!env.FILES) fallo("El almacenamiento de archivos no está configurado", 500);
  if (!ETAPAS.includes(etapa)) fallo("Etapa inválida");
  const cap = await capitulo(env, capId);
  if (!(await puedeSubir(env, yo, puedo, capId, etapa))) {
    fallo(etapa === "raw" ? "No tienes permiso para subir RAWs" : `Solo quien tiene la tarea de ${etapa} de este capítulo puede subir ese trabajo`, 403);
  }
  const nombre = limpiarNombre(nombreCrudo);
  const ext = extension(nombre);
  if (!FORMATOS[etapa].includes(ext)) fallo(`Formato .${ext} no permitido aquí. Se acepta: ${FORMATOS[etapa].join(", ")}`);
  const largo = Number(req.headers.get("content-length") || 0);
  if (!largo) fallo("El archivo está vacío");
  if (largo > MAX_BYTES) fallo("El archivo pasa de 50 MB");

  const clave = `caps/${cap.proyecto_id}/${cap.id}/${etapa}/${crypto.randomUUID().slice(0, 8)}-${nombre}`;
  const tipo = TIPOS[ext] || "application/octet-stream";
  const obj = await env.FILES.put(clave, req.body, { httpMetadata: { contentType: tipo } });
  const anterior = await env.DB.prepare("SELECT clave FROM archivos WHERE capitulo_id = ? AND etapa = ? AND nombre = ?").bind(capId, etapa, nombre).first();
  await env.DB.prepare(`INSERT INTO archivos (capitulo_id, etapa, nombre, clave, bytes, tipo, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (capitulo_id, etapa, nombre) DO UPDATE SET clave = excluded.clave, bytes = excluded.bytes, tipo = excluded.tipo,
    staff_id = excluded.staff_id, creado = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).bind(capId, etapa, nombre, clave, obj.size, tipo, yo.id).run();
  if (anterior) await env.FILES.delete(anterior.clave); // se reemplazó un archivo con el mismo nombre
  return { ok: true, nombre, bytes: obj.size, reemplazado: Boolean(anterior) };
}

export async function descargar(env, yo, puedo, id) {
  const a = await env.DB.prepare("SELECT * FROM archivos WHERE id = ?").bind(id).first();
  if (!a) fallo("Archivo no encontrado", 404);
  if (!(await puedeVer(env, yo, puedo, a.capitulo_id))) fallo("Toma una tarea de este capítulo para ver sus archivos", 403);
  const obj = await env.FILES.get(a.clave);
  if (!obj) fallo("El archivo ya no existe en el almacenamiento", 404);
  return new Response(obj.body, { headers: {
    "content-type": a.tipo, "content-length": String(obj.size), "cache-control": "private, max-age=300",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.nombre)}`,
    "x-content-type-options": "nosniff",
  } });
}

export async function borrar(env, yo, puedo, id) {
  const a = await env.DB.prepare("SELECT * FROM archivos WHERE id = ?").bind(id).first();
  if (!a) fallo("Archivo no encontrado", 404);
  if (!(await puedeSubir(env, yo, puedo, a.capitulo_id, a.etapa))) fallo("No puedes borrar este archivo", 403);
  await env.FILES.delete(a.clave);
  await env.DB.prepare("DELETE FROM archivos WHERE id = ?").bind(id).run();
  await registrar(env, yo.id, "archivo_borrado", { capitulo: a.capitulo_id, etapa: a.etapa, nombre: a.nombre });
  return { ok: true };
}

// Para entregar hay que haber subido el trabajo (si está activado en Ajustes)
export async function exigirArchivos(env, capId, rol) {
  const cfg = await config(env);
  if (String(cfg.exigir_archivos ?? "1") !== "1") return;
  const hay = await env.DB.prepare("SELECT 1 FROM archivos WHERE capitulo_id = ? AND etapa = ? LIMIT 1").bind(capId, rol).first();
  if (!hay) fallo("Sube tu trabajo antes de entregar (en Mis tareas, botón \"Archivos\").");
}
