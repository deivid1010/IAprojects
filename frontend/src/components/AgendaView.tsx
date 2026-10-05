import { useAgenda, useRegenerateAgenda } from '../api/hooks';
import type { AgendaMeta, AgendaView as Agenda } from '../api/types';
import { formatDateTime } from '../lib/format';
import { ErrorState, Loading } from './states';

const STATUS: Record<AgendaMeta['status'], { label: string; badge: string }> = {
  generando: { label: 'Generando…', badge: 'badge-en_curso' },
  lista: { label: 'Generada', badge: 'badge-resuelta_por_ia' },
  sin_agenda: { label: 'El documento no describe una agenda', badge: 'badge-escalada' },
  sin_documentos: { label: 'Sin documentos', badge: 'badge-escalada' },
  error: { label: 'Error al generar', badge: 'badge-escalada' },
};

const DAY_ORDER = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/**
 * Agenda generada desde la base de conocimiento (solo lectura): sedes, servicios
 * y profesionales con sus horarios. Se regenera sola al cambiar los documentos.
 */
export function AgendaView() {
  const agenda = useAgenda();
  const regenerate = useRegenerateAgenda();

  if (agenda.isPending) return <Loading label="Cargando agenda…" />;
  if (agenda.isError) return <ErrorState error={agenda.error} onRetry={() => void agenda.refetch()} />;
  const { meta, locations, services, professionals } = agenda.data;
  const generating = meta?.status === 'generando' || regenerate.isPending;

  return (
    <div className="agenda-view">
      <section className="card">
        <header className="card-header">
          <h2>Agenda</h2>
          {meta && <span className={`badge ${STATUS[meta.status].badge}`}>{STATUS[meta.status].label}</span>}
        </header>
        <p className="muted">
          Se genera automáticamente desde los documentos de la base de conocimiento cada vez que cambian. El LLM la extrae una vez por cambio y el sistema descarta
          cualquier sede, servicio o profesional que no aparezca escrito en el documento.
        </p>
        {meta && (
          <dl className="meta">
            <div className="meta-row">
              <dt>Documentos usados</dt>
              <dd>{meta.documents.length ? meta.documents.join(', ') : '—'}</dd>
            </div>
            <div className="meta-row">
              <dt>Última generación</dt>
              <dd>{meta.finished_at ? formatDateTime(meta.finished_at) : 'en curso'}</dd>
            </div>
          </dl>
        )}
        {meta?.status === 'error' && <p className="banner banner-warning">{meta.error} Se conserva la agenda anterior.</p>}
        {meta?.status === 'sin_agenda' && (
          <p className="banner banner-warning">Los documentos no describen sedes, servicios ni profesionales: el asistente responde con la base de conocimiento y escala, sin agendar.</p>
        )}
        <div className="row-actions">
          <button className="btn btn-small" onClick={() => regenerate.mutate()} disabled={generating}>
            {generating ? 'Generando agenda…' : 'Regenerar desde la base de conocimiento'}
          </button>
        </div>
        {regenerate.isError && <ErrorState error={regenerate.error} />}
      </section>

      {professionals.length > 0 && <Catalog locations={locations} services={services} professionals={professionals} />}

      {meta && (meta.warnings.length > 0 || meta.discarded.length > 0 || meta.notes.length > 0) && (
        <section className="card">
          <h2>Revisión</h2>
          <Findings title="Descartado por el sistema" items={meta.discarded} tone="error" />
          <Findings title="Ajustes aplicados" items={meta.warnings} />
          <Findings title="Ambigüedades del documento" items={meta.notes} />
        </section>
      )}
    </div>
  );
}

function Catalog({ locations, services, professionals }: Omit<Agenda, 'meta'>) {
  return (
    <>
      <section className="card">
        <h2>Profesionales ({professionals.length})</h2>
        <table className="mini-table">
          <thead>
            <tr>
              <th>Profesional</th>
              <th>Servicios</th>
              <th>Horarios</th>
            </tr>
          </thead>
          <tbody>
            {professionals.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.services.join(', ')}</td>
                <td>
                  {groupSchedules(p.schedules).map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="agenda-columns">
        <section className="card">
          <h2>Sedes ({locations.length})</h2>
          <ul className="plain-list">
            {locations.map((l) => (
              <li key={l.id}>
                <strong>{l.name}</strong>
                {l.address && <span className="muted"> · {l.address}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Servicios ({services.length})</h2>
          <ul className="plain-list">
            {services.map((s) => (
              <li key={s.id}>
                {s.name} <span className="muted">· {s.duration_min} min</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function Findings({ title, items, tone }: { title: string; items: string[]; tone?: 'error' }) {
  if (items.length === 0) return null;
  return (
    <details className="findings" open={tone === 'error'}>
      <summary className={tone === 'error' ? 'error-text' : ''}>
        {title} ({items.length})
      </summary>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </details>
  );
}

/** "Sede Sur: Lun, Mar, Mié 07:00–18:00" agrupando días con el mismo horario. */
function groupSchedules(schedules: Agenda['professionals'][number]['schedules']): string[] {
  const groups = new Map<string, string[]>();
  for (const s of schedules) {
    const key = `${s.location}|${s.start}–${s.end}`;
    groups.set(key, [...(groups.get(key) ?? []), s.day]);
  }
  return [...groups].map(([key, days]) => {
    const [location, hours] = key.split('|');
    const sorted = days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    return `${location}: ${sorted.join(', ')} ${hours}`;
  });
}
