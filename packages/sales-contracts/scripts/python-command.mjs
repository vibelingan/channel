import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const local = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
export const pythonCommand =
  process.env.SALES_CONTRACTS_PYTHON ?? (existsSync(local) ? local : 'python3');
