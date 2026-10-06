import type { AppDeps } from '../src/http/app.js';

/** Dependencias falsas para montar la app en tests unitarios. */
export function fakeAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    health: { postgres: async () => {}, mongo: async () => {} },
    ingest: {
      ingest: async (msg) => ({ status: 'accepted', messageId: msg.message_id, conversationId: `test:${msg.from}` }),
    },
    conversations: {
      listConversations: async () => ({ items: [], nextCursor: null }),
      countByStatus: async () => ({ en_curso: 0, resuelta_por_ia: 0, cita_agendada: 0, escalada: 0 }),
      getConversationDetail: async () => null,
      releaseConversation: async () => 'not_found',
    },
    knowledge: {
      list: async () => [],
      get: async () => null,
      upload: async () => {
        throw new Error('no implementado en el fake');
      },
      remove: async () => false,
      reindex: async () => ({ documents: 0, chunks: 0, reindexed: 0, unchanged: 0, removed: 0 }),
      search: async (_clinicId, query) => ({ query, min_similarity: 0.3, top_k: 4, results: [] }),
    },
    aiSettings: {
      status: async () => ({ configured: false, source: null, masked: null, updated_at: null, model: 'gpt-test', can_save: true }),
      save: async () => {
        throw new Error('no implementado en el fake');
      },
      remove: async () => ({ configured: false, source: null, masked: null, updated_at: null, model: 'gpt-test', can_save: true }),
      test: async () => ({ ok: false, reason: 'invalid_key', message: 'sin key', source: null }),
    },
    prompt: {
      status: async () => ({ template: 'x', default_template: 'x', is_default: true, updated_at: null, variables: [] as never }),
      save: async () => {
        throw new Error('no implementado en el fake');
      },
      reset: async () => ({ template: 'x', default_template: 'x', is_default: true, updated_at: null, variables: [] as never }),
    },
    agenda: {
      sync: { status: async () => null, schedule: () => {} },
      catalog: { findClinicById: async () => null, findResourcesByClinic: async () => [] },
      appointments: { findConfirmedOverlapping: async () => [] },
    },
    defaultClinicId: 'clinica-test',
    ...overrides,
  };
}
