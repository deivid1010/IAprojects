import { z } from 'zod';
import type { KnowledgeRetriever } from '../../knowledge/retriever.js';
import { invalidArgs } from './registry.js';
import type { Tool } from './types.js';

const argsSchema = z.object({ pregunta: z.string().trim().min(3).max(500) });

export function buscarConocimientoTool(retriever: KnowledgeRetriever): Tool {
  return {
    name: 'buscar_conocimiento',
    description:
      'Busca en los documentos oficiales de la clínica (sedes, horarios de atención, servicios y qué cubren, preparación de exámenes, políticas de cancelación, pagos, qué llevar a la cita). Úsala para cualquier pregunta informativa y responde solo con lo que devuelva.',
    parameters: {
      type: 'object',
      properties: {
        pregunta: { type: 'string', description: 'La pregunta del paciente, reformulada de forma clara y completa.' },
      },
      required: ['pregunta'],
      additionalProperties: false,
    },

    async execute(rawArgs, ctx) {
      const parsed = argsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);

      // La clínica sale del contexto del mensaje, nunca de los argumentos del
      // modelo: una clínica no puede leer documentos de otra.
      const hits = await retriever.search(ctx.clinic._id, parsed.data.pregunta);
      if (hits.length === 0) {
        return {
          ok: true,
          data: {
            resultados: [],
            sin_informacion: true,
            indicacion:
              'Los documentos de la clínica no tienen esta información. Díselo al paciente con honestidad y ofrécele hablar con un asesor. No la completes con conocimiento general.',
          },
        };
      }
      return {
        ok: true,
        data: {
          resultados: hits.map((h) => ({
            fuente: h.heading ? `${h.documentTitle} — ${h.heading}` : h.documentTitle,
            contenido: h.content,
            similitud: Math.round(h.similarity * 100) / 100,
          })),
          indicacion: 'Responde solo con lo que dicen estos fragmentos. Si no responden exactamente la pregunta, dilo.',
        },
      };
    },
  };
}
