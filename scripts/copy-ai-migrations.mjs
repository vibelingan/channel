import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = process.argv[2];
if (!target) throw new Error('usage: copy-ai-migrations.mjs <target-directory>');

const source = resolve(import.meta.dirname, '../packages/ai-store/src/migrations');
const destination = resolve(process.cwd(), target);
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
