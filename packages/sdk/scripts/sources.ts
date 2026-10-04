import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The committed interface files the guard's tables are made from, read from the repository root.

export const ROOT = join(import.meta.dirname, '..', '..', '..');
const INTERFACES = join(ROOT, 'contracts', 'src', 'interfaces');

export function readSources(): { idl: unknown; interfaces: Record<string, string> } {
  const interfaces: Record<string, string> = {};
  for (const file of readdirSync(INTERFACES).filter((f) => f.endsWith('.sol')))
    interfaces[file] = readFileSync(join(INTERFACES, file), 'utf8');
  return { idl: JSON.parse(readFileSync(join(ROOT, 'idl', 'basket.json'), 'utf8')), interfaces };
}
