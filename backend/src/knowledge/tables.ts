// Tablas → una línea por fila, con cada valor junto a su columna.
//
// Al indexar, una tabla aplanada celda por celda ("Profesional / Especialidad /
// Dr. Carlos Mejía / Medicina general / …") obliga al modelo a adivinar qué valor
// va con qué columna: ahí se cruzan nombres, sedes y precios. Con una fila por
// línea, cada dato viaja con su contexto aunque la fila termine sola en un
// fragmento.

const FIELD_SEPARATOR = ' | ';

/**
 * Convierte una tabla (matriz de celdas) en líneas de texto.
 * - 2 columnas → "clave: valor" (tablas de datos tipo Campo / Dato).
 * - N columnas con encabezado → "Col1: v1 | Col2: v2 | …".
 * - Si la primera celda del encabezado está vacía, la tabla está transpuesta (las
 *   columnas son entidades, p. ej. sedes): "Etiqueta — Col1: v1 | Col2: v2".
 */
export function tableToLines(matrix: string[][], opts: { firstRowIsHeader: boolean }): string[] {
  const rows = matrix.map((r) => r.map(clean)).filter((r) => r.some(Boolean));
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));

  if (width <= 1) return rows.map((r) => r[0]!).filter(Boolean);

  if (width === 2) {
    const body = opts.firstRowIsHeader && rows.length > 1 ? rows.slice(1) : rows;
    return body.filter((r) => r[0] || r[1]).map((r) => (r[0] && r[1] ? `${r[0]}: ${r[1]}` : r[0] || r[1]!));
  }

  const [header, ...body] = opts.firstRowIsHeader ? rows : [rows[0]!.map((_, i) => `Columna ${i + 1}`), ...rows];
  if (body.length === 0) return [header!.filter(Boolean).join(FIELD_SEPARATOR)];
  const transposed = !header![0];

  return body.map((row) => {
    const start = transposed ? 1 : 0;
    const fields: string[] = [];
    for (let i = start; i < width; i++) {
      const value = row[i];
      if (!value) continue;
      fields.push(header![i] ? `${header![i]}: ${value}` : value);
    }
    const line = fields.join(FIELD_SEPARATOR);
    return transposed && row[0] ? `${row[0]} — ${line}` : line;
  });
}

/** Tablas Markdown con barras (| a | b |) → una línea por fila. El resto del texto queda igual. */
export function markdownTablesToLines(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isRow = (l: string | undefined) => l !== undefined && /^\s*\|.*\|\s*$/.test(l);
    const isSeparator = (l: string | undefined) => l !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
    if (isRow(lines[i]) && isSeparator(lines[i + 1])) {
      const matrix: string[][] = [splitRow(lines[i]!)];
      let j = i + 2;
      while (isRow(lines[j])) matrix.push(splitRow(lines[j++]!));
      out.push(...tableToLines(matrix, { firstRowIsHeader: true }).map((l) => `- ${l}`));
      i = j - 1;
    } else {
      out.push(lines[i]!);
    }
  }
  return out.join('\n');
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Quita marcas de Markdown y espacios sobrantes de una celda. */
function clean(cell: string): string {
  return cell
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- PDF ---------------------------------------------------------------------
// Un PDF no guarda tablas: solo textos con su posición. Se reconstruyen las
// líneas (textos a la misma altura) y las columnas (un hueco horizontal grande
// entre dos textos). Varias líneas seguidas con la misma cantidad de columnas
// se tratan como tabla, con la primera como encabezado.

export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

const CELL_MARK = '\u0000';

/** Textos posicionados de una página → líneas, con las columnas marcadas. */
export function pdfItemsToLines(items: PositionedText[]): string[] {
  const visible = items.filter((i) => i.str.trim());
  const rows: PositionedText[][] = [];
  for (const item of [...visible].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0]!.y - item.y) <= Math.max(2, item.fontSize * 0.3));
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => {
    const sorted = row.sort((a, b) => a.x - b.x);
    let line = '';
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]!;
      if (i > 0) {
        const prev = sorted[i - 1]!;
        const gap = cur.x - (prev.x + prev.width);
        // Hueco de más de ~1,5 veces el tamaño de letra: otra columna.
        line += gap > cur.fontSize * 1.5 ? CELL_MARK : gap > cur.fontSize * 0.15 ? ' ' : '';
      }
      line += cur.str.trim();
    }
    return line;
  });
}

/** Líneas con columnas marcadas → texto, convirtiendo las tablas a una línea por fila. */
export function pdfLinesToText(lines: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = (l: string | undefined) => (l === undefined ? 0 : l.split(CELL_MARK).length);
    const width = cells(lines[i]);
    let j = i;
    while (width >= 2 && cells(lines[j + 1]) === width) j++;
    if (width >= 2 && j > i) {
      const matrix = lines.slice(i, j + 1).map((l) => l.split(CELL_MARK));
      out.push(...tableToLines(matrix, { firstRowIsHeader: width !== 2 }).map((l) => `- ${l}`));
      i = j;
    } else {
      out.push(lines[i]!.split(CELL_MARK).join(' '));
    }
  }
  return out.join('\n');
}
