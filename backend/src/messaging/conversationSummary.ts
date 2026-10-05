import type { ConversationDoc, ConversationStatus, MessageDoc, TurnDoc } from './types.js';

// Resumen de una conversación armado con reglas a partir de los mensajes y las
// trazas de cada turno. No usa el LLM: es determinista, instantáneo y no cuesta
// tokens. Las trazas ya dicen qué pasó (qué herramientas se usaron, con qué
// argumentos y resultado); el resumen solo lo pone en palabras.

export interface ConversationSummary {
  /** Párrafo corto para el coordinador. */
  text: string;
  /** Acciones en orden cronológico. */
  actions: string[];
  /** Motivo de contacto: el primer mensaje del paciente. */
  reason: string | null;
  outcome: string;
  /** Temas consultados en la base de conocimiento. */
  topics: string[];
  /** Cita creada en la conversación, si hubo. */
  appointment: { especialidad: string; profesional: string; dia: string; hora: string; sede: string | null; paciente: string } | null;
}

const OUTCOME: Record<ConversationStatus, string> = {
  en_curso: 'La conversación sigue en curso.',
  resuelta_por_ia: 'El asistente resolvió la consulta.',
  cita_agendada: 'Terminó con una cita agendada.',
  escalada: 'Se escaló a un asesor.',
};

const MAX_TOPICS = 3;

export function summarizeConversation(conversation: ConversationDoc, messages: MessageDoc[], turns: TurnDoc[]): ConversationSummary {
  const firstInbound = messages.find((m) => m.direction === 'inbound');
  const reason = firstInbound ? truncate(firstInbound.text, 140) : null;
  const actions: string[] = [];
  const topics: string[] = [];
  const unanswered: string[] = [];
  let appointment: ConversationSummary['appointment'] = null;

  for (const turn of turns) {
    if (turn.guardrail === 'sin_base_de_conocimiento') {
      pushOnce(actions, 'Respondió automáticamente (sin LLM) porque la clínica no tiene base de conocimiento.');
    } else if (turn.guardrail) {
      pushOnce(actions, 'Rechazó un pedido fuera de alcance (se bloqueó la respuesta del modelo).');
    }
    if (turn.error && turn.final_status === 'escalada') actions.push(`Falló el asistente tras ${turn.attempt} intentos (${truncate(turn.error, 80)}).`);

    for (const call of turn.tool_calls) {
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      const result = (call.result ?? {}) as Record<string, unknown>;
      switch (call.name) {
        case 'buscar_conocimiento': {
          const q = typeof args.pregunta === 'string' ? truncate(args.pregunta, 70) : null;
          if (!q) break;
          if (result.sin_informacion) pushOnce(unanswered, q);
          else pushOnce(topics, q);
          break;
        }
        case 'consultar_disponibilidad': {
          if (call.error) break;
          const franja = result.franja && result.franja !== 'cualquiera' ? ` en la ${result.franja === 'manana' ? 'mañana' : 'tarde'}` : '';
          pushOnce(actions, `Consultó disponibilidad de ${String(result.especialidad ?? args.especialidad)} para el ${String(result.dia ?? result.fecha)}${franja}: ${Number(result.total_horarios ?? 0)} horarios libres.`);
          break;
        }
        case 'agendar_cita': {
          if (call.error) {
            actions.push(`Intento de agendar sin éxito (${call.error.split(':')[0]}).`);
            break;
          }
          appointment = {
            especialidad: String(result.especialidad ?? ''),
            profesional: String(result.profesional ?? ''),
            dia: String(result.dia ?? result.fecha ?? ''),
            hora: String(result.hora ?? ''),
            sede: (result.sede as string | null) ?? null,
            paciente: String(result.paciente ?? ''),
          };
          actions.push(`Agendó ${appointment.especialidad} con ${appointment.profesional} el ${appointment.dia} a las ${appointment.hora}${appointment.sede ? ` en ${appointment.sede}` : ''}.`);
          break;
        }
        case 'escalar_a_humano':
          if (!call.error) actions.push(`Escaló a un asesor: ${truncate(String(args.motivo ?? ''), 100)}.`);
          break;
      }
    }
  }

  if (topics.length) actions.unshift(`Consultó la base de conocimiento sobre: ${topics.slice(0, MAX_TOPICS).join('; ')}${topics.length > MAX_TOPICS ? '…' : ''}.`);
  if (unanswered.length) actions.push(`Sin información en la base de conocimiento para: ${unanswered.slice(0, MAX_TOPICS).join('; ')}.`);

  const outcome =
    conversation.status === 'escalada' && conversation.escalation_reason
      ? `Se escaló a un asesor (${truncate(conversation.escalation_reason, 100)}).`
      : OUTCOME[conversation.status];

  const patientMessages = messages.filter((m) => m.direction === 'inbound').length;
  const parts = [
    reason ? `El paciente escribió: «${reason}».` : 'Conversación sin mensajes del paciente.',
    actions.length ? actions.join(' ') : patientMessages > 0 ? 'El asistente respondió sin usar herramientas.' : '',
    outcome,
  ].filter(Boolean);

  return { text: parts.join(' '), actions, reason, outcome, topics, appointment };
}

function pushOnce(list: string[], item: string) {
  if (!list.includes(item)) list.push(item);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
