# Cómo funciona el sistema

Este documento recorre un flujo completo con un ejemplo (un paciente pide una cita, confirma y queda agendada) e indica qué archivo se ejecuta en cada paso.

## Las piezas

El sistema corre en 6 contenedores, definidos en `docker-compose.yml`:

| Contenedor | Qué hace | Punto de entrada |
|---|---|---|
| `frontend` | Panel del coordinador y simulador de paciente (React servido por nginx en `:5173`). Reenvía `/api/*` a la API. | `frontend/src/main.tsx`, `frontend/nginx.conf` |
| `api` | Recibe el webhook de mensajes y atiende al panel. Responde rápido y **no** llama al LLM. | `backend/src/server.ts` |
| `worker` | Toma los mensajes de la cola, ejecuta el asistente (LLM y herramientas) y responde. | `backend/src/worker.ts` |
| `elasticmq` | Cola compatible con Amazon SQS (FIFO + DLQ). | `infra/elasticmq/elasticmq.conf` |
| `mongo` | Clínicas, profesionales y horarios, documentos de la base de conocimiento, conversaciones, mensajes y trazas. | `backend/src/db/collections.ts` |
| `postgres` | Citas (con la restricción contra duplicados), outbox y fragmentos con embeddings (pgvector). | `backend/src/db/migrations/*.sql` |

```
Paciente ──► frontend (simulador) ──► api ──► cola (elasticmq) ──► worker ──► OpenAI
                                       │                             │
                                       ▼                             ├──► Mongo (catálogo, conversaciones, trazas)
                                  Mongo (mensaje)                    └──► Postgres (agenda, citas, pgvector)
```

---

## Flujo de ejemplo

### Paso 0. Antes: el coordinador configura la API key y carga la base de conocimiento

**API key:** en **Configuración → Modelo de IA** (`frontend/src/components/Settings.tsx`) → `PUT /api/settings/ai` → `backend/src/http/routes/settings.ts` → `backend/src/settings/aiCredentials.ts`, que la valida contra OpenAI y la guarda cifrada (`settings/crypto.ts`). Si no hay key en el panel se usa la del `.env`.

**Base de conocimiento:**

La base de conocimiento es la **única fuente de información** del asistente. Sin documentos, el asistente no usa el LLM (ver paso 4).

1. El coordinador sube un Word, PDF, Markdown o texto en **Configuración → Base de conocimiento**:
   `frontend/src/components/Knowledge.tsx` → `frontend/src/api/client.ts` (`uploadFile`, multipart) → `POST /api/knowledge/documents`.
2. La API lo recibe en `backend/src/http/routes/knowledge.ts`, y `backend/src/knowledge/extract.ts` extrae el texto:
   - Word → Markdown, donde los títulos del documento pasan a ser secciones.
   - PDF → texto de todas las páginas.
3. `backend/src/knowledge/knowledgeService.ts` (`upload`) llama a `backend/src/knowledge/indexer.ts`, que:
   - parte el texto en fragmentos por sección con `chunker.ts`;
   - genera un embedding por fragmento con `embedder.ts` (OpenAI `text-embedding-3-small`);
   - guarda los fragmentos y sus embeddings en pgvector con `chunksRepository.ts`.

   El texto extraído queda en Mongo (`knowledge_documents`).
4. **La agenda se regenera desde los documentos** en segundo plano: `backend/src/agenda/agendaSync.ts` le pide al LLM que extraiga sedes, servicios y profesionales (`agenda/extraction/agendaExtractor.ts`), y `agenda/extraction/buildAgenda.ts` valida que cada nombre aparezca en el documento antes de reemplazar la agenda de la clínica en Mongo. Se ve en **Configuración → Agenda**.

### Paso 1. El paciente escribe

> "Hola, ¿tienen cita con dermatología mañana en la tarde?"

- `frontend/src/components/Simulator.tsx` arma el mensaje como lo haría WhatsApp: `message_id` único, teléfono y hora del sistema.
- `frontend/src/api/client.ts` (`sendWebhook`) lo envía a `POST /api/webhooks/messages`.
- nginx (`frontend/nginx.conf`) lo reenvía al contenedor `api`.

### Paso 2. La API recibe y encola (responde en milisegundos)

1. `backend/src/http/routes/webhooks.ts` valida el formato. Si no cumple, responde **400** con el detalle de cada campo.
2. `backend/src/messaging/ingestService.ts`:
   - Resuelve a qué clínica va el mensaje con `messaging/tenantResolver.ts` (por el WhatsApp Business Account ID, o la clínica por defecto en la prueba).
   - Guarda el mensaje en Mongo con `messaging/conversationsRepository.ts` (`insertInbound`). **El `message_id` es el `_id`**: si el mismo mensaje llega dos veces, el segundo choca y no se procesa otra vez (responde **200 `duplicate`**).
   - Crea o actualiza la conversación del teléfono (`touchConversation`).
   - Encola el mensaje en ElasticMQ con `messaging/queue/sqsQueue.ts`. Lo agrupa por conversación (los mensajes de un paciente se procesan en orden) y usa el `message_id` como clave de deduplicación.
3. Responde **202**. Hasta acá no se llamó al LLM.

### Paso 3. El worker toma el mensaje

- Al arrancar, `backend/src/worker.ts` arma el motor: `KnowledgeGateEngine` → `OpenAIEngine` → herramientas.
- `backend/src/worker/worker.ts` (`runOnce`) lee la cola. Procesa en paralelo las conversaciones distintas y de a uno los mensajes de un mismo paciente.
- `backend/src/worker/processor.ts` (`processIncoming`):
  1. Marca el mensaje como `procesando` (`claimInbound`). Si ya estaba respondido (una reentrega de la cola), no repite el turno.
  2. Si la conversación está `escalada`, no responde la IA: el mensaje queda `pendiente_humano`.
  3. Carga el historial (`recentMessages`) y llama al motor con un timeout (`ENGINE_TIMEOUT_MS`).

### Paso 4. ¿La clínica tiene API key y base de conocimiento?

`backend/src/assistant/knowledgeGate.ts` comprueba primero que la clínica tenga API key (`settings/aiCredentials.ts`, panel o `.env`) y después cuenta sus fragmentos indexados (`chunksRepository.countForClinic`).

- **Si no hay key o hay 0 fragmentos:**
  - Responde un mensaje fijo **sin llamar al LLM** (0 tokens, unos milisegundos): *"Lo siento, en este momento no tengo información para responder tu consulta. Ya la pasé a un asesor de la clínica, que te ayudará por este medio."*
  - La conversación queda **`escalada`** con el motivo `sin_base_de_conocimiento`, y aparece en ese filtro de la bandeja.
  - Los mensajes siguientes de ese paciente quedan pendientes de un asesor hasta que el coordinador use **"Devolver a la IA"**.
  - La traza del turno queda como `engine: sin_llm`.
- **Si hay documentos:** sigue al paso 5.

### Paso 5. El LLM decide qué herramienta usar

`backend/src/assistant/openaiEngine.ts`:

1. Arma las instrucciones con `assistant/prompt.ts`: alcance (solo la clínica), reglas, fuente única de información y la fecha y hora actual en Cali. **No incluye datos de la clínica**: todo lo informativo sale de la base de conocimiento.
2. Arma las herramientas para esta clínica con `assistant/tools/index.ts`, cada una con su JSON Schema en modo estricto:
   - `buscar_conocimiento`
   - `consultar_disponibilidad`
   - `agendar_cita`
   - `escalar_a_humano`
3. Llama a la Responses API de OpenAI (`gpt-6-luna`). El modelo responde con una llamada a herramienta:

   ```
   consultar_disponibilidad({ especialidad: "dermatologia", fecha: "manana", franja: "tarde", sede: null })
   ```

### Paso 6. El código valida y ejecuta la herramienta

El modelo propone; el código valida y ejecuta.

1. `assistant/tools/registry.ts` recibe la llamada y la pasa a `assistant/tools/consultarDisponibilidad.ts`.
2. `assistant/tools/resolve.ts` comprueba que la especialidad exista. Si no, devuelve un error con las opciones válidas para que el modelo corrija.
3. `agenda/dates.ts`:
   - `resolveDate` **convierte `"manana"` en una fecha en hora de Colombia**. Un mensaje a las 10:40 p. m. del día 5 da el 6, no el 7.
   - `checkBookableDate` rechaza fechas pasadas, festivos o fechas más allá del horizonte de agendamiento.
4. `agenda/localAgendaProvider.ts` (`findAvailability`):
   - lee los profesionales y sus horarios semanales en Mongo con `catalog/catalogRepository.ts` (la agenda generada desde los documentos);
   - lee las citas ya tomadas en Postgres con `appointments/appointmentsRepository.ts`;
   - `agenda/availability.ts` (`computeSlots`) calcula los horarios libres.
5. El resultado (o el error) vuelve al modelo como `function_call_output`.

### Paso 7. El modelo responde y se revisa la respuesta

- El modelo escribe: *"Mañana martes 6 hay dermatología en la tarde con el Dr. Felipe Martínez: 2:00, 2:30, 3:00…"*.
- `assistant/guardrails.ts` revisa la salida antes de enviarla. Si trae código, la reemplaza por el mensaje de fuera de alcance.

### Paso 8. Se guarda, se envía y se registra

De vuelta en `worker/processor.ts`:

1. Guarda la respuesta **antes** de enviarla (`saveReply`). Si el envío falla, el reintento reenvía la misma respuesta sin volver a llamar al LLM.
2. La envía con `messaging/outbound/logChannel.ts`. En local solo la registra en el log; en producción sería la API de WhatsApp.
3. Actualiza el estado de la conversación (`updateConversationAfterTurn`).
4. Registra la traza del turno (`recordTurn` → `insertTurn`): modelo, tokens, latencia, herramientas con sus argumentos y resultados, y el **costo**, calculado con `assistant/pricing.ts`.
5. Borra el mensaje de la cola (`ack`).

### Paso 9. El paciente ve la respuesta

- `frontend/src/api/hooks.ts` (`useConversation`) consulta `GET /api/conversations/:id` cada 1,5 s mientras `assistant_pending` sea `true`. Eso muestra "La clínica está escribiendo…".
- La API arma la respuesta en `backend/src/http/routes/conversations.ts` (`toDetail`).
- `Simulator.tsx` muestra el mensaje en el chat.

### Pasos 10 y 11. Elegir el horario y confirmar

> "A las 3 con el Dr. Felipe. Soy Ana Pérez, cédula 1130…, sin EPS" → el asistente pide confirmar el resumen.
>
> "Sí, confirmo" → el modelo llama a `agendar_cita`.

1. `assistant/tools/agendarCita.ts` valida el profesional, la fecha, la hora y los datos obligatorios de la clínica (documento).
2. `agenda/localAgendaProvider.ts` (`book`) comprueba que la hora exista en la agenda del profesional: dentro de un bloque de atención, en esa sede y alineada a la duración del servicio.
3. `appointments/appointmentsRepository.ts` (`create`) inserta la cita y un evento de outbox **en la misma transacción**.
4. **La restricción `EXCLUDE` de Postgres** (`db/migrations/002_appointments_outbox.sql`) impide que dos citas del mismo profesional se crucen, aunque dos pacientes confirmen en el mismo instante. Si choca, la herramienta devuelve `horario_ocupado` con alternativas reales del mismo día.
5. La conversación queda **`cita_agendada`**.

### Si el paciente hace una pregunta informativa

> "¿Hay que ir en ayunas para la glucosa?"

`assistant/tools/buscarConocimiento.ts` → `knowledge/retriever.ts`:

1. Genera el embedding de la pregunta con `embedder.ts`.
2. Busca los fragmentos más parecidos en pgvector, **solo de esa clínica** (`chunksRepository.search`).
3. Descarta los que no superan el umbral de similitud (`RAG_MIN_SIMILARITY`).

El modelo responde **solo** con esos fragmentos. Si no encuentra nada, lo dice y ofrece un asesor.

---

## Si algo falla

| Falla | Qué pasa | Dónde |
|---|---|---|
| OpenAI caído o lento | Se registra el error y se reintenta con espera exponencial (2 s, 4 s…). En el **tercer intento** se envía un mensaje de respaldo y la conversación queda `escalada`. | `worker/processor.ts`, `worker/worker.ts` |
| El worker se cae a mitad de un mensaje | Después de 4 entregas sin manejar, el mensaje pasa a la DLQ. | `infra/elasticmq/elasticmq.conf` |
| La cola no responde al recibir | La API responde 503. El mensaje ya quedó guardado, así que el reintento de WhatsApp lo encola. | `messaging/ingestService.ts` |
| Dos pacientes piden el mismo horario | Uno gana; el otro recibe `horario_ocupado` con alternativas. | `db/migrations/002_appointments_outbox.sql`, `assistant/tools/agendarCita.ts` |
| Llega dos veces el mismo mensaje | Se procesa una sola vez. | `messaging/conversationsRepository.ts` (`insertInbound`) |

---

## El panel del coordinador

| Vista | Frontend | API |
|---|---|---|
| Bandeja con filtro por estado | `frontend/src/components/Inbox.tsx` | `GET /conversations?status=` → `routes/conversations.ts` → `conversationsRepository.listConversations` (paginación por cursor) |
| Detalle de una conversación | `ConversationDetail.tsx` (transcripción con métricas y pestañas Resumen, Paciente y Técnico), `TurnDetails.tsx` | `GET /conversations/:id`: mensajes, trazas por respuesta y **resumen armado sin LLM** por `messaging/conversationSummary.ts` |
| Devolver una conversación escalada a la IA | Botón "Devolver a la IA" | `POST /conversations/:id/release` → `conversationsRepository.releaseConversation` |
| Base de conocimiento | `Knowledge.tsx` | `routes/knowledge.ts` → `knowledgeService.ts` (subir, listar, borrar, reindexar y probar búsquedas) |

---

## Dónde vive cada dato

| Base | Datos | Por qué ahí |
|---|---|---|
| **MongoDB** | Clínicas, profesionales y horarios (catálogo flexible por cliente), documentos de la base de conocimiento, conversaciones, mensajes y trazas por turno | Esquema que cambia por clínica y escritura de alto volumen |
| **PostgreSQL** | Citas, outbox y fragmentos con embeddings (pgvector) | Transacciones y la restricción que impide citas duplicadas; búsqueda vectorial filtrada por clínica |
