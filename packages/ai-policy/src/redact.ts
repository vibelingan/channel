const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g;

export function redactContactData(text: string): string {
  return text.replace(EMAIL, '[email redacted]').replace(PHONE, '[phone redacted]');
}
