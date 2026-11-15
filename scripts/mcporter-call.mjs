import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function mcporterCommand(selector, args, cwd, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('MCP timeout must be a positive integer');
  return [
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
  ];
}

export function callMcporter(
  selector,
  args,
  { cwd, timeoutMs = 180_000, run = execFileSync } = {},
) {
  const output = run(...mcporterCommand(selector, args, cwd, timeoutMs));
  return parseMcporterResult(output, selector);
}

/** Same command and checks as callMcporter, without blocking other calls while it runs. */
export async function callMcporterAsync(
  selector,
  args,
  { cwd, timeoutMs = 180_000, run = execFileAsync } = {},
) {
  const { stdout } = await run(...mcporterCommand(selector, args, cwd, timeoutMs));
  return parseMcporterResult(stdout, selector);
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
