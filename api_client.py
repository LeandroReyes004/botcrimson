"""
api_client.py — Cliente HTTP para comunicarse con el panel web
Reemplaza db_mysql.py para evitar conexión directa a MySQL
"""

import requests
import logging
from datetime import datetime

log = logging.getLogger(__name__)

API_URL = "https://scancrimson.com/api.php"
BOT_TOKEN = "crimson_bot_secret_2026"


def _api_call(action, method='GET', data=None):
    """Hace una llamada a la API del panel"""
    # Token por query en vez de header (evita WAF de Hostinger)
    params = {'bot_token': BOT_TOKEN}

    try:
        if method == 'POST':
            response = requests.post(f"{API_URL}?action={action}",
                                     json=data, params=params, timeout=10)
        else:
            if data:
                params.update(data)
            response = requests.get(f"{API_URL}?action={action}",
                                    params=params, timeout=10)

        response.raise_for_status()
        return response.json()
    except Exception as e:
        log.error(f"[API] Error en {action}: {e}")
        return {'exito': False, 'mensaje': str(e)}


# ══════════════════════════════════════════════════════════════
#  CONFIG
# ══════════════════════════════════════════════════════════════

def config_get(clave, default=''):
    result = _api_call('botConfigGet', 'GET', {'clave': clave})
    valor = result.get('valor')
    return valor if valor is not None else default

def config_set(clave, valor):
    _api_call('botConfigSet', 'POST', {'clave': clave, 'valor': str(valor)})


# ══════════════════════════════════════════════════════════════
#  STAFF
# ══════════════════════════════════════════════════════════════

def staff_registrar(discord_id: int, usuario_form, nombre_display: str):
    """Vincula o actualiza un miembro de Discord."""
    _api_call('botStaffRegistrar', 'POST', {
        'discord_id': discord_id,
        'usuario_form': usuario_form,
        'nombre_display': nombre_display,
    })

def staff_get_by_form(usuario_form: str):
    result = _api_call('botStaffGetByForm', 'GET', {'usuario_form': usuario_form})
    return result.get('staff') if result.get('exito') else None

def staff_get_by_id(discord_id: int):
    result = _api_call('botStaffGetById', 'GET', {'discord_id': discord_id})
    return result.get('staff') if result.get('exito') else None

def staff_listar():
    result = _api_call('botStaffListar', 'GET')
    return result.get('lista', []) if result.get('exito') else []

def staff_toggle(discord_id: int, activo: int):
    _api_call('botStaffToggle', 'POST', {'discord_id': discord_id, 'activo': activo})


# ══════════════════════════════════════════════════════════════
#  PROYECTOS
# ══════════════════════════════════════════════════════════════

def proyecto_crear(nombre: str, carpeta_drive_id: str = None):
    _api_call('botProyectoCrear', 'POST', {
        'nombre': nombre,
        'carpeta_drive_id': carpeta_drive_id,
    })

def proyecto_get(nombre: str):
    result = _api_call('botProyectoGet', 'GET', {'nombre': nombre})
    return result.get('proyecto') if result.get('exito') else None

def proyecto_listar(solo_activos=True):
    result = _api_call('botProyectoListar', 'GET', {'solo_activos': int(solo_activos)})
    return result.get('lista', []) if result.get('exito') else []

def proyecto_cambiar_estado(nombre: str, estado: str):
    _api_call('botProyectoCambiarEstado', 'POST', {'nombre': nombre, 'estado': estado})


# ══════════════════════════════════════════════════════════════
#  CAPÍTULOS
# ══════════════════════════════════════════════════════════════

def cap_importar(nombre_proyecto: str, numeros: list):
    result = _api_call('botCapImportar', 'POST', {
        'nombre_proyecto': nombre_proyecto,
        'numeros': numeros,
    })
    if result.get('exito'):
        return result.get('agregados', 0), None
    return 0, result.get('mensaje', 'Error desconocido')

def cap_get(nombre_proyecto: str, numero: str):
    result = _api_call('botCapGet', 'GET', {'nombre_proyecto': nombre_proyecto, 'numero': numero})
    return result.get('capitulo') if result.get('exito') else None

def cap_listar_pendientes(nombre_proyecto: str):
    result = _api_call('botCapListarPendientes', 'GET', {'nombre_proyecto': nombre_proyecto})
    return result.get('lista', []) if result.get('exito') else []


# ══════════════════════════════════════════════════════════════
#  TAREAS
# ══════════════════════════════════════════════════════════════

def tarea_crear(tarea_id: str = None, discord_id: int = None, obra: str = None,
                cap: str = None, rol: str = None, limite: datetime = None,
                canal_id: int = None):
    """Crea una tarea vía API. tarea_id y canal_id son ignorados (los gestiona el servidor)."""
    limite_str = limite.strftime("%Y-%m-%d %H:%M:%S") if limite else None
    result = _api_call('botTareaCrear', 'POST', {
        'discord_id': discord_id,
        'obra': obra,
        'cap': cap,
        'rol': rol,
        'limite': limite_str,
    })
    return result.get('tarea_id') if result.get('exito') else None

def tarea_completar(tarea_id: str):
    """Marca tarea como entregada; devuelve los puntos actuales del usuario."""
    result = _api_call('botTareaCompletar', 'POST', {'tarea_id': tarea_id})
    return result.get('puntos', 1) if result.get('exito') else None

def tarea_cancelar(tarea_id: str):
    _api_call('botTareaCancelar', 'POST', {'tarea_id': tarea_id})

def tarea_get(tarea_id: str):
    result = _api_call('botTareaGet', 'GET', {'tarea_id': tarea_id})
    return result.get('tarea') if result.get('exito') else None

def tarea_get_por_usuario(discord_id: int):
    result = _api_call('botTareaGetPorUsuario', 'GET', {'discord_id': discord_id})
    return result.get('lista', []) if result.get('exito') else []

def tarea_get_todas_activas():
    result = _api_call('botTareaGetTodasActivas', 'GET')
    return result.get('lista', []) if result.get('exito') else []

def tarea_extender(tarea_id: str, dias: int):
    _api_call('botTareaExtender', 'POST', {'tarea_id': tarea_id, 'dias': dias})

def tarea_get_por_usuario_y_obra(discord_id: int, obra: str, cap: str = None):
    result = _api_call('botTareaGetPorUsuarioYObra', 'GET', {
        'discord_id': discord_id, 'obra': obra, 'cap': cap,
    })
    return result.get('tarea') if result.get('exito') else None

def tarea_urgentes(horas=24):
    result = _api_call('botTareaUrgentes', 'GET', {'horas': horas})
    return result.get('lista', []) if result.get('exito') else []


# ══════════════════════════════════════════════════════════════
#  RANKING / EXPEDIENTES
# ══════════════════════════════════════════════════════════════

def ranking_mes(mes=None, anio=None):
    result = _api_call('botRankingMes', 'GET', {'mes': mes, 'anio': anio})
    return result.get('lista', []) if result.get('exito') else []

def ranking_resetear():
    _api_call('botRankingResetear', 'POST')

def puntos_get(discord_id: int):
    result = _api_call('botPuntosGet', 'GET', {'discord_id': discord_id})
    return result.get('puntos', 0) if result.get('exito') else 0


# ══════════════════════════════════════════════════════════════
#  ERRORES / EXPEDIENTE DISCIPLINARIO
# ══════════════════════════════════════════════════════════════

def error_registrar(discord_id: int, descripcion: str, reportado_por: int = None):
    _api_call('botErrorRegistrar', 'POST', {
        'discord_id': discord_id,
        'error': descripcion,
        'reportado_por': reportado_por,
    })

def errores_get(discord_id: int, limite=15):
    result = _api_call('botErroresGet', 'GET', {'discord_id': discord_id, 'limite': limite})
    return result.get('lista', []) if result.get('exito') else []


# ══════════════════════════════════════════════════════════════
#  FORMULARIOS PROCESADOS
# ══════════════════════════════════════════════════════════════

def formulario_ya_procesado(timestamp_str: str) -> bool:
    result = _api_call('botFormularioYaProcesado', 'GET', {'timestamp': timestamp_str})
    return result.get('procesado', False)

def formulario_marcar(timestamp_str: str):
    _api_call('botFormularioMarcar', 'POST', {'timestamp': timestamp_str})

def formularios_marcar_todos(lista: list):
    _api_call('botFormulariosMarcarTodos', 'POST', {'lista': lista})


# ══════════════════════════════════════════════════════════════
#  ESTADÍSTICAS
# ══════════════════════════════════════════════════════════════

def estadisticas_globales():
    result = _api_call('botEstadisticasGlobales', 'GET')
    if result.get('exito'):
        return result.get('stats', {})
    return {
        'total_asig': 0, 'total_entre': 0, 'total_retra': 0,
        'total_pend': 0, 'tareas_activas': 0, 'urgentes_24h': 0,
    }
