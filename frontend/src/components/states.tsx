import { ApiError } from '../api/client';
import type { ConversationStatus } from '../api/types';
import { STATUS_LABELS } from '../lib/format';

export function StatusBadge({ status }: { status: ConversationStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message : 'Ocurrió un error inesperado.';
  return (
    <div className="state state-error" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

export function TypingIndicator({ label = 'El asistente está respondiendo' }: { label?: string }) {
  return (
    <div className="typing" role="status" aria-live="polite">
      <span className="dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {label}
    </div>
  );
}
