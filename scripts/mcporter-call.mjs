import { execFileSync } from 'node:child_process';

export function callMcporter(
  selector,
  args,
  { cwd, timeoutMs = 180_000, run = execFileSync } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('MCP timeout must be a positive integer');
  const output = run(
    'npx',
    [
      'mcporter',
      'call',
      selector,
      '--args',
      JSON.stringify(args),
      '--output',
      'json',
      '--timeout',
      String(timeoutMs),
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs + 10_000,
    },
  );
  return parseMcporterResult(output, selector);
}

export function parseMcporterResult(output, selector) {
  const start = output.indexOf('{');
  if (start < 0) throw new Error(`MCP tool ${selector} returned no JSON result`);
  let result;
  try {
    result = JSON.parse(output.slice(start));
  } catch {
    throw new Error(`MCP tool ${selector} returned invalid JSON`);
  }
  // mcporter reports RPC failures as JSON even when its process exits successfully.
  if (result?.isError === true || result?.error)
    throw new Error(`MCP tool ${selector} returned a transport error`);
  return result;
}
