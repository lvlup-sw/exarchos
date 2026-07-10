/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const n = line.length;
  let i = 0;

  while (true) {
    let field = '';

    if (i < n && line[i] === '"') {
      // Quoted field: consume opening quote and read until the closing quote.
      i++;
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          // A doubled quote ("") is a literal quote inside the field.
          if (i + 1 < n && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            // Unescaped quote closes the field.
            i++;
            break;
          }
        } else {
          field += ch;
          i++;
        }
      }
      // Any characters after the closing quote (until the next comma) are
      // appended literally, matching common CSV reader behavior.
      while (i < n && line[i] !== ',') {
        field += line[i];
        i++;
      }
    } else {
      // Unquoted field: taken literally until the next comma.
      while (i < n && line[i] !== ',') {
        field += line[i];
        i++;
      }
    }

    fields.push(field);

    if (i < n && line[i] === ',') {
      i++; // consume the separator
      if (i === n) {
        // Trailing comma implies a final empty field.
        fields.push('');
        break;
      }
      // Otherwise continue with the next field.
    } else {
      // End of line.
      break;
    }
  }

  return fields;
}
