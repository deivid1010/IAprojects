-- Base de conocimiento para el RAG. Los documentos fuente viven en MongoDB
-- (knowledge_documents); aquí se guarda el índice derivado: fragmentos con su
-- embedding. Se puede reconstruir en cualquier momento (npm run index).
--
-- vector(1536): dimensiones de text-embedding-3-small. Cambiar a un modelo con
-- otra dimensión requiere una migración y reindexar.
CREATE TABLE document_chunks (
  id               bigserial PRIMARY KEY,
  clinic_id        text        NOT NULL,
  document_slug    text        NOT NULL,
  document_title   text        NOT NULL,
  chunk_index      int         NOT NULL,
  heading          text,
  content          text        NOT NULL,
  -- Hash del contenido: si no cambia, no se vuelve a pagar el embedding.
  content_hash     text        NOT NULL,
  embedding_model  text        NOT NULL,
  embedding        vector(1536) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT document_chunks_position_uq UNIQUE (clinic_id, document_slug, chunk_index)
);

-- Búsqueda por similitud coseno. HNSW: buen recall sin entrenar el índice.
CREATE INDEX document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- Multi-tenant: toda búsqueda filtra por clínica.
CREATE INDEX document_chunks_clinic_idx ON document_chunks (clinic_id, document_slug);
