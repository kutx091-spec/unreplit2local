---
name: Replit config fallbacks
description: Durable rules for converting nonstandard .replit startup and environment settings.
---

La configuración `.replit` puede definir el arranque en `[deployment].run` como string o array, usar `entrypoint` como último fallback y declarar el puerto local en `[[ports]]`. Las referencias a variables internas deben quedar sin valor fuera de Replit y `PATH` no pertenece al `.env.example`.

**Why:** Muchos proyectos reales no tienen `scripts.start`/`scripts.dev`, y copiar valores como `$REPL_HOME` o `PATH` puede producir arranques rotos o sobrescribir el entorno del sistema.

**How to apply:** Priorizar comandos explícitos y deployment sobre inferencias, convertir arrays argv a comandos ejecutables, usar `localPort` solo cuando no exista `PORT` explícito, y filtrar referencias `$VAR` sin resolver y variables de sistema al generar defaults.