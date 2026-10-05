import { describe, expect, it } from 'vitest';
import { summarizeConversation } from '../src/messaging/conversationSummary.js';
import type { ConversationDoc, MessageDoc, ToolCallTrace, TurnDoc } from '../src/messaging/types.js';

const conv = (status: ConversationDoc['status'], escalation_reason: string | null = null) => ({ _id: 'c', status, escalation_reason }) as ConversationDoc;
const inbound = (text: string) => ({ _id: text, direction: 'inbound', text }) as MessageDoc;
const call = (name: string, args: unknown, result: unknown, error: string | null = null): ToolCallTrace => ({ name, arguments: args, result, error, duration_ms: 10 });
const turn = (tool_calls: ToolCallTrace[], extra: Partial<TurnDoc> = {}) => ({ tool_calls, attempt: 1, error: null, final_status: null, guardrail: null, ...extra }) as TurnDoc;

describe('resumen de la conversación (sin LLM)', () => {
  it('conversación con cita agendada: motivo, acciones en orden y resultado', () => {
    const s = summarizeConversation(
      conv('cita_agendada'),
      [inbound('Hola, ¿tienen cita con dermatología mañana en la tarde?'), inbound('Sí, confirmo')],
      [
        turn([call('consultar_disponibilidad', { especialidad: 'dermatologia' }, { especialidad: 'Dermatología', dia: 'martes 6 de octubre', franja: 'tarde', total_horarios: 8 })]),
        turn([
          call('agendar_cita', {}, { especialidad: 'Dermatología', profesional: 'Dr. Felipe Martínez', dia: 'martes 6 de octubre', hora: '15:00', sede: 'Sede Norte', paciente: 'Ana Pérez' }),
        ]),
      ],
    );
    expect(s.reason).toBe('Hola, ¿tienen cita con dermatología mañana en la tarde?');
    expect(s.actions).toEqual([
      'Consultó disponibilidad de Dermatología para el martes 6 de octubre en la tarde: 8 horarios libres.',
      'Agendó Dermatología con Dr. Felipe Martínez el martes 6 de octubre a las 15:00 en Sede Norte.',
    ]);
    expect(s.appointment).toMatchObject({ profesional: 'Dr. Felipe Martínez', hora: '15:00', paciente: 'Ana Pérez' });
    expect(s.text).toMatch(/^El paciente escribió: «Hola, ¿tienen cita/);
    expect(s.text).toMatch(/Terminó con una cita agendada\.$/);
  });

  it('distingue temas respondidos de los que no estaban en la base de conocimiento', () => {
    const s = summarizeConversation(
      conv('resuelta_por_ia'),
      [inbound('¿Ayuno para glucosa?')],
      [
        turn([call('buscar_conocimiento', { pregunta: '¿Se requiere ayuno para glucosa?' }, { resultados: [{}] })]),
        turn([call('buscar_conocimiento', { pregunta: '¿Tienen cardiología?' }, { resultados: [], sin_informacion: true })]),
      ],
    );
    expect(s.topics).toEqual(['¿Se requiere ayuno para glucosa?']);
    expect(s.actions[0]).toBe('Consultó la base de conocimiento sobre: ¿Se requiere ayuno para glucosa?.');
    expect(s.actions.at(-1)).toBe('Sin información en la base de conocimiento para: ¿Tienen cardiología?.');
  });

  it('sin base de conocimiento: lo indica y el resultado incluye el motivo del escalamiento', () => {
    const s = summarizeConversation(conv('escalada', 'sin_base_de_conocimiento: la clínica no tiene documentos cargados'), [inbound('hola')], [
      turn([], { guardrail: 'sin_base_de_conocimiento', final_status: 'escalada' }),
    ]);
    expect(s.actions).toEqual(['Respondió automáticamente (sin LLM) porque la clínica no tiene base de conocimiento.']);
    expect(s.outcome).toBe('Se escaló a un asesor (sin_base_de_conocimiento: la clínica no tiene documentos cargados).');
  });

  it('registra intentos fallidos de agendar y fallas técnicas', () => {
    const s = summarizeConversation(conv('escalada', 'falla_tecnica'), [inbound('quiero cita')], [
      turn([call('agendar_cita', {}, null, 'horario_ocupado: Ese horario acaba de ser tomado')]),
      turn([], { error: 'proveedor caído', final_status: 'escalada', attempt: 3 }),
    ]);
    expect(s.actions).toEqual(['Intento de agendar sin éxito (horario_ocupado).', 'Falló el asistente tras 3 intentos (proveedor caído).']);
    expect(s.appointment).toBeNull();
  });

  it('una conversación vacía no rompe', () => {
    expect(summarizeConversation(conv('en_curso'), [], []).text).toBe('Conversación sin mensajes del paciente. La conversación sigue en curso.');
  });
});
