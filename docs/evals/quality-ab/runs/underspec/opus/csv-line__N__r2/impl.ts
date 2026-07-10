/** Parse ONE CSV record (a single line) into its fields (RFC 4180 style). */
export function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  const length = line.length;
  let index = 0;

  // Each iteration parses exactly one field, then either consumes a separating
  // comma (and loops for the next field) or hits end-of-line (and returns).
  for (;;) {
    let value = '';

    if (index < length && line[index] === '"') {
      // Quoted field: the very first character is a double quote.
      index += 1; // drop the opening quote (never part of the value)

      while (index < length) {
        const ch = line[index];
        if (ch === '"') {
          // A double quote inside a quoted field is either an escaped quote
          // ("" -> ") or the closing quote of the field.
          if (line[index + 1] === '"') {
            value += '"';
            index += 2;
          } else {
            index += 1; // consume the closing quote
            break;
          }
        } else {
          // Any other character (including commas) is part of the value.
          value += ch;
          index += 1;
        }
      }

      // Lenient handling of malformed input such as `"a"b`: anything between
      // the closing quote and the next comma is appended literally.
      while (index < length && line[index] !== ',') {
        value += line[index];
        index += 1;
      }
    } else {
      // Unquoted field: taken literally up to the next comma. This preserves
      // interior quotes and whitespace (e.g. `a"b` -> the 3-char field `a"b`).
      while (index < length && line[index] !== ',') {
        value += line[index];
        index += 1;
      }
    }

    fields.push(value);

    if (index < length && line[index] === ',') {
      index += 1; // consume the separator and move to the next field
      if (index === length) {
        // A trailing comma implies one final, empty field.
        fields.push('');
        return fields;
      }
    } else {
      // End of the record.
      return fields;
    }
  }
}
