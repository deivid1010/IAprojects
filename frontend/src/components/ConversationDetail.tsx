import { useEffect, useRef, useState } from 'react';
import { useConversation, useRelease } from '../api/hooks';
import type { ConversationDetail as Detail, Message, Turn } from '../api/types';
import { formatCompact, formatDateTime, formatDuration, formatNumber, formatOffset, formatUsd, STATUS_LABELS } from '../lib/format';
import { ErrorState, Loading, StatusBadge, TypingIndicator } from './states';
import { TurnDetails } from './TurnDetails';

const MESSAGE_STATUS: Record<string, string> = {
  recibido: 'recibido',
  encolado: 'en cola',
  procesando: 'procesando',
  respondido: 'respondido',
  fallido: 'falló: se envió el mensaje de respaldo',
  pendiente_humano: 'pendiente de un asesor',
  pendiente_envio: 'enviando',
  enviado: 'enviado',
};

// Etiqueta corta de cada herramienta para las métricas bajo cada respuesta.
const TOOL_LABEL: Record<string, string> = {
  buscar_conocimiento: 'RAG',
  consultar_disponibilidad: 'Agenda',
  agendar_cita: 'Agendar',
  escalar_a_humano: 'Escalar',
};

interface Props {
  id: string;
  /** Posición en la bandeja actual, para navegar entre conversaciones. */
  position: { index: number; total: number; hasMore: boolean } | null;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}

/** Detalle de una conversación: transcripción con métricas y panel con resumen, paciente y datos técnicos. */
export function ConversationDetail({ id, position, onPrev, onNext, onClose }: Props) {
  const query = useConversation(id);
  const release = useRelease(id);
  const scroller = useRef<HTMLDivElement>(null);
  const count = query.data?.messages.length ?? 0;

  // Al llegar mensajes nuevos, baja al último sin mover el resto de la página.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [count, query.data?.assistant_pending]);

  return (
    <section className="detail">
      <header className="detail-bar">
        <div className="detail-nav">
          {position && (
            <span className="muted" title="Posición en la bandeja">
              {position.index + 1} / {position.total}
              {position.hasMore ? '+' : ''}
            </span>
          )}
          <button className="icon-btn" onClick={onPrev ?? undefined} disabled={!onPrev} title="Conversación anterior (K o ↑)" aria-label="Conversación anterior">
            ↑
          </button>
          <button className="icon-btn" onClick={onNext ?? undefined} disabled={!onNext} title="Conversación siguiente (J o ↓)" aria-label="Conversación siguiente">
            ↓
          </button>
        </div>
        <h2 className="detail-title">Conversación con {query.data?.conversation.phone ?? '…'}</h2>
        {query.data && <StatusBadge status={query.data.conversation.status} />}
        <div className="detail-actions">
          {query.data?.conversation.status === 'escalada' && (
            <button className="btn btn-primary btn-small" onClick={() => release.mutate()} disabled={release.isPending}>
              {release.isPending ? 'Devolviendo…' : 'Devolver a la IA'}
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="Cerrar" aria-label="Cerrar detalle">
            ✕
          </button>
        </div>
      </header>

      {query.isPending && <Loading label="Cargando conversación…" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {release.isError && <ErrorState error={release.error} />}

      {query.isSuccess && (
        <div className="detail-body">
          <div className="transcript" ref={scroller}>
            <p className="transcript-start">
              La conversación comenzó por <strong>WhatsApp (simulado)</strong> · {formatDateTime(query.data.conversation.created_at)}
            </p>
            <ol className="transcript-list">
              {query.data.messages.map((m) => (
                <TranscriptItem key={m.id} message={m} start={query.data.messages[0]!.created_at} />
              ))}
              {query.data.assistant_pending && query.data.conversation.status !== 'escalada' && <TypingIndicator />}
            </ol>
            {query.isRefetchError && <p className="stale">No se pudo actualizar. Mostrando la última versión.</p>}
          </div>
          <SidePanel detail={query.data} />
        </div>
      )}
    </section>
  );
}

function TranscriptItem({ message: m, start }: { message: Message; start: string }) {
  const [open, setOpen] = useState(false);
  const fromPatient = m.direction === 'inbound';
  const who = fromPatient ? 'Paciente' : m.kind === 'respaldo' ? 'Mensaje de respaldo' : 'Asistente';
  const offset = formatOffset(new Date(m.created_at).getTime() - new Date(start).getTime());
  const turns = m.turns ?? [];
  const last = turns.at(-1);

  const time = new Date(m.created_at).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });

  // Estilo WhatsApp: el paciente a la izquierda (burbuja blanca) y el asistente
  // a la derecha (burbuja verde). Las métricas técnicas van debajo de la burbuja.
  return (
    <li className={`tmsg ${fromPatient ? 'tmsg-patient' : 'tmsg-assistant'}${m.kind === 'respaldo' ? ' tmsg-fallback' : ''}`}>
      <div className="wa-bubble">
        <span className="tmsg-who">{who}</span>
        <p className="tmsg-text">{m.text}</p>
        <span className="wa-time" title={`${offset} desde el inicio`}>
          {time}
          {!fromPatient && m.status === 'enviado' && <span className="wa-check"> ✓✓</span>}
        </span>
      </div>
      {(turns.length > 0 || (fromPatient && m.status !== 'respondido')) && (
        <div className="metrics">
          <span title="Tiempo desde el inicio de la conversación">{offset}</span>
          {fromPatient && m.status !== 'respondido' && <span className="chip">{MESSAGE_STATUS[m.status] ?? m.status}</span>}
          {last && <TurnChips turn={last} attempts={turns.length} />}
          {turns.length > 0 && (
            <button className="chip chip-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Ocultar detalle' : 'Ver detalle'}
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="tmsg-trace">
          <TurnDetails turns={turns} defaultOpen />
        </div>
      )}
    </li>
  );
}

/** Métricas del turno que produjo la respuesta: tiempo del LLM, de cada herramienta, tokens y costo. */
function TurnChips({ turn, attempts }: { turn: Turn; attempts: number }) {
  if (turn.engine === 'sin_llm') return <span className="chip chip-warn">Respuesta automática · sin LLM</span>;
  const toolsMs = turn.tool_calls.reduce((n, c) => n + c.duration_ms, 0);
  return (
    <>
      {attempts > 1 && <span className="chip chip-warn">{attempts} intentos</span>}
      {turn.model && <span className="chip">LLM {formatNumber(Math.max(0, turn.latency_ms - toolsMs))} ms</span>}
      {turn.tool_calls.map((c, i) => (
        <span key={i} className={`chip${c.error ? ' chip-error' : ''}`} title={c.name}>
          {TOOL_LABEL[c.name] ?? c.name} {c.duration_ms} ms
        </span>
      ))}
      {turn.model && <span className="chip">{formatCompact(turn.tokens.input + turn.tokens.output)} tokens</span>}
      {turn.cost_usd !== null && <span className="chip">{formatUsd(turn.cost_usd)}</span>}
      {turn.guardrail && turn.guardrail !== 'sin_base_de_conocimiento' && <span className="chip chip-error">guardrail</span>}
      {turn.error && <span className="chip chip-error">error</span>}
    </>
  );
}

type Tab = 'resumen' | 'paciente' | 'tecnico';

function SidePanel({ detail }: { detail: Detail }) {
  const [tab, setTab] = useState<Tab>('resumen');
  return (
    <aside className="side-panel">
      <nav className="tabs" role="tablist">
        {(
          [
            ['resumen', 'Resumen'],
            ['paciente', 'Paciente'],
            ['tecnico', 'Técnico'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'resumen' && <SummaryTab detail={detail} />}
        {tab === 'paciente' && <PatientTab detail={detail} />}
        {tab === 'tecnico' && <TechnicalTab detail={detail} />}
      </div>
    </aside>
  );
}

function SummaryTab({ detail: d }: { detail: Detail }) {
  const c = d.conversation;
  return (
    <>
      <section className="panel-section">
        <h3>Resumen</h3>
        <p className="summary-text">{d.summary.text}</p>
        <p className="muted small">Generado a partir de las trazas, sin usar el LLM.</p>
        {d.summary.actions.length > 0 && (
          <ol className="actions">
            {d.summary.actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        )}
      </section>
      <section className="panel-section">
        <div className="section-head">
          <h3>Metadatos</h3>
          <CopyButton value={c.id} label="Copiar ID" />
        </div>
        <dl className="meta">
          <Meta label="ID de la conversación">
            <code>{c.id}</code>
          </Meta>
          <Meta label="Inicio">{formatDateTime(c.created_at)}</Meta>
          <Meta label="Última actividad">{formatDateTime(c.last_message_at)}</Meta>
          <Meta label="Estado">
            <StatusBadge status={c.status} />
          </Meta>
          {c.escalation_reason && <Meta label="Motivo de escalamiento">{c.escalation_reason}</Meta>}
          {c.released_at && <Meta label="Devuelta a la IA">{formatDateTime(c.released_at)}</Meta>}
          <Meta label="Canal">WhatsApp (simulado) · entrante</Meta>
          <Meta label="Teléfono">
            {c.phone} <CopyButton value={c.phone} label="Copiar" small />
          </Meta>
          <Meta label="Duración">{formatDuration(d.totals.duration_ms)}</Meta>
          <Meta label="Mensajes">
            {d.totals.messages} ({d.totals.patient_messages} del paciente)
          </Meta>
        </dl>
      </section>
    </>
  );
}

function PatientTab({ detail: d }: { detail: Detail }) {
  // Datos que el paciente entregó al agendar: salen de los argumentos de agendar_cita.
  const booking = d.messages
    .flatMap((m) => m.turns ?? [])
    .flatMap((t) => t.tool_calls)
    .filter((c) => c.name === 'agendar_cita' && !c.error)
    .at(-1);
  const args = (booking?.arguments ?? {}) as { nombre_paciente?: string; datos_adicionales?: Record<string, unknown> };
  const appt = d.summary.appointment;

  return (
    <>
      <section className="panel-section">
        <h3>Paciente</h3>
        <dl className="meta">
          <Meta label="Teléfono">{d.conversation.phone}</Meta>
          <Meta label="Nombre">{args.nombre_paciente ?? <span className="muted">No lo indicó</span>}</Meta>
          {Object.entries(args.datos_adicionales ?? {})
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v]) => (
              <Meta key={k} label={fieldLabel(k)}>
                {String(v)}
              </Meta>
            ))}
        </dl>
      </section>
      <section className="panel-section">
        <h3>Cita agendada</h3>
        {appt ? (
          <dl className="meta">
            <Meta label="Servicio">{appt.especialidad}</Meta>
            <Meta label="Profesional">{appt.profesional}</Meta>
            <Meta label="Fecha">
              {appt.dia} · {appt.hora}
            </Meta>
            {appt.sede && <Meta label="Sede">{appt.sede}</Meta>}
          </dl>
        ) : (
          <p className="muted">No se agendó ninguna cita en esta conversación.</p>
        )}
      </section>
      <section className="panel-section">
        <h3>Motivo de contacto</h3>
        <p>{d.summary.reason ?? <span className="muted">—</span>}</p>
      </section>
    </>
  );
}

function TechnicalTab({ detail: d }: { detail: Detail }) {
  const t = d.totals;
  const turns = d.messages.flatMap((m) => m.turns ?? []);
  const byTool = new Map<string, { calls: number; errors: number; ms: number }>();
  for (const c of turns.flatMap((x) => x.tool_calls)) {
    const e = byTool.get(c.name) ?? { calls: 0, errors: 0, ms: 0 };
    byTool.set(c.name, { calls: e.calls + 1, errors: e.errors + (c.error ? 1 : 0), ms: e.ms + c.duration_ms });
  }
  const events = turns.filter((x) => x.guardrail || x.error);

  return (
    <>
      <section className="panel-section">
        <h3>Consumo</h3>
        <div className="stats">
          <Stat label="Turnos" value={String(t.turns)} />
          <Stat label="Herramientas" value={String(t.tool_calls)} />
          <Stat label="Tokens entrada" value={`${formatNumber(t.input_tokens)}`} hint={`${formatNumber(t.cached_input_tokens)} desde caché`} />
          <Stat label="Tokens salida" value={formatNumber(t.output_tokens)} />
          <Stat label="Costo" value={formatUsd(t.cost_usd)} />
          <Stat label="Latencia promedio" value={`${formatNumber(t.avg_latency_ms)} ms`} />
        </div>
        <dl className="meta">
          <Meta label="Modelo">{t.models.length ? t.models.join(', ') : <span className="muted">Sin LLM</span>}</Meta>
        </dl>
      </section>
      <section className="panel-section">
        <h3>Herramientas</h3>
        {byTool.size === 0 ? (
          <p className="muted">No se usaron herramientas.</p>
        ) : (
          <table className="mini-table">
            <thead>
              <tr>
                <th>Herramienta</th>
                <th>Llamadas</th>
                <th>Errores</th>
                <th>Tiempo</th>
              </tr>
            </thead>
            <tbody>
              {[...byTool].map(([name, s]) => (
                <tr key={name}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td>{s.calls}</td>
                  <td className={s.errors ? 'error-text' : ''}>{s.errors}</td>
                  <td>{formatNumber(s.ms)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {events.length > 0 && (
        <section className="panel-section">
          <h3>Eventos</h3>
          <ul className="events">
            {events.map((e, i) => (
              <li key={i}>
                {e.guardrail === 'sin_base_de_conocimiento'
                  ? 'Respuesta automática sin LLM: falta base de conocimiento.'
                  : e.guardrail
                    ? `Guardrail «${e.guardrail}» bloqueó la respuesta del modelo.`
                    : `Intento ${e.attempt} falló: ${e.error}`}
                {e.final_status && <span className="muted"> → {STATUS_LABELS[e.final_status]}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel-section">
        <h3>Turnos ({turns.length})</h3>
        <TurnDetails turns={turns} label={`${turns.length} ${turns.length === 1 ? 'turno' : 'turnos'}`} />
      </section>
    </>
  );
}

/** "documento" → "Documento", "eps" → "EPS". */
function fieldLabel(key: string): string {
  const text = key.replace(/_/g, ' ');
  return text.length <= 4 ? text.toUpperCase() : text.charAt(0).toUpperCase() + text.slice(1);
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="meta-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

function CopyButton({ value, label, small }: { value: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`btn ${small ? 'btn-tiny' : 'btn-small'}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copiado' : label}
    </button>
  );
}
