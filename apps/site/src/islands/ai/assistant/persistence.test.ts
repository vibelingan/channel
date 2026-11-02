import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { type PersistedAssistant, sessionAssistantPersistence } from './persistence';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
const record = (patch: Partial<PersistedAssistant> = {}): PersistedAssistant => ({
  version: 1,
  conversationId: randomUUID(),
  credential: 'c'.repeat(40),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  conversationKey: 'website-chat',
  open: true,
  ...patch,
});

test('one tab keeps one versioned record per site and business, merged by its owners', () => {
  const storage = new MemoryStorage();
  const site = sessionAssistantPersistence('supplychainsai.com:website_sales', storage);
  const other = sessionAssistantPersistence('other.example:website_sales', storage);
  site.save(record());
  site.update({
    turn: { turnKey: 'turn_12345', idempotencyKey: 'turn_12345', message: 'And for 700?' },
  });
  assert.equal(site.load()?.turn?.message, 'And for 700?');
  assert.equal(other.load(), null);
  site.update({ turn: undefined });
  assert.equal(site.load()?.turn, undefined);
  site.clear();
  assert.equal(site.load(), null);
});

test('expired, foreign-version or malformed records are dropped, never trusted', () => {
  const storage = new MemoryStorage();
  const p = sessionAssistantPersistence('s', storage);
  p.save(record({ expiresAt: new Date(Date.now() - 1).toISOString() }));
  assert.equal(p.load(), null);
  for (const bad of [
    { ...record(), version: 2 },
    { ...record(), credential: 'short' },
    { ...record(), conversationId: 'not-a-uuid' },
    { ...record(), extra: 'field' },
    { ...record(), turn: { turnKey: 'k', idempotencyKey: 'k', message: '' } },
  ]) {
    storage.setItem([...storage.values.keys()][0] ?? 'x', JSON.stringify(bad));
    assert.equal(p.load(), null, JSON.stringify(bad));
  }
  storage.setItem([...storage.values.keys()][0] ?? 'x', '{not json');
  assert.equal(p.load(), null);
});

test('blocked storage degrades to an in-memory conversation without throwing', () => {
  const blocked = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  const p = sessionAssistantPersistence('s', blocked);
  p.save(record());
  assert.equal(p.load(), null);
  p.clear();
});
