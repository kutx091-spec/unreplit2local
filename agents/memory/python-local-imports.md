---
name: Python local imports
description: Durable rule for detecting active Python modules during project conversion.
---

Los archivos Python locales deben considerarse activos cuando otro módulo los referencia mediante imports resolubles (`import`, `from ... import ...`, imports relativos o paquetes con `__init__.py`).

**Why:** Comparar solo basenames como `helpers` no reconoce correctamente módulos como `utils.helpers` y genera falsos huérfanos.

**How to apply:** Construir un índice de módulos a partir de los archivos `.py` reales del proyecto y resolver imports absolutos, relativos y de hermanos según la ubicación del archivo importador; los imports externos no deben marcar archivos locales.