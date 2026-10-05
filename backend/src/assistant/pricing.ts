// Precios por millón de tokens (USD), tier estándar. Fuente: página oficial de
// precios de OpenAI, consultada el 2026-10-04. El costo se calcula y se guarda
// al registrar cada turno: si el precio cambia después, las trazas conservan
// lo que costó en su momento.
export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

const PRICES: Record<string, ModelPrice> = {
  'gpt-6-luna': { inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5 },
  'gpt-6.1-sol': { inputPerM: 2.0, cachedInputPerM: 0.1, outputPerM: 10.0 },
  'gpt-6-astra': { inputPerM: 10.0, cachedInputPerM: 1.0, outputPerM: 50.0 },
  'gpt-5-nano': { inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4 },
  'gpt-5-mini': { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2.0 },
  'gpt-5.4-mini': { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
};

/** Costo estimado de un turno, o null si el modelo no está en la tabla. */
export function estimateCostUsd(model: string | null, tokens: { input: number; cachedInput: number; output: number }): number | null {
  const price = model ? PRICES[model] : undefined;
  if (!price) return null;
  const uncached = Math.max(0, tokens.input - tokens.cachedInput);
  const cost = (uncached * price.inputPerM + tokens.cachedInput * price.cachedInputPerM + tokens.output * price.outputPerM) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8; // 8 decimales: los turnos cuestan fracciones de centavo
}
