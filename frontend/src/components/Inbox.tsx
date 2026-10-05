import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useConversations, useSummary } from '../api/hooks';
import type { ConversationStatus } from '../api/types';
import { formatDateTime, formatDuration, formatUsd, STATUS_LABELS, STATUS_ORDER } from '../lib/format';
import { Empty, ErrorState, Loading, StatusBadge } from './states';

interface Props {
  status: ConversationStatus | undefined;
  onStatusChange: (status: ConversationStatus | undefined) => void;
}

/** Bandeja del coordinador: buscador, filtro por estado con contadores y paginación. */
export function Inbox({ status, onStatusChange }: Props) {
  const summary = useSummary();
  const list = useConversations(status);
  const [search, setSearch] = useState('');
  const all = list.data?.pages.flatMap((p) => p.items) ?? [];
  // Búsqueda sobre lo ya cargado (teléfono o último mensaje).
  const term = search.trim().toLowerCase().replace(/^\+/, '');
  const items = term ? all.filter((c) => c.phone.includes(term) || c.last_message_preview.toLowerCase().includes(term)) : all;

  return (
    <aside className="inbox">
      <div className="inbox-head">
        <h2>Historial de conversaciones</h2>
        <input className="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por teléfono o mensaje…" aria-label="Buscar conversaciones" />
        <nav className="filters" aria-label="Filtrar por estado">
          <FilterButton active={!status} onClick={() => onStatusChange(undefined)} label="Todas" count={summary.data?.total} />
          {STATUS_ORDER.map((s) => (
            <FilterButton key={s} active={status === s} onClick={() => onStatusChange(s)} label={STATUS_LABELS[s]} count={summary.data?.counts[s]} />
          ))}
        </nav>
      </div>

      <div className="inbox-list">
        {list.isPending && <Loading label="Cargando conversaciones…" />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
        {list.isSuccess && items.length === 0 && (
          <Empty>
            {term
              ? 'Ninguna conversación cargada coincide con la búsqueda.'
              : status
                ? `No hay conversaciones "${STATUS_LABELS[status]}".`
                : 'Todavía no hay conversaciones. Usa el simulador para enviar un mensaje.'}
          </Empty>
        )}

        {items.map((c) => (
          <NavLink
            key={c.id}
            to={{ pathname: `/conversaciones/${encodeURIComponent(c.id)}`, search: status ? `?estado=${status}` : '' }}
            className={({ isActive }) => `inbox-item${isActive ? ' active' : ''}`}
          >
            <div className="inbox-item-top">
              <strong>{c.phone}</strong>
              <time dateTime={c.last_message_at}>{formatDateTime(c.last_message_at)}</time>
            </div>
            <p className="preview">{c.last_message_preview}</p>
            <div className="inbox-item-bottom">
              <StatusBadge status={c.status} />
              <span className="muted">
                {formatDuration(new Date(c.last_message_at).getTime() - new Date(c.created_at).getTime())} · {c.turns} {c.turns === 1 ? 'turno' : 'turnos'} ·{' '}
                {formatUsd(c.cost_usd)}
              </span>
            </div>
          </NavLink>
        ))}

        {list.hasNextPage && (
          <button className="btn btn-block" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
          </button>
        )}
        {/* Si un refresco en segundo plano falla, se avisa sin ocultar la lista que ya se ve. */}
        {list.isRefetchError && all.length > 0 && <p className="stale">No se pudo actualizar la bandeja. Reintentando…</p>}
      </div>
    </aside>
  );
}

function FilterButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button className={`filter${active ? ' active' : ''}`} onClick={onClick} aria-pressed={active}>
      {label}
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  );
}
