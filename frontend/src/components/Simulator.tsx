import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useConversation } from '../api/hooks';
import type { WebhookPayload } from '../api/types';
import { formatDateTime } from '../lib/format';
import { ErrorState, TypingIndicator } from './states';

// La caja de texto crece con el mensaje hasta 4 líneas (3 saltos); de ahí en adelante hace scroll.
const COMPOSER_MAX_LINES = 4;

const randomPhone = () => `+57300${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

interface LogEntry {
  at: string;
  messageId: string;
  status: number | 'error';
  detail: string;
}

/**
 * Simulador de paciente: un chat que envía cada mensaje a POST /webhooks/messages,
 * como lo haría WhatsApp, y muestra la conversación desde el lado del paciente.
 */
export function Simulator() {
  const qc = useQueryClient();
  const [phone, setPhone] = useState(randomPhone);
  const [text, setText] = useState('');
  const [conversationId, setConversationId] = useState<string>();
  const [lastPayload, setLastPayload] = useState<WebhookPayload>();
  const [log, setLog] = useState<LogEntry[]>([]);
  // Mensaje recién enviado: se muestra de inmediato, antes de que la API lo confirme.
  const [outgoing, setOutgoing] = useState<{ id: string; text: string } | null>(null);

  const conversation = useConversation(conversationId);

  const send = useMutation({
    mutationFn: (payload: WebhookPayload) => api.sendWebhook(payload),
    onMutate: (payload) => {
      setLastPayload(payload);
      setOutgoing({ id: payload.message_id, text: payload.text });
    },
    onSuccess: ({ status, body }, payload) => {
      setConversationId(body.conversation_id);
      addLog(payload.message_id, status, body.status === 'duplicate' ? 'duplicado: no se procesa otra vez' : body.status);
      void qc.invalidateQueries({ queryKey: ['conversation', body.conversation_id] });
    },
    onError: (err, payload) => {
      // No se envió: el texto vuelve a la caja para reintentar.
      setOutgoing(null);
      setText((current) => current || payload.text);
      const detail = err instanceof ApiError ? `${err.code}: ${err.message}` : 'error inesperado';
      addLog(payload.message_id, err instanceof ApiError ? err.status : 'error', detail);
    },
  });

  function addLog(messageId: string, status: number | 'error', detail: string) {
    setLog((l) => [{ at: new Date().toISOString(), messageId, status, detail }, ...l].slice(0, 8));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || send.isPending) return;
    send.mutate({
      message_id: `wamid.sim-${crypto.randomUUID()}`,
      from: phone,
      text: text.trim(),
      // Hora del sistema, como la pondría WhatsApp al recibir el mensaje.
      timestamp: new Date().toISOString(),
    });
    setText('');
  }

  // Enter envía, como en WhatsApp Web; Shift+Enter agrega un salto de línea.
  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  const composer = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = lineHeight * COMPOSER_MAX_LINES + chrome;
    el.style.height = 'auto';
    const needed = el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(needed, max)}px`;
    el.style.overflowY = needed > max ? 'auto' : 'hidden';
  }, [text]);

  function newPatient() {
    setOutgoing(null);
    setPhone(randomPhone());
    setConversationId(undefined);
    setLastPayload(undefined);
    setLog([]);
  }

  const messages = conversation.data?.messages ?? [];
  const showOutgoing = outgoing && !messages.some((m) => m.id === outgoing.id);
  // "Escribiendo" desde que se envía hasta que llega la respuesta, incluida la
  // primera carga de la conversación.
  const pending =
    send.isPending || Boolean(showOutgoing) || (Boolean(conversationId) && conversation.isPending) || Boolean(conversation.data?.assistant_pending);
  const escalated = conversation.data?.conversation.status === 'escalada';
  const scroller = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages.length, pending]);

  return (
    <div className="simulator">
      <section className="phone">
        <header className="phone-header">
          <div>
            <strong>{phone}</strong>
            <span className="muted"> · paciente simulado</span>
          </div>
          <button className="btn btn-small" onClick={newPatient}>
            Nuevo paciente
          </button>
        </header>

        <ol className="messages chat" ref={scroller}>
          {!conversationId && !showOutgoing && <li className="hint">Escribe como si fueras un paciente en WhatsApp. Ejemplo: "¿Tienen cita con dermatología mañana en la tarde?"</li>}
          {conversation.isError && <ErrorState error={conversation.error} onRetry={() => void conversation.refetch()} />}
          {messages.map((m) => (
            <li key={m.id} className={`message ${m.direction === 'inbound' ? 'from-me' : 'from-clinic'}`}>
              <div className="bubble">
                <p>{m.text}</p>
                <span className="meta">{formatDateTime(m.created_at)}</span>
              </div>
            </li>
          ))}
          {showOutgoing && (
            <li className="message from-me sending">
              <div className="bubble">
                <p>{outgoing.text}</p>
                <span className="meta">enviando…</span>
              </div>
            </li>
          )}
          {pending && !escalated && <TypingIndicator label="La clínica está escribiendo" />}
          {escalated && <li className="hint">La conversación pasó a un asesor: la IA ya no responde.</li>}
        </ol>

        <form className="composer" onSubmit={submit}>
          <textarea
            ref={composer}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Escribe un mensaje…"
            aria-label="Mensaje del paciente"
            maxLength={4096}
          />
          <button className="btn btn-primary" type="submit" disabled={!text.trim() || send.isPending}>
            {send.isPending ? 'Enviando…' : 'Enviar'}
          </button>
        </form>
      </section>

      <aside className="sim-panel">
        <h3>Opciones de prueba</h3>
        <label className="field">
          <span>Teléfono del paciente</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <button
          className="btn"
          type="button"
          disabled={!lastPayload || send.isPending}
          onClick={() => lastPayload && send.mutate(lastPayload)}
          title="Envía el mismo message_id otra vez, como un reintento de WhatsApp"
        >
          Reenviar el último (mismo message_id)
        </button>
        {conversationId && (
          <Link className="btn" to={`/conversaciones/${encodeURIComponent(conversationId)}`}>
            Ver en la bandeja del coordinador →
          </Link>
        )}

        <h3>Respuestas del webhook</h3>
        {log.length === 0 && <p className="muted">Aún no hay envíos.</p>}
        <ul className="log">
          {log.map((e) => (
            <li key={e.at + e.messageId} className={typeof e.status === 'number' && e.status < 300 ? 'ok' : 'error-text'}>
              <code>{e.status}</code> {e.detail}
              <span className="muted"> · {e.messageId.slice(0, 22)}…</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
