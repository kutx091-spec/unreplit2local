---
name: Windows delegated scripts
description: Cross-platform handling for pnpm workspace package scripts in generated startup files.
---

Los comandos `pnpm --filter <paquete> run <script>` no contienen necesariamente el comando ejecutable final: el script puede incluir sintaxis Unix como `export`, asignaciones POSIX o una cadena de build/start. La generación para Windows debe conservar el `packageDir` y el `rawScript` del paquete, convertir solo si hay sintaxis incompatible y ejecutar el resultado desde ese directorio.

**Why:** Delegar de nuevo el comando a pnpm en `run.bat` reintroduce el script Unix sin convertir y puede cerrar silenciosamente la ventana del servicio.

**How to apply:** Mantener la metadata indexada por el comando normalizado final (`pnpm --filter ... run ...`), usar `cd /d` al directorio relativo del paquete cuando la conversión cambie el script y dejar el comando pnpm original cuando no haya nada que convertir.