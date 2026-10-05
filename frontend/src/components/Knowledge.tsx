import { useRef, useState } from 'react';
import { useKnowledgeDocument, useKnowledgeDocuments, useKnowledgeMutations } from '../api/hooks';
import type { KnowledgeDocumentSummary } from '../api/types';
import { formatDateTime, formatNumber } from '../lib/format';
import { Empty, ErrorState, Loading } from './states';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = /\.(md|markdown|txt|pdf|docx)$/i;
const FORMAT_LABEL = { markdown: 'Markdown', texto: 'Texto', pdf: 'PDF', word: 'Word' } as const;

/**
 * Base de conocimiento de la clínica: subir documentos (se procesan con
 * embeddings al subirlos), ver su estado y sus fragmentos, y probar qué
 * encontraría el asistente para una pregunta.
 */
export function Knowledge() {
  return (
    <div className="knowledge">
      <div className="knowledge-main">
        <UploadForm />
        <DocumentList />
      </div>
      <SearchTester />
    </div>
  );
}

function UploadForm() {
  const { uploadFile, uploadText } = useKnowledgeMutations();
  // Cada envío reinicia el otro modo, así que el activo es el que no está inactivo.
  const upload = uploadText.isIdle ? uploadFile : uploadText;
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'archivo' | 'texto'>('archivo');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite volver a subir el mismo archivo
    setFileError(null);
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.doc')) return setFileError('El formato .doc (Word 97-2003) no está soportado: guárdalo como .docx.');
    if (!ACCEPTED.test(file.name)) return setFileError('Formatos soportados: .md, .txt, .pdf, .docx.');
    if (file.size > MAX_FILE_BYTES) return setFileError('El archivo supera 10 MB.');
    uploadText.reset();
    uploadFile.mutate(file);
  }

  function onPaste(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !text.trim()) return;
    uploadFile.reset();
    uploadText.mutate({ title: title.trim(), content: text }, { onSuccess: () => (setTitle(''), setText('')) });
  }

  return (
    <section className="card">
      <header className="card-header">
        <h2>Subir documento</h2>
        <div className="segmented" role="tablist">
          <button className={mode === 'archivo' ? 'active' : ''} onClick={() => setMode('archivo')}>
            Archivo
          </button>
          <button className={mode === 'texto' ? 'active' : ''} onClick={() => setMode('texto')}>
            Pegar texto
          </button>
        </div>
      </header>
      <p className="muted">
        Word (.docx), PDF, Markdown o texto. Se extrae el texto y cada sección (los títulos del documento) se convierte en un fragmento con su embedding. Si ya
        existe un documento con el mismo nombre, se reemplaza. Esta es la única fuente de información del asistente.
      </p>

      {mode === 'archivo' ? (
        <div className="upload-row">
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt,.pdf,.docx,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={onFile}
            hidden
          />
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? 'Extrayendo texto y procesando embeddings…' : 'Elegir archivo (.docx, .pdf, .md, .txt)'}
          </button>
        </div>
      ) : (
        <form className="paste-form" onSubmit={onPaste}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título (por ejemplo: Tarifas)" aria-label="Título del documento" />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'# Tarifas\n\n## Particular\n…'} aria-label="Contenido" />
          <button className="btn btn-primary" type="submit" disabled={upload.isPending || !title.trim() || !text.trim()}>
            {upload.isPending ? 'Procesando embeddings…' : 'Guardar y procesar'}
          </button>
        </form>
      )}

      {fileError && <p className="error-text">{fileError}</p>}
      {upload.isError && <ErrorState error={upload.error} />}
      {upload.isSuccess && (
        <p className="banner banner-ok">
          {upload.data.created ? 'Documento agregado' : 'Documento reemplazado'}: <strong>{upload.data.document.title}</strong> · {upload.data.document.chunks}{' '}
          fragmentos {upload.data.reindexed ? 'indexados con embeddings nuevos' : '(sin cambios: no se regeneraron embeddings)'}.
          {upload.data.reindexed || upload.data.created ? ' La agenda se está regenerando desde los documentos (ver pestaña Agenda).' : ''}
        </p>
      )}
    </section>
  );
}

function DocumentList() {
  const docs = useKnowledgeDocuments();
  const { remove, reindex } = useKnowledgeMutations();
  const [open, setOpen] = useState<string | null>(null);

  function confirmRemove(doc: KnowledgeDocumentSummary) {
    if (window.confirm(`¿Eliminar "${doc.title}"? El asistente dejará de usar esta información.`)) remove.mutate(doc.slug);
  }

  const items = docs.data ?? [];
  const pending = items.filter((d) => !d.indexed).length;

  return (
    <section className="card">
      <header className="card-header">
        <h2>Documentos ({items.length})</h2>
        <button className="btn btn-small" onClick={() => reindex.mutate()} disabled={reindex.isPending || items.length === 0}>
          {reindex.isPending ? 'Reindexando…' : 'Reindexar todo'}
        </button>
      </header>
      {pending > 0 && <p className="banner banner-warning">{pending} documento(s) sin indexar o desactualizados: el asistente no los usa hasta reindexar.</p>}
      {reindex.isSuccess && (
        <p className="banner banner-ok">
          Reindexado: {reindex.data.reindexed} con embeddings nuevos, {reindex.data.unchanged} sin cambios, {reindex.data.removed} fragmentos huérfanos eliminados.
        </p>
      )}
      {reindex.isError && <ErrorState error={reindex.error} />}
      {remove.isError && <ErrorState error={remove.error} />}

      {docs.isPending && <Loading label="Cargando documentos…" />}
      {docs.isError && <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />}
      {docs.isSuccess && items.length === 0 && (
        <p className="banner banner-warning">
          No hay base de conocimiento: el asistente responde a los pacientes un mensaje por defecto (sin usar el LLM) y escala la conversación a un asesor, hasta que subas al menos un documento.
        </p>
      )}

      <ul className="doc-list">
        {items.map((d) => (
          <li key={d.slug} className="doc">
            <div className="doc-row">
              <button className="doc-title" onClick={() => setOpen(open === d.slug ? null : d.slug)} aria-expanded={open === d.slug}>
                {open === d.slug ? '▾' : '▸'} {d.title}
              </button>
              <span className={`badge ${d.indexed ? 'badge-resuelta_por_ia' : 'badge-escalada'}`}>{d.indexed ? 'Indexado' : 'Pendiente'}</span>
              {d.source_format && <span className="badge badge-en_curso">{FORMAT_LABEL[d.source_format]}</span>}
              <span className="muted">
                {d.chunks} {d.chunks === 1 ? 'fragmento' : 'fragmentos'} · {formatNumber(d.chars)} caracteres{d.updated_at ? ` · ${formatDateTime(d.updated_at)}` : ''}
              </span>
              <button className="btn btn-small btn-danger" onClick={() => confirmRemove(d)} disabled={remove.isPending}>
                Eliminar
              </button>
            </div>
            {open === d.slug && <DocumentDetail slug={d.slug} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DocumentDetail({ slug }: { slug: string }) {
  const doc = useKnowledgeDocument(slug);
  if (doc.isPending) return <Loading />;
  if (doc.isError) return <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />;
  const d = doc.data;
  return (
    <div className="doc-detail">
      <p className="muted">
        Archivo: {d.source_filename ?? '—'} · id: <code>{d.slug}</code> · modelo: {d.embedding_model ?? '—'}
        {d.indexed_at ? ` · indexado ${formatDateTime(d.indexed_at)}` : ''}
      </p>
      <h4>Fragmentos que se vectorizaron ({d.fragments.length})</h4>
      <ol className="fragments">
        {d.fragments.map((f) => (
          <li key={f.index}>
            <pre>{f.content}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SearchTester() {
  const { search } = useKnowledgeMutations();
  const [q, setQ] = useState('');

  return (
    <aside className="card search-tester">
      <h2>Probar búsqueda</h2>
      <p className="muted">Escribe una pregunta de paciente y mira qué fragmentos encontraría el asistente y con qué similitud.</p>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) search.mutate(q.trim());
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="¿Hay que ir en ayunas para la glucosa?" aria-label="Pregunta de prueba" />
        <button className="btn btn-primary" type="submit" disabled={search.isPending || q.trim().length < 2}>
          {search.isPending ? 'Buscando…' : 'Buscar'}
        </button>
      </form>

      {search.isError && <ErrorState error={search.error} />}
      {search.isSuccess && (
        <>
          <p className="muted">
            Umbral del asistente: similitud ≥ {search.data.min_similarity} · se muestran los {search.data.top_k} más cercanos.
          </p>
          {search.data.results.length === 0 && <Empty>No hay documentos indexados.</Empty>}
          <ol className="hits">
            {search.data.results.map((h, i) => (
              <li key={i} className={h.used_by_assistant ? 'hit' : 'hit hit-below'}>
                <div className="hit-head">
                  <strong>{h.source}</strong>
                  <span className="similarity">
                    <span className="bar" style={{ width: `${Math.max(0, Math.min(1, h.similarity)) * 100}%` }} />
                    {h.similarity.toFixed(3)}
                  </span>
                </div>
                <span className="muted">{h.used_by_assistant ? 'El asistente lo recibiría' : 'Bajo el umbral: el asistente no lo recibe'}</span>
                <pre>{h.content}</pre>
              </li>
            ))}
          </ol>
          {search.data.results.length > 0 && search.data.results.every((h) => !h.used_by_assistant) && (
            <p className="banner banner-warning">Ningún fragmento supera el umbral: el asistente respondería que no tiene esa información.</p>
          )}
        </>
      )}
    </aside>
  );
}
