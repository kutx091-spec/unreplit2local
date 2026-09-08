# unreplit2local

**Convierte un proyecto exportado de Replit en algo que puedes ejecutar en tu propio ordenador, con un solo comando.**

Cuando exportas un proyecto de Replit como zip, ese zip depende de configuraciones internas de Replit (rutas, variables, comandos) que no existen fuera de su entorno. Si alguna vez has intentado sacar tu proyecto de Replit y ejecutarlo en local, sabes que casi nunca funciona a la primera.

Esta herramienta lo arregla: subes tu zip, y te devuelve un proyecto listo para correr en local, sin tener que configurar nada tú mismo.

---

## ¿Qué hace exactamente?

1. **Lee tu proyecto** — detecta el lenguaje (Node.js, Python, o ambos combinados), el gestor de paquetes (npm, pnpm, pip) y cómo arranca la app.
2. **Limpia archivos internos de Replit** que no sirven fuera de su entorno (estado del agente, copias duplicadas, etc.).
3. **Traduce la configuración** de Replit (`.replit`) a algo que Windows, Mac y Linux entienden.
4. **Genera scripts de arranque** (`run.sh` para Linux/Mac, `run.bat` para Windows) que instalan las dependencias y lanzan la app automáticamente.
5. **Te avisa de lo que no puede resolver solo** — si necesitas una base de datos, variables de entorno concretas, o algo ambiguo, te lo indica en vez de fallar en silencio.

También incluye protección contra archivos zip maliciosos (zip bombs y path traversal) en el proceso de conversión.

---

## Cómo usarlo

Este proyecto todavía no está desplegado como web pública — para usarlo, tienes que ejecutarlo tú mismo en local:

### Requisitos

- Node.js 18+
- pnpm
- PostgreSQL (local o un servicio gratuito como [Neon](https://neon.tech) o [Supabase](https://supabase.com))

### Pasos

```bash
git clone https://github.com/kutx091-spec/unreplit2local.git
cd unreplit2local
cp .env.example .env   # y añade tu DATABASE_URL
```

**Linux/macOS:**
```bash
chmod +x run.sh
./run.sh
```

**Windows:**
```
run.bat
```

Esto arranca el servidor y la interfaz web en local. Desde ahí puedes subir un zip exportado de Replit y descargar el resultado convertido.

---

## Stack técnico

- **Backend:** TypeScript / Node.js, arquitectura de pipeline (extracción → parseo → detección de stack → generación de salida)
- **Monorepo:** pnpm workspaces
- **Base de datos:** PostgreSQL

---

## Estado del proyecto

Proyecto personal, probado contra proyectos reales propios y ajenos (incluyendo stacks híbridos Node+Python). Sigue en desarrollo — si algo no funciona con tu proyecto, abre un issue.

---

*No afiliado ni respaldado por Replit, Inc. "Replit" es marca de Replit, Inc.*
