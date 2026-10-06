# Frontend: bandeja del coordinador y simulador

React 19 + Vite + TypeScript. Consume la API del backend.

## Correr

Con Docker, desde la raíz del proyecto: `docker compose up --build` y abrir http://localhost:5173.

En local, con hot reload (requiere la API en `http://localhost:3000`):

```bash
cd frontend
cp .env.example .env
npm install
npm run dev        # http://localhost:5173
npm test
```

| Variable | Por defecto | Qué es |
|---|---|---|
| `VITE_API_URL` | `/api` | URL de la API. Por defecto el mismo origen: nginx (Docker) o Vite (desarrollo) reenvían `/api` a la API |
| `VITE_CLINIC_ID` | `clinica-vida-sana` | Clínica del coordinador (se envía en `X-Clinic-Id`) |

## Vistas

| Ruta | Qué muestra |
|---|---|
| `/conversaciones?estado=…` | Bandeja con filtro por estado y contadores, ordenada por actividad, con costo por conversación y "Cargar más" (paginación por cursor). El filtro vive en la URL. |
| `/conversaciones/:id` | Detalle a la derecha de la bandeja: transcripción con métricas bajo cada respuesta (LLM, RAG, agenda, tokens, costo) y panel con pestañas **Resumen** (resumen sin LLM y metadatos), **Paciente** (datos entregados y cita agendada) y **Técnico** (consumo, herramientas, eventos y turnos con argumentos y resultados). Flechas ↑↓ o teclas J/K para pasar a la conversación siguiente o anterior; Esc cierra. Botón "Devolver a la IA" si está escalada. |
| `/configuracion` | **Modelo de IA:** estado de la API key, que se configura o reemplaza en una ventana modal, y editor del prompt del asistente (variables obligatorias marcadas, guardar, descartar y restaurar el original). **Base de conocimiento** (abajo). **Agenda:** lo generado desde los documentos y un calendario mensual con citas y horas libres por día; al hacer clic en un día se abre a la derecha el detalle por profesional (Esc o la ✕ lo cierran), con filtro por profesional. |
| `/conocimiento` | Base de conocimiento: subir Word, PDF, Markdown o texto (se extrae el texto y se indexa en el momento), ver estado y fragmentos, borrar, reindexar y probar búsquedas. |
| `/simulador` | Chat de paciente: cada mensaje se envía a `POST /webhooks/messages` con la hora del sistema. La caja de texto crece hasta 4 líneas y luego hace scroll; Enter envía y Shift+Enter agrega un salto de línea. Permite reenviar el mismo `message_id` para ver la idempotencia y abrir la conversación en la bandeja. |

## Decisiones

- **TanStack Query** para todo lo que viene de la API: caché, estados de carga y error, y reintentos solo para errores reintentables (red o 5xx, no un 400 o un 404).
- **Polling adaptativo** en lugar de WebSocket: el detalle se consulta cada 1,5 s mientras `assistant_pending` es `true` y cada 5 s el resto del tiempo; la bandeja, cada 5 s. Para un coordinador es suficiente y no requiere infraestructura extra (ver `DECISIONS.md`).
- **Estados explícitos:** cargando, error con "Reintentar", vacío, "el asistente está respondiendo" y aviso cuando un refresco en segundo plano falla (se sigue mostrando la última versión).
- **Simulador optimista:** el mensaje del paciente aparece al enviarlo, con estado "enviando". Si el webhook falla, el texto vuelve a la caja para reintentar.
- **Fechas en hora de la clínica** (`America/Bogota`), no en la del navegador. El calendario trabaja con fechas `YYYY-MM-DD` y aritmética en UTC para que la zona del navegador no corra los días.
- **Colores del sistema:** la transcripción de la bandeja usa la paleta del panel (variables CSS en `styles.css`); el teléfono del simulador conserva el estilo WhatsApp.
- **Frontend y API en el mismo origen** (`/api` reenviado por nginx o Vite): funciona entrando por `localhost`, `127.0.0.1` o la IP de la máquina, sin depender de CORS. En AWS sería CloudFront delante del sitio estático y de API Gateway.
- Sin librería de componentes: el PDF no evalúa el diseño.
