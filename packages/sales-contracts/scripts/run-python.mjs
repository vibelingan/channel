import { spawnSync } from 'node:child_process';
import { pythonCommand } from './python-command.mjs';
const result = spawnSync(
  pythonCommand,
  ['-m', 'unittest', 'discover', '-s', 'python', '-p', 'test_*.py'],
  { stdio: 'inherit', cwd: new URL('..', import.meta.url) },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
