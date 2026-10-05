# Backend: asistente de agendamiento

Node 20 + TypeScript + Fastify. PostgreSQL (pgvector) y MongoDB corren en Docker.

## Levantar todo con Docker

Desde la raíz del proyecto (donde está `docker-compose.yml`):

```bash
docker compose up --build
curl http://localhost:3000/health
```

## Desarrollo local (API fuera de Docker, con hot reload)

```bash
docker compose up -d postgres mongo   # solo las bases
cd backend
cp .env.example .env
npm install
npm run dev
```

## Configurar el LLM (OpenAI)

La API key se configura en el panel (**Configuración → Modelo de IA**): se valida contra OpenAI, se guarda cifrada y aplica sin reiniciar. Para eso el servidor necesita una clave maestra de cifrado en `backend/.env`:

```bash
SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

También puedes poner una key por defecto en `backend/.env` (la del panel tiene prioridad):

```bash
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-6-luna            # opcional; por defecto gpt-6-luna
```

| Variable | Por defecto | Qué hace |
|---|---|---|
| `ASSISTANT_ENGINE` | `openai` | `stub` responde sin LLM (sirve para probar el flujo sin key) |
| `OPENAI_MODEL` | `gpt-6-luna` | Modelo de chat con tool calling |
| `OPENAI_REASONING_EFFORT` | `low` | Esfuerzo de razonamiento (`none` … `high`) |
| `ASSISTANT_MAX_TOOL_ITERATIONS` | `6` | Máximo de rondas de herramientas por turno |
| `ENGINE_TIMEOUT_MS` | `30000` | Timeout de un turno del asistente |

El worker de Docker lee estas variables de `backend/.env`.

### Conversar con el asistente desde la terminal

```bash
npm run chat                                   # interactivo
npm run chat -- --at 2026-10-06T03:40:00Z      # fija la hora (caso del enunciado)
npm run chat -- --cleanup                      # cancela al salir las citas creadas en la sesión
```

Muestra cada tool que llama el modelo, con sus argumentos y su resultado, el estado de la conversación y los tokens.

## Base de conocimiento (RAG)

**Es la única fuente de información del asistente.** Si la clínica no tiene documentos indexados, el asistente responde un mensaje por defecto sin llamar al LLM.

```bash
npm run index          # indexa los documentos de todas las clínicas (incremental)
```

El seed ya indexa si `OPENAI_API_KEY` está configurada. Se suben desde el panel (Word, PDF, Markdown o texto); los del seed están en `src/seed/docs/`. El texto extraído se guarda en MongoDB. Los fragmentos y sus embeddings se guardan en PostgreSQL (pgvector). Variables: `OPENAI_EMBEDDING_MODEL` (por defecto `text-embedding-3-small`), `RAG_TOP_K` (4) y `RAG_MIN_SIMILARITY` (0.3).

## Datos de prueba (seed)

```bash
npm run seed                                   # local
docker compose exec api npm run seed:prod      # dentro del contenedor
```

Crea la clínica ficticia **Clínica Vida Sana** (Cali, `America/Bogota`): 2 sedes, 3 servicios (medicina general 20 min, dermatología 30 min, pediatría 30 min), 6 profesionales con horarios semanales, 8 documentos y 4 citas ya tomadas en los próximos días. Es idempotente: se puede correr varias veces.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | API con recarga automática (lee `.env`) |
| `npm run migrate` | Aplica migraciones SQL pendientes (también corren al arrancar) |
| `npm run seed` | Carga la clínica de prueba e indexa sus documentos |
| `npm run index` | Reindexa la base de conocimiento (solo lo que cambió) |
| `npm run eval` | Evalúa al asistente con el modelo real: alcance, inyección, RAG, fechas, agenda y seguridad (`npm run eval -- rag` filtra por id) |
| `npm test` | Tests unitarios, sin bases reales ni LLM |
| `npm run test:integration` | Tests contra PostgreSQL y MongoDB reales (requiere `docker compose up -d postgres mongo`) |
| `npm run typecheck` | Verificación de tipos |
| `npm run build` / `npm start` | Compilar y correr la versión de producción |

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado de PostgreSQL y MongoDB. Responde 200 si ambas están arriba y 503 si alguna falla. |
| POST | `/webhooks/messages` | Recibe un mensaje (simula WhatsApp). **202** aceptado, **200** duplicado, **400** payload inválido, **404** clínica desconocida, **503** cola no disponible. |
| GET | `/conversations` | Bandeja: `?status=`, `?phone=`, `?limit=` (1–100, por defecto 20), `?cursor=` (de `next_cursor`). Más recientes primero. |
| GET | `/conversations/summary` | Cantidad de conversaciones por estado. |
| GET | `/conversations/:id` | Detalle: mensajes y, en cada respuesta del asistente, sus turnos (tools con argumentos y resultado, tokens, costo). `assistant_pending` indica si el asistente está respondiendo. El `id` va con URL encoding (`clinica-vida-sana%3A%2B573001112233`). |
| POST | `/conversations/:id/release` | Devuelve a la IA una conversación `escalada` (409 si no lo está). |

| GET | `/knowledge/documents` | Documentos de la base de conocimiento con fragmentos y estado del índice. |
| GET | `/knowledge/documents/:slug` | Contenido y fragmentos vectorizados de un documento. |
| POST | `/knowledge/documents` | Sube o reemplaza un documento y lo indexa con embeddings en el momento. Archivo por multipart (campo `file`: `.docx`, `.pdf`, `.md`, `.txt`, hasta 10 MB) o texto pegado en JSON `{ title, content }`. 201 nuevo, 200 reemplazado, 400 formato no soportado, 503 sin API key. |
| DELETE | `/knowledge/documents/:slug` | Borra el documento y sus fragmentos. |
| POST | `/knowledge/reindex` | Reindexa los documentos de la clínica (solo lo que cambió). |
| GET | `/knowledge/search?q=` | Búsqueda de prueba: fragmentos más cercanos, similitud y si el asistente los recibiría. |

| GET | `/settings/ai` | Estado de la API key del modelo: configurada, origen (panel o `.env`), key enmascarada y modelo. Nunca devuelve la key completa. |
| PUT | `/settings/ai` | `{ api_key }`: la valida contra OpenAI y, si sirve, la guarda cifrada (400 si OpenAI la rechaza; 503 sin `SETTINGS_ENCRYPTION_KEY`). |
| DELETE | `/settings/ai` | Borra la key del panel (vuelve a usarse la del `.env`, si existe). |
| POST | `/settings/ai/test` | Prueba la key en uso contra OpenAI. |

| GET | `/agenda` | Agenda generada desde la base de conocimiento: sedes, servicios, profesionales con horarios y el estado de la última generación (advertencias, descartes, ambigüedades). |
| POST | `/agenda/regenerate` | Regenera la agenda desde los documentos (en segundo plano, 202). |

Las rutas `/conversations*`, `/knowledge*`, `/settings*` y `/agenda*` son del coordinador y operan sobre una clínica. En local se toma del header `X-Clinic-Id` o de `DEFAULT_CLINIC_ID`; en producción saldría del token de Cognito.

## Probar el flujo de mensajes

Requiere la API y el worker corriendo (`docker compose up --build`, o `npm run dev` + `npm run worker` en local con `docker compose up -d postgres mongo elasticmq`).

```bash
# 1. Enviar el mensaje del enunciado
curl -s -X POST localhost:3000/webhooks/messages -H 'content-type: application/json' -d '{
  "message_id": "wamid.001", "from": "+573001112233",
  "text": "Hola, ¿tienen cita con dermatología mañana en la tarde?",
  "timestamp": "2026-10-06T03:40:00Z" }'

# 2. Enviarlo otra vez → 200 "duplicate", no se procesa de nuevo

# 3. Ver la conversación en la bandeja y su detalle
curl -s 'localhost:3000/conversations?phone=573001112233'
curl -s localhost:3000/conversations/clinica-vida-sana%3A%2B573001112233
```

Para provocar fallas a mano, corre el worker con `ASSISTANT_ENGINE=stub`:

| Texto que contiene | Qué pasa |
|---|---|
| `#falla` | El motor falla en cada intento: tras 3 intentos se envía el mensaje de respaldo y la conversación queda `escalada`. |
| `#lento` | El motor no responde: se corta por timeout (`ENGINE_TIMEOUT_MS`) y sigue el mismo camino de reintentos. |

Una conversación `escalada` ya no recibe respuestas de la IA (queda para un humano). Para seguir probando, usa otro número en `from`.
