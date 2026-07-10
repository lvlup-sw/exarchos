/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (true) {
    const [value, next] = parseField(line, i);
    fields.push(value);
    i = next;

    if (i < line.length && line[i] === ',') {
      i += 1;
      continue;
    }
    break;
  }

  return fields;
}

/**
 * Parse a single field starting at index `i`.
 * Returns the parsed (unescaped) field value and the index immediately
 * following the field (either at a comma separator or at `line.length`).
 */
function parseField(line: string, i: number): [string, number] {
  if (line[i] === '"') {
    return parseQuotedField(line, i);
  }
  return parseUnquotedField(line, i);
}

function parseQuotedField(line: string, i: number): [string, number] {
  // Skip the opening quote.
  i += 1;
  let value = '';

  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      if (line[i + 1] === '"') {
        // Escaped quote -> literal double quote.
        value += '"';
        i += 2;
        continue;
      }
      // Unescaped quote -> end of the quoted field.
      i += 1;
      break;
    }
    value += ch;
    i += 1;
  }

  // Tolerate (rather than crash on) any stray characters between the
  // closing quote and the next comma/end-of-line by folding them into the
  // field literally. Well-formed input never exercises this path.
  while (i < line.length && line[i] !== ',') {
    value += line[i];
    i += 1;
  }

  return [value, i];
}

function parseUnquotedField(line: string, i: number): [string, number] {
  const start = i;
  while (i < line.length && line[i] !== ',') {
    i += 1;
  }
  return [line.slice(start, i), i];
}
