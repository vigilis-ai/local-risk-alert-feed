/**
 * Simple CSV parser for handling Phoenix Open Data CSV responses.
 *
 * This is a lightweight parser that handles:
 * - Quoted fields with commas
 * - Escaped quotes within fields
 * - Header row parsing
 * - Type coercion for common patterns
 */

/**
 * Parse a CSV string into an array of objects.
 *
 * @param csvText - The raw CSV text
 * @param options - Parser options
 * @returns Array of parsed objects with headers as keys
 */
export function parseCSV<T extends Record<string, unknown> = Record<string, string>>(
  csvText: string,
  options: CSVParseOptions = {}
): T[] {
  const { delimiter = ',', hasHeader = true, trimFields = true } = options;

  const lines = splitCSVLines(csvText);
  if (lines.length === 0) {
    return [];
  }

  const headerLine = hasHeader ? lines[0] : null;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const headers = headerLine
    ? parseCSVLine(headerLine, delimiter).map((h) => (trimFields ? h.trim() : h))
    : [];

  const results: T[] = [];

  for (const line of dataLines) {
    if (line.trim() === '') continue;

    const values = parseCSVLine(line, delimiter);
    const obj: Record<string, unknown> = {};

    for (let i = 0; i < values.length; i++) {
      const key = headers[i] ?? `column_${i}`;
      let value: unknown = trimFields ? values[i].trim() : values[i];

      // Type coercion for common patterns
      if (options.coerceTypes !== false) {
        value = coerceValue(value as string);
      }

      obj[key] = value;
    }

    results.push(obj as T);
  }

  return results;
}

/**
 * Options for CSV parsing.
 */
export interface CSVParseOptions {
  /** Field delimiter (default: ',') */
  delimiter?: string;
  /** First line is header row (default: true) */
  hasHeader?: boolean;
  /** Trim whitespace from fields (default: true) */
  trimFields?: boolean;
  /** Attempt to coerce types (numbers, booleans) (default: true) */
  coerceTypes?: boolean;
}

/**
 * Split CSV text into lines, handling quoted newlines.
 */
function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      // Check for escaped quote
      if (inQuotes && text[i + 1] === '"') {
        currentLine += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        currentLine += char;
      }
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      // End of line
      if (currentLine.length > 0) {
        lines.push(currentLine);
      }
      currentLine = '';
      // Skip \r\n as single line ending
      if (char === '\r' && text[i + 1] === '\n') {
        i++;
      }
    } else {
      currentLine += char;
    }
  }

  // Add final line if exists
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Parse a single CSV line into fields.
 */
function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        currentField += '"';
        i++;
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      // End of field
      fields.push(currentField);
      currentField = '';
    } else {
      currentField += char;
    }
  }

  // Add final field
  fields.push(currentField);

  return fields;
}

/**
 * Attempt to coerce a string value to a more specific type.
 */
function coerceValue(value: string): unknown {
  // Empty or null-like values
  if (value === '' || value.toLowerCase() === 'null' || value.toLowerCase() === 'undefined') {
    return null;
  }

  // Boolean
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  // Number (integer or float)
  if (/^-?\d+$/.test(value)) {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= Number.MIN_SAFE_INTEGER && num <= Number.MAX_SAFE_INTEGER) {
      return num;
    }
  }

  if (/^-?\d*\.\d+$/.test(value)) {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      return num;
    }
  }

  // Return as string
  return value;
}

/**
 * Convert an array of objects to CSV string.
 */
export function toCSV<T extends Record<string, unknown>>(
  data: T[],
  options: { headers?: string[]; delimiter?: string } = {}
): string {
  if (data.length === 0) return '';

  const { delimiter = ',' } = options;
  const headers = options.headers ?? Object.keys(data[0]);

  const lines: string[] = [];

  // Header row
  lines.push(headers.map((h) => escapeCSVField(String(h), delimiter)).join(delimiter));

  // Data rows
  for (const row of data) {
    const values = headers.map((h) => {
      const value = row[h];
      if (value === null || value === undefined) return '';
      return escapeCSVField(String(value), delimiter);
    });
    lines.push(values.join(delimiter));
  }

  return lines.join('\n');
}

/**
 * Escape a field for CSV output.
 */
function escapeCSVField(value: string, delimiter: string): string {
  // Check if quoting is needed
  if (value.includes('"') || value.includes(delimiter) || value.includes('\n') || value.includes('\r')) {
    // Escape quotes by doubling them
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return value;
}
