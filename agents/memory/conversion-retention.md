---
name: Conversion and report retention
description: Operational retention rules for uploaded archives, generated zips, and issue reports.
---

Los uploads y zips generados son temporales: el upload se elimina al finalizar el pipeline, los archivos de un job exitoso se retienen 24 horas y los restos se limpian al arrancar un proceso nuevo. Los reportes no se escriben en una base de datos ni en un archivo propio; se emiten al logger y dependen de la retención de logs del despliegue.

**Why:** Los jobs viven en memoria y el producto no tiene todavía un sistema de tickets; retener archivos o reportes indefinidamente aumentaría el riesgo legal y operativo sin aportar una ruta de consulta estable.

**How to apply:** Mantener la limpieza de `/tmp` sincronizada con cualquier cambio del pipeline. Al documentar la disponibilidad de reportes, distinguir siempre entre retención de la aplicación (ninguna) y retención de logs de la plataforma (30 días para deployment logs según la documentación oficial consultada el 7 de septiembre de 2026).