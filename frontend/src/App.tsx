import { useCallback, useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useConversations } from './api/hooks';
import type { ConversationStatus } from './api/types';
import { ConversationDetail } from './components/ConversationDetail';
import { Inbox } from './components/Inbox';
import { Settings } from './components/Settings';
import { Simulator } from './components/Simulator';
import { Empty } from './components/states';
import { STATUS_ORDER } from './lib/format';

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Asistente de agendamiento</h1>
        <nav>
          <NavLink to="/conversaciones">Bandeja</NavLink>
          <NavLink to="/simulador">Simulador de paciente</NavLink>
          <NavLink to="/configuracion">Configuración</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/conversaciones" replace />} />
          <Route path="/conversaciones" element={<InboxPage />} />
          <Route path="/conversaciones/:id" element={<InboxPage />} />
          <Route path="/simulador" element={<Simulator />} />
          <Route path="/configuracion" element={<Settings />} />
          <Route path="/conocimiento" element={<Navigate to="/configuracion" replace />} />
          <Route path="*" element={<Empty>Página no encontrada.</Empty>} />
        </Routes>
      </main>
    </div>
  );
}

/**
 * Bandeja a la izquierda y detalle a la derecha. El filtro de estado vive en la
 * URL (?estado=) para poder compartir el enlace. J/↓ y K/↑ pasan a la
 * conversación siguiente o anterior de la bandeja.
 */
function InboxPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = params.get('estado');
  const status = STATUS_ORDER.includes(raw as ConversationStatus) ? (raw as ConversationStatus) : undefined;
  const list = useConversations(status); // misma consulta que la bandeja: comparte el caché
  const ids = list.data?.pages.flatMap((p) => p.items.map((c) => c.id)) ?? [];
  const index = id ? ids.indexOf(id) : -1;

  // Si la conversación abierta no está en lo cargado, se cargan más páginas
  // (hasta 10) para ubicarla y habilitar la navegación anterior/siguiente.
  const pages = list.data?.pages.length ?? 0;
  useEffect(() => {
    if (id && index === -1 && list.hasNextPage && !list.isFetchingNextPage && pages < 10) void list.fetchNextPage();
  }, [id, index, list, pages]);

  const changeStatus = (s: ConversationStatus | undefined) => {
    const next = new URLSearchParams(params);
    if (s) next.set('estado', s);
    else next.delete('estado');
    setParams(next);
  };

  const open = useCallback(
    (targetId: string) => navigate({ pathname: `/conversaciones/${encodeURIComponent(targetId)}`, search: status ? `?estado=${status}` : '' }),
    [navigate, status],
  );
  const prev = index > 0 ? () => open(ids[index - 1]!) : null;
  const next = index >= 0 && index < ids.length - 1 ? () => open(ids[index + 1]!) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === 'j' || e.key === 'ArrowDown') && next) (e.preventDefault(), next());
      if ((e.key === 'k' || e.key === 'ArrowUp') && prev) (e.preventDefault(), prev());
      if (e.key === 'Escape' && id) navigate({ pathname: '/conversaciones', search: status ? `?estado=${status}` : '' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, id, navigate, status]);

  return (
    <div className="inbox-page">
      <Inbox status={status} onStatusChange={changeStatus} />
      <div className="detail-pane">
        {id ? (
          <ConversationDetail
            key={id}
            id={id}
            position={index >= 0 ? { index, total: ids.length, hasMore: Boolean(list.hasNextPage) } : null}
            onPrev={prev}
            onNext={next}
            onClose={() => navigate({ pathname: '/conversaciones', search: status ? `?estado=${status}` : '' })}
          />
        ) : (
          <Empty>Selecciona una conversación para ver la transcripción, el resumen y los detalles técnicos.</Empty>
        )}
      </div>
    </div>
  );
}
