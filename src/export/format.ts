/** Escaping and number formats shared by every document the export writes. Pure code, runs in Node and the browser. */

/** True for code units that XML 1.0 does not allow, including lone surrogates. */
function isInvalidXmlChar(code: number): boolean {
  if (code === 0x9 || code === 0xa || code === 0xd) return false;
  if (code < 0x20) return true;
  if (code >= 0xd800 && code <= 0xdfff) return true; // callers pass code points, so any surrogate seen here is lone
  return code === 0xfffe || code === 0xffff;
}

const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for XML 1.0 and removes characters XML cannot hold. */
export function xmlEscape(text: string): string {
  let out = '';
  for (const char of text) { // iterates code points; a lone surrogate arrives as one code unit
    if (isInvalidXmlChar(char.codePointAt(0)!)) continue;
    out += XML_ENTITIES[char] ?? char;
  }
  return out;
}

/** Escapes text for HTML element content and attribute values. */
export function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]!);
}

/** Escapes text for one Markdown table cell. */
export function mdCell(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\\`*_[\]|<>&]/g, (char) => {
      if (char === '<') return '&lt;';
      if (char === '>') return '&gt;';
      if (char === '&') return '&amp;';
      return `\\${char}`;
    });
}

/** Escapes one CSV field. A leading formula character gets a quote prefix so spreadsheets read the field as text. */
export function csvField(text: string): string {
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[,"\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`;
}

/** At most four decimals, trailing zeros removed, and never "-0". */
export function fmtNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Cannot write a non-finite number.');
  const fixed = value.toFixed(4);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

const oneDecimal = (value: number): string => {
  const fixed = value.toFixed(1);
  return fixed === '-0.0' ? '0.0' : fixed;
};

export function formatMm(value: number): string {
  return oneDecimal(value);
}

export function formatSize(size: { x: number; y: number; z: number }): string {
  return `${formatMm(size.x)} × ${formatMm(size.y)} × ${formatMm(size.z)}`;
}

export function formatCm3(mm3: number): string {
  return oneDecimal(mm3 / 1000);
}

const two = (value: number): string => String(value).padStart(2, '0');

/** `yyyy-MM-dd HH:mm` in local time. */
export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** `yyyyMMdd-HHmm` in local time, for file names. */
export function formatStamp(date: Date): string {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}

// A multiple of 3, so every slice but the last encodes without padding and the pieces can be concatenated.
const BASE64_SLICE = 32_760;

export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_SLICE) {
    out += btoa(String.fromCharCode.apply(null, bytes.subarray(offset, offset + BASE64_SLICE) as unknown as number[]));
  }
  return out;
}
