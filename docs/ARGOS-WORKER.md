# Argos en Ultimate Terminal

El registro DB-backed usa dos nombres estables:

- TUI: `agv2-steven-argos-tui`
- Shell: `agv2-steven-argos`

No se guardan llaves en Git. Crea ambos workers desde la cuenta administradora
de Ultimate Terminal e inyecta las llaves generadas desde el gestor de secretos
del runtime.

Para el worker TUI dentro del runtime de Argos:

```text
NEXUS_URL=<inyectado por el runtime>
API_KEY=<secret ref de agv2-steven-argos-tui>
WORKER_NAME=agv2-steven-argos-tui
WORKER_TUI_ALWAYS=true
WORKER_TUI_CMD=openclaw tui --session main --history-limit 80
```

Para el worker de shell usa una segunda llave y deja `WORKER_TUI_ALWAYS` y
`WORKER_TUI_CMD` sin definir:

```text
NEXUS_URL=<inyectado por el runtime>
API_KEY=<secret ref de agv2-steven-argos>
WORKER_NAME=agv2-steven-argos
```

Arrancar cada proceso con el mismo supervisor que mantiene el gateway de Argos.
La verificación de despliegue debe exigir que ambos nombres aparezcan `online`
antes de habilitar los botones TUI/Shell en la interfaz.
