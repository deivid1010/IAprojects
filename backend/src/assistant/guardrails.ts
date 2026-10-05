// Controles deterministas sobre la respuesta del modelo, después del LLM y antes
// de enviarla. El prompt define el alcance, pero un prompt se puede saltar; estas
// reglas no dependen de que el modelo obedezca.

export const OUT_OF_SCOPE_TEXT =
  'Solo puedo ayudarte con información de la clínica y con tus citas (horarios, servicios, preparación de exámenes, agendamiento). ¿En qué te ayudo con eso?';

export interface GuardrailResult {
  text: string;
  /** Regla que bloqueó la respuesta original, o null si pasó. */
  blockedBy: string | null;
}

const RULES: { name: string; test: (text: string) => boolean }[] = [
  // Un asistente de WhatsApp de una clínica nunca responde con código.
  { name: 'bloque_de_codigo', test: (t) => /```/.test(t) },
  { name: 'codigo_en_linea', test: (t) => /\b(def |function |import |console\.log\(|print\(|<script|SELECT .+ FROM )/i.test(t) },
];

export function applyOutputGuardrails(text: string): GuardrailResult {
  const rule = RULES.find((r) => r.test(text));
  return rule ? { text: OUT_OF_SCOPE_TEXT, blockedBy: rule.name } : { text, blockedBy: null };
}
