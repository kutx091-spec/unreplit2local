---
name: ZIP ingestion security
description: Security invariants for archive validation before extraction.
---

La ingesta debe inspeccionar primero el directorio central del ZIP y rechazar antes de crear el directorio de proyecto cualquier entrada con tamaño total/individual excesivo, ratio de compresión sospechoso, ruta absoluta o traversal, o metadatos de symlink.

**Why:** La extracción streaming reduce memoria, pero no evita Zip Bomb ni Zip Slip si se empieza a escribir antes de validar todo el archivo.

**How to apply:** Mantener los límites configurables mediante variables de entorno, normalizar `/` y `\\`, comprobar `path.resolve` con `path.relative` y tratar los nombres de entrada como datos no confiables en mensajes y operaciones de escritura.