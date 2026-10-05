import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ConversationStatus } from './types';

// Intervalos de actualización. La bandeja se refresca sola; el detalle
// consulta más seguido mientras el asistente está respondiendo.
const INBOX_REFRESH_MS = 5000;
const DETAIL_IDLE_MS = 5000;
const DETAIL_PENDING_MS = 1500;

export const keys = {
  conversations: (status?: ConversationStatus) => ['conversations', status ?? 'todas'] as const,
  summary: ['summary'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  knowledge: ['knowledge'] as const,
  aiSettings: ['ai-settings'] as const,
  agenda: ['agenda'] as const,
  knowledgeDoc: (slug: string) => ['knowledge', slug] as const,
};

export function useConversations(status?: ConversationStatus) {
  return useInfiniteQuery({
    queryKey: keys.conversations(status),
    queryFn: ({ pageParam }) => api.listConversations({ status, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: INBOX_REFRESH_MS,
  });
}

export function useSummary() {
  return useQuery({ queryKey: keys.summary, queryFn: api.summary, refetchInterval: INBOX_REFRESH_MS });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: keys.conversation(id ?? ''),
    queryFn: () => api.conversation(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.assistant_pending ? DETAIL_PENDING_MS : DETAIL_IDLE_MS),
  });
}

export function useRelease(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.release(id),
    onSuccess: (detail) => {
      qc.setQueryData(keys.conversation(id), detail);
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: keys.summary });
    },
  });
}

// --- Base de conocimiento ---------------------------------------------------

export function useKnowledgeDocuments() {
  return useQuery({ queryKey: keys.knowledge, queryFn: api.knowledge.list });
}

export function useKnowledgeDocument(slug: string | null) {
  return useQuery({ queryKey: keys.knowledgeDoc(slug ?? ''), queryFn: () => api.knowledge.get(slug!), enabled: Boolean(slug) });
}

/** Subir, borrar y reindexar invalidan la lista (y el detalle) para mostrar el estado real del índice. */
export function useKnowledgeMutations() {
  const qc = useQueryClient();
  // Al cambiar documentos, la agenda se regenera en el servidor: se refresca también.
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: keys.knowledge }), qc.invalidateQueries({ queryKey: keys.agenda })]);
  return {
    uploadFile: useMutation({ mutationFn: api.knowledge.uploadFile, onSuccess: refresh }),
    uploadText: useMutation({ mutationFn: api.knowledge.uploadText, onSuccess: refresh }),
    remove: useMutation({ mutationFn: api.knowledge.remove, onSuccess: refresh }),
    reindex: useMutation({ mutationFn: api.knowledge.reindex, onSuccess: refresh }),
    search: useMutation({ mutationFn: api.knowledge.search }),
  };
}

// --- Configuración del modelo de IA -------------------------------------------

export function useAiSettings() {
  return useQuery({ queryKey: keys.aiSettings, queryFn: api.aiSettings.get });
}

export function useAiSettingsMutations() {
  const qc = useQueryClient();
  const setStatus = (status: Awaited<ReturnType<typeof api.aiSettings.get>>) => {
    qc.setQueryData(keys.aiSettings, status);
    void qc.invalidateQueries({ queryKey: keys.knowledge }); // el estado de indexado depende de la key
  };
  return {
    save: useMutation({ mutationFn: api.aiSettings.save, onSuccess: setStatus }),
    remove: useMutation({ mutationFn: api.aiSettings.remove, onSuccess: setStatus }),
    test: useMutation({ mutationFn: api.aiSettings.test }),
  };
}

// --- Agenda -----------------------------------------------------------------------

/** Mientras la agenda se está generando, se consulta cada 2 s. */
export function useAgenda() {
  return useQuery({
    queryKey: keys.agenda,
    queryFn: api.agenda.get,
    refetchInterval: (query) => (query.state.data?.meta?.status === 'generando' ? 2000 : false),
  });
}

export function useRegenerateAgenda() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.agenda.regenerate, onSuccess: () => qc.invalidateQueries({ queryKey: keys.agenda }) });
}
