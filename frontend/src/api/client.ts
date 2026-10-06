import type {
  AgendaCalendar,
  AgendaView,
  AiKeyTest,
  AiSettingsStatus,
  ConversationDetail,
  ConversationPage,
  ConversationStatus,
  KnowledgeDocumentDetail,
  KnowledgeDocumentSummary,
  KnowledgeSearchResult,
  PromptStatus,
  ReindexResult,
  StatusSummary,
  UploadResult,
  WebhookPayload,
  WebhookResult,
} from './types';

// Por defecto /api en el mismo origen (proxy de nginx o de Vite). Se puede apuntar a otra URL con VITE_API_URL.
const BASE_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
const CLINIC_ID = import.meta.env.VITE_CLINIC_ID as string | undefined;

/** Error de la API con lo que el usuario necesita saber: código HTTP, código de error y mensaje. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Errores que vale la pena reintentar (red caída, servidor o cola no disponibles). */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        // JSON solo si el cuerpo es texto; con FormData el navegador pone multipart y el boundary.
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...(CLINIC_ID ? { 'x-clinic-id': CLINIC_ID } : {}),
        ...init.headers,
      },
    });
  } catch {
    // El navegador no distingue una API caída de un bloqueo por CORS (posible solo
    // si VITE_API_URL apunta a otro dominio): se mencionan las dos causas.
    throw new ApiError(
      0,
      'network_error',
      `No se pudo conectar con la API (${BASE_URL}). Verifica que esté corriendo; si está en otro dominio, que permita el origen ${window.location.origin} en CORS_ORIGINS.`,
    );
  }

  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? 'http_error', body?.message ?? `Error ${res.status}`, body?.details ?? []);
  }
  return { status: res.status, body: body as T };
}

export const api = {
  listConversations: (params: { status?: ConversationStatus; cursor?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.cursor) q.set('cursor', params.cursor);
    q.set('limit', String(params.limit ?? 20));
    return request<ConversationPage>(`/conversations?${q}`).then((r) => r.body);
  },

  summary: () => request<StatusSummary>('/conversations/summary').then((r) => r.body),

  conversation: (id: string) => request<ConversationDetail>(`/conversations/${encodeURIComponent(id)}`).then((r) => r.body),

  release: (id: string) =>
    request<ConversationDetail>(`/conversations/${encodeURIComponent(id)}/release`, { method: 'POST' }).then((r) => r.body),

  knowledge: {
    list: () => request<{ items: KnowledgeDocumentSummary[] }>('/knowledge/documents').then((r) => r.body.items),
    get: (slug: string) => request<KnowledgeDocumentDetail>(`/knowledge/documents/${encodeURIComponent(slug)}`).then((r) => r.body),
    /** Archivo .md, .txt, .pdf o .docx: se envía tal cual (multipart) y el backend extrae el texto. */
    uploadFile: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return request<UploadResult>('/knowledge/documents', { method: 'POST', body: form }).then((r) => r.body);
    },
    uploadText: (input: { title: string; content: string }) =>
      request<UploadResult>('/knowledge/documents', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.body),
    remove: (slug: string) => request<null>(`/knowledge/documents/${encodeURIComponent(slug)}`, { method: 'DELETE' }).then(() => undefined),
    reindex: () => request<ReindexResult>('/knowledge/reindex', { method: 'POST' }).then((r) => r.body),
    search: (q: string) => request<KnowledgeSearchResult>(`/knowledge/search?q=${encodeURIComponent(q)}`).then((r) => r.body),
  },

  aiSettings: {
    get: () => request<AiSettingsStatus>('/settings/ai').then((r) => r.body),
    /** El backend valida la key contra OpenAI antes de guardarla (cifrada). */
    save: (apiKey: string) => request<AiSettingsStatus>('/settings/ai', { method: 'PUT', body: JSON.stringify({ api_key: apiKey }) }).then((r) => r.body),
    remove: () => request<AiSettingsStatus>('/settings/ai', { method: 'DELETE' }).then((r) => r.body),
    test: () => request<AiKeyTest>('/settings/ai/test', { method: 'POST' }).then((r) => r.body),
  },

  prompt: {
    get: () => request<PromptStatus>('/settings/prompt').then((r) => r.body),
    /** El backend rechaza (400) un prompt al que le falten variables obligatorias. */
    save: (template: string) => request<PromptStatus>('/settings/prompt', { method: 'PUT', body: JSON.stringify({ template }) }).then((r) => r.body),
    reset: () => request<PromptStatus>('/settings/prompt', { method: 'DELETE' }).then((r) => r.body),
  },

  agenda: {
    get: () => request<AgendaView>('/agenda').then((r) => r.body),
    regenerate: () => request<{ status: string }>('/agenda/regenerate', { method: 'POST' }).then((r) => r.body),
    calendar: (from: string, to: string) => request<AgendaCalendar>(`/agenda/calendar?from=${from}&to=${to}`).then((r) => r.body),
  },

  /** Simula un mensaje entrante de WhatsApp. Devuelve también el código HTTP (202 aceptado, 200 duplicado). */
  sendWebhook: (payload: WebhookPayload) =>
    request<WebhookResult>('/webhooks/messages', { method: 'POST', body: JSON.stringify(payload) }),
};
