"""
api_client.py — Cliente del panel de Crimson Scan (Cloudflare Worker).
El bot ya no se conecta a la base de datos: todo pasa por la API del panel.
Usa aiohttp (incluido con discord.py) para no congelar el bot mientras espera respuesta.
"""
import os
import logging
import aiohttp

log = logging.getLogger(__name__)


class ApiError(Exception):
    """Error que el panel devolvió con un mensaje para mostrar al usuario."""


class PanelAPI:
    def __init__(self):
        self.base = os.getenv("PANEL_URL", "").rstrip("/")
        self.clave = os.getenv("BOT_API_KEY", "")
        self._sesion: aiohttp.ClientSession | None = None
        if not self.base or not self.clave:
            log.critical("Faltan PANEL_URL o BOT_API_KEY en el .env")

    async def _s(self):
        if self._sesion is None or self._sesion.closed:
            self._sesion = aiohttp.ClientSession(
                headers={"Authorization": f"Bearer {self.clave}"},
                timeout=aiohttp.ClientTimeout(total=15),
            )
        return self._sesion

    async def _llamar(self, metodo, ruta, params=None, datos=None):
        s = await self._s()
        try:
            async with s.request(metodo, f"{self.base}/api/bot/{ruta}", params=params, json=datos) as r:
                cuerpo = await r.json(content_type=None)
                if r.status >= 400:
                    raise ApiError((cuerpo or {}).get("error", f"Error {r.status}"))
                return cuerpo
        except ApiError:
            raise
        except Exception as e:
            log.error(f"[API] {metodo} {ruta}: {e}")
            raise ApiError("No pude conectar con el panel. Intenta en un momento.")

    # ---- Consultas ----
    async def perfil(self, discord_id):
        return await self._llamar("GET", "perfil", {"discord_id": str(discord_id)})

    async def tareas(self, discord_id, pide=None):
        """pide = quien escribe el comando (para revisar si puede ver tareas de otros)."""
        return await self._llamar("GET", "tareas", {"discord_id": str(discord_id), "pide": str(pide or discord_id)})

    async def ranking(self, pide, mes=0):
        return await self._llamar("GET", "ranking", {"mes": str(mes), "pide": str(pide)})

    async def mercado(self, discord_id=None):
        return await self._llamar("GET", "mercado", {"discord_id": str(discord_id)} if discord_id else None)

    # ---- Acciones ----
    async def tomar(self, discord_id, capitulo_id, rol):
        return await self._llamar("POST", "tomar", datos={"discord_id": str(discord_id), "capitulo_id": capitulo_id, "rol": rol})

    async def entregar(self, discord_id, tarea_id):
        return await self._llamar("POST", "entregar", datos={"discord_id": str(discord_id), "tarea_id": tarea_id})

    async def solicitar(self, discord_id, tarea_id, tipo, dias=None, motivo=None):
        return await self._llamar("POST", "solicitar", datos={
            "discord_id": str(discord_id), "tarea_id": tarea_id, "tipo": tipo, "dias": dias, "motivo": motivo})

    async def enlace_acceso(self, discord_id):
        return await self._llamar("POST", "enlace-acceso", datos={"discord_id": str(discord_id)})

    async def miembro_salio(self, discord_id):
        return await self._llamar("POST", "miembro-salio", datos={"discord_id": str(discord_id)})

    async def sincronizar(self, ids):
        return await self._llamar("POST", "sincronizar", datos={"discord_ids": [str(i) for i in ids]})

    async def cerrar(self):
        if self._sesion and not self._sesion.closed:
            await self._sesion.close()
