import { describe, expect, it } from 'vitest';
import { applyOutputGuardrails, OUT_OF_SCOPE_TEXT } from '../../src/assistant/guardrails.js';

describe('guardrails de salida', () => {
  it.each([
    ['bloque de código', '```python\nprint("Hola mundo")\n```', 'bloque_de_codigo'],
    ['código en línea', 'Claro: print("hola")', 'codigo_en_linea'],
    ['función JavaScript', 'function agendar() { return 1 }', 'codigo_en_linea'],
  ])('reemplaza respuestas con %s', (_n, text, rule) => {
    expect(applyOutputGuardrails(text)).toEqual({ text: OUT_OF_SCOPE_TEXT, blockedBy: rule });
  });

  it('deja pasar respuestas normales de la clínica', () => {
    const text = 'Para el examen de glucosa debes ayunar de 8 a 12 horas; puedes tomar agua.';
    expect(applyOutputGuardrails(text)).toEqual({ text, blockedBy: null });
  });
});
