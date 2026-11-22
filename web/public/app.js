"use strict";
const $ = (s, el = document) => el.querySelector(s);
const ROLES = ["trad", "clean", "type"];
const ROL = { trad: "Traducción", clean: "Limpieza", type: "Typeo" };
const NIVEL = { admin: "Admin", lider: "Líder", staff: "Staff" };
const ESTADO_CAP = { pendiente: "Pendiente", en_proceso: "En proceso", listo: "Listo", publicado: "Publicado" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fecha = (iso) => iso ? new Date(iso).toLocaleString("es-DO", { dateStyle: "medium", timeStyle: "short" }) : "";
let YO = null, VISTA = "mercado";

async function api(ruta, opts = {}) {
  const o = { method: "GET", headers: {}, ...opts };
  if (o.body && typeof o.body !== "string") { o.body = JSON.stringify(o.body); o.headers["content-type"] = "application/json"; }
  const r = await fetch("/api/" + ruta, o);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && ruta !== "login") { YO = null; pantallaLogin(); throw new Error(d.error || "Inicia sesión"); }
  if (!r.ok) throw new Error(d.error || "Error");
  return d;
}
const post = (ruta, body = {}, method = "POST") => api(ruta, { method, body });

function toast(msg, tipo = "") {
  const t = $("#toast"); t.textContent = msg; t.className = "on " + tipo;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ""), 3500);
}
async function accion(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, "bien"); await render(); return r; }
  catch (e) { toast(e.message, "error"); }
}

// ---------- Inicio ----------
async function iniciar() {
  const acceso = location.hash.match(/^#acceso=([a-f0-9]{64})$/);
  if (acceso) return pantallaAcceso(acceso[1]);
  try {
    const { necesitaSetup } = await api("setup");
    if (necesitaSetup) return pantallaSetup();
    YO = await api("yo");
    pantallaPanel();
  } catch { if (!YO) pantallaLogin(); }
}

function pantallaLogin() {
  $("#app").innerHTML = `<div class="card login"><h2>Crimson Scan</h2>
    <form id="f"><input name="usuario" placeholder="Usuario" autocomplete="username" required>
    <input name="password" type="password" placeholder="Contraseña" autocomplete="current-password" required>
    <button>Entrar</button></form></div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try { await post("login", Object.fromEntries(new FormData(e.target))); YO = await api("yo"); pantallaPanel(); }
    catch (x) { toast(x.message, "error"); }
  };
}

function pantallaAcceso(token) {
  $("#app").innerHTML = `<div class="card login"><h2>Crea tu contraseña</h2>
    <p class="muted">Este enlace te lo mandó el bot y sirve una sola vez.</p>
    <form id="f"><input name="usuario" placeholder="Usuario (solo si todavía no tienes)" autocomplete="username">
    <input name="password" type="password" placeholder="Nueva contraseña (mín. 8)" minlength="8" autocomplete="new-password" required>
    <button>Guardar y entrar</button></form></div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await post("acceso", { token, ...Object.fromEntries(new FormData(e.target)) });
      history.replaceState(null, "", "/");
      YO = await api("yo"); pantallaPanel(); toast("¡Listo! Ya puedes entrar con tu usuario y contraseña.", "bien");
    } catch (x) { toast(x.message, "error"); }
  };
}

function pantallaSetup() {
  $("#app").innerHTML = `<div class="card login"><h2>Crear el administrador</h2>
    <p class="muted">Esto solo aparece la primera vez.</p>
    <form id="f"><input name="nombre" placeholder="Tu nombre" required>
    <input name="usuario" placeholder="Usuario para entrar" required>
    <input name="discord_id" placeholder="Tu ID de Discord (opcional)">
    <input name="password" type="password" placeholder="Contraseña (mín. 10)" minlength="10" required>
    <button>Crear y entrar</button></form></div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target)); if (!d.discord_id) delete d.discord_id;
    try { await post("setup", d); YO = await api("yo"); pantallaPanel(); } catch (x) { toast(x.message, "error"); }
  };
}

const lider = () => YO && (YO.nivel === "admin" || YO.nivel === "lider");
const PESTANAS = () => [
  ["mercado", "Mercado"], ["mis", "Mis tareas"], ["ranking", "Ranking"], ["perfil", "Mi perfil"],
  ...(lider() ? [["|"], ["control", "Control de tareas"], ["proyectos", "Proyectos"], ["staff", "Staff"], ["actividad", "Actividad"]] : []),
  ...(YO?.nivel === "admin" ? [["config", "Ajustes"]] : []),
];

function pantallaPanel() {
  $("#app").innerHTML = `<header><h1>Crimson Scan</h1>
      <div class="fila"><span class="muted">${esc(YO.nombre)} · ${NIVEL[YO.nivel]}</span><button class="sec mini" id="salir">Salir</button></div></header>
    <nav id="nav"></nav><main id="main"></main>`;
  $("#salir").onclick = async () => { await post("logout"); YO = null; pantallaLogin(); };
  render();
}

async function render() {
  if (!YO) return;
  $("#nav").innerHTML = PESTANAS().map(([k, n]) => k === "|" ? '<span class="sep"></span>' : `<button data-v="${k}" class="${k === VISTA ? "on" : ""}">${n}</button>`).join("");
  $("#nav").querySelectorAll("button").forEach((b) => (b.onclick = () => { VISTA = b.dataset.v; render(); }));
  const main = $("#main");
  try { await (VISTAS[VISTA] || VISTAS.mercado)(main); }
  catch (e) { main.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}

const chipEstadoTarea = (t) => {
  if (t.estado !== "activa") return `<span class="chip ${t.estado}">${t.estado}</span>`;
  return `<span class="chip ${t.restante.startsWith("atrasada") ? "atrasada" : "activa"}">${esc(t.restante)}</span>`;
};

const VISTAS = {
  async mercado(main, silencioso = false) {
    const caps = await api("mercado");
    const filtro = VISTAS.mercado.filtro || "todos";
    // Firma de cada capítulo para resaltar los que cambiaron desde la última vez (alguien tomó, entregó o quedó listo)
    const firma = (c) => c.estado + ROLES.map((r) => c.roles[r].estado + (c.roles[r].nombre || "")).join("|");
    const antes = VISTAS.mercado.firmas || {};
    const ahora = Object.fromEntries(caps.map((c) => [c.id, firma(c)]));
    const cambiados = new Set(silencioso ? caps.filter((c) => antes[c.id] && antes[c.id] !== ahora[c.id]).map((c) => c.id) : []);
    VISTAS.mercado.firmas = ahora;

    const libres = (c) => ROLES.some((r) => c.roles[r].estado === "libre");
    const visibles = caps.filter((c) =>
      filtro === "mios" ? ROLES.some((r) => c.roles[r].estado === "libre" && c.roles[r].puedo)
      : filtro === "libres" ? libres(c) : filtro === "listos" ? c.estado === "listo" : true);
    const porObra = {};
    for (const c of visibles) (porObra[c.obra] ??= []).push(c);
    const cuenta = { todos: caps.length, mios: caps.filter((c) => ROLES.some((r) => c.roles[r].estado === "libre" && c.roles[r].puedo)).length,
      libres: caps.filter(libres).length, listos: caps.filter((c) => c.estado === "listo").length };

    const filaRol = (c, r) => {
      const x = c.roles[r];
      if (x.estado === "libre") return `<div class="rol-fila"><span class="quien"><span class="punto libre"></span><span>${ROL[r]}</span></span>
        ${x.puedo ? `<button class="mini" data-tomar="${c.id}" data-rol="${r}">Tomar</button>` : '<span class="muted">Libre</span>'}</div>`;
      const txt = x.estado === "entregada" ? `✓ ${esc(x.nombre)}` : esc(x.nombre);
      return `<div class="rol-fila"><span class="quien"><span class="punto ${x.estado}"></span><span>${ROL[r]}</span></span>
        <span class="chip ${x.estado}" title="${x.estado === "entregada" ? "Entregado" : "Trabajando"}">${txt}</span></div>`;
    };

    main.innerHTML = `<div class="card"><div class="fila" style="justify-content:space-between"><h2>Mercado de tareas</h2><span class="vivo">Se actualiza solo</span></div>
      <p class="muted">Toma una tarea libre de tu rol. Tienes ${esc(YO.config.dias_limite)} días para entregarla. Cuando los 3 roles se entregan, el capítulo pasa a <b>Listo</b>.</p>
      <div class="filtros">${[["todos", "Todos"], ["mios", "Para mí"], ["libres", "Con roles libres"], ["listos", "Listos"]]
        .map(([k, n]) => `<button data-filtro="${k}" class="${filtro === k ? "on" : ""}">${n} (${cuenta[k]})</button>`).join("")}</div>
      ${Object.keys(porObra).length ? Object.entries(porObra).map(([obra, lista]) => `
        <div class="obra-titulo"><h3>${esc(obra)}</h3><span class="muted">${lista.length} cap.</span></div>
        <div class="caps-grid">${lista.map((c) => `<div class="cap-card ${c.estado} ${cambiados.has(c.id) ? "cambio" : ""}">
          <div class="cap-head"><b>Cap. ${esc(c.numero)}</b><span class="chip ${c.estado === "listo" ? "listo" : c.estado === "en_proceso" ? "activa" : "libre"}">${ESTADO_CAP[c.estado]}</span></div>
          ${ROLES.map((r) => filaRol(c, r)).join("")}</div>`).join("")}</div>`).join("")
      : `<p class="muted">${caps.length ? "No hay capítulos con este filtro." : "No hay capítulos pendientes en proyectos activos."}</p>`}</div>`;

    main.querySelectorAll("[data-filtro]").forEach((b) => (b.onclick = () => { VISTAS.mercado.filtro = b.dataset.filtro; VISTAS.mercado(main); }));
    main.querySelectorAll("[data-tomar]").forEach((b) => (b.onclick = () => {
      b.disabled = true;
      accion(() => post("tareas/tomar", { capitulo_id: Number(b.dataset.tomar), rol: b.dataset.rol }), "Tarea tomada. ¡A darle!");
    }));
    // Refresca cada 20 s mientras el mercado esté abierto
    clearTimeout(VISTAS.mercado.timer);
    VISTAS.mercado.timer = setTimeout(() => {
      if (VISTA === "mercado" && YO && !document.querySelector("dialog[open]")) VISTAS.mercado(main, true).catch(() => {});
    }, 20000);
  },

  async mis(main) {
    const ts = await api("mis-tareas?todas=1");
    const act = ts.filter((t) => t.estado === "activa"), otras = ts.filter((t) => t.estado !== "activa");
    main.innerHTML = `<div class="card"><h2>Mis tareas activas</h2>${act.length ? `<div class="tabla"><table>
      <tr><th>Obra</th><th>Cap.</th><th>Rol</th><th>Vence</th><th>Tiempo</th><th></th></tr>
      ${act.map((t) => `<tr><td>${esc(t.obra)}</td><td>${esc(t.cap)}</td><td>${t.rol_nombre}</td><td>${fecha(t.limite)}</td><td>${chipEstadoTarea(t)}</td>
        <td class="fila">${t.solicitud ? `<span class="chip">Pediste ${t.solicitud === "extension" ? `+${t.solicitud_dias} días` : "cancelar"}</span>` : `
          <button class="ok mini" data-entregar="${t.id}">Entregar</button>
          <button class="sec mini" data-ext="${t.id}">Pedir más tiempo</button>
          <button class="sec mini" data-cancel="${t.id}">Pedir cancelar</button>`}</td></tr>`).join("")}
      </table></div>` : '<p class="muted">No tienes tareas activas. Pasa por el mercado.</p>'}</div>
      <div class="card"><h2>Historial</h2>${otras.length ? `<div class="tabla"><table><tr><th>Obra</th><th>Cap.</th><th>Rol</th><th>Estado</th><th>Cerrada</th></tr>
      ${otras.map((t) => `<tr><td>${esc(t.obra)}</td><td>${esc(t.cap)}</td><td>${t.rol_nombre}</td><td>${chipEstadoTarea(t)}</td><td>${fecha(t.cerrada)}</td></tr>`).join("")}
      </table></div>` : '<p class="muted">Todavía nada.</p>'}</div>`;
    main.querySelectorAll("[data-entregar]").forEach((b) => (b.onclick = () => {
      if (confirm("¿Confirmas que entregaste esta tarea?")) accion(() => post(`tareas/${b.dataset.entregar}/entregar`), "¡Entregada! +puntos");
    }));
    main.querySelectorAll("[data-ext]").forEach((b) => (b.onclick = () => dialogo("Pedir más tiempo", `
      <label>Días extra <input name="dias" type="number" min="1" max="14" value="2" required></label>
      <label>Motivo <input name="motivo" maxlength="300" placeholder="Opcional"></label>`,
      (d) => post(`tareas/${b.dataset.ext}/solicitar`, { tipo: "extension", dias: Number(d.dias), motivo: d.motivo }), "Solicitud enviada a los líderes")));
    main.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => dialogo("Pedir cancelar la tarea", `
      <label>Motivo <input name="motivo" maxlength="300" required></label>`,
      (d) => post(`tareas/${b.dataset.cancel}/solicitar`, { tipo: "cancelacion", motivo: d.motivo }), "Solicitud enviada a los líderes")));
  },

  async ranking(main) {
    const mes = Number(VISTAS.ranking.mes || 0);
    const filas = await api("ranking?mes=" + mes);
    main.innerHTML = `<div class="card"><div class="fila" style="justify-content:space-between"><h2>Ranking ${mes === 0 ? "de este mes" : "del mes pasado"}</h2>
      <button class="sec mini" id="cambiarMes">${mes === 0 ? "Ver mes pasado" : "Ver este mes"}</button></div>
      ${filas.length ? `<div class="tabla"><table><tr><th>#</th><th>Nombre</th><th>Puntos</th><th>Entregas</th><th>Vencidas</th></tr>
      ${filas.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.nombre)}</td><td><b>${r.puntos}</b></td><td>${r.entregas}</td><td>${r.vencidas}</td></tr>`).join("")}
      </table></div>` : '<p class="muted">Aún no hay puntos este mes.</p>'}</div>`;
    $("#cambiarMes").onclick = () => { VISTAS.ranking.mes = mes === 0 ? -1 : 0; render(); };
  },

  async perfil(main) {
    const p = await api("perfil");
    main.innerHTML = `<div class="card"><h2>${esc(p.nombre)}</h2>
      <p class="muted">${NIVEL[p.nivel]} · Roles: ${p.roles ? p.roles.split(",").map((r) => ROL[r]).join(", ") : "ninguno"}${p.hiatus_hasta && new Date(p.hiatus_hasta) > new Date() ? ` · En hiatus hasta ${fecha(p.hiatus_hasta)}` : ""}</p>
      <div class="stats"><div class="stat"><span class="muted">Puntos del mes</span><b>${p.puntos_mes}</b></div>
      <div class="stat"><span class="muted">Entregas del mes</span><b>${p.entregas_mes} / ${p.cuota}</b></div>
      <div class="stat"><span class="muted">Entregas totales</span><b>${p.entregas_total}</b></div>
      <div class="stat"><span class="muted">Cuota</span><b>${p.cumple_cuota ? "✅ Cumplida" : `Faltan ${p.cuota - p.entregas_mes}`}</b></div></div></div>
      <div class="card"><h2>Cambiar contraseña</h2><form id="pw" class="fila">
      <input name="actual" type="password" placeholder="Contraseña actual" required>
      <input name="nueva" type="password" placeholder="Nueva (mín. 8)" minlength="8" required><button>Cambiar</button></form></div>`;
    $("#pw").onsubmit = (e) => { e.preventDefault(); accion(() => post("yo/password", Object.fromEntries(new FormData(e.target))), "Contraseña cambiada"); };
  },

  async control(main) {
    const ts = await api("admin/tareas");
    const sol = ts.filter((t) => t.solicitud);
    main.innerHTML = `<div class="card"><h2>Solicitudes pendientes (${sol.length})</h2>${sol.length ? `<div class="tabla"><table>
      <tr><th>Quién</th><th>Tarea</th><th>Pide</th><th>Motivo</th><th></th></tr>
      ${sol.map((t) => `<tr><td>${esc(t.staff_nombre)}</td><td>${esc(t.obra)} ${esc(t.cap)} · ${t.rol_nombre}<br>${chipEstadoTarea(t)}</td>
        <td>${t.solicitud === "extension" ? `+${t.solicitud_dias} días` : "Cancelar"}</td><td>${esc(t.solicitud_motivo)}</td>
        <td class="fila"><button class="ok mini" data-res="${t.id}" data-ok="1">Aprobar</button><button class="sec mini" data-res="${t.id}" data-ok="0">Rechazar</button></td></tr>`).join("")}
      </table></div>` : '<p class="muted">No hay solicitudes.</p>'}</div>
      <div class="card"><h2>Todas las tareas activas (${ts.length})</h2>${ts.length ? `<div class="tabla"><table>
      <tr><th>Quién</th><th>Obra</th><th>Cap.</th><th>Rol</th><th>Vence</th><th>Tiempo</th><th></th></tr>
      ${ts.map((t) => `<tr><td>${esc(t.staff_nombre)}</td><td>${esc(t.obra)}</td><td>${esc(t.cap)}</td><td>${t.rol_nombre}</td><td>${fecha(t.limite)}</td>
        <td>${chipEstadoTarea(t)}</td><td><button class="sec mini" data-quitar="${t.id}">Quitar</button></td></tr>`).join("")}</table></div>` : '<p class="muted">Nadie tiene tareas activas.</p>'}</div>`;
    main.querySelectorAll("[data-res]").forEach((b) => (b.onclick = () =>
      accion(() => post(`admin/tareas/${b.dataset.res}/resolver`, { aprobar: b.dataset.ok === "1" }), b.dataset.ok === "1" ? "Aprobada" : "Rechazada")));
    main.querySelectorAll("[data-quitar]").forEach((b) => (b.onclick = () => {
      if (confirm("¿Quitar esta tarea? Vuelve al mercado sin restar puntos.")) accion(() => post(`admin/tareas/${b.dataset.quitar}/quitar`), "Tarea liberada");
    }));
  },

  async proyectos(main) {
    const ps = await api("admin/proyectos");
    const sel = VISTAS.proyectos.sel ?? ps[0]?.id;
    main.innerHTML = `<div class="card"><h2>Proyectos</h2>
      <form id="np" class="fila"><input name="nombre" placeholder="Nombre del nuevo proyecto" required><button>Crear proyecto</button></form>
      <div class="tabla" style="margin-top:12px"><table><tr><th>Proyecto</th><th>Estado</th><th>Caps.</th><th>Pend.</th><th>En proceso</th><th>Listos</th><th>Publicados</th><th></th></tr>
      ${ps.map((p) => `<tr><td><a href="#" data-sel="${p.id}">${esc(p.nombre)}</a></td>
        <td><select data-estado="${p.id}">${["activo", "pausado", "terminado"].map((e) => `<option ${p.estado === e ? "selected" : ""}>${e}</option>`).join("")}</select></td>
        <td>${p.total}</td><td>${p.pendientes || 0}</td><td>${p.en_proceso || 0}</td><td>${p.listos || 0}</td><td>${p.publicados || 0}</td>
        <td><button class="sec mini" data-sel="${p.id}">Capítulos</button></td></tr>`).join("")}</table></div></div>
      <div id="caps"></div>`;
    $("#np").onsubmit = (e) => { e.preventDefault(); accion(() => post("admin/proyectos", Object.fromEntries(new FormData(e.target))), "Proyecto creado"); };
    main.querySelectorAll("[data-sel]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); VISTAS.proyectos.sel = Number(a.dataset.sel); render(); }));
    main.querySelectorAll("[data-estado]").forEach((s) => (s.onchange = () => accion(() => post(`admin/proyectos/${s.dataset.estado}`, { estado: s.value }, "PATCH"), "Estado cambiado")));
    if (sel) await capitulos($("#caps"), ps.find((p) => p.id === sel));
  },

  async staff(main) {
    const gente = await api("admin/staff");
    main.innerHTML = `<div class="card"><div class="fila" style="justify-content:space-between"><h2>Staff (${gente.filter((g) => g.activo).length} activos)</h2>
      <button id="nuevo">Añadir miembro</button></div>
      <div class="tabla"><table><tr><th>Nombre</th><th>Usuario</th><th>Discord</th><th>Nivel</th><th>Roles</th><th>Activas</th><th>Estado</th><th></th></tr>
      ${gente.map((g) => `<tr style="${g.activo ? "" : "opacity:.5"}"><td>${esc(g.nombre)}</td><td>${esc(g.usuario || "—")}</td><td class="muted">${esc(g.discord_id || "—")}</td>
        <td>${NIVEL[g.nivel]}</td><td>${g.roles ? g.roles.split(",").map((r) => `<span class="chip">${ROL[r]}</span>`).join(" ") : "—"}</td><td>${g.activas}</td>
        <td>${!g.activo ? "Inactivo" : g.hiatus_hasta && new Date(g.hiatus_hasta) > new Date() ? `Hiatus hasta ${fecha(g.hiatus_hasta)}` : "Activo"}</td>
        <td><button class="sec mini" data-edit="${g.id}">Editar</button></td></tr>`).join("")}</table></div></div>`;
    const form = (g = {}) => `
      <input name="nombre" placeholder="Nombre" value="${esc(g.nombre)}" required>
      <input name="usuario" placeholder="Usuario del panel (opcional)" value="${esc(g.usuario)}">
      <input name="password" type="password" placeholder="${g.id ? "Nueva contraseña (dejar vacío para no cambiar)" : "Contraseña (mín. 8)"}" minlength="8">
      <input name="discord_id" placeholder="ID de Discord" value="${esc(g.discord_id)}">
      ${YO.nivel === "admin" ? `<select name="nivel">${Object.entries(NIVEL).map(([k, n]) => `<option value="${k}" ${(g.nivel || "staff") === k ? "selected" : ""}>${n}</option>`).join("")}</select>` : ""}
      <div class="roles-check">${ROLES.map((r) => `<label><input type="checkbox" name="rol_${r}" ${(g.roles || "").split(",").includes(r) ? "checked" : ""}> ${ROL[r]}</label>`).join("")}</div>
      ${g.id ? `<label>Hiatus (días, 0 = quitar) <input name="hiatus_dias" type="number" min="0" max="365" placeholder="Sin cambios"></label>
      <label><input type="checkbox" name="activo" ${g.activo ? "checked" : ""}> Activo</label>` : ""}`;
    const datos = (d, g) => {
      const b = { nombre: d.nombre, usuario: d.usuario || null, discord_id: d.discord_id || null, roles: ROLES.filter((r) => d["rol_" + r]).join(",") };
      if (d.password) b.password = d.password;
      if (d.nivel) b.nivel = d.nivel;
      if (g) { b.activo = !!d.activo; if (d.hiatus_dias !== "") b.hiatus_dias = Number(d.hiatus_dias); if (g.nivel === d.nivel) delete b.nivel; }
      return b;
    };
    $("#nuevo").onclick = () => dialogo("Añadir miembro", form(), (d) => post("admin/staff", datos(d)), "Miembro añadido");
    main.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => {
      const g = gente.find((x) => x.id === Number(b.dataset.edit));
      dialogo(`Editar a ${g.nombre}`, form(g), (d) => post(`admin/staff/${g.id}`, datos(d, g), "PATCH"), "Cambios guardados");
    }));
  },

  async actividad(main) {
    const ev = await api("admin/eventos");
    main.innerHTML = `<div class="card"><h2>Actividad reciente</h2><div class="tabla"><table><tr><th>Fecha</th><th>Quién</th><th>Acción</th><th>Detalle</th></tr>
      ${ev.map((e) => `<tr><td class="muted">${fecha(e.fecha)}</td><td>${esc(e.nombre || "Sistema")}</td><td>${esc(e.accion.replace(/_/g, " "))}</td><td class="muted">${esc(e.detalle || "")}</td></tr>`).join("")}
      </table></div></div>`;
  },

  async config(main) {
    const c = (await api("yo")).config;
    const campos = [["dias_limite", "Días para entregar una tarea"], ["max_tareas_activas", "Máximo de tareas activas por persona"],
      ["puntos_entrega", "Puntos por entrega"], ["puntos_vencida", "Puntos por tarea vencida (negativo)"], ["horas_gracia", "Horas de gracia antes de vencer"],
      ["cuota_mensual", "Cuota mensual de entregas"], ["hora_reporte", "Hora del reporte diario a líderes (0-23)"]];
    main.innerHTML = `<div class="card"><h2>Ajustes del sistema</h2><form id="cfg">
      ${campos.map(([k, n]) => `<div class="fila" style="margin-bottom:8px"><label style="flex:2">${n}</label><input name="${k}" type="number" value="${esc(c[k])}" style="flex:1"></div>`).join("")}
      <button>Guardar</button></form></div>
      <div class="card"><h2>Acciones</h2><div class="fila">
      <button class="sec" id="vencer">Revisar tareas vencidas ahora</button><button class="sec" id="reporte">Mandar reporte a líderes ahora</button></div>
      <p class="muted">Esto también se hace solo cada hora.</p></div>`;
    $("#cfg").onsubmit = (e) => {
      e.preventDefault();
      const d = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]));
      accion(async () => { YO.config = await post("admin/config", d); }, "Ajustes guardados");
    };
    $("#vencer").onclick = () => accion(async () => toast(`Tareas vencidas: ${(await post("admin/revisar-vencidas")).vencidas}`, "bien"));
    $("#reporte").onclick = () => accion(() => post("admin/reporte"), "Reporte enviado");
  },
};

async function capitulos(el, p) {
  if (!p) return;
  const [caps, gente] = await Promise.all([api(`admin/proyectos/${p.id}/capitulos`), api("admin/staff")]);
  const activos = gente.filter((g) => g.activo);
  el.innerHTML = `<div class="card"><h2>${esc(p.nombre)}: capítulos</h2>
    <form id="nc" class="fila"><input name="capitulos" placeholder="Ej: 1-20, 21.5, 25" required><button>Añadir capítulos</button></form>
    <div class="tabla" style="margin-top:12px"><table><tr><th>Cap.</th><th>Estado</th>${ROLES.map((r) => `<th>${ROL[r]}</th>`).join("")}<th></th></tr>
    ${caps.map((c) => `<tr><td><b>${esc(c.numero)}</b></td>
      <td><select data-cap="${c.id}">${Object.entries(ESTADO_CAP).map(([k, n]) => `<option value="${k}" ${c.estado === k ? "selected" : ""}>${n}</option>`).join("")}</select></td>
      ${ROLES.map((r) => { const x = c.roles[r]; return `<td>${x ? `<span class="chip ${x.estado}">${esc(x.nombre)}</span>` : `<button class="sec mini" data-asig="${c.id}" data-rol="${r}">Asignar</button>`}</td>`; }).join("")}
      <td><button class="sec mini" data-borrar="${c.id}">Borrar</button></td></tr>`).join("")}</table></div></div>`;
  $("#nc").onsubmit = (e) => {
    e.preventDefault();
    accion(async () => { const r = await post(`admin/proyectos/${p.id}/capitulos`, Object.fromEntries(new FormData(e.target))); toast(`Creados ${r.creados}${r.repetidos ? `, ${r.repetidos} ya existían` : ""}`, "bien"); });
  };
  el.querySelectorAll("[data-cap]").forEach((s) => (s.onchange = () => accion(() => post(`admin/capitulos/${s.dataset.cap}`, { estado: s.value }, "PATCH"), "Estado cambiado")));
  el.querySelectorAll("[data-borrar]").forEach((b) => (b.onclick = () => { if (confirm("¿Borrar este capítulo?")) accion(() => api(`admin/capitulos/${b.dataset.borrar}`, { method: "DELETE" }), "Capítulo borrado"); }));
  el.querySelectorAll("[data-asig]").forEach((b) => (b.onclick = () => {
    const posibles = activos.filter((g) => g.nivel !== "staff" || g.roles.split(",").includes(b.dataset.rol));
    dialogo(`Asignar ${ROL[b.dataset.rol]}`, `<select name="staff_id" required>${posibles.map((g) => `<option value="${g.id}">${esc(g.nombre)} (${g.activas} activas)</option>`).join("")}</select>
      <label>Días para entregar <input name="dias" type="number" min="1" max="60" placeholder="${esc(YO.config.dias_limite)}"></label>`,
      (d) => post("admin/asignar", { capitulo_id: Number(b.dataset.asig), rol: b.dataset.rol, staff_id: Number(d.staff_id), dias: d.dias ? Number(d.dias) : undefined }), "Tarea asignada");
  }));
}

function dialogo(titulo, html, enviar, okMsg) {
  const d = document.createElement("dialog");
  d.innerHTML = `<form method="dialog"><h2>${esc(titulo)}</h2>${html}<div class="fila"><button value="ok">Guardar</button><button value="no" class="sec" formnovalidate>Cancelar</button></div></form>`;
  document.body.append(d);
  const f = $("form", d);
  f.onsubmit = async (e) => {
    if (e.submitter?.value === "no") return;
    e.preventDefault();
    const datos = Object.fromEntries(new FormData(f));
    try { await enviar(datos); d.close(); if (okMsg) toast(okMsg, "bien"); render(); } catch (x) { toast(x.message, "error"); }
  };
  d.onclose = () => d.remove();
  d.showModal();
}

iniciar();
