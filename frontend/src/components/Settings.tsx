import { useState } from 'react';
import { useAiSettings, useAiSettingsMutations } from '../api/hooks';
import { formatDateTime } from '../lib/format';
import { AgendaView } from './AgendaView';
import { Knowledge } from './Knowledge';
import { ErrorState, Loading } from './states';

type Section = 'ia' | 'conocimiento' | 'agenda';

/** Configuración del cliente: modelo de IA (API key), base de conocimiento y la agenda que se genera desde ella. */
export function Settings() {
  const [section, setSection] = useState<Section>('ia');
  return (
    <div className="settings">
      <header className="settings-head">
        <h2>Configuración</h2>
        <nav className="tabs settings-tabs" role="tablist">
          <button role="tab" aria-selected={section === 'ia'} className={section === 'ia' ? 'active' : ''} onClick={() => setSection('ia')}>
            Modelo de IA
          </button>
          <button role="tab" aria-selected={section === 'conocimiento'} className={section === 'conocimiento' ? 'active' : ''} onClick={() => setSection('conocimiento')}>
            Base de conocimiento
          </button>
          <button role="tab" aria-selected={section === 'agenda'} className={section === 'agenda' ? 'active' : ''} onClick={() => setSection('agenda')}>
            Agenda
          </button>
        </nav>
      </header>
      {section === 'ia' && <AiSettings />}
      {section === 'conocimiento' && <Knowledge />}
      {section === 'agenda' && <AgendaView />}
    </div>
  );
}

const SOURCE_LABEL = { panel: 'Configurada en este panel', env: 'Archivo .env del servidor' } as const;

function AiSettings() {
  const status = useAiSettings();
  const { save, remove, test } = useAiSettingsMutations();
  const [key, setKey] = useState('');

  if (status.isPending) return <Loading label="Cargando configuración…" />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    test.reset();
    save.mutate(key.trim(), { onSuccess: () => setKey('') });
  }

  return (
    <div className="settings-body">
      <section className="card">
        <header className="card-header">
          <h2>API key de OpenAI</h2>
          <span className={`badge ${s.configured ? 'badge-resuelta_por_ia' : 'badge-escalada'}`}>{s.configured ? 'Configurada' : 'Sin configurar'}</span>
        </header>

        {!s.configured && (
          <p className="banner banner-warning">
            Sin API key, el asistente no usa el LLM: responde a los pacientes un mensaje por defecto y escala la conversación a un asesor. Tampoco se pueden
            procesar documentos de la base de conocimiento.
          </p>
        )}

        <dl className="meta">
          <div className="meta-row">
            <dt>Key en uso</dt>
            <dd>{s.masked ? <code>{s.masked}</code> : <span className="muted">—</span>}</dd>
          </div>
          <div className="meta-row">
            <dt>Origen</dt>
            <dd>{s.source ? SOURCE_LABEL[s.source] : <span className="muted">—</span>}</dd>
          </div>
          <div className="meta-row">
            <dt>Modelo</dt>
            <dd>
              <code>{s.model}</code>
            </dd>
          </div>
          {s.updated_at && (
            <div className="meta-row">
              <dt>Actualizada</dt>
              <dd>{formatDateTime(s.updated_at)}</dd>
            </div>
          )}
        </dl>

        <div className="row-actions">
          <button className="btn btn-small" onClick={() => test.mutate()} disabled={test.isPending || !s.configured}>
            {test.isPending ? 'Probando…' : 'Probar conexión'}
          </button>
          {s.source === 'panel' && (
            <button
              className="btn btn-small btn-danger"
              onClick={() => window.confirm('¿Eliminar la key del panel? Se usará la del .env del servidor, si existe.') && remove.mutate()}
              disabled={remove.isPending}
            >
              Eliminar key del panel
            </button>
          )}
        </div>
        {test.isSuccess &&
          (test.data.ok ? (
            <p className="banner banner-ok">Conexión correcta: la key funciona y tiene acceso a {s.model}.</p>
          ) : (
            <p className="banner banner-warning">{test.data.message}</p>
          ))}
        {test.isError && <ErrorState error={test.error} />}
        {remove.isError && <ErrorState error={remove.error} />}
      </section>

      <section className="card">
        <h2>{s.source === 'panel' ? 'Reemplazar la API key' : 'Configurar una API key'}</h2>
        {s.can_save ? (
          <>
            <p className="muted">
              Se valida contra OpenAI antes de guardarla. Se guarda cifrada y nunca se vuelve a mostrar completa. Aplica al asistente de inmediato, sin reiniciar
              nada, y tiene prioridad sobre la del .env.
            </p>
            <form className="key-form" onSubmit={submit}>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-proj-…"
                autoComplete="off"
                spellCheck={false}
                aria-label="API key de OpenAI"
              />
              <button className="btn btn-primary" type="submit" disabled={save.isPending || key.trim().length < 20}>
                {save.isPending ? 'Validando con OpenAI…' : 'Validar y guardar'}
              </button>
            </form>
            {save.isSuccess && <p className="banner banner-ok">API key guardada ({save.data.masked}). El asistente ya la está usando.</p>}
            {save.isError && <ErrorState error={save.error} />}
          </>
        ) : (
          <p className="banner banner-warning">
            El servidor no tiene clave maestra de cifrado (<code>SETTINGS_ENCRYPTION_KEY</code> en <code>backend/.env</code>), así que no se pueden guardar keys
            desde el panel. Genérala con <code>openssl rand -base64 32</code> y reinicia la API.
          </p>
        )}
      </section>
    </div>
  );
}
