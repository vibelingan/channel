import type { JsonFileAdapter } from './json-adapter.ts';

/** Inject a little demo data so the admin UI has something to show on first run. */
export function seed(adapter: JsonFileAdapter): void {
  adapter.seedIfEmpty('members', [
    {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+1-555-0100',
      role: 'admin',
      status: 'active',
      notes: 'Seed admin member.',
    },
    {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      phone: '+1-555-0101',
      role: 'partner',
      status: 'pending',
    },
  ]);

  adapter.seedIfEmpty('applications', [
    {
      company: 'Acme Channels',
      contactName: 'John Doe',
      email: 'john@acme.example',
      phone: '+1-555-0200',
      status: 'new',
      message: 'Interested in becoming a reseller partner.',
    },
  ]);
}
