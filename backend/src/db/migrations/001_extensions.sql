-- pgvector: embeddings para el RAG.
-- btree_gist: necesario más adelante para la restricción EXCLUDE que impide
-- citas solapadas del mismo profesional.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
