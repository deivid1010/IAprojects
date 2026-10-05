export interface Chunk {
  index: number;
  heading: string | null;
  /** Texto que se vectoriza y se le entrega al modelo, con su contexto. */
  content: string;
}

export interface ChunkOptions {
  /** Tamaño máximo del cuerpo de un fragmento, en caracteres. */
  maxChars: number;
  /** Párrafos que se repiten entre fragmentos consecutivos de una sección larga. */
  overlapParagraphs: number;
}

const DEFAULTS: ChunkOptions = { maxChars: 900, overlapParagraphs: 1 };

/**
 * Parte un documento Markdown por secciones (##). Cada fragmento lleva el
 * título del documento y de su sección: "¿Hay que ayunar?" encuentra el
 * fragmento de "Preparación para exámenes — Ayuno" aunque el párrafo no diga
 * "examen". Las secciones largas se parten por párrafos, con solapamiento.
 *
 * Los documentos de una clínica son cortos y están organizados por tema, así
 * que la sección es la unidad natural: partir por tamaño fijo cortaría listas
 * y horarios a la mitad.
 */
export function chunkMarkdown(doc: { title: string; content: string }, options: Partial<ChunkOptions> = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  // Ruta de títulos vigente: [nivel 1, nivel 2, nivel 3] y, debajo, la subsección
  // en negrita (p. ej. una pregunta frecuente "**¿Atienden por EPS?**").
  const path: (string | null)[] = [null, null, null];
  let bold: string | null = null;
  const open = () => sections.push({ heading: [...path, bold].filter(Boolean).join(' › ') || null, lines: [] });
  let seenContent = false;

  for (const line of doc.content.split('\n')) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = clean(h[2]!);
      // El título del documento (si abre el texto como "# Título") ya va en doc.title.
      if (level === 1 && !seenContent && text === clean(doc.title)) continue;
      path[level - 1] = text;
      for (let i = level; i < path.length; i++) path[i] = null;
      bold = null;
      open();
      continue;
    }
    // Una línea entera en negrita (pregunta frecuente, objeción) abre una subsección.
    const b = /^\s*\*\*([^*]+)\*\*\s*$/.exec(line);
    if (b && seenContent) {
      bold = clean(b[1]!);
      open();
      continue;
    }
    if (line.trim()) seenContent = true;
    sections.at(-1)!.lines.push(line);
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const body = section.lines.join('\n').trim();
    if (!body) continue;
    const header = section.heading ? `${doc.title} — ${section.heading}` : doc.title;
    for (const part of splitBody(body, opts)) {
      chunks.push({ index: chunks.length, heading: section.heading, content: `${header}\n${part}` });
    }
  }
  return chunks;
}

function splitBody(body: string, opts: ChunkOptions): string[] {
  if (body.length <= opts.maxChars) return [body];

  // Párrafos: bloques separados por línea en blanco o ítems de lista. Un párrafo
  // más largo que el máximo (frecuente en texto extraído de PDF) se parte por
  // líneas, luego por oraciones y, como último recurso, por tamaño.
  const paragraphs = body
    .split(/\n\s*\n|\n(?=\s*[-*]\s)/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => splitLong(p, opts.maxChars));
  const parts: string[] = [];
  let current: string[] = [];

  for (const p of paragraphs) {
    const candidate = [...current, p].join('\n');
    if (current.length > 0 && candidate.length > opts.maxChars) {
      parts.push(current.join('\n'));
      current = current.slice(-opts.overlapParagraphs);
      // El solapamiento solo se repite si cabe junto al párrafo nuevo.
      if ([...current, p].join('\n').length > opts.maxChars) current = [];
    }
    current.push(p);
  }
  if (current.length) parts.push(current.join('\n'));
  return parts;
}

function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  for (const separator of [/\n/, /(?<=[.!?;:])\s+/]) {
    const parts = text.split(separator).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) return pack(parts, maxChars).flatMap((p) => splitLong(p, maxChars));
  }
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) pieces.push(text.slice(i, i + maxChars));
  return pieces;
}

/** Junta partes consecutivas mientras quepan en el máximo. */
function pack(parts: string[], maxChars: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if (current && current.length + 1 + part.length > maxChars) {
      out.push(current);
      current = part;
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Quita marcas de Markdown de un título ("**Sedes**" → "Sedes"). */
function clean(text: string): string {
  return text.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
}
