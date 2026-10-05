import type { ReasoningEffort } from 'openai/resources/shared';
import type { ResponsesClient } from '../../assistant/openaiEngine.js';
import { extractedAgendaSchema, type ExtractedAgenda } from './buildAgenda.js';

/** Extrae la agenda de un texto. Se inyecta: los tests usan uno falso, sin red. */
export type AgendaExtractor = (documentText: string, opts: { signal?: AbortSignal }) => Promise<ExtractedAgenda>;

const hhmmOrNull = { type: ['string', 'null'], description: 'HH:mm en 24 horas, o null si el documento no lo dice' };
const days = { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'Días ISO: 1 lunes … 6 sábado, 7 domingo' };

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['locations', 'services', 'professionals', 'notes'],
  properties: {
    locations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'address', 'hours'],
        properties: {
          name: { type: 'string', description: 'Nombre de la sede copiado tal cual del documento' },
          address: { type: ['string', 'null'] },
          hours: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['days', 'start', 'end'],
              properties: { days, start: { type: 'string' }, end: { type: 'string' } },
            },
          },
        },
      },
    },
    services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'duration_min'],
        properties: {
          name: { type: 'string', description: 'Nombre del servicio copiado tal cual del documento' },
          duration_min: { type: ['integer', 'null'], description: 'Duración en minutos, o null si no se indica' },
        },
      },
    },
    professionals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'services', 'schedules'],
        properties: {
          name: { type: 'string', description: 'Nombre del profesional copiado tal cual (con su título: Dr., Dra., Nut., etc.)' },
          services: { type: 'array', items: { type: 'string' }, description: 'Nombres exactos de la lista services que presta' },
          schedules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['location', 'days', 'start', 'end'],
              properties: {
                location: { type: 'string', description: 'Nombre exacto de una sede de la lista locations, o "Teleconsulta"' },
                days,
                start: hhmmOrNull,
                end: hhmmOrNull,
              },
            },
          },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Ambigüedades encontradas (p. ej. "rota según agenda")' },
  },
};

const INSTRUCTIONS = `Extraes la agenda de un negocio a partir de su documento de base de conocimiento: sedes con su horario de atención, servicios agendables con su duración y profesionales con los servicios que prestan y sus horarios por sede.

Reglas:
- Extrae solo lo que está escrito. No inventes sedes, servicios, profesionales, días ni horas.
- Copia los nombres exactamente como aparecen en el documento.
- Días en formato ISO (1 lunes … 7 domingo). "Lunes a viernes" = [1,2,3,4,5]. Horas en formato HH:mm de 24 horas ("2:00 p. m." = "14:00"; "12:00 m." = "12:00").
- Si el documento dice en qué sede y qué días atiende un profesional pero no a qué hora, usa start y end en null (el sistema usará el horario de la sede).
- La teleconsulta es una modalidad, no un servicio: nunca la pongas en services. Sus horarios van en el profesional como una entrada con location "Teleconsulta", solo si el documento da días y horas concretos.
- En services del profesional usa los nombres de tu lista services que correspondan a su especialidad.
- Si algo es ambiguo (por ejemplo "rota según agenda"), no lo conviertas en horarios: anótalo en notes.
- Si el documento no describe una agenda, devuelve listas vacías.`;

const MAX_DOCUMENT_CHARS = 80_000;

/** Extractor con la Responses API y salida JSON estricta. */
export function openAIAgendaExtractor(client: ResponsesClient, model: string, reasoningEffort: ReasoningEffort): AgendaExtractor {
  return async (documentText, { signal }) => {
    const response = await client.create(
      {
        model,
        instructions: INSTRUCTIONS,
        input: documentText.slice(0, MAX_DOCUMENT_CHARS),
        reasoning: { effort: reasoningEffort },
        max_output_tokens: 8000,
        store: false,
        text: { format: { type: 'json_schema', name: 'agenda', schema: JSON_SCHEMA, strict: true } },
      },
      { signal: signal ?? new AbortController().signal },
    );
    const raw = response.output_text?.trim();
    if (!raw) throw new Error(`el modelo no devolvió la agenda (estado: ${response.status ?? 'desconocido'})`);
    return extractedAgendaSchema.parse(JSON.parse(raw));
  };
}
