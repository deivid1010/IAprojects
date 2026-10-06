# DECISIONS.md

Este documento cuenta cómo diseñé y construí el asistente de agendamiento: qué decidí, qué descarté y por qué. Sigue el orden que pide el enunciado. Las instrucciones para levantarlo están en el [`README.md`](README.md), y el recorrido de un mensaje por el código, archivo por archivo, en [`flow.md`](flow.md).

## Contenido

1. [Mapa del enunciado](#mapa-del-enunciado)
2. [Arquitectura general](#arquitectura-general)
3. [Modelo de datos](#modelo-de-datos)
4. [Pipeline de IA](#pipeline-de-ia)
5. [Confiabilidad](#confiabilidad)
6. [API del coordinador](#api-del-coordinador)
7. [Frontend](#frontend)
8. [Nube (AWS)](#nube-aws)
9. [Costo](#costo)
10. [Trade-offs](#trade-offs)
11. [Ambigüedades del enunciado y cómo las resolví](#ambigüedades-del-enunciado-y-cómo-las-resolví)
12. [Uso de IA](#uso-de-ia)
13. [Qué haría distinto con más tiempo o en producción](#qué-haría-distinto-con-más-tiempo-o-en-producción)

---

## Mapa del enunciado

Dónde se cumple cada requisito del enunciado.

| Requisito | Dónde |
|---|---|
| Webhook `POST /webhooks/messages` que responde rápido; LLM fuera de la petición | `http/routes/webhooks.ts` → `messaging/ingestService.ts` → SQS FIFO (ElasticMQ) → `worker/`. Ver [Procesamiento asíncrono](#procesamiento-asíncrono-por-qué-elasticmq-en-local). |
| Mismo `message_id` procesado una sola vez | Tres barreras: `_id` en Mongo, deduplicación de SQS y estado del mensaje en el worker. Ver [Idempotencia](#idempotencia-un-mensaje-se-procesa-una-sola-vez). |
| Una conversación con historial por teléfono | Colección `conversations` con índice único `{clinic_id, phone}`; `messages` por `{conversation_id, created_at}`. |
| Tool calling con las 4 herramientas | `assistant/tools/` (function tools strict de la Responses API). Ver [Tools del LLM](#tools-del-llm-ejecutadas-y-validadas-por-el-código). |
| Validar argumentos y devolver el error al modelo | Cada tool valida con zod y contra el catálogo; los errores vuelven como datos con código y opciones. |
| Un horario no se agenda dos veces, aun en concurrencia | Restricción `EXCLUDE` en PostgreSQL. Probado con 10 inserciones simultáneas. |
| Si no está en los documentos, lo dice o escala | Prompt de fuente única, `sin_informacion` en el RAG, sin LLM cuando no hay base de conocimiento y set de evaluación. Ver [Confiabilidad](#confiabilidad). |
| "Mañana" en hora de Colombia (03:40Z del 6 → el 6) | `agenda/dates.ts`, con tests. Ver [Fechas y zona horaria](#fechas-y-zona-horaria). |
| Falla o lentitud del LLM | Timeout, reintentos con backoff, mensaje de respaldo y conversación `escalada`. Ver [Cuando el LLM falla](#cuando-el-llm-falla). |
| Trazabilidad por turno (modelo, tokens, latencia, tools, estado) | Colección `turns` + costo en USD. Visible en la pestaña **Técnico** del panel. |
| Bandeja con filtro por estado, detalle con tools, simulador | `frontend/`: Bandeja, detalle con pestañas Resumen / Paciente / Técnico y Simulador de paciente. |
| Estados de carga, error y "el asistente está respondiendo" | TanStack Query + `assistant_pending` del detalle. Ver [Frontend](#frontend). |
| PostgreSQL + MongoDB con criterio, índices y consistencia | Ver [Modelo de datos](#modelo-de-datos). |
| Base vectorial | pgvector en el mismo PostgreSQL. |
| Arquitectura en AWS para 50 clínicas y 20.000 mensajes/día | Ver [Nube (AWS)](#nube-aws). Diagrama: `docs/images/arquitectura-AWS-pruebaWekall.png`. |
| Seed: 6–10 documentos y agenda con 2 sedes, ≥3 especialidades y 2 semanas | `backend/src/seed/`: 9 documentos; agenda de 2 sedes, 3 especialidades (medicina general, dermatología, pediatría), 6 profesionales y horizonte de 14 días. |
| Tests sin el LLM real | 168 tests unitarios y 65 de integración con un cliente de OpenAI falso; 12 del frontend. El modelo real solo se usa en `npm run eval`, que es opcional. |
| Errores y entradas inválidas explícitos | Validación con zod en el borde (400 con detalle por campo), 404 sin filtrar existencia entre clínicas y 503 si la cola no responde. |
| La API key se configura con claridad y no se sube al repo | `backend/.env` (ignorado por git) o el panel, donde se guarda cifrada. Ver el README. |

---

## Arquitectura general

### Cómo está organizado

```
backend/src/
  http/          borde HTTP: rutas, validación del payload y contexto de clínica
  messaging/     ingesta, cola (SQS/ElasticMQ), conversaciones y resumen sin LLM
  worker/        procesamiento de cada mensaje: reintentos, respaldo y envío
  assistant/     motor del asistente: ciclo de tool calling, prompt, guardrails y tools
  agenda/        disponibilidad, fechas en hora local y agenda dinámica desde documentos
  appointments/  citas en PostgreSQL (transacción + EXCLUDE + outbox)
  catalog/       clínicas y recursos (esquemas zod y repositorio en Mongo)
  knowledge/     extracción de Word/PDF/MD, tablas, chunking, embeddings y búsqueda
  settings/      API key por clínica, cifrada
  db/            conexiones, migraciones SQL e índices de Mongo
  seed/          clínica de prueba y sus documentos
frontend/        panel del coordinador (React + Vite + TanStack Query)
```

Son **dos procesos** con la misma base de código: la **API** (`server.ts`), que recibe el webhook y atiende al panel, y el **worker** (`worker.ts`), que consume la cola y ejecuta el asistente. Así el webhook nunca espera al LLM, y cada proceso escala por separado. En AWS son dos Lambdas.

### Dónde vive cada cosa

- **La lógica de negocio vive en el código, no en el modelo:** `agenda/` (qué horarios existen, qué es una fecha válida, qué significa "mañana"), `appointments/` (que no haya cruces), `catalog/` (qué sedes, servicios y profesionales existen) y la validación dentro de cada tool. Nada de esto depende del LLM y todo tiene tests sin red.
- **La integración con el LLM está aislada en `assistant/`** y detrás de dos interfaces:
  - `AssistantEngine`: lo que el worker necesita ("dame la respuesta a este mensaje"). Hay tres implementaciones que se componen: `OpenAIEngine` (el ciclo real), `KnowledgeGateEngine` (no llama al modelo si no hay API key o base de conocimiento) y `StubEngine` (sin LLM, para desarrollo).
  - `ResponsesClient`: la única llamada al SDK de OpenAI. Los tests la reemplazan por un cliente con respuestas guionadas.
- **Las tools solo hablan con interfaces** (`AgendaProvider`, el retriever del RAG), no con las bases. Hoy la agenda es local (Mongo + Postgres). En producción, con Messenger Hub, podría ser un adaptador hacia el sistema de cada clínica sin tocar el motor.
- **La cola y el canal de salida también son interfaces** (`MessageQueue`, `OutboundChannel`): en local son ElasticMQ y un canal que deja la respuesta en el log; en AWS serían SQS y la WhatsApp Cloud API. Los tests usan una cola en memoria con la misma semántica.

### Cómo lo construí

Por fases, levantando y probando cada una antes de seguir: infraestructura (Docker Compose con PostgreSQL, MongoDB y ElasticMQ), modelo de datos y seed, ingesta e idempotencia, motor del asistente con tools, worker y fallas, API del coordinador y, al final, el frontend. Después vinieron los cambios que salieron de probarlo como lo usaría una clínica: base de conocimiento como única fuente, carga de documentos Word/PDF, agenda generada desde los documentos y configuración de la API key desde el panel.

---

## Modelo de datos

### Qué va en cada base

**Criterio:** en PostgreSQL va lo que necesita una garantía dura (transacciones y restricciones); en MongoDB va lo que cambia de forma entre clientes o crece rápido. Es un sistema multi-tenant: no todas las clínicas tienen varias sedes ni varias especialidades, y cada una pide datos distintos al agendar.

| Base | Datos | Por qué |
|---|---|---|
| **PostgreSQL** | `appointments` (citas), `outbox` y `document_chunks` (embeddings con pgvector) | Las citas son lo único que no puede fallar: un profesional no puede tener dos citas que se crucen. Eso lo garantiza una restricción `EXCLUDE` del esquema, no el código. Los embeddings viven aquí porque pgvector evita otra base. |
| **MongoDB (DocumentDB en AWS)** | `clinics` (sedes, servicios, campos de agendamiento, reglas, festivos y la agenda generada), `resources` (profesionales con horarios semanales), `knowledge_documents`, `conversations`, `messages`, `turns` (trazas) `clinic_settings` (API key cifrada) y `clinic_prompts` (prompt editado por la clínica) | El catálogo cambia de forma por cliente: una clínica tiene 0, 1 o N sedes, sus propios campos (EPS, documento…) y sus reglas. Las conversaciones y trazas se escriben mucho, se agregan sin modificarse y su forma varía (cada turno trae distintas tools). |

### Entidades y relaciones

| Entidad | Base | Clave | Se relaciona con |
|---|---|---|---|
| Clínica | Mongo `clinics` | `_id` (slug) | Todo lo demás lleva `clinic_id`. Tiene `whatsapp_business_account_id` (único) para el multi-tenant. |
| Recurso (profesional) | Mongo `resources` | `_id` | Clínica; presta `service_ids` en `location_ids` según `schedules` semanales. |
| Documento | Mongo `knowledge_documents` | `{clinic_id, slug}` | Clínica; sus fragmentos están en `document_chunks` (Postgres). |
| Fragmento | Postgres `document_chunks` | `id` | Documento (`clinic_id`, `document_slug`), con hash del contenido y modelo de embeddings. |
| Conversación | Mongo `conversations` | `_id = clinic_id:teléfono` | Clínica y paciente; estado, totales de tokens y costo. |
| Mensaje | Mongo `messages` | `_id = message_id` de WhatsApp | Conversación; dirección (entrante/saliente) y estado de procesamiento. |
| Turno (traza) | Mongo `turns` | `_id` | Conversación y mensaje que lo originó; modelo, tokens, latencia, tools, costo y resultado. |
| Cita | Postgres `appointments` | `id` (uuid) | `clinic_id`, `resource_id`, `location_id`, `service_id` (validados contra Mongo) y `source_message_id` (el mensaje que la creó). |
| Evento | Postgres `outbox` | `id` | Cita creada o cancelada, escrito en la misma transacción. |

No hay claves foráneas entre las dos bases: el código valida contra el catálogo antes de insertar (ver los trade-offs más abajo).

### Índices pensados para las consultas reales

| Consulta | Índice |
|---|---|
| Bandeja por estado, más recientes primero (paginación por cursor) | Mongo `conversations {clinic_id, status, last_message_at: -1, _id: -1}` |
| Bandeja sin filtro | Mongo `conversations {clinic_id, last_message_at: -1, _id: -1}` |
| Conversación de un teléfono (una por paciente y clínica) | Mongo `conversations {clinic_id, phone}` **único** |
| Historial de una conversación en orden | Mongo `messages {conversation_id, created_at}` |
| Idempotencia del webhook | Mongo `messages._id = message_id` (único por definición) |
| Trazas de una conversación | Mongo `turns {conversation_id, created_at}` |
| Clínica de un mensaje entrante | Mongo `clinics {whatsapp_business_account_id}` **único** (parcial) |
| Profesionales que prestan un servicio | Mongo `resources {clinic_id, service_ids, active}` |
| Disponibilidad por profesional (y sede) y fecha | Postgres `appointments (clinic_id, resource_id, starts_at)` filtrado a citas confirmadas, más el índice GiST de la restricción `EXCLUDE` |
| Citas de un paciente | Postgres `appointments (clinic_id, patient_phone, starts_at DESC)` |
| Reintento de un turno que ya agendó | Postgres `appointments (source_message_id)` parcial |
| Búsqueda semántica | Postgres `document_chunks` HNSW (`vector_cosine_ops`) + `(clinic_id, document_slug)` |

La disponibilidad "por sede y fecha" del enunciado se resuelve así: el catálogo (Mongo) dice qué profesionales atienden ese servicio en esa sede ese día, y el índice de citas (Postgres) trae sus citas confirmadas de ese día. Las sedes no son una columna del índice porque la ocupación es del profesional: si atiende en dos sedes, no puede estar en ambas a la vez.

### Citas: restricción en el esquema

```sql
EXCLUDE USING gist (
  clinic_id WITH =, resource_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status = 'confirmada')
```

- Impide no solo la misma hora sino **cualquier cruce de horarios**, aunque cada servicio dure distinto (20 o 30 minutos).
- El rango es semiabierto, así que 10:00–10:30 y 10:30–11:00 no chocan.
- Una cita cancelada sale de la restricción y libera el horario.
- Probado con 10 inserciones simultáneas del mismo horario: exactamente 1 gana, 9 reciben `SlotTakenError` y no quedan eventos de outbox huérfanos.

**Disponibilidad:** se calcula en código. Los horarios posibles salen de los horarios semanales de cada profesional (Mongo), menos los festivos, la anticipación mínima y las citas confirmadas (Postgres).

### Multi-tenant: a qué clínica va cada mensaje

- **Producción:** por el **WhatsApp Business Account ID** (WABA) que trae el webhook de Meta (`entry[].id`). Cada clínica guarda su `whatsapp_business_account_id`, con índice único. Si un cliente necesitara varios números en el mismo WABA, se resolvería por `phone_number_id` (`metadata` del webhook) con el mismo mecanismo.
- **Prueba:** el payload del enunciado no trae ningún identificador de destino. El webhook acepta un `waba_id` opcional y, si no viene, usa la clínica por defecto (`DEFAULT_CLINIC_ID`).
- El tenant nunca se toma del texto del paciente ni de lo que diga el LLM.

### Procesamiento asíncrono: por qué ElasticMQ en local

El enunciado pide justificar el mecanismo. Elegí **ElasticMQ**, que es compatible con Amazon SQS: la API usa **el mismo SDK de AWS y el mismo código que en producción** (SQS FIFO), y solo cambia el endpoint. Da `MessageGroupId` (orden por conversación), `MessageDeduplicationId` y DLQ sin programarlos a mano.

Alternativas descartadas: una cola sobre Postgres (`SKIP LOCKED`), porque habría que programar el orden por grupo, los reintentos y la DLQ, y en AWS sería otro código. BullMQ + Redis, porque no tiene grupos FIFO en la versión gratuita. LocalStack, porque es más pesado de lo necesario para usar solo SQS.

**Flujo:** el webhook guarda, encola y responde **202** sin esperar al LLM. El **worker** consume la cola. Las conversaciones distintas se procesan en paralelo y los mensajes de una misma conversación, en orden y de a uno (`MessageGroupId = teléfono`). Si un mensaje se reintenta, los siguientes del mismo paciente esperan detrás de él.

**Orden del historial:** los mensajes se ordenan por la hora en que los recibió el servidor (`created_at`), no por la hora de WhatsApp (`timestamp`). Si el reloj del remitente no coincide con el del servidor, la respuesta podría quedar antes que la pregunta. Lo detectaron los tests. El `timestamp` de WhatsApp se usa para interpretar "mañana" en hora de Colombia.

### Idempotencia: un mensaje se procesa una sola vez

1. **Ingesta:** inserta el mensaje en MongoDB con `_id = message_id`. Si ya existe, responde **200 `duplicate`** y no encola.
2. **SQS FIFO:** `MessageDeduplicationId = message_id` es una segunda barrera, con ventana de 5 minutos.
3. **Worker:** antes de procesar cambia el estado del mensaje (`recibido` → `procesando` → `respondido`) con un update condicional. Si SQS reentrega el mensaje, el turno no se repite.
4. **Agendamiento:** si un turno se reintenta después de haber creado la cita (por ejemplo, el worker se cayó antes de guardar la traza), `agendar_cita` encuentra la cita por `source_message_id` y la devuelve en vez de crear otra o chocar consigo misma.

La ventana de deduplicación de SQS no basta sola: un reintento de Meta horas después pasaría. Por eso la garantía final es la clave única en la base.

### Citas sin duplicados

- **El código valida los argumentos** que propone el modelo antes de ejecutar `agendar_cita`: que la fecha no sea pasada ni festiva ni esté fuera del horizonte, que existan la sede, la especialidad y el profesional, y que la hora exista en su agenda. Si algo falla, el error vuelve al LLM para que corrija o pregunte.
- **La base es la última barrera:** la cita se inserta en una transacción protegida por la restricción `EXCLUDE`. Si dos pacientes piden el mismo horario a la vez, uno gana y el otro recibe `horario_ocupado` con alternativas reales del mismo día.

### Consistencia entre PostgreSQL y MongoDB

La única operación que toca las dos bases es agendar: la cita va a Postgres y el estado de la conversación y la traza van a Mongo.

- **Postgres es la fuente de verdad** de las citas y se escribe primero. La cita existe solo si la transacción hizo commit.
- **Mongo se actualiza después**, cuando el worker guarda la traza del turno y el estado `cita_agendada`. Si esa escritura falla, el turno falla y la cola lo reintenta. En el reintento, `agendar_cita` encuentra la cita por `source_message_id` y la reutiliza (ver idempotencia, paso 4): no se duplica ni se pierde.
- Por ese orden, puede pasar transitoriamente que exista la cita sin la traza (se completa en el reintento). **Lo que nunca puede pasar es que Mongo diga `cita_agendada` sin una cita en Postgres.**
- **Outbox:** en la misma transacción de la cita se escribe un evento en la tabla `outbox` (`appointment.created` / `appointment.cancelled`). **Hoy ningún proceso lo consume**: lo dejé preparado para producción, donde un publicador lo enviaría a EventBridge (notificar al coordinador, sincronizar con el sistema de la clínica) sin el riesgo de publicar un evento de una cita que no hizo commit. Lo aclaro porque una versión anterior de este documento lo describía como si ya existiera.

### Trade-offs de separar el catálogo de las citas

1. **No hay FK entre bases:** Postgres no sabe si `resource_id` existe. El código lo valida contra Mongo antes de insertar (`validateResourceAgainstClinic` y la validación de las tools).
2. **La disponibilidad no es una sola consulta:** requiere leer de las dos bases. A cambio, cada clínica define sus horarios a su manera.
3. **Borrar un recurso con citas futuras** se debe bloquear en el código.
4. **El catálogo se valida al leerlo** (con zod), porque Mongo no impone la forma de los documentos.

---

## Pipeline de IA

### Tools del LLM, ejecutadas y validadas por el código

Las herramientas se declaran al modelo como **function tools** de la Responses API de OpenAI, con JSON Schema en **modo `strict`**. **El modelo decide** cuándo llamar a cada una y con qué argumentos. **OpenAI no las ejecuta**: devuelve un `function_call` y nuestro código lo valida, lo ejecuta y le devuelve el resultado o el error (`function_call_output`).

| Tool | Qué hace | Qué valida el código |
|---|---|---|
| `buscar_conocimiento(pregunta)` | Búsqueda semántica (RAG) en los documentos de la clínica. | La clínica sale del contexto del mensaje, no de los argumentos: el modelo no puede consultar documentos de otra clínica. |
| `consultar_disponibilidad(especialidad, sede, fecha, franja)` | Horarios libres reales del día, con el primer y el último horario. Sin cupos, sugiere las próximas fechas con disponibilidad. | Que la especialidad y la sede existan (si no, devuelve las opciones), la fecha (pasada, festivo, fuera del horizonte de 14 días) y la franja. |
| `agendar_cita(especialidad, sede, profesional, fecha, hora, nombre_paciente, datos_adicionales)` | Crea la cita. | Lo anterior, más: que el profesional preste el servicio, que la hora exista en su agenda (bloque, sede, alineada a la duración, anticipación mínima) y los datos obligatorios de la clínica. La ocupación la decide el `EXCLUDE` de Postgres. |
| `escalar_a_humano(motivo)` | Marca la conversación `escalada`. | Que haya un motivo. |

- **Los errores son datos, no excepciones:** vuelven al modelo con un código (`horario_ocupado`, `especialidad_inexistente`, `fecha_pasada`, `datos_faltantes`…) y, cuando aplica, las opciones válidas, para que corrija o le pregunte al paciente. Las fallas de infraestructura (por ejemplo una base caída) sí se propagan: el turno falla y el worker lo reintenta.
- **Los esquemas se arman por clínica:** si una clínica no tiene sedes, el modelo no ve el parámetro `sede`. Los campos de `datos_adicionales` salen de `booking_fields` (en la clínica de prueba: documento obligatorio y EPS opcional). Si la clínica no tiene agenda, las tools de agendamiento no se cargan.
- **`especialidad` y `profesional` no usan `enum`.** Aceptan id o nombre ("Dermatología", "el Dr. Felipe") y el código los resuelve sin depender de mayúsculas ni tildes. Con `enum` el modelo no podría equivocarse, pero perderíamos la validación explícita que pide el enunciado y la posibilidad de devolverle opciones cuando el paciente pide algo que no existe.

### RAG: documentos, fragmentos, embeddings y base vectorial

- **Fuente de verdad:** los documentos viven en MongoDB (`knowledge_documents`). **El índice vectorial vive en PostgreSQL con pgvector** (`document_chunks`): es derivado y se reconstruye con `npm run index` o con "Reindexar todo" en el panel.
- **Por qué pgvector:** ya tenemos Postgres, el corpus es chico (decenas de fragmentos por clínica) y el filtro por `clinic_id` es una cláusula `WHERE`. Descarté Atlas Vector Search porque DocumentDB, nuestro Mongo en AWS, no lo tiene. Qdrant u OpenSearch serían otra pieza que operar, sin necesidad a este volumen.
- **Chunking por secciones, no por tamaño fijo.** Los documentos de una clínica son cortos y están organizados por tema; partir por tamaño cortaría listas y horarios a la mitad.
  - Los títulos de todos los niveles abren sección, y cada fragmento lleva el título del documento y la ruta de la sección ("Preparación para exámenes — Ayuno", "1. Datos de la clínica › 1.2 Profesionales").
  - Las líneas enteras en negrita (preguntas frecuentes) abren una subsección: cada pregunta con su respuesta es un fragmento rotulado con la pregunta.
  - Las secciones largas (más de 900 caracteres) se parten por párrafos, luego por líneas y oraciones, repitiendo un párrafo entre fragmentos solo si cabe.
  - Las tablas se convierten a una línea por fila, con cada valor junto a su columna (ver [Administración de la base de conocimiento](#administración-de-la-base-de-conocimiento)).
- **Embeddings:** `text-embedding-3-small` (1536 dimensiones, USD 0,02/M de tokens). Indexar los 9 documentos del seed cuesta menos de un centavo.
- **Indexado incremental:** cada fragmento guarda un hash de su contenido y el modelo que lo vectorizó. Si un documento no cambió, no se vuelve a pagar el embedding. Los documentos borrados salen del índice.
- **Búsqueda:** similitud coseno, top 4, siempre filtrada por clínica. Con `hnsw.iterative_scan = strict_order` (pgvector 0.8), si Postgres usa el índice HNSW sigue buscando hasta completar los resultados de esa clínica. Sin esto, una clínica con pocos documentos podría quedarse sin resultados en una tabla con muchas clínicas.

**El umbral de similitud no evita que el modelo invente.** Calibré con 10 preguntas que sí están en los documentos y 8 que no. La relevante con menor puntaje sacó 0,364, y una que no está ("¿cuánto cuesta la consulta?") sacó 0,546 porque se parece al tema "consulta". Los rangos se cruzan, así que ningún umbral los separa. Por eso:

- El umbral (`RAG_MIN_SIMILARITY = 0.30`) solo descarta ruido evidente. Si nada lo supera, la tool responde `sin_informacion` con la indicación de no completar con conocimiento general.
- **La protección real está en el prompt y en la evaluación:** el modelo recibe los fragmentos con su fuente y la instrucción de responder solo con lo que dicen y de decirlo si no responden la pregunta. Lo verifiqué con el modelo real: no inventó precio, cardiología ni cirugía estética, y respondió bien ayuno, parqueadero y horarios.

### Cómo se arma el prompt

`assistant/prompt.ts`. Las instrucciones tienen cuatro bloques, de lo más estable a lo más variable:

1. **Rol y alcance** (con prioridad sobre cualquier pedido del usuario): solo la clínica y sus citas; rechaza código, cultura general y pedidos de cambiar de rol o revelar instrucciones.
2. **Fuente única de información:** todo lo que informe sobre la clínica debe venir de `buscar_conocimiento`. Los resultados de las tools de agenda sirven para ofrecer horarios y crear citas, no para informar.
3. **Reglas:** no inventar; consultar disponibilidad antes de ofrecer horarios; confirmar con el paciente antes de agendar y dar la cita por hecha solo si la tool responde ok; leer los errores y corregir; fechas relativas como `'manana'` para que las resuelva el código; cuándo escalar; urgencias (línea 123); sin diagnósticos ni medicamentos; estilo WhatsApp.
4. **Contexto del mensaje, al final:** la fecha y hora actual en la zona de la clínica.

**El prompt no tiene datos de la clínica** (ni el nombre ni sus servicios o sedes): de la configuración solo usa la zona horaria y los datos que la clínica pide para agendar. Así todo lo informativo pasa por el RAG y queda en la traza.

**Prompt caching:** como la parte estable (instrucciones y definiciones de las tools) va primero y la fecha al final, el prefijo se repite idéntico entre llamadas y OpenAI lo cobra a la décima parte. En la medición real, el 77 % de los tokens de entrada salió del caché.

**Prompt editable por la clínica.** El prompt es una plantilla (`DEFAULT_PROMPT_TEMPLATE`) con tres variables que el sistema reemplaza en cada turno: `{{fecha_actual}}`, `{{datos_para_agendar}}` y `{{aviso_agenda}}`. Desde **Configuración → Modelo de IA** se puede editar el texto completo:

- **Las variables son obligatorias:** sin `{{fecha_actual}}` el modelo no resuelve "el jueves"; sin las otras dos, pierde los datos para agendar o el aviso de que no hay agenda. La API rechaza (400) una plantilla a la que le falte alguna o que tenga una desconocida, y el panel lo muestra antes de guardar.
- **El original sigue vivo:** si la clínica no editó el prompt, o guarda el texto original, no se crea una copia; así recibe las mejoras futuras del código. "Restaurar original" borra la versión de la clínica. La plantilla por defecto genera exactamente el mismo texto que antes de hacerla editable (verificado byte a byte).
- **Sin reinicios:** el worker lee la plantilla por clínica en cada turno con un caché de 30 s, igual que la API key.
- **Trade-off:** editar el texto completo da flexibilidad (tono, nombre del asistente, reglas propias), pero permite borrar las reglas que evitan que el asistente invente o confirme citas que no existen. Lo preferí a dejar fijas esas reglas para darle a cada clínica control completo sobre su asistente; el panel lo advierte y recomienda probar en el simulador. `scripts/eval.ts` y `scripts/chat.ts` siguen usando el prompt original.

**Entrada al modelo:** las instrucciones, las definiciones de las tools y los últimos 20 mensajes de la conversación.

### Control del ciclo de tool calling

- **Límite de iteraciones** (`ASSISTANT_MAX_TOOL_ITERATIONS`, 6 por defecto): si se agota, el paciente recibe un mensaje y la conversación queda `escalada`. Corta los ciclos sin fin y acota el costo.
- **Una tool a la vez** (`parallel_tool_calls: false`): agendar depende de lo que devolvió consultar.
- **Validación:** los argumentos se validan con zod y contra el catálogo antes de ejecutar; un argumento inválido vuelve como error, no como excepción.
- **`store: false`:** OpenAI no guarda las respuestas, porque son datos de salud. El razonamiento cifrado (`reasoning.encrypted_content`) se reenvía entre rondas para no perder el contexto.
- **Timeout por turno** (`ENGINE_TIMEOUT_MS`, 30 s) y reintentos en la cola. Los reintentos del SDK quedan en 1 para no multiplicarlos.
- **Traza por turno** en Mongo: modelo, tokens de entrada (incluidos los del caché) y de salida, iteraciones, latencia, cada tool con sus argumentos, resultado o error y duración, el costo en USD y el resultado del guardrail.

### Por qué no LangChain ni Agents SDK

El ciclo son unas 100 líneas: llamar al modelo, ejecutar las tools, devolver los resultados y repetir hasta tener texto o agotar las iteraciones. Escribirlo directo con el SDK oficial deja explícito lo que el enunciado evalúa (validación, límite de iteraciones, manejo de errores, trazas) y evita una dependencia que oculta ese control.

**Descartados también:**
- **Servidor MCP remoto:** OpenAI llamaría a nuestras tools por una URL pública. No funciona en local y se pierde el control del ciclo y de las trazas.
- **`file_search` hospedado** para el RAG: los documentos quedarían en OpenAI y no controlaríamos los fragmentos.

### Fechas y zona horaria

El código interpreta "mañana", no el LLM. Las tools aceptan `'hoy'`, `'manana'`, `'pasado_manana'` o `YYYY-MM-DD`. Las relativas se resuelven contra la **hora del mensaje** (`timestamp` del webhook) en la zona horaria de la clínica (`America/Bogota`). "En la tarde" es la franja desde las 12:00. El caso del enunciado (03:40 UTC del 6 de octubre = 10:40 p. m. del 5 en Cali → "mañana" es el 6) está cubierto por tests y se verificó con el modelo real. Para fechas como "el jueves", el prompt incluye la fecha y hora local actual.

### La base de conocimiento es la única fuente de información

**Decisión:** todo lo que el asistente *informa* sobre la clínica sale solo de los documentos: su nombre, servicios, sedes, direcciones, horarios de atención, precios y políticas. La **agenda** (profesionales, horarios y citas) es la fuente de disponibilidad y la que garantiza que no haya citas duplicadas, pero no se usa para informar.

- **El prompt no tiene datos de la clínica** y tiene una sección "fuente única" (ver arriba).
- **Las tools tampoco los exponen:** sus descripciones no listan servicios ni sedes (aceptan lo que diga el paciente y, si no existe, devuelven las opciones para corregir). La confirmación de una cita no trae la dirección ni la política de cancelación.
- **Sin base de conocimiento no se llama al LLM y se escala a un asesor.** Antes de invocar el modelo, `KnowledgeGateEngine` revisa si la clínica tiene fragmentos indexados. Si no tiene, responde un mensaje fijo ("en este momento no tengo información… ya la pasé a un asesor"): sin costo, en milisegundos y sin riesgo de que el modelo improvise. La conversación queda **`escalada`** (motivo `sin_base_de_conocimiento`) y la traza queda como `engine: sin_llm`.

### Agenda dinámica, generada desde la base de conocimiento

Una prueba mostró al asistente ofreciendo un profesional que no estaba en el documento del cliente: salía de la agenda fija del seed. Había dos fuentes con datos distintos. **Decisión:** la agenda (sedes, servicios con duración y profesionales con sus horarios) **se genera desde los documentos** cada vez que cambian (subir, reemplazar, borrar, reindexar) o con el botón "Regenerar". Se ve en **Configuración → Agenda**.

- **Extracción con LLM, una vez por cambio de documento** (no por mensaje), con salida JSON en modo estricto (`agenda/extraction/agendaExtractor.ts`). Los documentos describen la agenda en texto libre ("Norte: lunes a viernes · Sur: martes", tablas, "rota según agenda") y un parser de reglas no sería confiable. Cuesta del orden de USD 0,002 por documento y tarda unos 25 s, en segundo plano.
- **El código decide qué entra** (`agenda/extraction/buildAgenda.ts`, sin LLM y con tests):
  - Cada sede, servicio y profesional **debe aparecer escrito en el documento**. Lo que no, se descarta. Así un nombre inventado nunca llega a la agenda.
  - Días, horas y duraciones válidos. Los servicios de un profesional deben existir, y también sus sedes.
  - **Si el documento no da la hora** de un profesional ("Norte: lunes a viernes"), se usa el horario de la sede ese día y queda una advertencia.
  - La **teleconsulta** es una sede virtual con sus propios horarios. Si el modelo la propone como servicio, se descarta.
  - Lo ambiguo ("rota según agenda") no se convierte en horarios: queda anotado para revisión.
- **Si falla la generación**, se conserva la agenda anterior. **Si los documentos no describen una agenda**, el asistente no carga las herramientas de agendamiento: responde con la base de conocimiento y escala.
- **Verificado con un documento real de una clínica** (Word con tablas): 2 sedes con dirección, la sede virtual con los horarios de teleconsulta, 7 servicios con duración y 7 profesionales. Ante "medicina general, sede sur, miércoles en la tarde" ofrece a la profesional que dice el documento, no a la del seed.

### API key del modelo configurable desde el panel

El enunciado pide dejar claro cómo configurar la API key. Hay dos formas: `OPENAI_API_KEY` en `backend/.env`, o el panel (**Configuración → Modelo de IA**), que tiene prioridad.

- **Por clínica:** cada cliente puede usar su propia key. Si no configuró una, se usa la del `.env`.
- **Se valida antes de guardar:** se le pide a OpenAI el modelo configurado, lo que comprueba la key y el acceso al modelo. Si falla, no se guarda y el panel explica por qué.
- **Cifrada en reposo:** AES-256-GCM con una clave maestra (`SETTINGS_ENCRYPTION_KEY`) que solo vive en el entorno del servidor, nunca en la base. La API solo devuelve la key enmascarada (`sk-proj-…abcd`) y los errores de esas rutas no se registran con detalle. En AWS, la clave maestra sería KMS.
- **Sin reinicios:** el worker y los embeddings resuelven la key por clínica en cada uso, con un caché de 30 s.
- **Sin key no se llama al LLM:** el paciente recibe el mensaje por defecto y la conversación se escala (motivo `sin_api_key`).

### Administración de la base de conocimiento

- El coordinador **sube documentos Word (.docx), PDF, Markdown o texto** desde el panel, hasta 10 MB, o pega texto. Un documento con el mismo nombre reemplaza al anterior.
- **Extracción:** Word con `mammoth` y `turndown` (los estilos de título pasan a `#`/`##`). PDF con `unpdf` (pdf.js), que rechaza con un mensaje claro los PDF escaneados sin texto, dañados o con contraseña. Se guarda el texto extraído, no el archivo (en producción el original iría a S3).
- **Tablas: una línea por fila, con cada valor junto a su columna** (`knowledge/tables.ts`). Aplanadas celda por celda ("Profesional / Especialidad / Dr. Carlos Mejía / Medicina general…"), el modelo tenía que adivinar qué valor iba con qué columna, y ahí se cruzaban nombres, sedes y precios. Ahora cada fila es autocontenida: `Profesional: Dr. Carlos Mejía | Especialidad: Medicina general | Sede y días: Norte: lunes a viernes`. Soporta tablas normales, transpuestas y clave-valor, en Word, Markdown y PDF (en PDF las filas y columnas se reconstruyen desde la posición de cada texto).
- **Se indexa en el momento** y la API responde con la cantidad de fragmentos. Primero se generan los embeddings y después se escribe en Mongo: si falla (por ejemplo, sin API key), no se guarda nada. Así nunca queda un documento visible en el panel pero invisible para el asistente.
- **Búsqueda de prueba:** muestra los fragmentos que recibiría el asistente para una pregunta, con su similitud. Sirve para depurar el RAG sin abrir una conversación.

---

## Confiabilidad

### Cómo evito que el asistente invente

En capas, porque ninguna sola alcanza:

1. **Sin base de conocimiento o sin API key, no hay LLM:** mensaje fijo y escalamiento (`KnowledgeGateEngine`).
2. **Fuente única en el prompt:** lo informativo solo viene de `buscar_conocimiento`; si devuelve `sin_informacion` o los fragmentos no responden, lo dice y ofrece un asesor.
3. **Los datos de la clínica no están en el prompt ni en las tools**, así que el modelo no tiene de dónde sacar un dato que no esté en los documentos.
4. **Horarios solo de `consultar_disponibilidad`** y cita confirmada solo si `agendar_cita` responde ok. Todo lo que el modelo pide se valida en código.
5. **La agenda solo contiene nombres que aparecen en los documentos** (`buildAgenda.ts`).
6. **Guardrail determinista de salida:** si la respuesta trae código, se reemplaza por el mensaje de fuera de alcance. Queda registrado en la traza (`guardrail`) y es visible en el panel.
7. **Set de evaluación** (`npm run eval`, `backend/eval/cases.ts`): 10 casos contra el modelo real. Cubren alcance (código, cultura general), inyección de instrucciones, RAG (respuesta en documentos, precio que no debe inventar, servicio inexistente), "mañana" del enunciado, agendamiento completo, medicamentos y urgencias. Antes de agregar la sección de alcance fallaban los casos de código y cultura general; después pasan los 10 (unos USD 0,002 por corrida).

### Cuando el LLM falla

| Situación | Qué pasa |
|---|---|
| OpenAI tarda más de 30 s | Se aborta la llamada (`ENGINE_TIMEOUT_MS`) y el mensaje vuelve a la cola con backoff exponencial. |
| Falla tres veces seguidas (`WORKER_MAX_ATTEMPTS`) | El worker envía un mensaje de respaldo ("en este momento no puedo responderte. Ya le avisé a un asesor…") y deja la conversación `escalada` (motivo `falla_tecnica`). El paciente nunca se queda sin respuesta. |
| El worker se cae a mitad de un turno | El mensaje vuelve a ser visible en la cola. La DLQ (`maxReceiveCount = 4`) atrapa lo que ni siquiera alcanzó a manejarse. |
| Falla el envío de la respuesta | La respuesta se guarda **antes** de enviarla: el reintento reenvía la misma respuesta **sin volver a llamar al LLM**. |
| El turno ya había agendado | El reintento reutiliza la cita por `source_message_id`. |
| Se agotan las iteraciones de tools | Mensaje al paciente y conversación `escalada`. |

**Estado consistente:** el mensaje del paciente pasa por `recibido → procesando → respondido` con updates condicionales, y la conversación solo cambia de estado al registrar el turno. Con la conversación `escalada`, la IA deja de responder: los mensajes nuevos quedan `pendiente_humano` hasta que el coordinador la **devuelva a la IA**.

---

## API del coordinador

- **Bandeja** (`GET /conversations`) con filtro por estado o teléfono y conteo por estado. Usa **paginación por cursor** sobre `(last_message_at, _id)` en lugar de `skip`: es estable aunque lleguen mensajes nuevos mientras el coordinador pagina, y siempre usa el índice de la bandeja.
- **Detalle** (`GET /conversations/:id`): cada respuesta del asistente trae los turnos que la produjeron (incluidos los intentos fallidos), con las tools que usó, sus argumentos y resultados, tokens y **costo en USD**. El costo se calcula al registrar el turno con el precio vigente del modelo y se guarda, así que si cambian los precios las trazas conservan lo que costó en su momento. Los totales se acumulan en la conversación (`$inc`).
- **`assistant_pending`:** indica si hay un mensaje del paciente sin responder. Lo usa el frontend para mostrar "el asistente está respondiendo".
- **Devolver a la IA** (`POST /conversations/:id/release`): una conversación escalada vuelve a `en_curso`. Los mensajes `pendiente_humano` no se reprocesan, porque se asume que el asesor ya los atendió.
- **Base de conocimiento, configuración y agenda:** `/knowledge` (subir, listar, borrar, reindexar, buscar), `/settings/ai` (guardar, probar y borrar la key), `/settings/prompt` (ver, guardar y restaurar el prompt), `/agenda` (ver y regenerar) y `/agenda/calendar` (citas y horas libres por día).
- **Clínica del coordinador:** en local viene del header `X-Clinic-Id`. En producción vendría del token de Cognito, nunca de un parámetro que el cliente pueda cambiar. Una conversación de otra clínica responde 404, no 403, para no revelar que existe.
- **Sin autenticación en la versión local.** Es una simplificación consciente para la prueba; en AWS esas rutas irían detrás de Cognito.

---

## Frontend

- **React + Vite + TypeScript**, sin librería de componentes. **TanStack Query** maneja caché, carga, error y reintentos: reintenta solo errores de red o 5xx, nunca un 400 o un 404.
- **Estados:** cada vista tiene carga, vacío y error con opción de reintentar.
- **"El asistente está respondiendo"** sale de `assistant_pending`. Mientras es `true`, el detalle se consulta cada 1,5 s; si no, cada 5 s. Descarté WebSocket o SSE: para un coordinador alcanza el polling y evita otra pieza en la infraestructura.
- **Diseño:** la bandeja a la izquierda y el detalle a la derecha. El detalle muestra la transcripción como chat, con los colores del panel, con métricas bajo cada respuesta (tiempo del LLM y de cada herramienta, tokens y costo), y un panel con tres pestañas: **Resumen**, **Paciente** y **Técnico** (cada turno con sus tools, argumentos y resultados).
- **Resumen sin LLM:** lo arma el backend con reglas (`messaging/conversationSummary.ts`) a partir de las trazas. Es determinista, instantáneo y no cuesta tokens. Un resumen con LLM sería más natural, pero costaría una llamada por conversación y podría equivocarse sobre lo que pasó; las trazas son la fuente exacta.
- **Simulador:** un chat que envía cada mensaje a `POST /webhooks/messages` con un `message_id` único y la hora del sistema, como lo haría WhatsApp. Permite reenviar el mismo `message_id` para ver la idempotencia (200 `duplicate`). El caso de "mañana" a las 10:40 p. m. se reproduce con los tests, con Postman (ver el README) y con `npm run chat -- --at 2026-10-06T03:40:00Z`.
- **Calendario de citas:** `GET /agenda/calendar` arma, por día y profesional, los bloques de atención menos las citas confirmadas, los festivos, las excepciones y la anticipación mínima (`agenda/calendar.ts`, función pura con tests). Los tramos libres no dependen del servicio, a diferencia de `consultar_disponibilidad`, porque el coordinador quiere ver la ocupación del profesional, no los cupos de un servicio. El panel muestra el mes y abre el detalle del día a la derecha solo al hacer clic; se refresca cada 15 s para ver las citas que agenda el asistente.
- **La API key se cambia en una ventana modal**, no en un formulario siempre visible: la tarjeta muestra el estado y el formulario aparece solo cuando se va a cambiar.
- **Las fechas se muestran en hora de la clínica**, no en la del navegador.
- **nginx sirve el panel y reenvía `/api` a la API**, así el navegador habla con un solo origen y no hay CORS (lo encontré al abrir el panel desde `127.0.0.1` en lugar de `localhost`).

---

## Nube (AWS)

### Escenario de diseño

- **50 clínicas** y **20.000 mensajes/día**, es decir unos **600.000 mensajes/mes**.
- Promedio de **0,23 mensajes/s**. Supongo picos de 10× (unos 2–3 mensajes/s) en horario laboral de Colombia (UTC-5).
- Es una carga baja y con picos. Por eso elegí servicios serverless y gestionados.

**Diagrama:** [`docs/images/arquitectura-AWS-pruebaWekall.png`](docs/images/arquitectura-AWS-pruebaWekall.png) (fuente en Excalidraw). La arquitectura local está en el README.

**No hay infraestructura como código ni despliegue real.** El enunciado lo deja como opcional y preferí invertir el tiempo en el núcleo (motor de IA y datos). Es lo primero que haría después (ver el final del documento).

### Flujo de un mensaje

1. **WhatsApp → API Gateway (REST) + WAF → Lambda de ingesta.** Valida la firma HMAC de Meta y el payload, guarda el mensaje con `_id = message_id` (si ya existe, no hace nada más), encola en **SQS FIFO** y responde **200** en menos de 300 ms. Meta espera 200; en local respondo 202 porque es más preciso ("aceptado, se procesa después").
2. **SQS FIFO → Lambda worker.** `MessageGroupId = teléfono`: cada conversación procesa un turno a la vez y en orden. `MessageDeduplicationId = message_id` es una segunda barrera contra duplicados.
3. **Worker:** arma el contexto (historial en DocumentDB) y corre el ciclo de tool calling con OpenAI. Las tools consultan pgvector y la agenda, y crean la cita en Postgres en una transacción con la restricción `EXCLUDE`. Guarda la respuesta y la traza, y envía la respuesta por la WhatsApp Cloud API.
4. **Si algo falla:** el worker reintenta con backoff. Al tercer intento fallido envía un mensaje de respaldo y escala. Lo que no alcanza a manejar va a la **DLQ**, con alarma.
5. **Coordinador:** usa el panel (S3 y CloudFront), se autentica con Cognito y consulta `/api/*` por polling.

### Servicios elegidos y por qué

| Capa | Servicio | Por qué |
|---|---|---|
| Entrada | API Gateway REST + AWS WAF | WAF (rate limiting, reglas gestionadas) se integra directo con REST API, no con HTTP API. Throttling por ruta. |
| Cómputo | AWS Lambda (ingesta, worker, ingesta de documentos) | Con 0,23 mensajes/s un servidor encendido 24/7 estaría casi siempre ocioso. Lambda escala sola y cobra por uso. |
| Cola | SQS FIFO + DLQ | Orden por conversación y deduplicación nativa. El límite de FIFO (300 operaciones/s por API, más con batching o modo high-throughput) está muy por encima del pico. |
| Datos transaccionales | RDS PostgreSQL (Single-AZ; Multi-AZ opcional) + **pgvector** + RDS Proxy | Citas con transacciones y restricciones. pgvector evita operar una base vectorial aparte. RDS Proxy evita agotar conexiones cuando Lambda escala. |
| Catálogo, conversaciones y trazas | Amazon DocumentDB (compatible con MongoDB), 1 instancia; réplica opcional | Esquema flexible y escritura intensiva: mensajes, tool calls, tokens y latencias. |
| Archivos | S3 | Documentos originales de cada clínica (prefijo por `clinic_id`) y logs exportados. |
| Frontend | S3 + CloudFront (+ Route 53; Amplify opcional) | Hosting estático barato con CDN, en el mismo dominio que la API. |
| Identidad | Cognito | Login de coordinadores con JWT validado en API Gateway; la clínica sale de un claim del token. El webhook no usa Cognito sino la firma HMAC de Meta. |
| Secretos | Secrets Manager + KMS | Token de Meta, credenciales de las bases y API key por defecto. KMS cifra las API keys de cada clínica (reemplaza a `SETTINGS_ENCRYPTION_KEY`). |
| Red | VPC con subredes privadas, 1 NAT Gateway y VPC endpoint de S3 | Las bases no quedan expuestas. La salida a OpenAI y WhatsApp pasa por NAT. |
| Escalamiento | SNS / EventBridge | `escalar_a_humano` y el outbox de citas publican eventos que notifican al coordinador. |
| Observabilidad | CloudWatch (logs, métricas, alarmas) + X-Ray | Alarmas sobre la profundidad de la DLQ, la tasa de error del LLM, la latencia p95 del turno y los tokens por clínica. |

### Cómo escala

- **Ingesta y worker:** Lambda escala por concurrencia. Con unos 5 s por turno y 3 mensajes/s de pico, se necesitan **unas 15 ejecuciones concurrentes**. Configuro **reserved concurrency** en el worker para proteger RDS y no superar el rate limit de OpenAI.
- **Cola:** SQS absorbe los picos. Si OpenAI se pone lento, los mensajes esperan en la cola y no se pierden.
- **Postgres:** el cuello de botella sería la cantidad de conexiones, no las consultas. RDS Proxy resuelve eso, y se puede subir de instancia o agregar una réplica de lectura.
- **DocumentDB:** se agregan réplicas de lectura si la bandeja y la trazabilidad lo necesitan.
- **Volumen ×10 (200.000 mensajes/día):** el diseño aguanta igual. Lo primero que reconsideraría es mover el worker a ECS Fargate, porque Lambda cobra el tiempo que pasa esperando al LLM.

### Qué pasa si se cae una pieza

| Falla | Comportamiento |
|---|---|
| OpenAI lento o caído | Timeout por llamada y reintentos con backoff (3 intentos). Si persiste, mensaje de respaldo, estado `escalada` y notificación al coordinador. El visibility timeout de SQS es mayor que el tiempo máximo del turno para no duplicar procesamiento. |
| Error en el worker | SQS reintenta. El turno es idempotente (estado por `message_id`, cita por `source_message_id` y `EXCLUDE`). Lo que no se maneja va a la DLQ, con alarma. |
| Falla de la instancia de RDS | **1 AZ:** AWS recupera o reemplaza la instancia en minutos. RDS Proxy reconecta. Los mensajes esperan en SQS. **2 AZ (opcional):** failover automático en unos 60–120 s. |
| Falla de la instancia de DocumentDB | **1 AZ:** AWS reemplaza la instancia en minutos; los turnos fallidos se reintentan desde la cola. **2 AZ (opcional):** se promueve la réplica en unos 30 s. |
| Caída de la zona (AZ) completa | **1 AZ:** el worker y las bases quedan detenidos. API Gateway y SQS son regionales, así que **los mensajes se siguen recibiendo y quedan en la cola** (retención de 4 días). Se procesan cuando la zona vuelve, o al restaurar en otra AZ desde backup point-in-time (pérdida de unos 5 min como máximo; recuperación en 30–60 min). **2 AZ (opcional):** el servicio sigue operando. |
| Falla al enviar a WhatsApp | Reintento con backoff y sin volver a llamar al LLM (la respuesta ya está guardada). Si no se puede entregar, queda marcado en la traza y visible en la bandeja. |
| Tráfico abusivo al webhook | WAF limita por IP y API Gateway hace throttling. Los mensajes sin firma válida se descartan antes de encolar. |

### Disponibilidad: 1 AZ por defecto, 2 AZ opcional

**Supuesto:** el enunciado no exige alta disponibilidad (pide "qué pasa si se cae una pieza", no un nivel de disponibilidad). Por eso el diseño base usa **una sola zona** para las piezas con costo fijo (RDS, DocumentDB y NAT) y deja **Multi-AZ como opción**.

- **Con 1 AZ igual se resiste bastante:** las fallas de instancia se recuperan en minutos, y API Gateway, SQS, S3 y Lambda son regionales. Ante una caída de la zona, los mensajes no se pierden: esperan en SQS. Lo que se pierde es la **inmediatez**.
- **Detalle técnico:** los *subnet groups* de RDS y DocumentDB exigen subredes en al menos 2 AZ. Las subredes de la segunda zona ya quedan creadas, así que pasar a Multi-AZ es un cambio de configuración, no un rediseño.
- **Cuándo activar 2 AZ:** si se acuerda un SLA con las clínicas, si el volumen crece o si una respuesta tardía empieza a costar citas. Cuesta unos **+USD 140/mes**.

### Multi-tenant (50 clínicas)

Modelo **pool** (infraestructura compartida) con aislamiento lógico:

- **Identificación del tenant:** el WABA ID del webhook (o el `phone_number_id`) determina la `clinic_id` en la ingesta. El tenant nunca se toma del texto del paciente ni de lo que diga el LLM. Ya está implementado así en local.
- **Postgres:** `clinic_id` en todas las tablas y como primera columna de los índices. En producción agregaría **Row-Level Security** con `SET app.clinic_id` por transacción (no está implementado en la versión local).
- **MongoDB:** `clinic_id` como primer campo de los índices compuestos (por ejemplo `{clinic_id, status, last_message_at, _id}` para la bandeja). Todas las consultas del repositorio filtran por clínica.
- **RAG:** la búsqueda vectorial siempre filtra por `clinic_id`. Una clínica nunca recibe fragmentos de otra.
- **Coordinadores:** la clínica sale del token de Cognito; una conversación de otra clínica responde 404.
- **Secretos:** API key de OpenAI por clínica, cifrada.
- **S3:** prefijo por clínica (`s3://docs/{clinic_id}/…`).
- **Cuotas:** límite de tokens y mensajes por clínica para que una no consuma el presupuesto de las demás.
- **Evolución:** un cliente grande o con requisitos regulatorios podría pasar a modelo **silo** (base dedicada) cambiando solo la configuración de conexión por tenant.

### Alternativas descartadas

| Alternativa | Por qué no (por ahora) |
|---|---|
| ECS Fargate para el worker | Más barato con carga alta y constante, porque Lambda cobra la espera al LLM. Con 20.000 mensajes/día Lambda es más simple y cuesta parecido. Lo reevaluaría por encima de unos 200.000 mensajes/día. |
| SQS estándar | No garantiza orden por conversación. Dos mensajes seguidos del mismo paciente podrían procesarse en paralelo y dejar el historial inconsistente. |
| Kinesis / MSK | Sobredimensionado para este volumen y más costoso de operar. |
| Step Functions para el ciclo de tool calling | Agrega costo y latencia por transición. El ciclo con límite de iteraciones es más claro en código y fácil de probar con un LLM falso. |
| OpenSearch para vectores | Costo base alto para un corpus de decenas de documentos por clínica. pgvector alcanza y evita una pieza más. |
| Aurora Serverless v2 | Opción válida por la escala automática. Elegí RDS clásico por tener un costo predecible a este volumen. |
| MongoDB Atlas (en AWS) | Compatibilidad total con MongoDB y Atlas Vector Search. Lo descarté por consolidar facturación y red dentro de AWS. **Trade-off:** DocumentDB no es 100 % compatible con MongoDB, así que hay que probar los drivers y las consultas. |
| API Gateway WebSocket | Mejor experiencia para mostrar "el asistente está respondiendo". El polling cada pocos segundos es más simple y suficiente para coordinadores. |
| Amazon Bedrock en lugar de OpenAI | Mantendría el tráfico del LLM dentro de AWS (VPC endpoint, sin NAT). Es una buena evolución; el proveedor ya está detrás de una interfaz. |

### Costo mensual estimado de infraestructura

> **Supuestos:** región `us-east-1`, precios on-demand de lista **de referencia**, sin free tier ni Savings Plans. Son órdenes de magnitud para dimensionar. **Hay que validar con el [AWS Pricing Calculator](https://calculator.aws/) antes de presentar cifras definitivas.**

**Diseño base con 1 AZ**

| Servicio | Supuesto de uso | USD/mes aprox. |
|---|---|---|
| Lambda worker | 600.000 invocaciones × unos 5 s × 512 MB ≈ 1,5 M GB-s | 25 |
| Lambda de ingesta y documentos | 600.000 × 0,2 s × 256 MB + requests | 1 |
| API Gateway REST | Unos 3 M requests (webhook + API + polling) × USD 3,50/M | 11 |
| SQS FIFO | Unos 1,8 M requests (send, receive, delete) | 1 |
| RDS PostgreSQL | db.t4g.medium **Single-AZ** + 50 GB gp3 + backups | 55 |
| RDS Proxy | 2 vCPU × USD 0,015/h | 22 |
| DocumentDB | 1 × db.t4g.medium + storage e I/O | 58 |
| NAT Gateway | 1 NAT (unos USD 33) + datos procesados | 35 |
| AWS WAF | 2 Web ACL + reglas + requests | 22 |
| CloudWatch + X-Ray | Unos 10 GB de logs, métricas, alarmas y trazas | 15 |
| Secrets Manager + KMS | 4 secretos + 1 clave + llamadas (cacheadas) | 3 |
| Frontend (S3, CloudFront, Route 53) | Panel de coordinadores, tráfico bajo | 5 |
| Cognito, SNS/EventBridge, S3 documentos | Pocos usuarios activos y eventos | 1–3 |
| **Total infraestructura (1 AZ)** | | **≈ USD 255/mes** (rango 220–290) |

**Opcional: alta disponibilidad con 2 AZ**

| Cambio | USD/mes adicional aprox. |
|---|---|
| RDS PostgreSQL pasa a Multi-AZ | +50 |
| DocumentDB suma una réplica en la segunda AZ | +57 |
| Segundo NAT Gateway (uno por AZ) | +33 |
| **Total adicional** | **≈ +USD 140/mes** |
| **Total infraestructura (2 AZ)** | **≈ USD 395/mes** (rango 350–450) |

Incluso con 1 AZ, lo que más pesa son los **costos fijos**: bases, RDS Proxy, NAT y WAF suman unos USD 190, cerca del 75 %. El cómputo serverless es marginal.

**Cómo bajarlo:** Reserved Instances o Savings Plans a 1 año para RDS y DocumentDB (30–40 % menos en esas líneas); Bedrock en lugar de OpenAI quita la mayor parte del tráfico por NAT; en desarrollo, quitar RDS Proxy y WAF.

---

## Costo

### Cuánto cuesta una conversación típica

Modelo: **`gpt-6-luna`** (USD 0,10/M de tokens de entrada, USD 0,01/M en caché y USD 0,50/M de salida, según la página oficial de precios de OpenAI consultada el 2026-10-04). Lo elegí por ser el más barato con tool calling confiable para este caso; el enunciado no evalúa la calidad conversacional. Embeddings: `text-embedding-3-small` (USD 0,02/M).

**Medición real:** una conversación de 4 mensajes (consultar disponibilidad, elegir horario, confirmar y agendar, y una pregunta sin respuesta que terminó escalada):

| | Tokens | USD |
|---|---|---|
| Entrada sin caché | 3.450 | 0,000345 |
| Entrada desde el caché (77 %) | 11.735 | 0,000117 |
| Salida | 604 | 0,000302 |
| **Conversación completa** | | **≈ USD 0,0008** (unos USD 0,0002 por mensaje) |

El panel muestra el costo real de cada turno y el total de cada conversación, calculado con estos precios.

### Proyección mensual

| | Por mensaje | 600.000 mensajes/mes |
|---|---|---|
| Medido | ≈ USD 0,0002 | ≈ USD 115 |
| **Estimado conservador** (fragmentos de RAG y conversaciones más largas, unas 2×) | ≈ USD 0,0004 | **≈ USD 250** |

| Escenario | Infraestructura | LLM | Total/mes | Por clínica/mes |
|---|---|---|---|---|
| **Base (1 AZ)** | ≈ USD 255 | ≈ USD 250 | **≈ USD 505** | ≈ USD 10 |
| Alta disponibilidad (2 AZ, opcional) | ≈ USD 395 | ≈ USD 250 | ≈ USD 645 | ≈ USD 13 |

Con este modelo y el caché, el LLM es cerca de la mitad del costo; la infraestructura fija pesa igual o más.

### Cómo lo reduciría

- **Ya aplicado:** prompt caching (parte estable primero), sin LLM cuando no hay base de conocimiento ni key, resumen de la conversación sin LLM, indexado incremental de embeddings y extracción de la agenda solo cuando cambian los documentos.
- **Siguiente:** recortar el historial a los últimos N turnos con un resumen, limitar la cantidad de fragmentos de RAG, responder preguntas frecuentes sin tool calling y usar un modelo más grande solo cuando haga falta (por ejemplo `gpt-6.1-sol` en conversaciones difíciles).

---

## Trade-offs

Decisiones donde elegí una opción sabiendo lo que costaba:

| Decisión | Lo que gané | Lo que pagué |
|---|---|---|
| Catálogo en Mongo y citas en Postgres | Catálogo flexible por clínica y garantía dura contra citas duplicadas | No hay claves foráneas entre bases; la disponibilidad lee de las dos; validación en código |
| Postgres primero y Mongo después, con reintento idempotente (sin transacción distribuida) | Simplicidad; la cita nunca se pierde ni se duplica | La traza puede llegar unos segundos tarde; el outbox quedó escrito pero sin consumidor |
| ElasticMQ en local en lugar de una cola en Postgres | El mismo código que en AWS, con orden por grupo, deduplicación y DLQ | Un contenedor más |
| Ciclo de tool calling propio, sin LangChain | Control explícito de validación, iteraciones, errores y trazas | Escribir y mantener unas 100 líneas |
| Sin `enum` en especialidad y profesional | Validación explícita y opciones para corregir | El modelo puede mandar un nombre inválido (y el código se lo devuelve) |
| Umbral de similitud bajo (0,30) | No se pierden respuestas relevantes | No filtra lo irrelevante; la protección depende del prompt y de la evaluación |
| Agenda extraída con LLM desde los documentos | Una sola fuente de verdad, sin cargar la agenda a mano | No es determinista; la mitigo con reglas en código, revisión en el panel y conservando la agenda anterior si falla |
| Resumen de la conversación con reglas | Gratis, instantáneo y exacto | Menos natural que uno escrito por un LLM |
| Polling en lugar de WebSocket | Menos infraestructura | Hasta 1,5 s de retraso en el panel |
| Indexación síncrona al subir un documento | El coordinador sabe al instante si quedó indexado | Unos segundos por documento; no escala a cargas masivas |
| 1 AZ por defecto en AWS | Unos USD 140/mes menos | Ante la caída de una zona, las respuestas se demoran (no se pierden) |
| Lambda para el worker | Escala sola y sin servidores | Paga el tiempo de espera del LLM; a 10× volumen conviene Fargate |
| Sin autenticación en local | Probar más rápido | El panel local no es multi-usuario; en AWS va Cognito |

---

## Ambigüedades del enunciado y cómo las resolví

| Ambigüedad | Decisión |
|---|---|
| El payload del webhook no dice a qué clínica va | `waba_id` opcional en el payload; si no viene, `DEFAULT_CLINIC_ID`. En producción, el WABA ID de Meta. |
| ¿202 o 200 en el webhook? | 202 en local (aceptado, se procesa después) y 200 duplicado; en producción 200, que es lo que espera Meta. |
| "Una agenda con 2 semanas de horarios" | Horarios semanales por profesional y un horizonte de agendamiento de 14 días (`booking_horizon_days`), en lugar de generar dos semanas de cupos fijos que se vencen. |
| "Esta tarde" / "en la tarde" | Franja `tarde` desde las 12:00, en hora de la clínica. |
| Qué hora usar como "ahora" | El `timestamp` del mensaje, no la hora del servidor: así "mañana" significa lo que el paciente quiso decir al escribir, aunque el mensaje se procese después. |
| Qué pasa después de escalar | La IA deja de responder esa conversación hasta que el coordinador la devuelve a la IA. |
| Si el estado final es por turno o por conversación | La conversación guarda el estado más importante que alcanzó (`escalada` > `cita_agendada` > `resuelta_por_ia`) y cada turno guarda el suyo. |
| De dónde sale la agenda | Al probarlo con documentos reales, decidí que la agenda se genere desde la base de conocimiento para que haya una sola fuente. El seed incluye un documento de profesionales y horarios (`09-profesionales-y-horarios.md`) del que sale la agenda de 2 sedes y 3 especialidades. |

---

## Uso de IA

Usé **Claude Code** (un agente de programación) durante todo el proyecto: generó la mayor parte del código, los tests, la documentación y los diagramas a partir de mis instrucciones. Yo definí el alcance y las decisiones de diseño, construí por fases y probé cada una levantando los contenedores, usando el panel y el simulador como lo haría una clínica, y revisando las trazas.

### Qué me entregó mal o incompleto, y qué corregí

- **Alcance sin límites:** la primera versión del asistente escribía código en Python y respondía cultura general si se lo pedían. El prompt solo prohibía inventar datos de la clínica. Lo encontré en una prueba manual y lo corregimos en capas: sección de alcance, guardrail de salida y set de evaluación.
- **Datos de la clínica fuera de la base de conocimiento:** después de borrar todos los documentos, el asistente seguía dando el nombre y los servicios de la clínica, porque el prompt los traía desde la configuración. Pedí que la base de conocimiento fuera la única fuente: el prompt quedó sin datos de la clínica y, sin documentos, no se llama al LLM y se escala.
- **Un profesional que no existía en mi documento:** con un documento real cargado, el asistente ofreció un médico de la agenda de prueba del seed. Por eso la agenda pasó a generarse desde los documentos.
- **Tablas y secciones mal leídas:** al revisar los fragmentos de un documento real encontré tablas aplanadas celda por celda (nombres y sedes cruzados) y secciones completas mal rotuladas (Preguntas frecuentes, Urgencias y Políticas quedaban bajo "6.9 Cierre", porque se descartaban los títulos de primer nivel). Se corrigieron con la conversión de tablas por filas y el chunking por ruta de títulos.
- **Precisión de las respuestas:** el asistente presentó una lista de horarios recortada como si fuera todo el rango del día, y la extracción de la agenda tomó la teleconsulta como un servicio. Ambos se corrigieron en código (primer y último horario con aviso de recorte; descarte determinista de la teleconsulta).
- **Las herramientas tenían que ser tools reales del LLM:** desde el principio exigí que el modelo decidiera cuándo usarlas (function calling), no funciones que el código invocara por reglas, y lo verifiqué en las trazas.
- **Errores que encontraron los tests y el navegador:** el historial se ordenaba por la hora de WhatsApp y la respuesta podía quedar antes que la pregunta; el solapamiento entre fragmentos podía superar el tamaño máximo; tests de integración que competían con el worker en ejecución; CORS al abrir el panel desde `127.0.0.1`; y una caja de texto del simulador que quedaba oculta en pantallas bajas.
- **Documentación desactualizada:** al revisar este documento contra el código encontré que describía un proceso que consumía el outbox y que no existe, y varios datos viejos (chunking, cantidad de documentos, ruta del diagrama). Lo corregí.

### Qué validé yo

- El caso de "mañana" del enunciado, con tests y con el modelo real.
- La concurrencia de citas: 10 inserciones simultáneas del mismo horario, 1 gana.
- El set de evaluación con el modelo real (10/10) después de cada cambio de prompt.
- Los costos del LLM con tokens medidos y los precios de la página oficial de OpenAI. Los costos de AWS son de referencia y hay que validarlos en el AWS Pricing Calculator.
- Que la API key nunca quede en el repositorio: `backend/.env` está en `.gitignore` y la key del panel se guarda cifrada.

---

## Qué haría distinto con más tiempo o en producción

- **Evaluación de respuestas:** ampliar el set de evaluación con casos reales anonimizados y correrlo en CI en cada cambio de prompt, modelo o documentos. Agregar una verificación de que cada afirmación de la respuesta esté respaldada por un fragmento (grounding), con un modelo evaluador o reglas.
- **Infraestructura como código:** CDK o Terraform, empezando por la cola, las Lambdas y las bases, y un despliegue real.
- **Consumidor del outbox** que publique en EventBridge (notificar al coordinador cuando se agenda o se escala, sincronizar con el sistema de la clínica).
- **Seguridad:** Cognito en el panel, validación de la firma HMAC de Meta en el webhook (no está en la versión local), Row-Level Security en Postgres y políticas de retención para datos de salud.
- **Observabilidad:** métricas por clínica (tokens, costo, tasa de escalamiento, latencia p95), alarmas sobre la DLQ y trazas distribuidas con OpenTelemetry/X-Ray desde el webhook hasta el envío.
- **Varios clientes en la misma plataforma:** cuotas de tokens por clínica, historial de versiones del prompt de cada cliente con evaluación automática antes de publicarlo, y adaptadores de `AgendaProvider` hacia los sistemas de agenda de cada clínica.
- **Producto:** aprobación manual antes de publicar una agenda regenerada, indexación asíncrona para documentos grandes, OCR para PDF escaneados (Textract), actualizaciones del panel en tiempo real (WebSocket o SSE) y el canal real de WhatsApp Cloud API.
