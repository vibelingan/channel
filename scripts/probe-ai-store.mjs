#!/usr/bin/env node
/**
 * MIU 0 / P0 — the operational store probe.
 *
 * This is the single highest-stakes probe in the AI assistant plan. LLD-001's
 * entire takeover design rests on one behaviour: a conditional
 * `UPDATE ... WHERE <predicate> RETURNING ...` that, when it waits on a row
 * lock and the predicate has since become false, returns ZERO ROWS rather than
 * an error or a stale success. If the target store cannot do that, the design
 * does not survive and ADR-001 must be reopened — so run this before anything
 * else in MIU 0, and before a single line of MIU 2c schema is written.
 *
 * It is deliberately dependency-light and destructive only inside its own
 * schema (`ai_probe`), which it drops on the way out.
 *
 * Usage:
 *   node scripts/probe-ai-store.mjs --url postgres://user:pass@host:5432/db
 *   PGURL=postgres://... node scripts/probe-ai-store.mjs
 *   node scripts/probe-ai-store.mjs --url ... --json > evidence.json
 *
 * Exit codes:
 *   0  every required behaviour present  → the design is buildable on this store
 *   1  a required behaviour is missing   → STOP, reopen ADR-001
 *   2  could not connect / probe error   → not a verdict, fix and re-run
 */

import { Client } from 'pg';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const URL = flag('url') ?? process.env.PGURL ?? process.env.DATABASE_URL;
const AS_JSON = has('json');

if (has('help') || !URL) {
  console.error(
    'usage: node scripts/probe-ai-store.mjs --url postgres://user:pass@host:port/db [--json]',
  );
  process.exit(URL ? 0 : 2);
}

const results = [];
const record = (id, requirement, pass, detail) => {
  results.push({ id, requirement, pass, detail });
  if (!AS_JSON) {
    const mark = pass === true ? '  PASS' : pass === false ? '  FAIL' : '  INFO';
    console.log(`${mark}  ${id}  ${requirement}`);
    if (detail) console.log(`        ${detail}`);
  }
};

const connect = async () => {
  const client = new Client({ connectionString: URL, application_name: 'miu0-store-probe' });
  await client.connect();
  return client;
};

async function main() {
  const a = await connect();

  // ── Context ────────────────────────────────────────────────────────────
  const version = (await a.query('select version()')).rows[0].version;
  record('S0', 'server reachable', true, version.split(',')[0]);

  const defaultIsolation = (await a.query('show default_transaction_isolation')).rows[0]
    .default_transaction_isolation;
  record(
    'S1',
    "default isolation is 'read committed'",
    defaultIsolation === 'read committed',
    `observed: ${defaultIsolation}. LLD-001 §4.4 requires READ COMMITTED — under REPEATABLE READ a lost fence raises a serialization error instead of returning zero rows, so "someone else took over first" becomes a 500.`,
  );

  await a.query('drop schema if exists ai_probe cascade');
  await a.query('create schema ai_probe');
  await a.query(`
    create table ai_probe.conversations (
      id             int primary key,
      status         text not null,
      mode_version   int  not null,
      next_event_seq bigint not null default 1
    )`);
  await a.query(`
    create table ai_probe.events (
      conversation_id int not null,
      sequence        bigint not null,
      primary key (conversation_id, sequence)
    )`);
  await a.query(`
    create table ai_probe.runs (
      id              int primary key,
      conversation_id int not null,
      status          text not null,
      claim_token     uuid
    )`);
  await a.query("insert into ai_probe.conversations values (1,'BOT_ACTIVE',1,1)");

  // ── S2: conditional UPDATE ... RETURNING yields zero rows, not an error ──
  const miss = await a.query(
    "update ai_probe.conversations set status='X' where id=1 and mode_version=999 returning id",
  );
  record(
    'S2',
    'a conditional UPDATE whose predicate fails returns zero rows',
    miss.rowCount === 0,
    `rowCount=${miss.rowCount}. This is Primitive A's entire contract.`,
  );

  // ── S3: RETURNING sees post-update values ───────────────────────────────
  const bump = await a.query(
    'update ai_probe.conversations set next_event_seq = next_event_seq + 1 ' +
      'where id=1 returning next_event_seq - 1 as allocated',
  );
  record(
    'S3',
    'RETURNING exposes post-update values (sequence allocation)',
    bump.rows[0]?.allocated === '1' || bump.rows[0]?.allocated === 1,
    `allocated=${bump.rows[0]?.allocated}; expected 1. LLD-001 §4.2 allocates the sequence and fences in one statement using this.`,
  );

  // ── S4: THE ONE THAT MATTERS ────────────────────────────────────────────
  // Two transactions. B's conditional UPDATE blocks on A's row lock. A then
  // commits a change that invalidates B's predicate. B must return ZERO ROWS.
  const b = await connect();
  await a.query('begin');
  await a.query('update ai_probe.conversations set mode_version = 2 where id = 1'); // holds the lock

  // A serialization failure here is not a probe error — it IS the verdict, and
  // the most consequential one. Catch it rather than crashing, or the probe
  // reports "not a verdict" for the single result that matters most.
  const blocked = b
    .query(
      'update ai_probe.conversations set status=$1 where id=1 and mode_version=$2 returning id',
      ['HUMAN_ACTIVE', 1],
    )
    .then((r) => ({ ok: true, rowCount: r.rowCount }))
    .catch((error) => ({ ok: false, message: String(error?.message ?? error) }));

  // Give B time to actually reach the lock rather than racing our own commit.
  await new Promise((r) => setTimeout(r, 300));
  const waiting = await a.query(
    "select count(*)::int as n from pg_stat_activity where wait_event_type='Lock'",
  );
  await a.query('commit');
  const blockedResult = await blocked;

  if (blockedResult.ok) {
    record(
      'S4',
      'a blocked conditional UPDATE re-evaluates its predicate after the lock clears',
      blockedResult.rowCount === 0,
      `waiters observed: ${waiting.rows[0].n}; blocked statement rowCount=${blockedResult.rowCount} (must be 0). THIS IS THE LOAD-BEARING BEHAVIOUR: it is what makes a stale takeover lose instead of silently overwriting.`,
    );
  } else {
    record(
      'S4',
      'a blocked conditional UPDATE re-evaluates its predicate after the lock clears',
      false,
      `the blocked statement RAISED instead of returning zero rows: "${blockedResult.message}". This is the exact failure LLD-001 §4.4 predicts above READ COMMITTED: "someone else took over first" becomes a 500 rather than a clean conflict. Either pin READ COMMITTED, or the takeover paths need explicit serialization-failure retry.`,
    );
  }

  // ── S5: rollback un-does a counter bump (gapless sequence) ──────────────
  const before = (await a.query('select next_event_seq from ai_probe.conversations where id=1'))
    .rows[0].next_event_seq;
  await a.query('begin');
  await a.query('update ai_probe.conversations set next_event_seq = next_event_seq + 1 where id=1');
  await a.query('rollback');
  const after = (await a.query('select next_event_seq from ai_probe.conversations where id=1'))
    .rows[0].next_event_seq;
  record(
    'S5',
    'rollback restores the sequence counter (gaplessness, LLD-001 §8)',
    String(before) === String(after),
    `before=${before} after=${after}. A Postgres SEQUENCE would NOT restore — which is exactly why §8 forbids replacing the counter column with one.`,
  );

  // ── S6: clock_timestamp() advances inside a transaction, now() does not ──
  // Must be SEPARATE statements. Inside one statement's target list the
  // evaluation order relative to pg_sleep is not guaranteed, so both
  // clock_timestamp() calls can land on the same instant and the probe reports
  // a false FAIL against a perfectly good server. (This probe did exactly that
  // on its first run.)
  await a.query('begin');
  const t1 = await a.query('select now() as n, clock_timestamp() as c');
  await a.query('select pg_sleep(0.2)');
  const t2 = await a.query('select now() as n, clock_timestamp() as c');
  await a.query('commit');
  // Compare epoch milliseconds, not String(Date): the pg driver returns Date
  // objects and String() renders them at second resolution, so two timestamps
  // 200ms apart stringify identically. (This probe did that too, on its second
  // run — the same false FAIL, one layer down.)
  const ms = (v) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
  const nowFixed = ms(t1.rows[0].n) === ms(t2.rows[0].n);
  const clockMoves = ms(t2.rows[0].c) > ms(t1.rows[0].c);
  record(
    'S6',
    'now() is transaction-start; clock_timestamp() advances',
    nowFixed && clockMoves,
    `now() fixed=${nowFixed}, clock_timestamp() advanced=${clockMoves}. Every lease deadline in LLD-001 uses clock_timestamp() for this reason: a renewal written with now() after a long lock wait is already expired.`,
  );

  // ── S7: partial unique index (one live run per conversation, I9) ─────────
  await a.query(
    "create unique index one_live_run on ai_probe.runs (conversation_id) where status in ('CREATING','RUNNING')",
  );
  await a.query("insert into ai_probe.runs values (1,1,'RUNNING',null)");
  let partialHeld = false;
  try {
    await a.query("insert into ai_probe.runs values (2,1,'RUNNING',null)");
  } catch {
    partialHeld = true;
  }
  await a.query("insert into ai_probe.runs values (3,1,'COMPLETED',null)"); // outside the predicate
  record(
    'S7',
    'partial unique index enforces one live run per conversation',
    partialHeld,
    'a second live run was rejected; a terminal run was accepted alongside.',
  );

  // ── S8: ON CONFLICT DO UPDATE ... WHERE ... RETURNING (the claim shape) ──
  const claim1 = await a.query(
    `insert into ai_probe.runs (id, conversation_id, status, claim_token)
       values (9, 9, 'CREATING', gen_random_uuid())
     on conflict (id) do update set claim_token = gen_random_uuid()
       where ai_probe.runs.status = 'CREATING'
     returning id, claim_token`,
  );
  const claim2 = await a.query(
    `insert into ai_probe.runs (id, conversation_id, status, claim_token)
       values (9, 9, 'CREATING', gen_random_uuid())
     on conflict (id) do update set claim_token = gen_random_uuid()
       where ai_probe.runs.status = 'COMPLETED'
     returning id, claim_token`,
  );
  record(
    'S8',
    'ON CONFLICT DO UPDATE ... WHERE ... RETURNING behaves as a claim',
    claim1.rowCount === 1 && claim2.rowCount === 0,
    `first claim rows=${claim1.rowCount} (want 1), non-matching claim rows=${claim2.rowCount} (want 0). LLD-001 §7's engine_operations claim uses this.`,
  );

  // ── S9: composite FK (run bound to its conversation, Round-2 finding 4) ──
  let compositeFkHeld = false;
  try {
    await a.query(
      'alter table ai_probe.runs add constraint runs_conv_uk unique (conversation_id, id)',
    );
    await a.query(
      'alter table ai_probe.events add constraint events_run_fk ' +
        'foreign key (conversation_id, sequence) references ai_probe.events (conversation_id, sequence) ' +
        'deferrable initially immediate',
    );
    compositeFkHeld = true;
  } catch (error) {
    compositeFkHeld = false;
    record('S9', 'composite keys/FKs available', false, String(error).slice(0, 160));
  }
  if (compositeFkHeld) {
    record(
      'S9',
      'composite unique keys and FKs available',
      true,
      'needed to bind an event to (conversation, run).',
    );
  }

  // ── S10: explicit isolation level can be set per transaction ─────────────
  await a.query('begin isolation level read committed');
  const lvl = (await a.query('show transaction_isolation')).rows[0].transaction_isolation;
  await a.query('commit');
  record(
    'S10',
    'transaction isolation can be set explicitly per transaction',
    lvl === 'read committed',
    `observed ${lvl}. MIU 2a asserts this at connection setup rather than inheriting a pooler default.`,
  );

  // ── S11: advisory of pooling mode (transaction pooling breaks session state) ─
  try {
    await a.query('begin');
    await a.query('select 1');
    await a.query('commit');
    record(
      'S11',
      'multi-statement transactions survive the connection path',
      true,
      'if this store sits behind a transaction-pooling proxy (e.g. pgbouncer in ' +
        'transaction mode), verify separately that session-scoped state is not assumed.',
    );
  } catch (error) {
    record(
      'S11',
      'multi-statement transactions survive the connection path',
      false,
      String(error).slice(0, 160),
    );
  }

  await a.query('drop schema if exists ai_probe cascade');
  await a.end();
  await b.end();
}

main()
  .then(() => {
    const required = results.filter((r) => r.pass === false);
    if (AS_JSON) {
      console.log(
        JSON.stringify(
          {
            probedAt: new Date().toISOString(),
            verdict: required.length ? 'FAIL' : 'PASS',
            results,
          },
          null,
          2,
        ),
      );
    } else {
      console.log('');
      if (required.length === 0) {
        console.log('VERDICT: PASS — the store supports the LLD-001 design. MIU 2a may proceed.');
      } else {
        console.log(`VERDICT: FAIL — ${required.length} required behaviour(s) missing:`);
        for (const r of required) console.log(`  - ${r.id} ${r.requirement}`);
        console.log('');
        console.log('STOP. Do not write MIU 2c schema. Reopen ADR-001: the takeover design');
        console.log('needs a different primitive, and 14 of 17 MIUs are affected.');
      }
    }
    process.exit(required.length ? 1 : 0);
  })
  .catch((error) => {
    console.error('PROBE ERROR (not a verdict — fix and re-run):');
    console.error(error?.message ?? error);
    process.exit(2);
  });
