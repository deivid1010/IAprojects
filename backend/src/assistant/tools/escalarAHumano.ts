import { z } from 'zod';
import { invalidArgs } from './registry.js';
import type { Tool } from './types.js';

const argsSchema = z.object({ motivo: z.string().trim().min(3) });

export function escalarAHumanoTool(): Tool {
  return {
    name: 'escalar_a_humano',
    description:
      'Marca la conversación para que la atienda un asesor humano. Úsala si el paciente lo pide, si hay una queja, una urgencia o un tema que requiere criterio clínico, o si no puedes resolver con seguridad (por ejemplo, la información no está en los documentos).',
    parameters: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Motivo breve del escalamiento, para el coordinador.' } },
      required: ['motivo'],
      additionalProperties: false,
    },
    async execute(rawArgs) {
      const parsed = argsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      return {
        ok: true,
        data: { escalada: true, indicacion: 'Dile al paciente que un asesor de la clínica continuará la conversación por este medio.' },
        effects: { conversationStatus: 'escalada', escalationReason: parsed.data.motivo },
      };
    },
  };
}
