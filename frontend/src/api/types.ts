// Tipos de las respuestas de la API (espejo de backend/src/http/routes).

export type ConversationStatus = 'en_curso' | 'resuelta_por_ia' | 'cita_agendada' | 'escalada';

export interface ConversationListItem {
  id: string;
  phone: string;
  status: ConversationStatus;
  escalation_reason: string | null;
  last_message_at: string;
  last_message_preview: string;
  created_at: string;
  turns: number;
  cost_usd: number;
}

export interface ConversationPage {
  items: ConversationListItem[];
  next_cursor: string | null;
}

export interface StatusSummary {
  counts: Record<ConversationStatus, number>;
  total: number;
}

export interface ToolCall {
  name: string;
  arguments: unknown;
  result: unknown;
  error: string | null;
  duration_ms: number;
}

export interface Turn {
  attempt: number;
  engine: string;
  model: string | null;
  latency_ms: number;
  iterations: number;
  tokens: { input: number; cached_input: number; output: number };
  cost_usd: number | null;
  final_status: ConversationStatus | null;
  error: string | null;
  guardrail: string | null;
  tool_calls: ToolCall[];
  created_at: string;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  timestamp: string;
  created_at: string;
  status: string;
  kind: 'respuesta' | 'respaldo' | null;
  reply_to: string | null;
  last_error: string | null;
  turns?: Turn[];
}

/** Resumen armado por el backend con reglas sobre las trazas (sin LLM). */
export interface ConversationSummary {
  text: string;
  actions: string[];
  reason: string | null;
  outcome: string;
  topics: string[];
  appointment: { especialidad: string; profesional: string; dia: string; hora: string; sede: string | null; paciente: string } | null;
}

export interface ConversationDetail {
  conversation: {
    id: string;
    clinic_id: string;
    phone: string;
    status: ConversationStatus;
    escalation_reason: string | null;
    created_at: string;
    last_message_at: string;
    released_at: string | null;
  };
  assistant_pending: boolean;
  summary: ConversationSummary;
  totals: {
    turns: number;
    tool_calls: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    messages: number;
    patient_messages: number;
    duration_ms: number;
    avg_latency_ms: number;
    models: string[];
  };
  messages: Message[];
}

export interface WebhookPayload {
  message_id: string;
  from: string;
  text: string;
  timestamp: string;
}

export interface WebhookResult {
  status: 'accepted' | 'requeued' | 'duplicate';
  message_id: string;
  conversation_id: string;
}

// --- Base de conocimiento ---------------------------------------------------

export interface KnowledgeDocumentSummary {
  slug: string;
  title: string;
  source_filename: string | null;
  source_format: 'markdown' | 'texto' | 'pdf' | 'word' | null;
  chars: number;
  updated_at: string | null;
  chunks: number;
  indexed_at: string | null;
  embedding_model: string | null;
  indexed: boolean;
}

export interface KnowledgeDocumentDetail extends KnowledgeDocumentSummary {
  content: string;
  fragments: { index: number; heading: string | null; content: string }[];
}

export interface UploadResult {
  document: KnowledgeDocumentSummary;
  created: boolean;
  reindexed: boolean;
}

export interface ReindexResult {
  documents: number;
  chunks: number;
  reindexed: number;
  unchanged: number;
  removed: number;
}

export interface KnowledgeSearchResult {
  query: string;
  min_similarity: number;
  top_k: number;
  results: { source: string; document_slug: string; content: string; similarity: number; used_by_assistant: boolean }[];
}

// --- Configuración del modelo de IA -------------------------------------------

export interface AiSettingsStatus {
  configured: boolean;
  source: 'panel' | 'env' | null;
  masked: string | null;
  updated_at: string | null;
  model: string;
  can_save: boolean;
}

export type AiKeyTest = { ok: true; source: 'panel' | 'env' | null } | { ok: false; reason: string; message: string; source: 'panel' | 'env' | null };

// --- Agenda generada desde la base de conocimiento ------------------------------

export interface AgendaMeta {
  status: 'generando' | 'lista' | 'sin_agenda' | 'sin_documentos' | 'error';
  started_at: string;
  finished_at: string | null;
  documents: string[];
  warnings: string[];
  discarded: string[];
  notes: string[];
  error: string | null;
}

export interface AgendaView {
  meta: AgendaMeta | null;
  locations: { id: string; name: string; address?: string }[];
  services: { id: string; name: string; duration_min: number }[];
  professionals: { id: string; name: string; services: string[]; schedules: { location: string; day: string; start: string; end: string }[] }[];
}
