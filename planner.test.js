const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPlanner = require('./planner.js');
const emptyBoard = () => Array(100).fill('unknown');
const fast = { samples: 32, chains: 2, burn: 20, thin: 3, stages: [2, 4], maxMs: 600000, seed: 17 };
test('sampled fleets obey hits, misses, ship counts and no-touch rules', () => {
  const planner = createPlanner(), board = emptyBoard();
  board[44] = 'hit'; board[45] = 'hit'; board[9] = 'miss'; board[70] = 'miss';
  const context = planner.prepare(board), rng = planner.random(71);
  const initial = planner.seedLayout(context, rng, 20000);
  assert.equal(initial.layout.length, 10);
  const chain = planner.makeChain(context, initial.layout, rng);
  for (let iteration = 0; iteration < 250; iteration++) {
    chain.step();
    const occupied = new Set(), counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const p of chain.layout) {
      counts[p.length]++;
      assert.equal(p.cells.some(i => ['miss', 'auto', 'sunk'].includes(board[i])), false);
      assert.equal(p.halo.some(i => occupied.has(i)), false);
      p.cells.forEach(i => occupied.add(i));
    }
    assert.deepEqual(counts, { 1: 4, 2: 3, 3: 2, 4: 1 });
    assert.equal(occupied.size, 20);
    assert.equal(occupied.has(44) && occupied.has(45), true);
  }
});
test('rollouts finish without repeated shots and do not change observations', () => {
  const planner = createPlanner(), input = emptyBoard(), context = planner.prepare(input);
  const layout = planner.seedLayout(context, planner.random(24), 20000).layout;
  for (const first of [0, 44, 99]) {
    const shots = planner.rollout(context, planner.makeWorld(layout), first, 7);
    assert.equal(shots >= 20 && shots <= 100, true);
    assert.deepEqual(Array.from(context.board), Array(100).fill(0));
  }
});
test('last known deck needs exactly one shot', async () => {
  const planner = createPlanner({ 1: 0, 2: 1, 3: 0, 4: 0 });
  const board = Array(100).fill('miss'); board[44] = 'hit'; board[45] = 'unknown';
  const result = await planner.analyze(board, fast);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.cells, [45]);
  assert.equal(result.estimates[0].mean, 1); assert.equal(result.estimates[0].hitProbability, 1);
});
test('lookahead prefers a middle shot for a two-deck ship in four cells', async () => {
  const planner = createPlanner({ 1: 0, 2: 1, 3: 0, 4: 0 });
  const board = Array(100).fill('miss'); [0, 1, 2, 3].forEach(i => board[i] = 'unknown');
  const result = await planner.analyze(board, { ...fast, samples: 384, burn: 60, thin: 4, stages: [16, 64, 192] });
  assert.equal(result.status, 'ready'); assert.equal([1, 2].includes(result.cells[0]), true);
  assert.equal(result.estimates.every(e => e.trials === 192 && e.mean >= 2 && e.mean <= 4), true);
});
test('impossible observations are distinguished from search limits', async () => {
  const planner = createPlanner();
  assert.equal((await planner.analyze(Array(100).fill('miss'), fast)).status, 'inconsistent');
  assert.equal((await planner.analyze(emptyBoard(), { ...fast, nodeLimit: 1 })).status, 'limited');
});
test('a hit cannot secretly belong to a fully sunk unreported ship', async () => {
  const planner = createPlanner({ 1: 1, 2: 0, 3: 0, 4: 0 });
  const board = Array(100).fill('miss'); board[0] = 'hit';
  assert.equal((await planner.analyze(board, fast)).status, 'inconsistent');
});
test('finished fleet needs no simulations', async () => {
  const planner = createPlanner({ 1: 1, 2: 0, 3: 0, 4: 0 });
  const board = emptyBoard(); board[0] = 'sunk';
  const result = await planner.analyze(board, fast);
  assert.equal(result.status, 'complete'); assert.equal(result.simulations, 0);
});
test('an interrupted comparison never presents uneven estimates as a winner', async () => {
  const result = await createPlanner().analyze(emptyBoard(), { ...fast, maxMs: -1 });
  assert.equal(result.status, 'limited'); assert.deepEqual(result.cells, []);
});
test('cancelled calculations stop without changing input', async () => {
  const input = emptyBoard(); let message = '';
  try { await createPlanner().analyze(input, { ...fast, isCancelled: () => true }); } catch (error) { message = error.message; }
  assert.equal(message, 'cancelled'); assert.deepEqual(input, emptyBoard());
});
test('fixed seeds make recommendations reproducible', async () => {
  const planner = createPlanner({ 1: 1, 2: 0, 3: 0, 4: 0 }), board = Array(100).fill('miss');
  [0, 8, 44, 99].forEach(i => board[i] = 'unknown');
  const a = await planner.analyze(board, fast), b = await planner.analyze(board, fast);
  assert.deepEqual(a.estimates, b.estimates); assert.deepEqual(a.probability, b.probability);
});
test('symmetry reduction preserves every observation', () => {
  const planner = createPlanner(), board = emptyBoard();
  assert.equal(planner.symmetries(planner.prepare(board).board).length, 8);
  board[24] = 'hit'; board[78] = 'miss';
  assert.equal(planner.symmetries(planner.prepare(board).board).length, 1);
});
test('planner serialization works without surrounding module variables', async () => {
  const restored = new Function(`return (${createPlanner.toString()})`)();
  const board = Array(100).fill('miss'); board[44] = 'unknown';
  const result = await restored({ 1: 1, 2: 0, 3: 0, 4: 0 }).analyze(board, fast);
  assert.deepEqual(result.cells, [44]); assert.equal(result.estimates[0].mean, 1);
});
