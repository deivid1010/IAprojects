import { describe, expect, it } from 'vitest';
import { buildToolRegistry } from '../../src/assistant/tools/index.js';
import type { ToolContext, ToolOutcome } from '../../src/assistant/tools/types.js';
import { clinicSchema } from '../../src/catalog/schemas.js';
import type { ConversationDoc, MessageDoc } from '../../src/messaging/types.js';
import { fakeAgenda, PDF_MESSAGE_AT, testClinic } from '../agenda/fakes.js';
import { fakeKnowledge } from '../knowledge/fakes.js';

const conversation = { _id: 'k:+573001112233', clinic_id: testClinic._id, phone: '+573001112233', status: 'en_curso' } as ConversationDoc;
const message = { _id: 'wamid.001', timestamp: PDF_MESSAGE_AT, clinic_id: testClinic._id, conversation_id: conversation._id } as MessageDoc;
const ctx: ToolContext = { clinic: testClinic, conversation, message, now: PDF_MESSAGE_AT };

function setup() {
  const { agenda, appointments } = fakeAgenda();
  const registry = buildToolRegistry(testClinic, { agenda, knowledge: fakeKnowledge() });
  const call = (name: string, args: unknown) => registry.execute(name, JSON.stringify(args), ctx);
  return { registry, appointments, call };
}

const errorCode = (o: ToolOutcome) => (o.ok ? null : o.error.code);

const bookArgs = {
  especialidad: 'dermatologia',
  sede: 'sede-norte',
  profesional: 'Dr. Felipe Martínez',
  fecha: 'manana',
  hora: '14:00',
  nombre_paciente: 'Ana María Pérez',
  datos_adicionales: { documento: '1130000000', eps: null },
};

describe('definiciones de tools que ve el LLM', () => {
  it('expone las tools como function tools en modo strict', () => {
    const defs = setup().registry.definitions();
    expect(defs.map((d) => d.name)).toEqual(['buscar_conocimiento', 'consultar_disponibilidad', 'agendar_cita', 'escalar_a_humano']);
    for (const d of defs) {
      expect(d).toMatchObject({ type: 'function', strict: true });
      // strict exige: todas las propiedades en required y sin propiedades extra.
      const params = d.parameters as { properties: object; required: string[]; additionalProperties: boolean };
      expect(params.additionalProperties).toBe(false);
      expect([...params.required].sort()).toEqual(Object.keys(params.properties).sort());
    }
  });

  it('el esquema de agendar_cita incluye los datos que pide esta clínica', () => {
    const agendar = setup().registry.definitions().find((d) => d.name === 'agendar_cita')!;
    const datos = (agendar.parameters as any).properties.datos_adicionales;
    expect(Object.keys(datos.properties)).toEqual(['documento', 'eps']);
    expect(datos.properties.documento.type).toBe('string'); // obligatorio
    expect(datos.properties.eps.type).toEqual(['string', 'null']); // opcional
    expect(datos.required).toEqual(['documento', 'eps']);
  });

  it('una clínica sin sedes no le muestra el parámetro "sede" al modelo', () => {
    const sinSedes = clinicSchema.parse({ ...testClinic, locations: [] });
    const defs = buildToolRegistry(sinSedes, { agenda: fakeAgenda().agenda, knowledge: fakeKnowledge() }).definitions();
    for (const d of defs) expect(Object.keys((d.parameters as any).properties)).not.toContain('sede');
  });
});

describe('consultar_disponibilidad', () => {
  it('caso del enunciado: dermatología mañana en la tarde → horarios del martes 6', async () => {
    const out = await setup().call('consultar_disponibilidad', { especialidad: 'Dermatología', sede: null, fecha: 'manana', franja: 'tarde' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data).toMatchObject({ fecha: '2026-10-06', dia: 'martes 6 de octubre', especialidad: 'Dermatología', total_horarios: 8 });
    expect((out.data.horarios as any[])[0]).toMatchObject({ hora: '14:00', profesional: 'Dr. Felipe Martínez', sede: 'Sede Norte' });
  });

  it.each([
    ['especialidad inexistente', { especialidad: 'cardiologia', sede: null, fecha: 'manana', franja: null }, 'especialidad_inexistente'],
    ['sede inexistente', { especialidad: 'dermatologia', sede: 'sede oeste', fecha: 'manana', franja: null }, 'sede_inexistente'],
    ['fecha pasada', { especialidad: 'dermatologia', sede: null, fecha: '2026-10-01', franja: null }, 'fecha_pasada'],
    ['festivo', { especialidad: 'dermatologia', sede: null, fecha: '2026-10-12', franja: null }, 'festivo'],
    ['fuera del horizonte', { especialidad: 'dermatologia', sede: null, fecha: '2026-11-30', franja: null }, 'fuera_de_horizonte'],
    ['fecha que no entiende', { especialidad: 'dermatologia', sede: null, fecha: 'el jueves', franja: null }, 'fecha_invalida'],
    ['franja inválida', { especialidad: 'dermatologia', sede: null, fecha: 'manana', franja: 'noche' }, 'argumentos_invalidos'],
  ])('rechaza con un error que el modelo puede corregir: %s', async (_name, args, code) => {
    expect(errorCode(await setup().call('consultar_disponibilidad', args))).toBe(code);
  });

  it('el error de especialidad lista las opciones válidas', async () => {
    const out = await setup().call('consultar_disponibilidad', { especialidad: 'cardiologia', sede: null, fecha: 'manana', franja: null });
    expect(out.ok ? null : out.error.especialidades_disponibles).toHaveLength(3);
  });

  it('sin cupos ese día, sugiere próximas fechas con disponibilidad real', async () => {
    // Domingo 11: no hay agenda.
    const out = await setup().call('consultar_disponibilidad', { especialidad: 'pediatria', sede: null, fecha: '2026-10-11', franja: null });
    expect(out.ok && out.data.total_horarios).toBe(0);
    const next = out.ok ? (out.data.proximas_fechas_con_disponibilidad as { fecha: string }[]) : [];
    expect(next.map((n) => n.fecha)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']); // el 12 es festivo
  });
});

describe('agendar_cita', () => {
  it('agenda y marca la conversación como cita_agendada', async () => {
    const { call, appointments } = setup();
    const out = await call('agendar_cita', bookArgs);
    expect(out).toMatchObject({ ok: true, effects: { conversationStatus: 'cita_agendada' } });
    expect(out.ok && out.data).toMatchObject({ estado: 'confirmada', fecha: '2026-10-06', hora: '14:00', sede: 'Sede Norte', profesional: 'Dr. Felipe Martínez' });
    expect(appointments.rows[0]).toMatchObject({ patientPhone: '+573001112233', customFields: { documento: '1130000000' }, sourceMessageId: 'wamid.001' });
  });

  it('acepta el profesional por nombre parcial o por id', async () => {
    expect((await setup().call('agendar_cita', { ...bookArgs, profesional: 'felipe' })).ok).toBe(true);
    expect((await setup().call('agendar_cita', { ...bookArgs, profesional: 'dr-felipe-martinez' })).ok).toBe(true);
  });

  it.each([
    ['profesional que no presta el servicio', { profesional: 'Dra. Laura Gómez' }, 'profesional_inexistente'],
    ['hora en formato inválido', { hora: '2pm' }, 'argumentos_invalidos'],
    ['hora que no existe en la agenda (fuera del bloque)', { hora: '19:00' }, 'horario_fuera_de_agenda'],
    ['hora desalineada con la duración del servicio', { hora: '14:10' }, 'horario_fuera_de_agenda'],
    ['sede donde el profesional no atiende ese día', { sede: 'sede-sur' }, 'horario_fuera_de_agenda'],
    ['sin sede, en una clínica con sedes', { sede: null }, 'sede_requerida'],
    ['falta un dato obligatorio de la clínica', { datos_adicionales: { documento: '', eps: null } }, 'datos_faltantes'],
    ['fecha pasada', { fecha: '2026-10-02' }, 'fecha_pasada'],
  ])('no agenda y explica el error: %s', async (_name, override, code) => {
    const { call, appointments } = setup();
    expect(errorCode(await call('agendar_cita', { ...bookArgs, ...override }))).toBe(code);
    expect(appointments.rows).toHaveLength(0);
  });

  it('horario ocupado: no agenda y devuelve alternativas reales del mismo día', async () => {
    const { registry, call, appointments } = setup();
    // Otro paciente, desde otra conversación, toma las 14:00 primero.
    const otherPatient: ToolContext = {
      ...ctx,
      conversation: { ...conversation, phone: '+573009999999' },
      message: { ...message, _id: 'wamid.otro' },
    };
    expect((await registry.execute('agendar_cita', JSON.stringify(bookArgs), otherPatient)).ok).toBe(true);

    const out = await call('agendar_cita', bookArgs);
    expect(errorCode(out)).toBe('horario_ocupado');
    const alts = out.ok ? [] : (out.error.alternativas_mismo_dia as { hora: string }[]);
    expect(alts.map((a) => a.hora)).not.toContain('14:00');
    expect(alts.length).toBeGreaterThan(0);
    expect(appointments.rows).toHaveLength(1);
  });

  it('si el mismo turno se reintenta, devuelve la cita existente en vez de duplicarla', async () => {
    const { call, appointments } = setup();
    const first = await call('agendar_cita', bookArgs);
    const again = await call('agendar_cita', bookArgs);
    expect(again.ok && first.ok && again.data.cita_id).toBe(first.ok && first.data.cita_id);
    expect(appointments.rows).toHaveLength(1);
  });
});

describe('escalar_a_humano y errores del registro', () => {
  it('escala con el motivo indicado', async () => {
    const out = await setup().call('escalar_a_humano', { motivo: 'Paciente pide hablar con una persona' });
    expect(out).toMatchObject({ ok: true, effects: { conversationStatus: 'escalada', escalationReason: 'Paciente pide hablar con una persona' } });
  });

  it('una tool inexistente o un JSON inválido vuelven al modelo como error, no como excepción', async () => {
    const { registry } = setup();
    expect(errorCode(await registry.execute('borrar_todo', '{}', ctx))).toBe('herramienta_desconocida');
    expect(errorCode(await registry.execute('agendar_cita', '{no json', ctx))).toBe('json_invalido');
  });
});

describe('buscar_conocimiento', () => {
  const hit = {
    documentSlug: 'preparacion-examenes',
    documentTitle: 'Preparación para exámenes de laboratorio',
    heading: 'Ayuno',
    content: 'Preparación para exámenes de laboratorio — Ayuno\n- Glucosa: ayuno de 8 a 12 horas.',
    similarity: 0.71234,
  };

  it('devuelve los fragmentos con su fuente y busca siempre en la clínica del mensaje', async () => {
    const knowledge = fakeKnowledge([hit]);
    const registry = buildToolRegistry(testClinic, { agenda: fakeAgenda().agenda, knowledge });
    const out = await registry.execute('buscar_conocimiento', JSON.stringify({ pregunta: '¿Hay que ayunar para la glucosa?' }), ctx);

    expect(out.ok && out.data.resultados).toEqual([
      { fuente: 'Preparación para exámenes de laboratorio — Ayuno', contenido: hit.content, similitud: 0.71 },
    ]);
    expect(knowledge.queries).toEqual([{ clinicId: testClinic._id, query: '¿Hay que ayunar para la glucosa?' }]);
  });

  it('sin resultados, le indica al modelo que no hay información y que no invente', async () => {
    const registry = buildToolRegistry(testClinic, { agenda: fakeAgenda().agenda, knowledge: fakeKnowledge([]) });
    const out = await registry.execute('buscar_conocimiento', JSON.stringify({ pregunta: '¿Cuánto cuesta la consulta?' }), ctx);
    expect(out.ok && out.data).toMatchObject({ resultados: [], sin_informacion: true });
    expect(out.ok && String(out.data.indicacion)).toMatch(/No la completes con conocimiento general/);
  });

  it('el modelo no puede elegir la clínica: no existe ese parámetro', () => {
    const def = setup().registry.definitions().find((d) => d.name === 'buscar_conocimiento')!;
    expect(Object.keys((def.parameters as any).properties)).toEqual(['pregunta']);
  });
});

describe('sin agenda (la base de conocimiento no describe servicios)', () => {
  it('no se cargan las herramientas de agendamiento', () => {
    const sinAgenda = clinicSchema.parse({ ...testClinic, services: [], locations: [] });
    const names = buildToolRegistry(sinAgenda, { agenda: fakeAgenda().agenda, knowledge: fakeKnowledge() }).definitions().map((d) => d.name);
    expect(names).toEqual(['buscar_conocimiento', 'escalar_a_humano']);
  });
});

describe('consultar_disponibilidad: lista recortada', () => {
  it('informa el rango completo y advierte que la lista está recortada', async () => {
    const out = await setup().call('consultar_disponibilidad', { especialidad: 'medicina general', sede: 'sede-norte', fecha: 'manana', franja: null });
    expect(out.ok && out.data).toMatchObject({ total_horarios: 15, primer_horario: '07:00', ultimo_horario: '11:40' });
    expect(out.ok && String(out.data.nota)).toMatch(/entre 07:00 y 11:40; aquí se listan solo los primeros 12/);
  });
});
