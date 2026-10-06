import { useRef, useState } from 'react';
import { usePrompt, usePromptMutations } from '../api/hooks';
import type { PromptStatus } from '../api/types';
import { formatDateTime, formatNumber } from '../lib/format';
import { ErrorState, Loading } from './states';

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Prompt del asistente editable. Las variables {{...}} las reemplaza el sistema en cada turno. */
export function PromptEditor() {
  const prompt = usePrompt();
  const mutations = usePromptMutations();
  if (prompt.isPending) return <Loading label="Cargando prompt…" />;
  if (prompt.isError) return <ErrorState error={prompt.error} onRetry={() => void prompt.refetch()} />;
  // Al guardar o restaurar cambia la versión del servidor: el borrador arranca de nuevo desde ella.
  return <PromptForm key={`${prompt.data.updated_at}|${prompt.data.is_default}`} status={prompt.data} {...mutations} />;
}

function PromptForm({ status, save, reset }: { status: PromptStatus } & ReturnType<typeof usePromptMutations>) {
  const [draft, setDraft] = useState(status.template);
  const editor = useRef<HTMLTextAreaElement>(null);

  const used = new Set([...draft.matchAll(VARIABLE)].map((m) => m[1]!));
  const known = new Set(status.variables.map((v) => v.name));
  const missing = status.variables.filter((v) => !used.has(v.name));
  const unknown = [...used].filter((name) => !known.has(name));
  const dirty = draft !== status.template;
  const valid = draft.trim().length > 0 && missing.length === 0 && unknown.length === 0;

  /** Inserta la variable donde está el cursor. */
  function insert(name: string) {
    const el = editor.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + token + draft.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function restore() {
    if (window.confirm('¿Restaurar el prompt original? Se pierden los cambios guardados de esta clínica.')) reset.mutate();
  }

  return (
    <section className="card prompt-card">
      <header className="card-header">
        <h2>Prompt del asistente</h2>
        <span className={`badge ${status.is_default ? 'badge-en_curso' : 'badge-cita_agendada'}`}>{status.is_default ? 'Original' : 'Personalizado'}</span>
      </header>
      <p className="muted">
        Son las instrucciones que recibe el modelo en cada respuesta. Los cambios aplican a las conversaciones en menos de 30 segundos, sin reiniciar nada.
        {status.updated_at && ` Última edición: ${formatDateTime(status.updated_at)}.`}
      </p>
      <p className="banner banner-warning">
        Las reglas del prompt original evitan que el asistente invente información, ofrezca horarios sin consultarlos o dé una cita por confirmada sin que
        exista. Si las quitas o las cambias, pruébalo en el simulador antes de usarlo con pacientes.
      </p>

      <div className="prompt-vars">
        <span className="muted small">Variables obligatorias (clic para insertar donde está el cursor):</span>
        {status.variables.map((v) => (
          <button
            key={v.name}
            type="button"
            className={`chip chip-toggle ${used.has(v.name) ? 'chip-ok' : 'chip-error'}`}
            onClick={() => insert(v.name)}
            title={`${v.description}\nEjemplo: ${v.example}`}
          >
            {used.has(v.name) ? '✓' : '✗'} {`{{${v.name}}}`}
          </button>
        ))}
      </div>

      <textarea
        ref={editor}
        className="prompt-editor"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        aria-label="Prompt del asistente"
        rows={22}
      />

      <div className="prompt-foot">
        <span className={`small ${valid ? 'muted' : 'error-text'}`}>
          {!draft.trim()
            ? 'El prompt no puede quedar vacío.'
            : missing.length > 0
              ? `Faltan: ${missing.map((v) => `{{${v.name}}}`).join(', ')}`
              : unknown.length > 0
                ? `Variables desconocidas: ${unknown.map((n) => `{{${n}}}`).join(', ')}`
                : `${formatNumber(draft.length)} caracteres`}
        </span>
        <div className="row-actions">
          {!status.is_default && (
            <button className="btn btn-small btn-danger" onClick={restore} disabled={reset.isPending}>
              {reset.isPending ? 'Restaurando…' : 'Restaurar original'}
            </button>
          )}
          {dirty && (
            <button className="btn btn-small" onClick={() => setDraft(status.template)}>
              Descartar cambios
            </button>
          )}
          <button className="btn btn-small btn-primary" onClick={() => save.mutate(draft)} disabled={!dirty || !valid || save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar prompt'}
          </button>
        </div>
      </div>
      {save.isSuccess && !dirty && !status.is_default && <p className="banner banner-ok">Prompt guardado. El asistente lo usará en los próximos mensajes.</p>}
      {save.isError && <ErrorState error={save.error} />}
      {reset.isError && <ErrorState error={reset.error} />}
    </section>
  );
}
