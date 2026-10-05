import type { Turn } from '../api/types';
import { formatJson, formatNumber, formatUsd, STATUS_LABELS } from '../lib/format';

/** Traza de los intentos que produjeron una respuesta: tools, argumentos, resultados, tokens y costo. */
export function TurnDetails({ turns, defaultOpen = false, label }: { turns: Turn[]; defaultOpen?: boolean; label?: string }) {
  if (turns.length === 0) return null;
  const tools = turns.reduce((n, t) => n + t.tool_calls.length, 0);
  const cost = turns.reduce((n, t) => n + (t.cost_usd ?? 0), 0);

  return (
    <details className="turns" open={defaultOpen}>
      <summary>
        {label ? `${label} · ` : turns.length > 1 ? `${turns.length} intentos · ` : ''}
        {tools} {tools === 1 ? 'herramienta' : 'herramientas'} · {formatUsd(cost)}
      </summary>
      {turns.map((t) => (
        <section key={`${t.attempt}-${t.created_at}`} className={`turn${t.error ? ' turn-error' : ''}`}>
          <header>
            <strong>Intento {t.attempt}</strong>
            <span>{t.model ?? t.engine}</span>
            <span>{formatNumber(t.latency_ms)} ms</span>
            <span>{t.iterations} rondas</span>
            <span title="Tokens de entrada (desde caché) / salida">
              {formatNumber(t.tokens.input)} ({formatNumber(t.tokens.cached_input)} caché) / {formatNumber(t.tokens.output)} tokens
            </span>
            <span>{formatUsd(t.cost_usd)}</span>
            {t.final_status && <span>→ {STATUS_LABELS[t.final_status]}</span>}
          </header>
          {t.error && <p className="error-text">Error: {t.error}</p>}
          {t.guardrail === 'sin_base_de_conocimiento' && (
            <p className="error-text">⚠ Respuesta automática sin LLM: la clínica no tiene base de conocimiento configurada.</p>
          )}
          {t.guardrail && t.guardrail !== 'sin_base_de_conocimiento' && (
            <p className="error-text">⛔ Respuesta del modelo bloqueada por el guardrail «{t.guardrail}»: se envió el mensaje de fuera de alcance.</p>
          )}
          {t.tool_calls.length === 0 && !t.error && !t.guardrail && <p className="muted">Respondió sin usar herramientas.</p>}
          {t.tool_calls.map((call, i) => (
            <details key={i} className={`tool${call.error ? ' tool-error' : ''}`}>
              <summary>
                <code>{call.name}</code> {call.error ? <span className="error-text">✗ {call.error.split(':')[0]}</span> : <span className="ok">✓</span>}
                <span className="muted"> {call.duration_ms} ms</span>
              </summary>
              <div className="tool-body">
                <h4>Argumentos (propuestos por el modelo)</h4>
                <pre>{formatJson(call.arguments)}</pre>
                <h4>{call.error ? 'Error devuelto al modelo' : 'Resultado'}</h4>
                <pre>{call.error ?? formatJson(call.result)}</pre>
              </div>
            </details>
          ))}
        </section>
      ))}
    </details>
  );
}
