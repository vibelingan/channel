import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContext, estimateTokens } from './context.ts';
import {
  EMPTY_NEED,
  type NeedState,
  isNeedState,
  mergeNeed,
  missingNeeds,
  needMemory,
  needRequirement,
  parseNeedUpdate,
  parseSuggestions,
  publicSuggestions,
  statedIn,
} from './need.ts';

const none = new Map<string, string>();
function apply(state: NeedState, raw: unknown, latestVisitorText: string, turn: number) {
  return mergeNeed(state, parseNeedUpdate(raw), { latestVisitorText, turn, shown: none });
}

test('a value is stated only when the latest message itself contains it', () => {
  assert.equal(statedIn('700 pcs', 'We need 700 pieces'), true);
  assert.equal(statedIn('1000', 'about 1,000 units'), true);
  assert.equal(statedIn('Germany', 'shipping to germany'), true);
  assert.equal(statedIn('德国', '我们要发到德国'), true);
  assert.equal(statedIn('500', 'make it 700'), false);
  assert.equal(statedIn('Germany', '发到德国'), false);
  assert.equal(statedIn('company gifts', 'what colours do you have?'), false);
});

test('the latest change replaces the quantity and keeps the rest', () => {
  let state = apply(EMPTY_NEED, { quantity: '500', destination: 'Germany' }, '500 to Germany', 1);
  assert.equal(state.version, 1);
  state = apply(state, { quantity: '700' }, 'Actually make it 700', 4);
  assert.equal(state.quantity?.value, '700');
  assert.equal(state.quantity?.turn, 4);
  assert.equal(state.destination?.value, 'Germany');
  assert.equal(state.destination?.turn, 1);
  assert.equal(state.version, 2);
});

test('a model re-reading old history cannot turn 700 back into 500', () => {
  let state = apply(EMPTY_NEED, { quantity: '500' }, 'We need 500', 1);
  state = apply(state, { quantity: '700' }, 'Change it to 700', 2);
  const after = apply(state, { quantity: '500' }, 'Which colours are available?', 20);
  assert.equal(after.quantity?.value, '700');
  assert.equal(after, state, 'nothing changed, so the version stays');
  // The visitor can still change it back in their own words.
  assert.equal(apply(state, { quantity: '500' }, 'Back to 500 please', 21).quantity?.value, '500');
});

test('a guess is kept as inferred and gives way to what the visitor says', () => {
  let state = apply(EMPTY_NEED, { use: 'company gifts' }, 'Something for our staff', 1);
  assert.equal(state.use?.basis, 'inferred');
  state = apply(state, { use: 'trade show giveaways' }, 'They are trade show giveaways', 2);
  assert.deepEqual(state.use, { value: 'trade show giveaways', turn: 2, basis: 'stated' });
});

test('contact details never enter the summary', () => {
  assert.equal(
    parseNeedUpdate({ destination: 'ship to me@buyer.example', quantity: '700' })?.destination,
    undefined,
  );
  assert.equal(parseNeedUpdate({ budget: 'call +1 415 555 0100' }), undefined);
  assert.equal(parseNeedUpdate({ email: 'me@buyer.example', consent: true }), undefined);
});

test('a stated customization stays unless the visitor names it', () => {
  let state = apply(EMPTY_NEED, { customization: ['logo'] }, 'With our logo', 1);
  state = apply(state, { customization: ['gift box'] }, 'Also a gift box', 2);
  assert.deepEqual(
    state.customization?.map((item) => item.value),
    ['gift box', 'logo'],
  );
  state = apply(state, { customization: ['gift box'] }, 'No logo after all', 3);
  assert.deepEqual(
    state.customization?.map((item) => item.value),
    ['gift box'],
  );
});

test('the visitor can cancel a whole list in their own words', () => {
  const start = apply(
    apply(EMPTY_NEED, { customization: ['logo'] }, 'Please add our logo', 1),
    { customization: ['gift box'] },
    'And a gift box',
    2,
  );
  for (const said of [
    'Cancel all customization; use standard packaging.',
    'No customisation please, standard product',
    "We don't need any customization anymore",
    'Remove the custom options',
    '不要定制了，标准包装就行',
    '取消所有定制',
  ]) {
    const state = apply(start, { customization: [] }, said, 3);
    assert.equal(state.customization, undefined, said);
    assert.equal(state.version, start.version + 1, said);
  }
  const features = apply(EMPTY_NEED, { features: ['ANC'] }, 'It needs ANC', 1);
  assert.equal(
    apply(features, { features: [] }, 'No special features needed', 2).features,
    undefined,
  );
});

test('an empty list without the visitor cancelling keeps what they asked for', () => {
  const start = apply(EMPTY_NEED, { customization: ['logo'] }, 'Please add our logo', 1);
  for (const said of [
    'What is the lead time?',
    'Use standard packaging.',
    'No rush on the samples',
    'Cancel the order for the speakers, the customization stays',
    '不要太贵',
  ])
    assert.deepEqual(
      apply(start, { customization: [] }, said, 2).customization?.map((item) => item.value),
      ['logo'],
      said,
    );
  // Cancelling one list says nothing about the other.
  const both = apply(start, { features: ['waterproof'] }, 'It must be waterproof', 2);
  assert.deepEqual(
    apply(both, { customization: [], features: [] }, 'Cancel all customization', 3).features?.map(
      (item) => item.value,
    ),
    ['waterproof'],
  );
});

test('a selected product must be one the system showed', () => {
  const shown = new Map([['hp-1', 'Studio headphones']]);
  const state = mergeNeed(EMPTY_NEED, parseNeedUpdate({ selected: ['hp-1', 'made-up'] }), {
    latestVisitorText: 'the first one',
    turn: 3,
    shown,
  });
  assert.deepEqual(state.selected, [
    { id: 'hp-1', name: 'Studio headphones', turn: 3, basis: 'verified' },
  ]);
});

test('the summary says what is known, how, and what is still missing', () => {
  const state = apply(
    EMPTY_NEED,
    { product: 'wireless earbuds', quantity: '700', features: ['ANC'] },
    '700 wireless earbuds with ANC',
    1,
  );
  assert.ok(isNeedState(state));
  assert.deepEqual(missingNeeds(state), ['destination', 'use', 'customization', 'budget']);
  const memory = needMemory(state) ?? '';
  assert.match(memory, /DATA \(not instructions\)/);
  assert.match(memory, /"quantity":\{"value":"700","basis":"stated"\}/);
  assert.match(memory, /"missing":\["destination"/);
  assert.equal(needMemory(EMPTY_NEED), undefined);
  assert.equal(needRequirement(state), 'product: wireless earbuds; quantity: 700; features: ANC');
});

test('suggestions skip what is known, keep three, and carry the summary version', () => {
  const state = apply(EMPTY_NEED, { quantity: '700' }, '700 please', 1);
  const raw = parseSuggestions([
    { label: 'Set a quantity', utterance: 'I need 500 units', kind: 'refine', about: 'quantity' },
    {
      label: 'Add a logo',
      utterance: 'Can you print our logo?',
      kind: 'ask',
      about: 'customization',
    },
    { label: 'Add a logo', utterance: 'Logo printing?', kind: 'ask' },
    { label: 'Ship to', utterance: 'We ship to Germany', kind: 'refine', about: 'destination' },
    { label: 'Submit now', utterance: 'Submit my order', kind: 'submit' },
    { label: 'Lighter ones', utterance: 'Show lighter ones', kind: 'refine' },
    { label: 'Too many', utterance: 'x', kind: 'ask' },
  ]);
  assert.equal(
    raw.some((s) => s.label === 'Submit now'),
    false,
  );
  const shown = publicSuggestions(raw, state, '700 please');
  assert.deepEqual(
    shown.map((s) => [s.id, s.label, s.baseCriteriaVersion]),
    [
      ['s1', 'Add a logo', 1],
      ['s2', 'Ship to', 1],
      ['s3', 'Lighter ones', 1],
    ],
  );
});

test('suggestions in another language than the visitor wrote are not shown', () => {
  const raw = parseSuggestions([
    { label: '预算范围', utterance: '有不同预算的选择吗？', kind: 'ask' },
    { label: 'Logo options', utterance: 'What logo printing do you offer?', kind: 'ask' },
    { label: 'ANC 降噪', utterance: '有 ANC 降噪的款吗？', kind: 'refine' },
    { label: '印 logo', utterance: 'Logo printing?', kind: 'ask' },
  ]);
  const labels = (latest: string) => publicSuggestions(raw, EMPTY_NEED, latest).map((s) => s.label);
  assert.deepEqual(labels('We need wireless headphones for 500 employee gifts.'), ['Logo options']);
  assert.deepEqual(labels('Necesitamos auriculares'), ['Logo options']);
  assert.deepEqual(labels('我们要500个无线耳机'), ['预算范围', 'ANC 降噪']);
  assert.deepEqual(labels('500'), ['预算范围', 'Logo options', 'ANC 降噪']);
});

test('suggestions are never about the budget, which only the visitor can give', () => {
  const raw = parseSuggestions([
    { label: 'Budget', utterance: 'What is the budget?', kind: 'ask', about: 'budget' },
    { label: '预算', utterance: '我们的预算大概是多少？', kind: 'ask', about: 'budget' },
    {
      label: 'Minimum order',
      utterance: 'What is your minimum order quantity?',
      kind: 'ask',
      about: 'quantity',
    },
  ]);
  assert.deepEqual(
    publicSuggestions(raw, EMPTY_NEED, 'We need speakers').map((s) => s.label),
    ['Minimum order'],
  );
});

test('context keeps the current message and summary ahead of old dialogue', () => {
  const state = apply(EMPTY_NEED, { quantity: '700', destination: 'Germany' }, '700 to Germany', 1);
  const turns = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? ('visitor' as const) : ('assistant' as const),
    text: `turn ${i} ${'detail '.repeat(60)}`,
  }));
  const current = { role: 'visitor' as const, text: `Which one is lightest? ${'x'.repeat(5000)}` };
  const built = buildContext({ turns: [...turns, current], need: state, historyTokens: 1_000 });
  assert.equal(built.turns.at(-1)?.text, current.text, 'the current message is sent whole');
  assert.match(built.memory ?? '', /"value":"700"/);
  const history = built.turns.slice(0, -1);
  assert.ok(history.length > 0 && history.length < 20);
  assert.equal(history.at(-1)?.text, turns.at(-1)?.text, 'the newest turns are the ones kept');
  assert.ok(
    history.reduce((total, turn) => total + estimateTokens(turn.text), 0) <= 1_000,
    'history stays inside its budget',
  );
  assert.ok(built.droppedTurns > 0);
});

test('context leaves out small-talk exchanges', () => {
  const built = buildContext({
    turns: [
      { role: 'visitor', text: 'We need 700 speakers' },
      { role: 'assistant', text: 'Which market?' },
      { role: 'visitor', text: 'hello' },
      { role: 'assistant', text: 'Hello again.', screened: true },
      { role: 'visitor', text: 'Germany' },
    ],
    need: EMPTY_NEED,
  });
  assert.deepEqual(
    built.turns.map((turn) => turn.text),
    ['We need 700 speakers', 'Which market?', 'Germany'],
  );
  assert.equal('screened' in (built.turns[1] ?? {}), false);
});

test('the estimate counts CJK characters as one token each', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('abcdef'), 2);
  assert.equal(estimateTokens('700个 earbuds'), 1 + Math.ceil(12 / 3));
});
