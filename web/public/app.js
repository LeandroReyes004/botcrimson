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
  const err = location.hash.match(/^#error=([a-z-]+)$/);
  if (err) { history.replaceState(null, "", "/"); setTimeout(() => toast(ERRORES_LOGIN[err[1]] || "No se pudo entrar con Discord.", "error"), 50); }
  try {
    const { necesitaSetup, discord } = await api("setup");
    DISCORD_LOGIN = discord;
    if (necesitaSetup) return pantallaSetup();
    YO = await api("yo");
    pantallaPanel();
  } catch { if (!YO) pantallaLogin(); }
}

let DISCORD_LOGIN = false;
const ERRORES_LOGIN = {
  "no-registrado": "Tu cuenta de Discord no está en el staff. Pide a un líder que te añada con tu ID de Discord.",
  desactivado: "Tu cuenta está desactivada. Habla con un líder.",
  cancelado: "Cancelaste el inicio de sesión con Discord.",
  estado: "El inicio de sesión caducó. Vuelve a intentarlo.",
  discord: "Discord no respondió. Intenta otra vez en un momento.",
  "discord-off": "El login con Discord todavía no está configurado.",
};

function pantallaLogin() {
  $("#app").innerHTML = `<div class="card login"><h2>Crimson Scan</h2>
    ${DISCORD_LOGIN ? `<a class="boton-discord" href="/api/auth/discord">Entrar con Discord</a>
    <p class="muted centro-txt">o con usuario y contraseña</p>` : ""}
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

const P = (claves) => YO?.nivel === "admin" || claves.split("|").some((k) => YO?.permisos?.[k]);
const PESTANAS = () => {
  const gestion = [["resumen", "Resumen", "ver_resumen"], ["control", "Control de tareas", "revisar_solicitudes|asignar_tareas"],
    ["proyectos", "Proyectos", "gestionar_proyectos|asignar_tareas"], ["staff", "Staff", "ver_staff"], ["actividad", "Actividad", "ver_actividad"]]
    .filter(([, , k]) => P(k));
  return [
    ...[["mercado", "Mercado", "ver_mercado"], ["mis", "Mis tareas"], ["ranking", "Ranking", "ver_ranking"], ["perfil", "Mi perfil"]].filter(([, , k]) => !k || P(k)),
    ...(gestion.length ? [["|"], ...gestion] : []),
    ...(YO?.nivel === "admin" ? [["config", "Ajustes"], ["permisos", "Permisos"]] : []),
  ];
};
// Quita botones y controles que la persona no puede usar (marcados con data-perm="clave|otra")
function aplicarPermisos(raiz = document) {
  raiz.querySelectorAll("[data-perm]").forEach((el) => {
    if (P(el.dataset.perm)) return;
    if (el.tagName === "SELECT") { el.disabled = true; el.removeAttribute("data-perm"); } else el.remove();
  });
}
new MutationObserver(() => aplicarPermisos()).observe(document.body, { childList: true, subtree: true });

function pantallaPanel() {
  VISTA = P("ver_resumen") ? "resumen" : P("ver_mercado") ? "mercado" : "mis";
  $("#app").innerHTML = `<header><h1>Crimson Scan</h1>
      <div class="fila"><span class="muted">${esc(YO.nombre)} · ${NIVEL[YO.nivel]}</span><button class="sec mini" id="salir">Salir</button></div></header>
    <nav id="nav"></nav><main id="main"></main>`;
  $("#salir").onclick = async () => { await post("logout"); YO = null; pantallaLogin(); };
  render();
}

async function render() {
  if (!YO) return;
  $("#nav").innerHTML = PESTANAS().map(([k, n]) => k === "|" ? '<span class="sep"></span>' : `<button data-v="${k}" class="${k === VISTA || (k === "staff" && VISTA === "ficha") ? "on" : ""}">${n}</button>`).join("");
  $("#nav").querySelectorAll("button").forEach((b) => (b.onclick = () => { VISTA = b.dataset.v; render(); }));
  const main = $("#main");
  if (!PESTANAS().some(([k]) => k === VISTA) && VISTA !== "ficha") VISTA = PESTANAS()[0][0];
  try { await (VISTAS[VISTA] || VISTAS.mis)(main); }
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
          <div class="cap-head"><b>Cap. ${esc(c.numero)}${c.raws ? ' <span class="chip raw" title="RAW subida al panel">RAW</span>' : ""}</b><span class="chip ${c.estado === "listo" ? "listo" : c.estado === "en_proceso" ? "activa" : "libre"}">${ESTADO_CAP[c.estado]}</span></div>
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
    main.innerHTML = `<div class="card"><h2>Mis tareas activas (${act.length})</h2>
      ${act.length ? `<div class="caps-grid">${act.map((t) => tarjetaTarea(t, "propia")).join("")}</div>`
        : '<p class="muted">No tienes tareas activas. Pasa por el mercado.</p>'}</div>
      <div class="card"><h2>Historial</h2>${tablaHistorial(otras)}</div>`;
    main.querySelectorAll("[data-entregar]").forEach((b) => (b.onclick = () => {
      if (confirm("¿Confirmas que entregaste esta tarea?")) accion(() => post(`tareas/${b.dataset.entregar}/entregar`), "¡Entregada! +puntos");
    }));
    main.querySelectorAll("[data-archivos]").forEach((b) => (b.onclick = () => dialogoArchivos(Number(b.dataset.archivos), b.dataset.titulo, b.dataset.rol)));
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
      ${filas.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.nombre)}</td>${r.oculto ? '<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>' : `<td><b>${r.puntos}</b></td><td>${r.entregas}</td><td>${r.vencidas}</td>`}</tr>`).join("")}
      </table></div>` : '<p class="muted">Aún no hay puntos este mes.</p>'}</div>`;
    $("#cambiarMes").onclick = () => { VISTAS.ranking.mes = mes === 0 ? -1 : 0; render(); };
  },

  async perfil(main) {
    const p = await api("perfil");
    main.innerHTML = fichaHTML(p, false) + `
      <div class="card"><h2>Cambiar contraseña</h2><form id="pw" class="fila">
      <input name="actual" type="password" placeholder="Contraseña actual" required>
      <input name="nueva" type="password" placeholder="Nueva (mín. 8)" minlength="8" required><button>Cambiar</button></form>
      <p class="muted">¿La olvidaste? Escribe <code>cd!acceso</code> en Discord y el bot te manda un enlace.</p></div>`;
    $("#pw").onsubmit = (e) => { e.preventDefault(); accion(() => post("yo/password", Object.fromEntries(new FormData(e.target))), "Contraseña cambiada"); };
  },

  async resumen(main) {
    const r = await api("admin/resumen");
    const stat = (n, txt, clase = "", ir = "") => `<div class="stat ${clase}" ${ir ? `data-ir="${ir}" style="cursor:pointer"` : ""}><span class="muted">${txt}</span><b>${n}</b></div>`;
    main.innerHTML = `<div class="card"><h2>Resumen</h2><div class="stats">
        ${stat(r.solicitudes, "Solicitudes por revisar", r.solicitudes ? "alerta" : "", "control")}
        ${stat(r.atrasadas, "Tareas atrasadas", r.atrasadas ? "mal" : "", "control")}
        ${stat(r.pronto, "Vencen en menos de 24 h", r.pronto ? "alerta" : "", "control")}
        ${stat(r.activas, "Tareas activas", "", "control")}
        ${stat(r.listos, "Capítulos listos para publicar", r.listos ? "bien" : "", "proyectos")}
        ${stat(r.sinEmpezar, "Capítulos sin empezar", "", "mercado")}
        ${stat(r.entregas7, "Entregas últimos 7 días")}
        ${stat(`${r.entregasMes} / ${r.vencidasMes}`, "Entregadas / vencidas este mes")}
      </div></div>
      <div class="dos-col">
        <div class="card"><h2>Disponibles sin tareas (${r.libres.length})</h2>
          ${r.libres.length ? `<div class="tabla"><table><tr><th>Nombre</th><th>Roles</th><th>Última entrega</th></tr>
          ${r.libres.map((s) => `<tr><td><a href="#" data-ficha="${s.id}">${esc(s.nombre)}</a></td><td>${chipsRoles(s.roles)}</td>
            <td class="muted">${s.ultima_entrega ? hace(s.ultima_entrega) : "Nunca"}</td></tr>`).join("")}</table></div>`
          : '<p class="muted">Todo el staff activo tiene trabajo.</p>'}</div>
        <div class="card"><h2>Listos para publicar (${r.listosLista.length})</h2>
          ${r.listosLista.length ? r.listosLista.map((c) => `<div class="rol-fila"><span>${esc(c.obra)} · cap. ${esc(c.numero)}</span>
            <button class="ok mini" data-publicar="${c.id}" data-perm="gestionar_proyectos">Marcar publicado</button></div>`).join("") : '<p class="muted">Nada pendiente de publicar.</p>'}
          ${r.hiatus.length ? `<h3>En hiatus</h3>${r.hiatus.map((s) => `<div class="rol-fila"><a href="#" data-ficha="${s.id}">${esc(s.nombre)}</a><span class="muted">hasta ${fecha(s.hiatus_hasta)}</span></div>`).join("")}` : ""}
        </div>
      </div>`;
    main.querySelectorAll("[data-ir]").forEach((d) => {
      if (!PESTANAS().some(([k]) => k === d.dataset.ir)) { d.removeAttribute("data-ir"); d.style.cursor = ""; return; }
      d.onclick = () => { VISTA = d.dataset.ir; render(); };
    });
    main.querySelectorAll("[data-ficha]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); abrirFicha(Number(a.dataset.ficha)); }));
    main.querySelectorAll("[data-publicar]").forEach((b) => (b.onclick = () =>
      accion(() => post(`admin/capitulos/${b.dataset.publicar}`, { estado: "publicado" }, "PATCH"), "¡Publicado! Se avisó en Discord")));
  },

  async ficha(main) {
    const id = VISTAS.ficha.id;
    if (!id) { VISTA = "staff"; return render(); }
    const p = await api(`admin/staff/${id}`);
    main.innerHTML = `<p><a href="#" id="volver">← Volver al staff</a></p>` + fichaHTML(p, true) +
      `<div class="card"><h2>Historial de tareas</h2>${tablaHistorial(p.historial.filter((t) => t.estado !== "activa"))}</div>`;
    $("#volver").onclick = (e) => { e.preventDefault(); VISTA = "staff"; render(); };
    if ($("#editar")) $("#editar").onclick = () => editarPersona(p);
    if ($("#puntos")) $("#puntos").onclick = () => dialogo(`Ajustar puntos de ${p.nombre}`, `
      <label>Puntos (positivo = bono, negativo = penalización) <input name="puntos" type="number" min="-50" max="50" required></label>
      <label>Motivo <input name="nota" maxlength="200" placeholder="Ej: ayudó con un cap urgente" required></label>`,
      (d) => post(`admin/staff/${p.id}/puntos`, { puntos: Number(d.puntos), nota: d.nota }), "Puntos ajustados");
    if ($("#hiatus")) $("#hiatus").onclick = () => dialogo(`Hiatus de ${p.nombre}`, `
      <label>Días de hiatus (0 = quitar) <input name="dias" type="number" min="0" max="365" value="${enHiatus(p) ? 0 : 7}" required></label>
      <p class="muted">En hiatus no puede tomar tareas nuevas. Sus tareas actuales siguen igual.</p>`,
      (d) => post(`admin/staff/${p.id}`, { hiatus_dias: Number(d.dias) }, "PATCH"), "Hiatus actualizado");
    main.querySelectorAll("[data-quitar]").forEach((b) => (b.onclick = () => {
      if (confirm("¿Quitar esta tarea? Vuelve al mercado sin restar puntos.")) accion(() => post(`admin/tareas/${b.dataset.quitar}/quitar`), "Tarea liberada");
    }));
  },

  async control(main) {
    const ts = await api("admin/tareas");
    const sol = ts.filter((t) => t.solicitud);
    main.innerHTML = `<div class="card"><h2>Solicitudes pendientes (${sol.length})</h2>${sol.length ? `<div class="tabla"><table>
      <tr><th>Quién</th><th>Tarea</th><th>Pide</th><th>Motivo</th><th></th></tr>
      ${sol.map((t) => `<tr><td>${esc(t.staff_nombre)}</td><td>${esc(t.obra)} ${esc(t.cap)} · ${t.rol_nombre}<br>${chipEstadoTarea(t)}</td>
        <td>${t.solicitud === "extension" ? `+${t.solicitud_dias} días` : "Cancelar"}</td><td>${esc(t.solicitud_motivo)}</td>
        <td class="fila"><button class="ok mini" data-res="${t.id}" data-ok="1" data-perm="revisar_solicitudes">Aprobar</button><button class="sec mini" data-res="${t.id}" data-ok="0" data-perm="revisar_solicitudes">Rechazar</button></td></tr>`).join("")}
      </table></div>` : '<p class="muted">No hay solicitudes.</p>'}</div>
      <div class="card"><h2>Todas las tareas activas (${ts.length})</h2>${ts.length ? `<div class="tabla"><table>
      <tr><th>Quién</th><th>Obra</th><th>Cap.</th><th>Rol</th><th>Vence</th><th>Tiempo</th><th></th></tr>
      ${ts.map((t) => `<tr><td>${esc(t.staff_nombre)}</td><td>${esc(t.obra)}</td><td>${esc(t.cap)}</td><td>${t.rol_nombre}</td><td>${fecha(t.limite)}</td>
        <td>${chipEstadoTarea(t)}</td><td><button class="sec mini" data-quitar="${t.id}" data-perm="asignar_tareas">Quitar</button></td></tr>`).join("")}</table></div>` : '<p class="muted">Nadie tiene tareas activas.</p>'}</div>`;
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
      <form id="np" class="fila" data-perm="gestionar_proyectos"><input name="nombre" placeholder="Nombre del nuevo proyecto" required><button>Crear proyecto</button></form>
      <div class="tabla" style="margin-top:12px"><table><tr><th>Proyecto</th><th>Estado</th><th>Caps.</th><th>Pend.</th><th>En proceso</th><th>Listos</th><th>Publicados</th><th></th></tr>
      ${ps.map((p) => `<tr><td><a href="#" data-sel="${p.id}">${esc(p.nombre)}</a></td>
        <td><select data-estado="${p.id}" data-perm="gestionar_proyectos">${["activo", "pausado", "terminado"].map((e) => `<option ${p.estado === e ? "selected" : ""}>${e}</option>`).join("")}</select></td>
        <td>${p.total}</td><td>${p.pendientes || 0}</td><td>${p.en_proceso || 0}</td><td>${p.listos || 0}</td><td>${p.publicados || 0}</td>
        <td><button class="sec mini" data-sel="${p.id}">Capítulos</button></td></tr>`).join("")}</table></div></div>
      <div id="caps"></div>`;
    if ($("#np")) $("#np").onsubmit = (e) => { e.preventDefault(); accion(() => post("admin/proyectos", Object.fromEntries(new FormData(e.target))), "Proyecto creado"); };
    main.querySelectorAll("[data-sel]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); VISTAS.proyectos.sel = Number(a.dataset.sel); render(); }));
    main.querySelectorAll("[data-estado]").forEach((s) => (s.onchange = () => accion(() => post(`admin/proyectos/${s.dataset.estado}`, { estado: s.value }, "PATCH"), "Estado cambiado")));
    if (sel) await capitulos($("#caps"), ps.find((p) => p.id === sel));
  },

  async staff(main) {
    const gente = await api("admin/staff");
    const filtro = VISTAS.staff.filtro || "activos";
    const busca = (VISTAS.staff.busca || "").toLowerCase();
    const estado = (g) => !g.activo ? "inactivo" : enHiatus(g) ? "hiatus" : "activo";
    const lista = gente.filter((g) => (filtro === "todos" || estado(g) === filtro.replace(/s$/, ""))
      && (!busca || `${g.nombre} ${g.usuario || ""} ${g.discord_id || ""}`.toLowerCase().includes(busca)));
    const cuenta = (f) => gente.filter((g) => f === "todos" || estado(g) === f.replace(/s$/, "")).length;
    main.innerHTML = `<div class="card"><div class="fila" style="justify-content:space-between"><h2>Staff</h2>
      <button id="nuevo" data-perm="editar_staff">Añadir miembro</button></div>
      <div class="fila" style="margin-bottom:10px"><input id="busca" placeholder="Buscar por nombre, usuario o ID de Discord" value="${esc(VISTAS.staff.busca || "")}"></div>
      <div class="filtros">${[["activos", "Activos"], ["hiatus", "En hiatus"], ["inactivos", "Inactivos"], ["todos", "Todos"]]
        .map(([k, n]) => `<button data-filtro="${k}" class="${filtro === k ? "on" : ""}">${n} (${cuenta(k)})</button>`).join("")}</div>
      <div class="caps-grid">${lista.map((g) => `<div class="cap-card persona ${estado(g)}" data-ficha="${g.id}">
        <div class="cap-head"><b>${esc(g.nombre)}</b><span class="chip">${NIVEL[g.nivel]}</span></div>
        <div class="muted">${g.usuario ? "@" + esc(g.usuario) : "Sin usuario del panel"}${g.discord_id ? " · Discord vinculado" : " · <span style='color:var(--warn)'>Sin Discord</span>"}</div>
        <div style="margin:8px 0">${chipsRoles(g.roles) || '<span class="muted">Sin roles</span>'}</div>
        <div class="rol-fila"><span>${g.activas} tarea(s) activa(s)</span><span class="muted">${estado(g) === "hiatus" ? `Hiatus hasta ${fecha(g.hiatus_hasta)}` : estado(g) === "inactivo" ? "Inactivo" : "Activo"}</span></div>
      </div>`).join("") || '<p class="muted">Nadie con ese filtro.</p>'}</div></div>`;
    $("#busca").oninput = (e) => {
      VISTAS.staff.busca = e.target.value;
      clearTimeout(VISTAS.staff.t);
      VISTAS.staff.t = setTimeout(async () => { await VISTAS.staff(main); const i = $("#busca"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250);
    };
    main.querySelectorAll("[data-filtro]").forEach((b) => (b.onclick = () => { VISTAS.staff.filtro = b.dataset.filtro; VISTAS.staff(main); }));
    main.querySelectorAll("[data-ficha]").forEach((c) => (c.onclick = () => abrirFicha(Number(c.dataset.ficha))));
    if ($("#nuevo")) $("#nuevo").onclick = () => dialogo("Añadir miembro", formPersona(), (d) => post("admin/staff", datosPersona(d)), "Miembro añadido");
  },

  async actividad(main) {
    const ev = await api("admin/eventos");
    main.innerHTML = `<div class="card"><h2>Actividad reciente</h2><div class="tabla"><table><tr><th>Fecha</th><th>Quién</th><th>Acción</th><th>Detalle</th></tr>
      ${ev.map((e) => `<tr><td class="muted">${fecha(e.fecha)}</td><td>${esc(e.nombre || "Sistema")}</td><td>${esc(e.accion.replace(/_/g, " "))}</td><td class="muted">${esc(e.detalle || "")}</td></tr>`).join("")}
      </table></div></div>`;
  },

  async permisos(main) {
    const { lista, valores } = await api("admin/permisos");
    const grupos = {};
    for (const [k, txt, g] of lista) (grupos[g] ??= []).push([k, txt]);
    main.innerHTML = `<div class="card"><h2>Qué puede ver y hacer cada nivel</h2>
      <p class="muted">Tú (admin) siempre lo ves todo. Cada persona siempre ve sus propias tareas y su perfil. Los cambios se aplican al momento, en la web y en el bot.</p>
      <form id="fp"><div class="tabla"><table class="permisos">
      <tr><th>Permiso</th><th class="centro">Líder</th><th class="centro">Staff</th></tr>
      ${Object.entries(grupos).map(([g, ps]) => `<tr><td colspan="3" class="grupo">${esc(g)}</td></tr>
        ${ps.map(([k, txt]) => `<tr><td>${esc(txt)}</td>
          ${["lider", "staff"].map((n) => `<td class="centro"><input type="checkbox" name="${n}.${k}" ${valores[n][k] ? "checked" : ""}></td>`).join("")}</tr>`).join("")}`).join("")}
      </table></div>
      <div class="fila" style="margin-top:12px"><button>Guardar permisos</button><button type="button" class="sec" id="defecto">Volver a los valores por defecto</button></div></form></div>`;
    const leer = () => {
      const v = { lider: {}, staff: {} };
      for (const [k] of lista) for (const n of ["lider", "staff"]) v[n][k] = $(`input[name="${n}.${k}"]`).checked;
      return v;
    };
    $("#fp").onsubmit = (e) => { e.preventDefault(); accion(() => post("admin/permisos", leer()), "Permisos guardados"); };
    $("#defecto").onclick = () => {
      if (!confirm("¿Volver a los permisos por defecto?")) return;
      for (const [k, , , l, st] of lista) { $(`input[name="lider.${k}"]`).checked = l; $(`input[name="staff.${k}"]`).checked = st; }
      toast("Valores por defecto puestos. Pulsa Guardar para aplicarlos.");
    };
  },

  async config(main) {
    const c = (await api("yo")).config;
    const campos = [["dias_limite", "Días para entregar una tarea"], ["max_tareas_activas", "Máximo de tareas activas por persona"],
      ["puntos_entrega", "Puntos por entrega"], ["puntos_vencida", "Puntos por tarea vencida (negativo)"], ["horas_gracia", "Horas de gracia antes de vencer"],
      ["cuota_mensual", "Cuota mensual de entregas"], ["hora_reporte", "Hora del reporte diario a líderes (0-23)"],
      ["exigir_archivos", "Para entregar hay que subir archivos (1 = sí, 0 = no)"]];
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
  const [caps, gente] = await Promise.all([api(`admin/proyectos/${p.id}/capitulos`), P("ver_staff|asignar_tareas") ? api("admin/staff") : []]);
  const activos = gente.filter((g) => g.activo);
  el.innerHTML = `<div class="card"><h2>${esc(p.nombre)}: capítulos</h2>
    <form id="nc" class="fila" data-perm="gestionar_proyectos"><input name="capitulos" placeholder="Ej: 1-20, 21.5, 25" required><button>Añadir capítulos</button></form>
    <div class="fila" style="margin-top:10px" data-perm="subir_raws"><button id="subirRaws">⏫ Subir RAWs de varios capítulos</button>
      <span class="muted">Elige una carpeta con una subcarpeta por capítulo, o varios .zip (Cap01.zip, Cap02.zip…).</span></div>
    <div class="tabla" style="margin-top:12px"><table><tr><th>Cap.</th><th>Estado</th><th>Archivos</th>${ROLES.map((r) => `<th>${ROL[r]}</th>`).join("")}<th></th></tr>
    ${caps.map((c) => `<tr><td><b>${esc(c.numero)}</b></td>
      <td><select data-cap="${c.id}" data-perm="gestionar_proyectos">${Object.entries(ESTADO_CAP).map(([k, n]) => `<option value="${k}" ${c.estado === k ? "selected" : ""}>${n}</option>`).join("")}</select></td>
      <td><button class="sec mini" data-verarch="${c.id}" data-num="${esc(c.numero)}">${c.archivos.raw ? `RAW ${c.archivos.raw}` : "Sin RAW"}${ROLES.filter((r) => c.archivos[r]).length ? ` · ${ROLES.filter((r) => c.archivos[r]).map((r) => r).join(", ")}` : ""}</button></td>
      ${ROLES.map((r) => { const x = c.roles[r]; return `<td>${x ? `<span class="chip ${x.estado}">${esc(x.nombre)}</span>` : `<button class="sec mini" data-perm="asignar_tareas" data-asig="${c.id}" data-rol="${r}">Asignar</button>`}</td>`; }).join("")}
      <td><button class="sec mini" data-borrar="${c.id}" data-perm="gestionar_proyectos">Borrar</button></td></tr>`).join("")}</table></div></div>`;
  if ($("#nc")) $("#nc").onsubmit = (e) => {
    e.preventDefault();
    accion(async () => { const r = await post(`admin/proyectos/${p.id}/capitulos`, Object.fromEntries(new FormData(e.target))); toast(`Creados ${r.creados}${r.repetidos ? `, ${r.repetidos} ya existían` : ""}`, "bien"); });
  };
  el.querySelectorAll("[data-verarch]").forEach((b) => (b.onclick = () => dialogoArchivos(Number(b.dataset.verarch), `${p.nombre} · cap. ${b.dataset.num}`, P("subir_raws") ? "raw" : null)));
  if ($("#subirRaws")) $("#subirRaws").onclick = () => subirRawsVarios(p, caps);
  el.querySelectorAll("[data-cap]").forEach((s) => (s.onchange = () => accion(() => post(`admin/capitulos/${s.dataset.cap}`, { estado: s.value }, "PATCH"), "Estado cambiado")));
  el.querySelectorAll("[data-borrar]").forEach((b) => (b.onclick = () => { if (confirm("¿Borrar este capítulo?")) accion(() => api(`admin/capitulos/${b.dataset.borrar}`, { method: "DELETE" }), "Capítulo borrado"); }));
  el.querySelectorAll("[data-asig]").forEach((b) => (b.onclick = () => {
    const posibles = activos.filter((g) => g.nivel !== "staff" || g.roles.split(",").includes(b.dataset.rol));
    dialogo(`Asignar ${ROL[b.dataset.rol]}`, `<select name="staff_id" required>${posibles.map((g) => `<option value="${g.id}">${esc(g.nombre)} (${g.activas} activas)</option>`).join("")}</select>
      <label>Días para entregar <input name="dias" type="number" min="1" max="60" placeholder="${esc(YO.config.dias_limite)}"></label>`,
      (d) => post("admin/asignar", { capitulo_id: Number(b.dataset.asig), rol: b.dataset.rol, staff_id: Number(d.staff_id), dias: d.dias ? Number(d.dias) : undefined }), "Tarea asignada");
  }));
}

// ---------- Piezas compartidas: personas y tareas ----------
const enHiatus = (g) => g.hiatus_hasta && new Date(g.hiatus_hasta) > new Date();
const chipsRoles = (roles) => (roles || "").split(",").filter((r) => ROL[r]).map((r) => `<span class="chip">${ROL[r]}</span>`).join(" ");
const hace = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? "Hoy" : d === 1 ? "Ayer" : `Hace ${d} días`;
};
const MOTIVO = { entrega: "Entrega", vencida: "Tarea vencida", ajuste: "Ajuste", migrado: "Puntos del sistema viejo" };

function tarjetaTarea(t, modo) {
  const atrasada = t.restante?.startsWith("atrasada");
  return `<div class="cap-card ${atrasada ? "atrasada" : "en_proceso"}">
    <div class="cap-head"><b>${esc(t.obra)} · cap. ${esc(t.cap)}</b><span class="chip">${t.rol_nombre}</span></div>
    <div class="rol-fila"><span class="muted">Vence</span><span>${fecha(t.limite)}</span></div>
    <div class="rol-fila"><span class="muted">Tiempo</span>${chipEstadoTarea(t)}</div>
    ${t.solicitud ? `<div class="rol-fila"><span class="muted">Solicitud</span><span class="chip activa">${t.solicitud === "extension" ? `+${t.solicitud_dias} días` : "Cancelar"}: esperando a un líder</span></div>` : ""}
    <div class="fila" style="margin-top:10px">${modo === "propia" ? `<button class="mini sec" data-archivos="${t.capitulo_id}" data-rol="${t.rol}" data-titulo="${esc(t.obra)} · cap. ${esc(t.cap)}">Archivos</button><button class="ok mini" data-entregar="${t.id}">Entregar</button>` + (t.solicitud ? "" : `
      <button class="sec mini" data-ext="${t.id}">Pedir más tiempo</button>
      <button class="sec mini" data-cancel="${t.id}">Pedir cancelar</button>`) : modo === "lider" ? `<button class="sec mini" data-quitar="${t.id}" data-perm="asignar_tareas">Quitar tarea</button>` : ""}</div>
  </div>`;
}

function tablaHistorial(lista) {
  if (!lista.length) return '<p class="muted">Todavía nada.</p>';
  return `<div class="tabla"><table><tr><th>Obra</th><th>Cap.</th><th>Rol</th><th>Resultado</th><th>Cerrada</th></tr>
    ${lista.map((t) => `<tr><td>${esc(t.obra)}</td><td>${esc(t.cap)}</td><td>${t.rol_nombre}</td>
      <td>${t.estado === "entregada" ? `<span class="chip entregada">${t.cerrada <= t.limite ? "A tiempo" : "Con retraso"}</span>` : chipEstadoTarea(t)}</td>
      <td class="muted">${fecha(t.cerrada)}</td></tr>`).join("")}</table></div>`;
}

// Ficha de una persona: la usa "Mi perfil" y la vista de líderes
function fichaHTML(p, admin) {
  const estado = !p.activo ? "Inactivo" : enHiatus(p) ? `En hiatus hasta ${fecha(p.hiatus_hasta)}` : "Activo";
  return `<div class="card"><div class="fila" style="justify-content:space-between">
      <div><h2 style="margin-bottom:4px">${esc(p.nombre)}</h2>
      <div class="muted">${NIVEL[p.nivel]} · ${estado}${p.usuario ? ` · @${esc(p.usuario)}` : ""}${p.creado ? ` · En el equipo desde ${new Date(p.creado).toLocaleDateString("es-DO", { month: "long", year: "numeric" })}` : ""}</div>
      <div style="margin-top:6px">${chipsRoles(p.roles) || '<span class="muted">Sin roles asignados</span>'}</div></div>
      ${admin ? `<div class="fila"><button class="sec mini" id="editar" data-perm="editar_staff">Editar</button><button class="sec mini" id="hiatus" data-perm="editar_staff">Hiatus</button><button class="mini" id="puntos" data-perm="ajustar_puntos">Ajustar puntos</button></div>` : ""}
    </div>
    <div class="stats" style="margin-top:14px">
      <div class="stat"><span class="muted">Puntos del mes</span><b>${p.puntos_mes}</b></div>
      <div class="stat ${p.cumple_cuota ? "bien" : ""}"><span class="muted">Cuota del mes</span><b>${p.entregas_mes} / ${p.cuota}</b></div>
      <div class="stat"><span class="muted">Entregas totales</span><b>${p.entregas_total}</b></div>
      <div class="stat ${p.vencidas_total ? "mal" : ""}"><span class="muted">Vencidas</span><b>${p.vencidas_total}</b></div>
      <div class="stat"><span class="muted">Puntualidad</span><b>${p.puntualidad === null ? "—" : p.puntualidad + "%"}</b></div>
      <div class="stat"><span class="muted">Puntos totales</span><b>${p.puntos_total}</b></div>
    </div></div>
    <div class="card"><h2>${admin ? "Tareas activas" : "Lo que tienes ahora"} (${p.activas.length})</h2>
      ${p.activas.length ? `<div class="caps-grid">${p.activas.map((t) => tarjetaTarea(t, admin ? "lider" : "ver")).join("")}</div>` : '<p class="muted">Sin tareas activas.</p>'}</div>
    <div class="card"><h2>Movimientos de puntos</h2>
      ${p.movimientos.length ? `<div class="tabla"><table><tr><th>Fecha</th><th>Puntos</th><th>Motivo</th></tr>
      ${p.movimientos.map((m) => `<tr><td class="muted">${fecha(m.fecha)}</td>
        <td><b style="color:${m.puntos > 0 ? "var(--ok)" : "var(--bad)"}">${m.puntos > 0 ? "+" : ""}${m.puntos}</b></td>
        <td>${MOTIVO[m.motivo] || esc(m.motivo)}${m.obra ? `: ${esc(m.obra)} cap. ${esc(m.cap)} (${m.rol_nombre})` : ""}${m.nota ? `: ${esc(m.nota)}` : ""}${m.autor ? ` <span class="muted">· por ${esc(m.autor)}</span>` : ""}</td></tr>`).join("")}
      </table></div>` : '<p class="muted">Todavía no hay puntos.</p>'}</div>`;
}

function abrirFicha(id) { if (!P("ver_staff")) return; VISTAS.ficha.id = id; VISTA = "ficha"; render(); }

function formPersona(g = {}) {
  return `
    <input name="nombre" placeholder="Nombre" value="${esc(g.nombre)}" required>
    <input name="usuario" placeholder="Usuario del panel (opcional)" value="${esc(g.usuario)}">
    <input name="password" type="password" placeholder="${g.id ? "Nueva contraseña (dejar vacío para no cambiar)" : "Contraseña (o que use cd!acceso)"}" minlength="8">
    <input name="discord_id" placeholder="ID de Discord (clic derecho > Copiar ID)" value="${esc(g.discord_id)}">
    ${YO.nivel === "admin" ? `<select name="nivel">${Object.entries(NIVEL).map(([k, n]) => `<option value="${k}" ${(g.nivel || "staff") === k ? "selected" : ""}>${n}</option>`).join("")}</select>` : ""}
    <div class="roles-check">${ROLES.map((r) => `<label><input type="checkbox" name="rol_${r}" ${(g.roles || "").split(",").includes(r) ? "checked" : ""}> ${ROL[r]}</label>`).join("")}</div>
    ${g.id ? `<label><input type="checkbox" name="activo" ${g.activo ? "checked" : ""}> Activo (si lo desactivas, sus tareas vuelven al mercado)</label>` : ""}`;
}
function datosPersona(d, g) {
  const b = { nombre: d.nombre, usuario: d.usuario || null, discord_id: d.discord_id || null, roles: ROLES.filter((r) => d["rol_" + r]).join(",") };
  if (d.password) b.password = d.password;
  if (d.nivel && (!g || g.nivel !== d.nivel)) b.nivel = d.nivel;
  if (g) b.activo = !!d.activo;
  return b;
}
function editarPersona(p) {
  dialogo(`Editar a ${p.nombre}`, formPersona(p), (d) => post(`admin/staff/${p.id}`, datosPersona(d, p), "PATCH"), "Cambios guardados");
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

// ---------- Archivos (RAWs y entregas) ----------
const ETAPA = { raw: "RAW", trad: "Traducción", clean: "Limpieza", type: "Typeo" };
const FORMATOS = {
  raw: ["jpg", "jpeg", "png", "webp", "gif", "zip", "rar", "7z"],
  trad: ["docx", "doc", "odt", "txt", "pdf", "zip"],
  clean: ["jpg", "jpeg", "png", "webp", "gif", "zip", "rar", "7z", "psd"],
  type: ["jpg", "jpeg", "png", "webp", "gif", "zip", "rar", "7z", "psd"],
};
const ext = (n) => n.split(".").pop().toLowerCase();
const tam = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const natural = (a, b) => a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });

// Sube archivos de 4 en 4. alProgreso(hechos, total)
async function subirLote(trabajos, alProgreso) {
  let hechos = 0; const errores = [];
  const cola = [...trabajos];
  async function obrero() {
    while (cola.length) {
      const { capId, etapa, file, nombre } = cola.shift();
      try {
        const r = await fetch(`/api/capitulos/${capId}/archivos/${etapa}?nombre=${encodeURIComponent(nombre || file.name)}`,
          { method: "PUT", body: file, credentials: "same-origin", headers: { "content-type": file.type || "application/octet-stream" } });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
      } catch (e) { errores.push(`${nombre || file.name}: ${e.message}`); }
      alProgreso(++hechos, trabajos.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, trabajos.length) }, obrero));
  return errores;
}

function cargarJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => ok(window.JSZip); s.onerror = () => mal(new Error("No se pudo cargar el compresor"));
    document.head.append(s);
  });
}
async function descargarTodo(lista, nombreZip, btn) {
  if (lista.length === 1) { location.href = `/api/archivos/${lista[0].id}`; return; }
  const JSZip = await cargarJSZip(); const zip = new JSZip(); let n = 0;
  for (const a of lista) {
    btn.textContent = `Bajando ${++n}/${lista.length}…`;
    const r = await fetch(`/api/archivos/${a.id}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`No se pudo bajar ${a.nombre}`);
    zip.file(a.nombre, await r.blob());
  }
  btn.textContent = "Comprimiendo…";
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href: url, download: `${nombreZip}.zip` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Ventana con los archivos del capítulo. etapaSubir = la etapa que esta persona puede subir (o null)
async function dialogoArchivos(capId, titulo, etapaSubir) {
  const d = document.createElement("dialog");
  d.className = "grande";
  document.body.append(d);
  d.onclose = () => { d.remove(); render(); };
  async function pintar() {
    let arch;
    try { arch = await api(`capitulos/${capId}/archivos`); } catch (e) { toast(e.message, "error"); d.close(); return; }
    d.innerHTML = `<div class="fila" style="justify-content:space-between"><h2>${esc(titulo)}</h2><button class="sec mini" id="cerrar">Cerrar</button></div>
      ${etapaSubir ? `<div class="subida"><b>Subir ${ETAPA[etapaSubir]}</b>
        <p class="muted">Formatos: ${FORMATOS[etapaSubir].join(", ")}. Puedes elegir varios a la vez. Si subes uno con el mismo nombre, se reemplaza.</p>
        <label class="boton-archivo">⏫ Elegir archivos<input type="file" id="archivos" multiple hidden accept="${FORMATOS[etapaSubir].map((e) => "." + e).join(",")}"></label>
        <div id="progreso" class="muted"></div></div>` : ""}
      ${Object.entries(arch).map(([et, lista]) => `<h3>${ETAPA[et]} (${lista.length})${lista.length ? ` <button class="sec mini" data-todo="${et}">Descargar todo</button>` : ""}</h3>
        ${lista.length ? `<div class="lista-arch">${lista.map((a) => `<div class="arch"><a href="/api/archivos/${a.id}">${esc(a.nombre)}</a>
          <span class="muted">${tam(a.bytes)} · ${esc(a.subio || "")}</span>${et === etapaSubir ? `<button class="sec mini" data-borra="${a.id}">✕</button>` : ""}</div>`).join("")}</div>`
        : '<p class="muted">Nada todavía.</p>'}`).join("")}`;
    $("#cerrar", d).onclick = () => d.close();
    d.querySelectorAll("[data-todo]").forEach((b) => (b.onclick = () => descargarTodo(arch[b.dataset.todo], `${titulo} - ${ETAPA[b.dataset.todo]}`, b)
      .catch((e) => toast(e.message, "error")).finally(() => (b.textContent = "Descargar todo"))));
    d.querySelectorAll("[data-borra]").forEach((b) => (b.onclick = async () => {
      if (!confirm("¿Borrar este archivo?")) return;
      try { await api(`archivos/${b.dataset.borra}`, { method: "DELETE" }); pintar(); } catch (e) { toast(e.message, "error"); }
    }));
    const inp = $("#archivos", d);
    if (inp) inp.onchange = async () => {
      const files = [...inp.files];
      const malos = files.filter((f) => !FORMATOS[etapaSubir].includes(ext(f.name)));
      if (malos.length) return toast(`No se aceptan: ${malos.map((f) => f.name).join(", ")}`, "error");
      inp.disabled = true;
      const errores = await subirLote(files.map((file) => ({ capId, etapa: etapaSubir, file })),
        (h, t) => ($("#progreso", d).textContent = `Subiendo ${h} de ${t}…`));
      if (errores.length) toast(`${errores.length} con error: ${errores[0]}`, "error"); else toast(`${files.length} archivo(s) subido(s)`, "bien");
      pintar();
    };
  }
  d.showModal();
  d.innerHTML = '<p class="muted">Cargando…</p>';
  pintar();
}

// Saca el número de capítulo de un nombre: "Cap 12", "Capitulo_012", "Chapter 12.5", "012"
function numeroCapitulo(nombre, esArchivo) {
  const base = esArchivo ? nombre.replace(/\.[a-z0-9]{1,4}$/i, "") : nombre;
  const m = base.match(/(?:cap(?:[ií]tulo)?|ch(?:apter)?|ep(?:isodio)?)[\s._#-]*(\d{1,4}(?:[.,]\d{1,2})?)/i) || base.match(/(\d{1,4}(?:[.,]\d{1,2})?)(?!.*\d)/);
  return m ? String(Number(m[1].replace(",", "."))) : null;
}

// Subir RAWs de varios capítulos de una vez: una carpeta con subcarpetas por capítulo, o varios .zip
function subirRawsVarios(p, caps) {
  const d = document.createElement("dialog");
  d.className = "grande";
  d.innerHTML = `<h2>Subir RAWs: ${esc(p.nombre)}</h2>
    <p class="muted">Opción 1: una carpeta que tenga una subcarpeta por capítulo (por ejemplo <code>Cap 12</code>, <code>Cap 13</code>) con las imágenes dentro.<br>
    Opción 2: varios archivos .zip o .rar, uno por capítulo (por ejemplo <code>Cap12.zip</code>).<br>El número del capítulo se saca del nombre. Si el capítulo no existe, se crea.</p>
    <div class="fila"><label class="boton-archivo">📁 Elegir carpeta<input type="file" id="carpeta" webkitdirectory multiple hidden></label>
    <label class="boton-archivo">🗜️ Elegir .zip / .rar<input type="file" id="zips" multiple accept=".zip,.rar,.7z" hidden></label></div>
    <div id="vista"></div>
    <div class="fila" style="margin-top:12px"><button id="ir" disabled>Subir</button><button class="sec" id="cerrar">Cerrar</button></div>`;
  document.body.append(d);
  d.onclose = () => { d.remove(); render(); };
  $("#cerrar", d).onclick = () => d.close();
  const existentes = new Map(caps.map((c) => [c.numero, c]));
  let grupos = new Map();

  function preparar(files, desdeCarpeta) {
    grupos = new Map(); const ignorados = [];
    for (const f of files) {
      if (!FORMATOS.raw.includes(ext(f.name))) { if (!f.name.startsWith(".") && !/thumbs\.db$/i.test(f.name)) ignorados.push(f.name); continue; }
      const partes = (f.webkitRelativePath || f.name).split("/");
      // En carpeta: el número sale de la subcarpeta del capítulo; si no hay subcarpeta, del nombre del archivo
      const fuente = desdeCarpeta && partes.length >= 3 ? partes[partes.length - 2] : f.name;
      const num = numeroCapitulo(fuente, fuente === f.name);
      if (!num) { ignorados.push(f.name); continue; }
      if (!grupos.has(num)) grupos.set(num, []);
      grupos.get(num).push(f);
    }
    const orden = [...grupos.keys()].sort((a, b) => Number(a) - Number(b));
    const total = [...grupos.values()].reduce((s, l) => s + l.length, 0);
    $("#vista", d).innerHTML = orden.length ? `<p><b>${orden.length} capítulos</b>, ${total} archivos.${ignorados.length ? ` Se ignoran ${ignorados.length} (no son imágenes/zip o sin número).` : ""}</p>
      <div class="tabla" style="max-height:40vh;overflow:auto"><table><tr><th>Cap.</th><th>Archivos</th><th>Tamaño</th><th></th></tr>
      ${orden.map((n) => { const l = grupos.get(n), c = existentes.get(n);
        return `<tr><td><b>${esc(n)}</b></td><td>${l.length}</td><td>${tam(l.reduce((s, f) => s + f.size, 0))}</td>
        <td>${c ? (c.archivos.raw ? `<span class="chip activa">Ya tiene ${c.archivos.raw} RAW: se añaden</span>` : '<span class="chip">Existe</span>') : '<span class="chip libre">Nuevo</span>'}</td></tr>`; }).join("")}</table></div>
      <div id="prog" class="muted" style="margin-top:8px"></div>`
      : `<p class="muted">No encontré capítulos. ${ignorados.length ? `Archivos ignorados: ${ignorados.slice(0, 5).map(esc).join(", ")}…` : ""}</p>`;
    $("#ir", d).disabled = !orden.length;
  }
  $("#carpeta", d).onchange = (e) => preparar([...e.target.files], true);
  $("#zips", d).onchange = (e) => preparar([...e.target.files], false);

  $("#ir", d).onclick = async () => {
    const boton = $("#ir", d); boton.disabled = true;
    try {
      const nuevos = [...grupos.keys()].filter((n) => !existentes.has(n));
      if (nuevos.length) await post(`admin/proyectos/${p.id}/capitulos`, { capitulos: nuevos.join(", ") });
      const ahora = await api(`admin/proyectos/${p.id}/capitulos`);
      const ids = new Map(ahora.map((c) => [c.numero, c.id]));
      const trabajos = [];
      for (const [n, files] of grupos) {
        const capId = ids.get(n);
        if (!capId) continue;
        for (const file of files.sort((a, b) => natural(a.name, b.name))) trabajos.push({ capId, etapa: "raw", file });
      }
      const errores = await subirLote(trabajos, (h, t) => ($("#prog", d).textContent = `Subiendo ${h} de ${t}…`));
      $("#prog", d).innerHTML = errores.length ? `<span style="color:var(--bad)">${errores.length} archivos con error:</span><br>${errores.slice(0, 10).map(esc).join("<br>")}`
        : `✅ Listo: ${trabajos.length} archivos en ${grupos.size} capítulos${nuevos.length ? ` (${nuevos.length} capítulos nuevos)` : ""}.`;
      toast(errores.length ? "Terminó con errores" : "RAWs subidas", errores.length ? "error" : "bien");
    } catch (e) { toast(e.message, "error"); boton.disabled = false; }
  };
  d.showModal();
}
