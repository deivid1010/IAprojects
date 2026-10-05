import { z } from 'zod';

// Toda la configuración entra por variables de entorno y se valida al arrancar:
// si falta algo, el proceso falla de inmediato con un mensaje claro en vez de
// fallar más tarde en medio de una petición.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Orígenes del frontend, separados por coma.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),

  DATABASE_URL: z.string().url(),
  MONGO_URL: z.string().url(),
  MONGO_DB: z.string().min(1).default('clinic_assistant'),

  // Zona horaria de la operación: "mañana" y "esta tarde" se interpretan aquí.
  CLINIC_TIMEZONE: z.string().default('America/Bogota'),

  // Clínica a la que va un mensaje sin waba_id. En producción todo mensaje
  // trae el WhatsApp Business Account ID y esto no se usa.
  DEFAULT_CLINIC_ID: z.string().min(1),

  // Cola SQS. En local SQS_ENDPOINT apunta a ElasticMQ; en AWS se deja vacío.
  AWS_REGION: z.string().default('us-east-1'),
  SQS_ENDPOINT: z.string().url().optional(),
  INCOMING_QUEUE_NAME: z.string().default('incoming-messages.fifo'),

  // Worker: intentos antes de responder con el mensaje de respaldo y escalar.
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),

  // Motor del asistente: 'openai' (LLM real) o 'stub' (sin LLM, para probar el flujo).
  ASSISTANT_ENGINE: z.enum(['openai', 'stub']).default('openai'),
  ASSISTANT_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(10).default(6),
  // API key por defecto. La que se configura en el panel (por clínica) tiene prioridad.
  OPENAI_API_KEY: z.string().optional(),
  // Clave maestra (32 bytes en base64) para cifrar las API keys guardadas desde el panel.
  SETTINGS_ENCRYPTION_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-6-luna'),
  OPENAI_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('low'),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).default(1000),

  // RAG: embeddings y búsqueda semántica sobre pgvector.
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  RAG_TOP_K: z.coerce.number().int().min(1).max(10).default(4),
  RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),

  // Agenda dinámica: esfuerzo de razonamiento al extraerla de los documentos (una vez por cambio).
  AGENDA_EXTRACTION_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('medium'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  return parsed.data;
}
