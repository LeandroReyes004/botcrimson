// Utilidades comunes
export class ApiError extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}
export const fallo = (mensaje, status = 400) => { throw new ApiError(mensaje, status); };

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const ROLES = ["trad", "clean", "type", "proof"];
export const ROL_NOMBRE = { trad: "Traducción", clean: "Limpieza", type: "Typeo", proof: "Proofreading" };

// ---------- Fechas (todo en UTC) ----------
export const ahoraISO = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
export const sumarDias = (iso, dias) => {
  const d = new Date(iso);
  d.setTime(d.getTime() + dias * 86400000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
};
// Horas que faltan (negativo = atrasada). Se calcula con horas, no días, para no redondear mal.
export const horasRestantes = (iso) => Math.round((new Date(iso).getTime() - Date.now()) / 3600000);
export const textoRestante = (iso) => {
  const h = horasRestantes(iso);
  if (h < 0) {
    const a = -h;
    return a < 24 ? `atrasada ${a} h` : `atrasada ${Math.floor(a / 24)} d ${a % 24} h`;
  }
  return h < 24 ? `faltan ${h} h` : `faltan ${Math.floor(h / 24)} d ${h % 24} h`;
};
export const inicioMesISO = (zona, offsetMeses = 0) => {
  // Primer día del mes en la zona horaria del scan, expresado en UTC
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  let y = Number(partes.find((p) => p.type === "year").value);
  let m = Number(partes.find((p) => p.type === "month").value) + offsetMeses;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  const offset = zonaOffsetMin(zona, new Date(Date.UTC(y, m - 1, 1, 12)));
  return new Date(Date.UTC(y, m - 1, 1) - offset * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
};
function zonaOffsetMin(zona, fecha) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zona, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(fecha).map((x) => [x.type, x.value]));
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((local - fecha.getTime()) / 60000);
}
export const horaLocal = (zona) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: zona, hour: "numeric", hourCycle: "h23" }).format(new Date()));
export const fechaLocal = (zona) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(new Date());

// ---------- Contraseñas (PBKDF2) ----------
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}
// 50.000 iteraciones cabe en el límite de CPU del plan gratis de Workers (~8 ms).
// Las iteraciones se guardan en el hash, así que se pueden subir más adelante sin romper nada.
const ITERACIONES = 50000;
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERACIONES}$${toHex(salt)}$${toHex(await pbkdf2(password, salt, ITERACIONES))}`;
}
export async function verificarPassword(password, guardado) {
  if (!guardado || !guardado.startsWith("pbkdf2$")) return false;
  const [, iter, salt, hash] = guardado.split("$");
  return iguales(toHex(await pbkdf2(password, fromHex(salt), Number(iter))), hash);
}
export function iguales(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export const tokenAleatorio = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

// ---------- Validación ----------
export const texto = (v, nombre, max = 200) => {
  const s = String(v ?? "").trim();
  if (!s) fallo(`Falta ${nombre}`);
  if (s.length > max) fallo(`${nombre} es demasiado largo`);
  return s;
};
export const entero = (v, nombre, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fallo(`${nombre} debe ser un número entre ${min} y ${max}`);
  return n;
};
export const discordId = (v) => {
  const s = String(v ?? "").trim().replace(/^<@!?(\d+)>$/, "$1");
  if (!/^\d{15,22}$/.test(s)) fallo("ID de Discord inválido");
  return s;
};
export const normalizarRoles = (v) => {
  const lista = (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((r) => r.trim().toLowerCase()).filter(Boolean);
  for (const r of lista) if (!ROLES.includes(r)) fallo(`Rol desconocido: ${r}`);
  return [...new Set(lista)].join(",");
};

// ---------- Config ----------
export async function config(env) {
  const { results } = await env.DB.prepare("SELECT clave, valor FROM config").all();
  return Object.fromEntries(results.map((r) => [r.clave, r.valor]));
}

export async function registrar(env, staffId, accion, detalle) {
  await env.DB.prepare("INSERT INTO eventos (staff_id, accion, detalle) VALUES (?, ?, ?)")
    .bind(staffId ?? null, accion, detalle ? JSON.stringify(detalle) : null).run();
}

// ---------- Discord ----------
export async function avisar(env, contenido, canal = "general") {
  const url = (canal === "lideres" ? env.DISCORD_WEBHOOK_LIDERES || env.DISCORD_WEBHOOK_URL : env.DISCORD_WEBHOOK_URL)?.trim();
  if (!url) return;
  const body = typeof contenido === "string" ? { content: contenido } : contenido;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_mentions: { parse: ["users"] }, ...body }),
    });
    if (!r.ok) console.error("Webhook Discord", r.status, await r.text());
  } catch (e) { console.error("Webhook Discord", e); }
}
export const mencion = (s) => (s.discord_id ? `<@${s.discord_id}>` : `**${s.nombre}**`);
