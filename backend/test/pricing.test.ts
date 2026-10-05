import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../src/assistant/pricing.js';

describe('estimateCostUsd', () => {
  it('cobra la entrada en caché a su precio reducido', () => {
    // gpt-6-luna: 1.700 sin caché × 0,10 + 1.300 en caché × 0,01 + 120 salida × 0,50 (por millón)
    expect(estimateCostUsd('gpt-6-luna', { input: 3000, cachedInput: 1300, output: 120 })).toBe(0.000243);
  });

  it('devuelve null para modelos sin precio conocido o sin modelo (motor stub)', () => {
    expect(estimateCostUsd('modelo-desconocido', { input: 1, cachedInput: 0, output: 1 })).toBeNull();
    expect(estimateCostUsd(null, { input: 0, cachedInput: 0, output: 0 })).toBeNull();
  });
});
