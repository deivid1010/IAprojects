// El LLM puede referirse a un servicio, sede o profesional por su id o por su
// nombre ("Dermatología", "dermatologia", "la Dra. Camila"). Se resuelve aquí
// de forma determinista; si es ambiguo o no existe, se devuelve un error con
// las opciones válidas para que el modelo corrija o pregunte.

const TITLES = /^(dra?|doctora?)\s+/;

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(TITLES, '');
}

export type MatchResult<T> = { ok: true; item: T } | { ok: false; reason: 'no_existe' | 'ambiguo'; candidates: T[] };

/** Coincidencia exacta por id o nombre; si no, coincidencia parcial única. */
export function matchOne<T>(items: T[], query: string, keys: (item: T) => string[]): MatchResult<T> {
  const q = normalize(query);
  if (!q) return { ok: false, reason: 'no_existe', candidates: [] };

  const exact = items.filter((i) => keys(i).some((k) => normalize(k) === q));
  if (exact.length === 1) return { ok: true, item: exact[0]! };

  const partial = items.filter((i) => keys(i).some((k) => normalize(k).includes(q)));
  if (partial.length === 1) return { ok: true, item: partial[0]! };
  if (partial.length > 1) return { ok: false, reason: 'ambiguo', candidates: partial };
  return { ok: false, reason: 'no_existe', candidates: [] };
}
