import { stripVTControlCharacters } from 'node:util';
export function localSiteUrl(output) {
  const match = stripVTControlCharacters(output).match(/Local\s+http:\/\/127\.0\.0\.1:(\d+)\//);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? `http://127.0.0.1:${port}`
    : undefined;
}
