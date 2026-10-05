# DECISIONS.md

> Borrador: por ahora están la sección de **Nube** y los puntos de datos que salieron del diagrama. Faltan arquitectura general, el modelo de datos completo (entidades e índices), pipeline de IA, confiabilidad, costo por conversación, trade-offs y uso de IA.

---

## Modelo de datos (puntos clave, borrador)

### Qué va en cada base

**Criterio:** en Postgres va solo lo que necesita una garantía dura; en MongoDB va todo lo que cambia de forma entre clientes o crece rápido. Es un sistema multi-tenant: no todas las clínicas tienen varias sedes ni varias especialidades, y cada una pide datos distintos al agendar.

| Base | Datos | Por qué |
|---|---|---|
| **PostgreSQL** | `appointments` (citas), `outbox` y, más adelante, embeddings de documentos (pgvector) | Las citas son lo único que no puede fallar: un recurso no puede tener dos citas que se crucen. Eso lo garantiza una restricción `EXCLUDE` del esquema, no el código. |
| **MongoDB (DocumentDB)** | `clinics` (sedes, servicios, campos de agendamiento, reglas y festivos, todo opcional por clínica), `resources` (profesionales, salas o equipos, con horarios semanales), `knowledge_documents`, `conversations`, `messages` y `turns` (trazas) | El catálogo cambia de forma por cliente: una clínica tiene 0, 1 o N sedes, sus propios campos (EPS, documento…) y sus reglas. Las conversaciones y trazas son append-heavy y de forma variable. |

**Citas: restricción en el esquema**

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

**Disponibilidad:** se calcula en código. Los horarios posibles salen de `resources.schedules` (Mongo), menos los festivos y las citas confirmadas (Postgres, índice `(clinic_id, resource_id, starts_at)`).

**Trade-offs de separar el catálogo de las citas:**
1. **No hay FK entre bases:** Postgres no sabe si `resource_id` existe. El código lo valida contra Mongo antes de insertar (`validateResourceAgainstClinic` y validación en las tools).
2. **La disponibilidad no es una sola consulta:** requiere leer de las dos bases. A cambio, cada clínica define sus horarios a su manera.
3. **Borrar un recurso con citas futuras** se debe bloquear en el código.
4. **El catálogo se valida al leerlo** (con zod), porque Mongo no impone la forma de los documentos.

**Evolución en producción:** con Messenger Hub, la agenda probablemente vive en el sistema de cada clínica. Las herramientas se diseñan detrás de una interfaz (`AgendaProvider`) para poder conectar un adaptador por cliente sin cambiar el motor del asistente.

### Multi-tenant: a qué clínica va cada mensaje

- **Producción:** por el **WhatsApp Business Account ID** (WABA) que trae el webhook de Meta (`entry[].id`). Cada clínica guarda su `whatsapp_business_account_id`, con índice único. Si un cliente necesitara varios números en el mismo WABA, se resolvería por `phone_number_id` (`metadata` del webhook) con el mismo mecanismo.
- **Prueba (decisión ante una ambigüedad del enunciado):** el payload del PDF no trae ningún identificador de destino. El webhook acepta un `waba_id` opcional y, si no viene, usa la clínica por defecto (`DEFAULT_CLINIC_ID`).
- El tenant nunca se toma del texto del paciente ni de lo que diga el LLM.

### Procesamiento asíncrono: por qué ElasticMQ en local

El PDF pide justificar el mecanismo. Elegí **ElasticMQ**, que es compatible con Amazon SQS: la API usa **el mismo SDK de AWS y el mismo código que en producción** (SQS FIFO), y solo cambia el endpoint. Da `MessageGroupId` (orden por conversación), `MessageDeduplicationId` y DLQ sin programarlos a mano.

Alternativas descartadas: una cola sobre Postgres (`SKIP LOCKED`), porque habría que programar el orden por grupo, los reintentos y la DLQ, y en AWS sería otro código. BullMQ + Redis, porque no tiene grupos FIFO en la versión gratuita. LocalStack, porque es más pesado de lo necesario para usar solo SQS. La cola está detrás de una interfaz `MessageQueue`; los tests usan una implementación en memoria con la misma semántica.

**Flujo:** el webhook guarda, encola y responde **202** sin esperar al LLM. Un **worker** (proceso aparte) consume la cola. Las conversaciones distintas se procesan en paralelo y los mensajes de una misma conversación, en orden y de a uno. Si un mensaje se reintenta, los siguientes del mismo paciente esperan detrás de él.

**Fallas:**
- El motor tiene un timeout (`ENGINE_TIMEOUT_MS`). Si falla, se reintenta con espera exponencial.
- En el **tercer intento fallido**, el worker envía un mensaje de respaldo y deja la conversación `escalada` (`falla_tecnica`).
- La DLQ (`maxReceiveCount = 4`) atrapa lo que el worker ni siquiera alcanzó a manejar, por ejemplo si el proceso se cae.
- La respuesta se guarda **antes** de enviarla: si el envío falla, el reintento reenvía la misma respuesta **sin volver a llamar al LLM**. Esto ahorra costo y evita respuestas distintas a la misma pregunta.
- Con la conversación `escalada`, la IA deja de responder: los mensajes nuevos quedan `pendiente_humano`.

**Orden del historial:** los mensajes se ordenan por la hora en que los recibió el servidor (`created_at`), no por la hora de WhatsApp (`timestamp`). Si el reloj del remitente no coincide con el del servidor, la respuesta podría quedar antes que la pregunta. Lo detectaron los tests. El `timestamp` de WhatsApp se usa para interpretar "mañana" en hora de Colombia.

### Idempotencia: un mensaje se procesa una sola vez

1. **Ingesta:** inserta el mensaje en MongoDB con `_id = message_id` (único por definición). Si ya existe, responde 200 y no encola.
2. **SQS FIFO:** `MessageDeduplicationId = message_id` es una segunda barrera, con ventana de 5 minutos.
3. **Worker:** antes de procesar verifica el estado del mensaje (`recibido` → `procesando` → `respondido`) con un update condicional. Así, si SQS reentrega el mensaje, el turno no se repite.

La ventana de deduplicación de SQS no basta sola: un reintento de Meta horas después pasaría. Por eso la garantía final es el índice `UNIQUE` en la base.

### Orden por paciente

`MessageGroupId = teléfono`: los mensajes de una misma conversación se procesan en serie y en orden. Las conversaciones distintas se procesan en paralelo.

### Citas sin duplicados

- **El código valida los argumentos** que propone el modelo antes de ejecutar `agendar_cita`: que la fecha no sea pasada, que existan la sede, la especialidad y el profesional, y que el horario esté dentro de la agenda. Si algo falla, el error vuelve al LLM para que corrija o pregunte.
- **La base es la última barrera:** la cita se inserta en una transacción protegida por la restricción `EXCLUDE` descrita arriba. Si dos pacientes piden el mismo horario a la vez, uno gana y el otro recibe "horario ocupado" con alternativas.

### Consistencia entre PostgreSQL y MongoDB

- **Postgres es la fuente de verdad** para las citas. La cita se confirma solo cuando la transacción hace commit.
- En la misma transacción se escribe un registro en una tabla **outbox**. Un proceso aparte lo lee y actualiza MongoDB (traza y estado de la conversación, por ejemplo `cita_agendada`), con reintentos idempotentes.
- Si MongoDB falla, la cita no se pierde y la traza se completa cuando el outbox se procese. Lo que nunca puede pasar es que MongoDB diga `cita_agendada` sin una cita en Postgres.

---

## Pipeline de IA

### Tools del LLM, ejecutadas y validadas por el código

Las herramientas se declaran al modelo como **function tools** de la Responses API de OpenAI, con JSON Schema en **modo `strict`**. **El modelo decide** cuándo llamar a cada una y con qué argumentos. **OpenAI no las ejecuta**: devuelve un `function_call` y nuestro código lo valida, lo ejecuta y le devuelve el resultado o el error (`function_call_output`).

| Tool | Qué hace | Qué valida el código |
|---|---|---|
| `consultar_disponibilidad(especialidad, sede, fecha, franja)` | Horarios libres reales del día. Sin cupos, sugiere las próximas fechas con disponibilidad. | Que la especialidad y la sede existan (si no, devuelve las opciones), la fecha (pasada, festivo, fuera del horizonte de 14 días) y la franja. |
| `agendar_cita(especialidad, sede, profesional, fecha, hora, nombre_paciente, datos_adicionales)` | Crea la cita. | Lo anterior, más: que el profesional preste el servicio, que la hora exista en su agenda (bloque, sede, alineada a la duración, anticipación mínima) y los datos obligatorios de la clínica. La ocupación la decide el `EXCLUDE` de Postgres. Si el horario está ocupado, devuelve alternativas reales del mismo día. |
| `buscar_conocimiento(pregunta)` | Búsqueda semántica (RAG) en los documentos de la clínica. | La clínica sale del contexto del mensaje, no de los argumentos: el modelo no puede consultar documentos de otra clínica. |
| `escalar_a_humano(motivo)` | Marca la conversación `escalada`. | Que haya un motivo. |

- **Los errores son datos, no excepciones:** vuelven al modelo con un código (`horario_ocupado`, `especialidad_inexistente`, `datos_faltantes`…) y, cuando aplica, las opciones válidas, para que corrija o le pregunte al paciente. Las fallas de infraestructura (por ejemplo una base caída) sí se propagan: el turno falla y el worker lo reintenta.
- **Los esquemas se arman por clínica:** si una clínica no tiene sedes, el modelo no ve el parámetro `sede`. Los campos de `datos_adicionales` salen de `booking_fields` (en la clínica de prueba: documento obligatorio y EPS opcional).
- **Trade-off:** `especialidad` y `profesional` no usan `enum`. Aceptan id o nombre ("Dermatología", "el Dr. Felipe") y el código los resuelve sin depender de mayúsculas ni tildes. Con `enum` el modelo no podría equivocarse, pero perderíamos la validación explícita que pide el enunciado y la posibilidad de devolverle opciones cuando el paciente pide algo que no existe.
- **Las tools solo usan la interfaz `AgendaProvider`.** Hoy la implementa la agenda local (Mongo + Postgres); en producción podría ser un adaptador hacia el sistema de cada clínica.

### RAG: documentos, fragmentos, embeddings y base vectorial

- **Fuente de verdad:** los documentos viven en MongoDB (`knowledge_documents`), con el resto del catálogo flexible de cada clínica. **El índice vectorial vive en PostgreSQL con pgvector** (`document_chunks`): es derivado y se reconstruye con `npm run index`.
- **Por qué pgvector:** ya tenemos Postgres, el corpus es chico (decenas de fragmentos por clínica) y el filtro por `clinic_id` es una cláusula `WHERE`. Descarté Atlas Vector Search porque DocumentDB, nuestro Mongo en AWS, no lo tiene. Qdrant u OpenSearch serían otra pieza que operar, sin necesidad a este volumen.
- **Chunking por sección (`##`)**, con el título del documento y de la sección dentro de cada fragmento ("Preparación para exámenes — Ayuno"). Los documentos de una clínica son cortos y están organizados por tema, así que partir por tamaño fijo cortaría listas y horarios a la mitad. Las secciones largas (más de 900 caracteres) se parten por párrafos, repitiendo un párrafo entre fragmentos.
- **Embeddings:** `text-embedding-3-small` (1536 dimensiones, USD 0,02/M de tokens). Indexar los 8 documentos cuesta menos de un centavo.
- **Indexado incremental:** cada fragmento guarda un hash de su contenido y el modelo que lo vectorizó. Si un documento no cambió, no se vuelve a pagar el embedding. Los documentos borrados salen del índice.
- **Búsqueda:** similitud coseno, top 4, siempre filtrada por clínica. Con `hnsw.iterative_scan = strict_order` (pgvector 0.8), si Postgres usa el índice HNSW sigue buscando hasta completar los resultados de esa clínica. Sin esto, una clínica con pocos documentos podría quedarse sin resultados en una tabla con muchas clínicas.

**El umbral de similitud no evita que el modelo invente.** Calibré con 10 preguntas que sí están en los documentos y 8 que no. La relevante con menor puntaje sacó 0,364, y una que no está ("¿cuánto cuesta la consulta?") sacó 0,546 porque se parece al tema "consulta". Los rangos se cruzan, así que ningún umbral los separa. Por eso:
- El umbral (`RAG_MIN_SIMILARITY = 0.30`) solo descarta ruido evidente. Si nada lo supera, la tool responde `sin_informacion` con la indicación de no completar con conocimiento general.
- **La protección real está en el modelo:** recibe los fragmentos con su fuente y la instrucción de responder solo con lo que dicen y de decirlo si no responden la pregunta. Lo verifiqué con el modelo real: no inventó precio, cardiología ni cirugía estética, y respondió bien ayuno, parqueadero y horarios.
- **En producción** agregaría un set de evaluación (preguntas con respuesta esperada o "no está") que corra en cada cambio de prompt, modelo o documentos. Y una verificación posterior de que cada afirmación de la respuesta esté respaldada por algún fragmento.

### Alcance del asistente y guardrails

Una prueba manual encontró que el asistente **escribía código y respondía cultura general** ("crea un script en Python", "¿cuál es la capital de Francia?"). El prompt le prohibía inventar datos de la clínica, pero no limitaba su función. Lo corregí en capas, porque un prompt solo se puede saltar:

1. **Alcance en el prompt, con prioridad sobre el usuario:** solo la clínica y sus citas. Rechaza código, cultura general, tareas, opiniones y pedidos de cambiar de rol o revelar instrucciones. Sin usar una herramienta solo puede saludar, pedir aclaración, pedir datos para agendar, rechazar o derivar una urgencia.
2. **Guardrail determinista de salida:** si la respuesta del modelo trae código (bloques ``` o código en línea), se reemplaza por el mensaje de fuera de alcance antes de enviarla. Queda registrado en la traza del turno (`guardrail`) y es visible en el panel del coordinador.
3. **Set de evaluación** (`npm run eval`, en `backend/eval/cases.ts`): 10 casos contra el modelo real. Cubren alcance (código, cultura general), inyección de instrucciones, RAG (respuesta en documentos, precio que no debe inventar, servicio inexistente), "mañana" del enunciado, agendamiento completo, medicamentos y urgencias. **Antes del cambio fallaban los casos de código y cultura general; después pasan los 10** (costo de la corrida: unos USD 0,002). Se corre cada vez que cambia el prompt, el modelo o los documentos.

### La base de conocimiento es la única fuente de información

**Decisión:** todo lo que el asistente *informa* sobre la clínica sale solo de los documentos de la base de conocimiento: su nombre, servicios y especialidades, sedes, direcciones, horarios de atención, precios y políticas. La **agenda** (profesionales, horarios y citas) sigue siendo la fuente de disponibilidad y la que garantiza que no haya citas duplicadas, como exige el enunciado, pero no se usa para informar.

- **El prompt no tiene datos de la clínica:** ni el nombre ni listas de servicios o sedes. De la configuración solo usa la zona horaria y los datos que la clínica pide para agendar (documento, EPS). Tiene además una sección "fuente única" que le prohíbe usar los resultados de las herramientas de agenda para informar.
- **Las tools tampoco los exponen:** sus descripciones no listan servicios ni sedes (aceptan lo que diga el paciente y, si no existe, devuelven las opciones para corregir). La confirmación de una cita ya no trae la dirección ni la política de cancelación.
- **Sin base de conocimiento no se llama al LLM y se escala a un asesor.** Antes de invocar el modelo, `KnowledgeGateEngine` revisa si la clínica tiene fragmentos indexados. Si no tiene, responde un mensaje fijo ("en este momento no tengo información… ya la pasé a un asesor"): sin costo, en milisegundos y sin riesgo de que el modelo improvise. La conversación queda **`escalada`** (motivo `sin_base_de_conocimiento`), así que aparece en ese filtro de la bandeja, y los mensajes siguientes quedan pendientes del asesor hasta que la devuelva a la IA. La traza queda como `engine: sin_llm`.
- **Verificado:** con la base vacía, la respuesta por defecto sale con 0 tokens. Con documentos subidos, "¿cómo se llama la clínica?" y "¿dónde queda la sede norte?" se responden con `buscar_conocimiento`, y el set de evaluación pasa 10/10.

### Agenda dinámica, generada desde la base de conocimiento

Una prueba mostró al asistente ofreciendo un profesional que no estaba en el documento del cliente: salía de la agenda de prueba del seed. Había dos fuentes con datos distintos. **Decisión:** la agenda (sedes, servicios con duración y profesionales con sus horarios) **se genera desde los documentos** cada vez que cambian (subir, reemplazar, borrar, reindexar) o con el botón "Regenerar". Se ve en **Configuración → Agenda**.

- **Extracción con LLM, una vez por cambio de documento** (no por mensaje), con salida JSON en modo estricto (`agenda/extraction/agendaExtractor.ts`). Los documentos describen la agenda en texto libre ("Norte: lunes a viernes · Sur: martes", tablas aplanadas, "rota según agenda") y un parser de reglas no sería confiable. Cuesta del orden de USD 0,002 por documento y tarda unos 25 s, en segundo plano.
- **El código decide qué entra** (`agenda/extraction/buildAgenda.ts`, sin LLM y con tests):
  - Cada sede, servicio y profesional **debe aparecer escrito en el documento**. Lo que no, se descarta. Así un nombre inventado nunca llega a la agenda.
  - Días, horas y duraciones válidos. Los servicios de un profesional deben existir, y también sus sedes.
  - **Si el documento no da la hora** de un profesional ("Norte: lunes a viernes"), se usa el horario de la sede ese día y queda una advertencia.
  - La **teleconsulta** es una sede virtual con sus propios horarios. Si el modelo la propone como servicio, se descarta.
  - Lo ambiguo ("rota según agenda") no se convierte en horarios: queda anotado para revisión.
- **Si falla la generación**, se conserva la agenda anterior. **Si los documentos no describen una agenda**, el asistente no carga las herramientas de agendamiento: responde con la base de conocimiento y escala. Así el sistema no depende de citas.
- **Trade-off:** la extracción con LLM no es determinista; dos generaciones del mismo documento pueden diferir en detalles. Por eso se regenera solo cuando cambian los documentos, se muestra para revisión (con descartes, ajustes y ambigüedades) y las reglas que importan están en código. Con más tiempo agregaría una aprobación manual antes de publicar una agenda nueva.
- **Verificado con el documento real del cliente:** 2 sedes con dirección, la sede virtual con los horarios de teleconsulta del documento, 7 servicios con duración y 7 profesionales. Antes, ante el mismo pedido ("medicina general, sede sur, miércoles en la tarde"), ofrecía al "Dr. Andrés Rojas" de la agenda de prueba; ahora ofrece a la Dra. Valentina Rojas, como dice el documento.
- **Precisión relacionada:** `consultar_disponibilidad` ahora informa el primer y el último horario disponible y avisa cuando la lista está recortada. Antes el modelo presentó "de 12:00 a 15:40" como si fuera todo el rango.

### API key del modelo configurable desde el panel

- **Por clínica:** cada cliente puede usar su propia key de OpenAI (Configuración → Modelo de IA). Si no configuró una, se usa la `OPENAI_API_KEY` del `.env`.
- **Se valida antes de guardar:** se le pide a OpenAI el modelo configurado, lo que comprueba la key y el acceso al modelo. Si falla, no se guarda y el panel explica por qué (inválida o revocada, sin acceso al modelo, OpenAI no responde).
- **Cifrada en reposo:** AES-256-GCM con una clave maestra (`SETTINGS_ENCRYPTION_KEY`) que solo vive en el entorno del servidor, nunca en la base. La API solo devuelve la key enmascarada (`sk-proj-…abcd`) y los errores de esas rutas no se registran con detalle, porque podrían incluirla. En AWS, la clave maestra sería KMS (cifrado por sobre) o la key iría directo a Secrets Manager.
- **Sin reinicios:** el worker y los embeddings resuelven la key por clínica en cada uso, con un caché de 30 s. Un cambio en el panel aplica en segundos, y el worker ya no necesita una key para arrancar.
- **Sin key no se llama al LLM:** igual que sin base de conocimiento, el paciente recibe el mensaje por defecto y la conversación se escala (motivo `sin_api_key`).

### Administración de la base de conocimiento

- El coordinador **sube documentos Word (.docx), PDF, Markdown o texto** desde el panel (pantalla "Base de conocimiento"), por multipart y hasta 10 MB. También puede pegar texto. Un documento con el mismo nombre reemplaza al anterior.
- **Extracción:** de Word con `mammoth` y `turndown` (los estilos "Título 1/2" pasan a `#`/`##`, así que el chunking parte por las secciones del documento). De PDF con `unpdf` (pdf.js), que rechaza con un mensaje claro los PDF escaneados sin texto, dañados o con contraseña. Se guarda el texto extraído, no el archivo original (en producción el original iría a S3). Si no hay encabezado, el título es la primera línea del texto.
- **Tablas: una línea por fila, con cada valor junto a su columna** (`knowledge/tables.ts`). Al convertir Word a texto, las tablas quedaban celda por celda ("Profesional / Especialidad / Dr. Carlos Mejía / Medicina general…") y el modelo tenía que adivinar qué valor iba con qué columna: ahí se cruzaban nombres, sedes y precios. Ahora cada fila es autocontenida, por ejemplo `Profesional: Dr. Carlos Mejía | Especialidad: Medicina general | Sede y días: Norte: lunes a viernes`. Hay tres formas de tabla: normal (encabezados arriba), transpuesta (la primera celda del encabezado vacía: `Dirección — Sede Norte: … | Sede Sur: …`) y clave-valor de 2 columnas (`Nombre: Clínica…`). Se aplica a Word, a tablas Markdown (`| a | b |`) y a PDF. En el PDF las filas y columnas se reconstruyen desde la posición de cada texto: misma altura forma una fila, y un hueco horizontal grande marca un cambio de columna. Como los fragmentos se parten por líneas, una fila nunca queda cortada. También mejora la extracción de la agenda, que lee el mismo texto.
- **Secciones con su ruta completa:** los títulos de todos los niveles abren sección y cada fragmento lleva la ruta ("1. Datos de la clínica › 1.2 Profesionales"). Las líneas enteras en negrita (preguntas frecuentes, objeciones) abren una subsección propia, así que cada pregunta con su respuesta es un fragmento rotulado con la pregunta. Antes los títulos de primer nivel se descartaban y, en el documento real del cliente, Preguntas frecuentes, Urgencias y Políticas quedaban rotuladas como "6.9 Cierre".
- **Chunking robusto para PDF:** el texto extraído de un PDF suele venir en bloques largos sin líneas en blanco. Esos bloques se parten por líneas, luego por oraciones y, como último recurso, por tamaño. Un test encontró que repetir el párrafo de solapamiento podía pasar el máximo; ahora se omite si no cabe.
- **Se indexa en el momento** (chunking, embeddings y pgvector) y la API responde con la cantidad de fragmentos. Primero se generan los embeddings y después se escribe en Mongo: si falla (por ejemplo, sin API key, 503), no se guarda nada. Así nunca queda un documento visible en el panel pero invisible para el asistente.
- **Estado "indexado o pendiente" por huella del contenido**, no por fecha: un documento está al día si sus fragmentos indexados coinciden con su contenido actual y con el modelo de embeddings configurado.
- **Búsqueda de prueba:** muestra los fragmentos que recibiría el asistente para una pregunta, con su similitud y si superan el umbral. Sirve para depurar el RAG sin abrir una conversación.
- **Verificado de punta a punta:** con un documento de tarifas subido desde el panel, el asistente respondió el precio exacto. Al borrarlo, volvió a responder "lo informa recepción", sin reiniciar nada.
- **Trade-off:** la indexación es síncrona (unos segundos por documento). Para documentos grandes o carga masiva la haría asíncrona con la misma cola. No hay OCR: un PDF escaneado se rechaza (en AWS se podría agregar Textract). Tampoco se soporta `.doc` de Word 97-2003.

### Fechas y zona horaria

El código interpreta "mañana", no el LLM. Las tools aceptan `'hoy'`, `'manana'`, `'pasado_manana'` o `YYYY-MM-DD`. Las relativas se resuelven contra la **hora del mensaje** en la zona horaria de la clínica (`America/Bogota`). El caso del enunciado (03:40 UTC del 6 de octubre = 10:40 p. m. del 5 en Cali → "mañana" es el 6) está cubierto por tests y se verificó con el modelo real. Para fechas como "el jueves", el prompt incluye la fecha y hora local actual.

### Control del ciclo de tool calling

- **Límite de iteraciones** (`ASSISTANT_MAX_TOOL_ITERATIONS`, 6 por defecto): si se agota, el paciente recibe un mensaje y la conversación queda `escalada`. Corta los ciclos sin fin y acota el costo.
- **Una tool a la vez** (`parallel_tool_calls: false`): agendar depende de lo que devolvió consultar.
- **`store: false`:** OpenAI no guarda las respuestas, porque son datos de salud. El razonamiento cifrado (`reasoning.encrypted_content`) se reenvía entre rondas para no perder el contexto.
- **Timeout por turno** (`ENGINE_TIMEOUT_MS`) y reintentos en la cola (fase 3). Los reintentos del SDK quedan en 1.
- **Traza por turno** en Mongo: modelo, tokens de entrada (incluidos los del caché) y de salida, iteraciones, latencia, y cada tool con sus argumentos, resultado o error.
- **El motor está detrás de la interfaz `AssistantEngine`** y el SDK detrás de `ResponsesClient`: los tests usan un cliente falso con respuestas guionadas, sin red ni API key.

### Por qué no LangChain ni Agents SDK

El ciclo son unas 100 líneas: llamar al modelo, ejecutar las tools, devolver los resultados y repetir hasta tener texto o agotar las iteraciones. Escribirlo directo con el SDK oficial deja explícito lo que el enunciado evalúa (validación, límite de iteraciones, manejo de errores, trazas) y evita una dependencia que oculta ese control.

### Descartados

- **Servidor MCP remoto:** OpenAI llamaría a nuestras tools por una URL pública. No funciona en local y se pierde el control del ciclo y de las trazas.
- **`file_search` hospedado** para el RAG: los documentos quedarían en OpenAI y no controlaríamos los chunks.

---

## API del coordinador

- **Bandeja** (`GET /conversations`) con filtro por estado o teléfono. Usa **paginación por cursor** sobre `(last_message_at, _id)` en lugar de `skip`: es estable aunque lleguen mensajes nuevos mientras el coordinador pagina, y siempre usa el índice `{clinic_id, status, last_message_at, _id}`. El `_id` desempata conversaciones con la misma fecha.
- **Detalle** (`GET /conversations/:id`): cada respuesta del asistente trae los turnos que la produjeron (incluidos los intentos fallidos), con las tools que usó, sus argumentos y resultados, tokens y **costo en USD**. El costo se calcula al registrar el turno con el precio vigente del modelo y se guarda, así que si OpenAI cambia los precios las trazas conservan lo que costó en su momento. Los totales se acumulan en la conversación (`$inc`) para que la bandeja muestre el costo sin recorrer las trazas.
- **`assistant_pending`:** indica si hay un mensaje del paciente sin responder (recibido, encolado o procesando). Lo usa el frontend para mostrar "el asistente está respondiendo".
- **Devolver a la IA** (`POST /conversations/:id/release`): una conversación escalada vuelve a `en_curso`. Los mensajes que quedaron `pendiente_humano` no se reprocesan, porque se asume que el asesor ya los atendió. El siguiente mensaje del paciente lo responde la IA.
- **Clínica del coordinador:** en local viene del header `X-Clinic-Id`. En producción vendría del token de Cognito (un claim con la clínica), nunca de un parámetro que el cliente pueda cambiar. Todas las consultas filtran por clínica: una conversación de otra clínica responde 404, no 403, para no revelar que existe.
- **Sin autenticación en la versión local.** Es una simplificación consciente para la prueba; en AWS esas rutas irían detrás de Cognito (ver la sección de Nube).

---

## Frontend

- **Diseño del detalle** (inspirado en las referencias de UI del proyecto): la bandeja queda a la izquierda y el detalle a la derecha. El detalle tiene la transcripción en el centro, con métricas bajo cada respuesta (tiempo del LLM, de cada herramienta, tokens y costo), y un panel con tres pestañas: **Resumen**, **Paciente** y **Técnico**. Se navega entre conversaciones con ↑↓ o J/K.
- **Resumen sin LLM:** lo arma el backend con reglas (`messaging/conversationSummary.ts`) a partir de las trazas que ya se guardan. El primer mensaje del paciente da el motivo; cada herramienta usada aporta una acción ("consultó disponibilidad de dermatología para el martes 6: 8 horarios", "agendó con el Dr. Felipe a las 16:00"); y el estado da el resultado. Es determinista, instantáneo y no cuesta tokens. Un resumen con LLM sería más natural, pero costaría una llamada por conversación y podría equivocarse sobre lo que pasó; las trazas, en cambio, son la fuente exacta.

- **React + Vite + TypeScript**, sin librería de componentes. **TanStack Query** maneja caché, carga, error y reintentos: reintenta solo errores de red o 5xx, nunca un 400 o un 404.
- **"El asistente está respondiendo"** sale de `assistant_pending` del detalle. Mientras es `true`, el detalle se consulta cada 1,5 s; si no, cada 5 s. Descarté WebSocket o SSE: para un coordinador alcanza el polling, y evita otra pieza en la infraestructura (en AWS sería API Gateway WebSocket). Sería la mejora natural con más tiempo.
- **Simulador:** es un chat que envía cada mensaje a `POST /webhooks/messages` con un `message_id` único y la hora del sistema, como lo haría WhatsApp. Permite reenviar el mismo `message_id` para ver la idempotencia (responde 200 `duplicate`). El caso de "mañana" a las 10:40 p. m. del enunciado se reproduce con los tests y con `npm run chat -- --at 2026-10-06T03:40:00Z`. El mensaje se muestra de inmediato (actualización optimista) y, si el envío falla, el texto vuelve a la caja.
- **Las fechas se muestran en hora de la clínica**, no en la del navegador del coordinador.
- **Verificado en un navegador real** (Chromium headless con puppeteer): bandeja, filtros, detalle con tools, simulador, duplicado y consola sin errores. Esas pruebas encontraron problemas que no aparecían en los tests: el scroll automático escondía el encabezado del detalle, el mensaje del paciente no aparecía mientras se enviaba y faltaba el favicon (un 404 en la consola).

---

## Nube (AWS)

### Escenario de diseño

- **50 clínicas** y **20.000 mensajes/día**, es decir unos **600.000 mensajes/mes**.
- Promedio de **0,23 mensajes/s**. Supongo picos de 10× (unos 2–3 mensajes/s) en horario laboral de Colombia (UTC-5).
- Es una carga baja y con picos. Por eso elegí servicios serverless y gestionados: no hace falta administrar servidores para este volumen.

Diagrama: `ar IA chat.excalidraw` (exportado como `arqutectura.jpeg`).

### Flujo de un mensaje

1. **WhatsApp → API Gateway (REST) + WAF → Lambda de ingesta.** La Lambda valida la firma HMAC y el payload, registra el `message_id` con índice `UNIQUE` (si ya existe, responde 200 y no hace nada más), encola en **SQS FIFO** y responde **200 en menos de 300 ms**.
2. **SQS FIFO → Lambda worker.** Usa `MessageGroupId = teléfono`, así que cada conversación procesa un turno a la vez y en orden. `MessageDeduplicationId = message_id` es una segunda barrera contra duplicados.
3. **Worker:** arma el contexto (historial en MongoDB, chunks de RAG en pgvector) y corre el ciclo de tool calling con OpenAI, con un límite de iteraciones. Ejecuta las herramientas contra Postgres (disponibilidad y citas en transacción con `UNIQUE`), guarda la traza del turno y envía la respuesta por la WhatsApp Cloud API.
4. **Si algo falla:** SQS reintenta. Después de 3 intentos el mensaje va a la **DLQ**, se dispara una alarma, el paciente recibe un mensaje de respaldo y la conversación queda `escalada`.
5. **Coordinador:** usa la bandeja (Amplify, S3 y CloudFront), se autentica con Cognito y consulta `/api/*` por polling.

### Servicios elegidos y por qué

| Capa | Servicio | Por qué |
|---|---|---|
| Entrada | API Gateway REST + AWS WAF | WAF (rate limiting, reglas gestionadas) se integra directo con REST API, no con HTTP API. Throttling por ruta. |
| Cómputo | AWS Lambda (ingesta, worker, ingesta de documentos) | Con 0,23 mensajes/s un servidor encendido 24/7 estaría casi siempre ocioso. Lambda escala sola y cobra por uso. |
| Cola | SQS FIFO + DLQ | Orden por conversación y deduplicación nativa. El límite de FIFO (300 operaciones/s por API, más con batching o modo high-throughput) está muy por encima del pico. |
| Datos transaccionales | RDS PostgreSQL (Single-AZ; Multi-AZ opcional) + **pgvector** + RDS Proxy | Agenda y citas necesitan transacciones y restricciones. pgvector evita operar una base vectorial aparte para un corpus pequeño. RDS Proxy evita agotar conexiones cuando Lambda escala. |
| Conversaciones y trazas | Amazon DocumentDB (compatible con MongoDB), 1 instancia; réplica opcional | Esquema flexible y escritura append-heavy: mensajes, tool calls, tokens y latencias. |
| Archivos | S3 | Documentos fuente de cada clínica (prefijo por `clinic_id`) y logs exportados. |
| Frontend | Amplify, S3, CloudFront y Route 53 | Hosting estático barato con CDN. |
| Identidad | Cognito | Login de coordinadores con JWT validado en API Gateway. El webhook no usa Cognito sino la firma HMAC de Meta. |
| Secretos | Secrets Manager | API key de OpenAI, token de Meta y credenciales de las bases. Las Lambdas los cachean en memoria. |
| Red | VPC con subredes privadas, 1 NAT Gateway y VPC endpoint de S3 | Las bases no quedan expuestas. La salida a OpenAI y WhatsApp pasa por NAT. |
| Escalamiento | SNS / EventBridge | `escalar_a_humano` publica un evento que notifica al coordinador de la clínica. |
| Observabilidad | CloudWatch (logs, métricas, alarmas) + X-Ray | Alarmas sobre la profundidad de la DLQ, la tasa de error del LLM, la latencia p95 del turno y los tokens por clínica. |

### Cómo escala

- **Ingesta y worker:** Lambda escala por concurrencia. Con unos 5 s por turno y 3 mensajes/s de pico, se necesitan **unas 15 ejecuciones concurrentes**. Configuro **reserved concurrency** en el worker para proteger RDS y no superar el rate limit de OpenAI.
- **Cola:** SQS absorbe los picos. Si OpenAI se pone lento, los mensajes esperan en la cola y no se pierden.
- **Postgres:** el cuello de botella sería la cantidad de conexiones, no las consultas. RDS Proxy resuelve eso, y se puede subir de instancia o agregar una read replica para la bandeja.
- **DocumentDB:** se agregan réplicas de lectura si la bandeja y la trazabilidad lo necesitan.
- **Volumen ×10 (200.000 mensajes/día):** el diseño aguanta igual. Lo primero que reconsideraría es mover el worker a ECS Fargate, porque Lambda cobra el tiempo que pasa esperando al LLM.

### Qué pasa si se cae una pieza

| Falla | Comportamiento |
|---|---|
| OpenAI lento o caído | Timeout de unos 20 s por llamada y 2 reintentos con backoff. Si persiste, se envía un mensaje de respaldo, el estado queda `escalada` y se notifica al coordinador. El visibility timeout de SQS es mayor que el tiempo máximo del turno para no duplicar procesamiento. |
| Error en el worker | SQS reintenta. El turno es idempotente (estado por `message_id`, cita con `UNIQUE`). Tras 3 intentos va a la DLQ y se dispara una alarma. |
| Falla de la instancia de RDS | **1 AZ:** AWS recupera o reemplaza la instancia en minutos. RDS Proxy reconecta. Los mensajes esperan en SQS. **2 AZ (opcional):** failover automático en unos 60–120 s. |
| Falla de la instancia de DocumentDB | **1 AZ:** AWS reemplaza la instancia en minutos. Las trazas pendientes se reescriben desde el outbox. **2 AZ (opcional):** se promueve la réplica en unos 30 s. |
| Caída de la zona (AZ) completa | **1 AZ:** el worker y las bases quedan detenidos. API Gateway y SQS son regionales, así que **los mensajes se siguen recibiendo y quedan en la cola** (retención configurada a 4 días). Se procesan cuando la zona vuelve, o al restaurar en otra AZ desde backup point-in-time (pérdida de datos de unos 5 min como máximo; recuperación en unos 30–60 min). **2 AZ (opcional):** el servicio sigue operando. |
| Falla al enviar a WhatsApp | Reintento con backoff. Si no se puede entregar, queda marcado en la traza y visible en la bandeja. |
| Tráfico abusivo al webhook | WAF limita por IP y API Gateway hace throttling. Los mensajes sin firma válida se descartan antes de encolar. |

### Disponibilidad: 1 AZ por defecto, 2 AZ opcional

**Supuesto:** el enunciado no exige alta disponibilidad (pide "qué pasa si se cae una pieza", no un nivel de disponibilidad). Por eso el diseño base usa **una sola zona de disponibilidad** para las piezas con costo fijo (RDS, DocumentDB y NAT) y deja **Multi-AZ como opción** si el negocio lo pide.

- **Con 1 AZ igual se resiste bastante:** las fallas de instancia se recuperan en minutos, y API Gateway, SQS, S3 y Lambda son regionales. Ante una caída de la zona, los mensajes no se pierden: esperan en SQS. Lo que se pierde es la **inmediatez**, porque los pacientes reciben la respuesta tarde.
- **Detalle técnico:** aunque las instancias vivan en una sola AZ, los *subnet groups* de RDS y DocumentDB exigen subredes en al menos 2 AZ. Las subredes de la segunda zona ya quedan creadas, así que pasar a Multi-AZ es un cambio de configuración, no un rediseño.
- **Cuándo activar 2 AZ:** si se acuerda un SLA con las clínicas, si el volumen crece o si una respuesta tardía empieza a costar citas. Cuesta unos **+USD 140/mes** (ver la tabla de costos).

### Multi-tenant (50 clínicas)

Modelo **pool** (infraestructura compartida) con aislamiento lógico:

- **Identificación del tenant:** el número de WhatsApp de destino (`phone_number_id`) determina la `clinic_id` en la ingesta. El tenant nunca se toma de lo que diga el LLM.
- **Postgres:** `clinic_id` en todas las tablas y **Row-Level Security** con `SET app.clinic_id` por transacción. Los índices empiezan por `clinic_id`.
- **MongoDB:** `clinic_id` como primer campo de los índices compuestos (por ejemplo `{clinic_id, estado, updated_at}` para la bandeja).
- **RAG:** la búsqueda vectorial siempre filtra por `clinic_id`. Una clínica nunca recibe chunks de otra.
- **S3:** prefijo por clínica (`s3://docs/{clinic_id}/…`).
- **Cuotas:** límite de tokens y mensajes por clínica para que una no consuma el presupuesto de las demás.
- **Evolución:** un cliente grande o con requisitos regulatorios podría pasar a modelo **silo** (base dedicada) sin cambiar el código, solo la configuración de conexión por tenant.

### Alternativas descartadas

| Alternativa | Por qué no (por ahora) |
|---|---|
| ECS Fargate para el worker | Más barato con carga alta y constante, porque Lambda cobra la espera al LLM. Con 20.000 mensajes/día Lambda es más simple y cuesta parecido. Lo reevaluaría por encima de unos 200.000 mensajes/día. |
| SQS estándar | No garantiza orden por conversación. Dos mensajes seguidos del mismo paciente podrían procesarse en paralelo y dejar el historial inconsistente. |
| Kinesis / MSK | Sobredimensionado para este volumen y más costoso de operar. |
| Step Functions para el ciclo de tool calling | Agrega costo y latencia por transición. El ciclo con límite de iteraciones es más claro en código y fácil de probar con un LLM falso. |
| OpenSearch para vectores | Costo base alto para un corpus de decenas de documentos por clínica. pgvector alcanza y evita una pieza más. |
| Aurora Serverless v2 | Opción válida, sobre todo por la escala automática. Elegí RDS clásico por tener un costo predecible a este volumen. |
| MongoDB Atlas (en AWS) | Compatibilidad total con MongoDB y Atlas Vector Search. Lo descarté por consolidar facturación y red dentro de AWS. **Trade-off:** DocumentDB no es 100 % compatible con MongoDB, así que hay que probar los drivers y las consultas. |
| API Gateway WebSocket | Mejor experiencia para mostrar "el asistente está respondiendo". El polling cada pocos segundos es más simple para un MVP y suficiente para coordinadores. |
| Amazon Bedrock en lugar de OpenAI | Mantendría el tráfico del LLM dentro de AWS (VPC endpoint, sin NAT). Es una buena evolución. Para la prueba usé OpenAI y dejé el proveedor detrás de una interfaz. |

### Costo mensual estimado

> **Supuestos:** región `us-east-1`, precios on-demand de lista **de referencia**, sin free tier ni Savings Plans. Son órdenes de magnitud para dimensionar. **Hay que validar con el [AWS Pricing Calculator](https://calculator.aws/) antes de presentar cifras definitivas.**

**Infraestructura AWS: diseño base con 1 AZ**

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
| Secrets Manager | 4 secretos + llamadas (cacheados) | 2 |
| Frontend (Amplify, S3, CloudFront, Route 53) | Bandeja de coordinadores, tráfico bajo | 5 |
| Cognito, SNS/EventBridge, S3 documentos | Pocos usuarios activos y eventos | 1–3 |
| **Total infraestructura (1 AZ)** | | **≈ USD 255/mes** (rango 220–290) |

**Opcional: alta disponibilidad con 2 AZ**

| Cambio | USD/mes adicional aprox. |
|---|---|
| RDS PostgreSQL pasa a Multi-AZ (réplica en espera en la segunda AZ) | +50 |
| DocumentDB suma una réplica en la segunda AZ | +57 |
| Segundo NAT Gateway (uno por AZ) | +33 |
| **Total adicional** | **≈ +USD 140/mes** |
| **Total infraestructura (2 AZ)** | **≈ USD 395/mes** (rango 350–450) |

Incluso con 1 AZ, lo que más pesa son los **costos fijos**: bases, RDS Proxy, NAT y WAF suman unos USD 190, cerca del 75 %. El cómputo serverless es marginal.

**Cómo bajarlo más:**
- Reserved Instances o Savings Plans a 1 año para RDS y DocumentDB: 30–40 % menos en esas líneas.
- Usar Bedrock en lugar de OpenAI quita la mayor parte del tráfico por NAT.
- Para un entorno de desarrollo: quitar RDS Proxy y WAF, o usar una sola base Postgres con JSONB solo en ese entorno.

**LLM (medido con el modelo real)**

Modelo: **`gpt-6-luna`** (USD 0,10/M de entrada, USD 0,01/M de entrada en caché, USD 0,50/M de salida, según la página oficial de precios de OpenAI consultada el 2026-10-04). Embeddings: `text-embedding-3-small` (USD 0,02/M).

Medición real (fase 4): una conversación de 4 mensajes (consultar disponibilidad, elegir horario, confirmar y agendar, y una pregunta sin respuesta que terminó escalada) usó 15.185 tokens de entrada (**11.735 desde el caché, el 77 %**) y 604 de salida.

| | Por mensaje | 600.000 mensajes/mes |
|---|---|---|
| Medido (sin RAG) | ≈ USD 0,0002 | ≈ USD 115 |
| **Estimado conservador** (con chunks de RAG y conversaciones más largas, unas 2×) | ≈ USD 0,0004 | **≈ USD 250** |

El prompt caching pesa mucho: la parte estable (reglas, datos de la clínica y definiciones de las tools) va primero y la fecha y hora al final. Así el prefijo se repite idéntico entre llamadas y cuesta la décima parte.

**Cómo bajarlo más:** recortar el historial a los últimos N turnos con un resumen, limitar la cantidad de chunks de RAG, responder FAQs frecuentes sin tool calling y usar un modelo más grande solo cuando haga falta (por ejemplo, escalar a `gpt-6.1-sol` en conversaciones difíciles).

**Total estimado**

| Escenario | Infraestructura | LLM | Total/mes | Por clínica/mes |
|---|---|---|---|---|
| **Base (1 AZ)** | ≈ USD 255 | ≈ USD 250 | **≈ USD 505** | ≈ USD 10 |
| Alta disponibilidad (2 AZ, opcional) | ≈ USD 395 | ≈ USD 250 | ≈ USD 645 | ≈ USD 13 |

Con el modelo actual y el caché, el LLM dejó de ser el costo dominante (cerca del 50 % en el escenario base). La infraestructura fija (bases, NAT, WAF) pesa igual o más.
