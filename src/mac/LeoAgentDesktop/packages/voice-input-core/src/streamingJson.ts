/**
 * Extracts the best-effort current value of a JSON string field from a partial
 * streaming response. The returned value is preview-only: final acceptance must
 * still parse the complete JSON object.
 */
export function extractJsonStringFieldSnapshot(text: string, field: string): string | null {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escapedField}"\\s*:\\s*"`).exec(text);
  if (!match) return null;
  let i = match.index + match[0].length;
  let result = '';
  while (i < text.length) {
    const char = text[i];
    if (char === '"') return result;
    if (char !== '\\') {
      result += char;
      i += 1;
      continue;
    }

    const escape = text[i + 1];
    if (!escape) break;
    switch (escape) {
      case '"':
      case '\\':
      case '/':
        result += escape;
        i += 2;
        break;
      case 'b':
        result += '\b';
        i += 2;
        break;
      case 'f':
        result += '\f';
        i += 2;
        break;
      case 'n':
        result += '\n';
        i += 2;
        break;
      case 'r':
        result += '\r';
        i += 2;
        break;
      case 't':
        result += '\t';
        i += 2;
        break;
      case 'u': {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return result;
        result += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        break;
      }
      default:
        result += escape;
        i += 2;
    }
  }
  return result || null;
}
