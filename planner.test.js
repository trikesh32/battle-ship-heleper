const { test } = require('node:test');
const assert = require('node:assert/strict');
const createPlanner = require('./planner.js');
const emptyBoard = () => Array(100).fill('unknown');
const fast = { samples: 32, chains: 2, burn: 20, thin: 3, maxMs: 600000, seed: 17 };
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
  assert.equal(result.estimates[0].hitProbability, 1);
});
test('hit probability prefers a middle shot for a two-deck ship in four cells', async () => {
  const planner = createPlanner({ 1: 0, 2: 1, 3: 0, 4: 0 });
  const board = Array(100).fill('miss'); [0, 1, 2, 3].forEach(i => board[i] = 'unknown');
  const result = await planner.analyze(board, { ...fast, samples: 384, burn: 60, thin: 4 });
  assert.equal(result.status, 'ready'); assert.equal([1, 2].includes(result.cells[0]), true);
  assert.equal(result.cells.every(cell => result.probability[cell] === Math.max(...result.probability)), true);
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
test('an interrupted sampling run keeps the provisional recommendation', async () => {
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
  assert.deepEqual(result.cells, [44]); assert.equal(result.probability[44], 1);
});

test('outside exact endgames recommendations maximize hit probability', async () => {
  for (const hit of [false, true]) {
    const board = emptyBoard(); board[9] = 'miss'; board[70] = 'miss';
    if (hit) board[44] = 'hit';
    const result = await createPlanner().analyze(board, fast);
    const best = Math.max(...result.probability);
    assert.deepEqual(result.cells, result.probability.flatMap((p, i) => board[i] === 'unknown' && Math.abs(p - best) < 1e-12 ? [i] : []));
  }
});

test('exact singleton endgame has uniform probabilities and optimal search cost', async () => {
  const planner = createPlanner({ 1: 1, 2: 0, 3: 0, 4: 0 });
  const board = Array(100).fill('miss');
  [0, 8, 44, 98].forEach(i => board[i] = 'unknown');
  const result = await planner.analyze(board, fast);
  assert.equal(result.exact, true);
  assert.deepEqual(result.cells, [0, 8, 44, 98]);
  assert.equal(result.expectedShots, 2.5);
  for (const i of result.cells) assert.equal(result.probability[i], 0.25);
});

test('exact search respects separated hits and the unknown gap', async () => {
  const planner = createPlanner({ 1: 0, 2: 0, 3: 1, 4: 0 });
  const board = Array(100).fill('miss'); board[44] = 'hit'; board[46] = 'hit'; board[45] = 'unknown';
  const result = await planner.analyze(board, fast);
  assert.deepEqual(result.cells, [45]);
  assert.equal(result.expectedShots, 1);
});

test('exact search counts indistinguishable ships once and excludes touching ships', async () => {
  const planner = createPlanner({ 1: 2, 2: 0, 3: 0, 4: 0 });
  const board = Array(100).fill('miss'); [0, 1, 2, 9].forEach(i => board[i] = 'unknown');
  const result = await planner.analyze(board, fast);
  // Legal unordered pairs: (0,2), (0,9), (1,9), (2,9).
  assert.equal(result.samples, 4);
  assert.equal(result.probability[9], 0.75);
  assert.equal(result.probability[1], 0.25);
  assert.equal(result.probability.reduce((a, b) => a + b), 2);
});

test('three remaining singletons are solved without permutations of identical ships', async () => {
  const planner = createPlanner({ 1: 3, 2: 0, 3: 0, 4: 0 });
  const board = Array(100).fill('miss'); [0, 2, 4, 6].forEach(i => board[i] = 'unknown');
  const result = await planner.analyze(board, fast);
  assert.equal(result.samples, 4);
  assert.equal(result.expectedShots, 3.75);
  assert.deepEqual(result.cells, [0, 2, 4, 6]);
});

test('exhausted endgame search falls back to sampling', async () => {
  const planner = createPlanner({ 1: 1, 2: 0, 3: 0, 4: 0 });
  const board = Array(100).fill('miss'); [0, 8, 44, 98].forEach(i => board[i] = 'unknown');
  const result = await planner.analyze(board, { ...fast, endgameNodes: 0 });
  assert.equal(result.status, 'ready');
  assert.equal(result.selection, 'probability');
  assert.equal(result.samples, fast.samples);
});

test('endgame policy beats greedy hit probability across every legal hidden fleet in a fixture', async () => {
  const { mark } = require('./engine.js');
  const planner = createPlanner({ 1: 1, 2: 1, 3: 0, 4: 0 });
  const initial = Array(100).fill('miss');
  [0, 2, 3, 4, 12, 13, 21, 24, 25, 33].forEach(i => initial[i] = 'unknown');
  const context = planner.prepare(initial), layouts = [];
  for (const a of context.pool[1]) for (const b of context.pool[2]) {
    if (b.cells.every(i => !a.halo.includes(i))) layouts.push([a, b]);
  }
  assert.equal(layouts.length, 28);
  const cache = new Map(), totals = {};
  for (const policy of ['greedy', 'endgame']) {
    let total = 0;
    for (const ships of layouts) {
      let board = [...initial], shots = 0;
      while (ships.some(ship => ship.cells.some(i => board[i] !== 'sunk'))) {
        const key = board.join(',');
        if (!cache.has(key)) cache.set(key, await planner.analyze(board, fast));
        const result = cache.get(key);
        assert.equal(result.exact, true);
        const shot = policy === 'endgame' ? result.cells[0] : result.probability.indexOf(Math.max(...result.probability));
        assert.equal(board[shot], 'unknown');
        const ship = ships.find(p => p.cells.includes(shot));
        board = mark(board, shot, !ship ? 'miss' : ship.cells.every(i => i === shot || board[i] === 'hit') ? 'sunk' : 'hit');
        assert.ok(++shots <= 10);
      }
      total += shots;
    }
    totals[policy] = total;
  }
  const root = cache.get(initial.join(','));
  assert.deepEqual(root.cells, [25]);
  assert.ok(root.probability[25] < root.probability[3]);
  assert.equal(totals.endgame / layouts.length, root.expectedShots);
  assert.equal(totals.endgame, 161);
  assert.equal(totals.greedy, 162);
});

test('exact endgame search can be cancelled without changing observations', async () => {
  const planner = createPlanner({ 1: 1, 2: 1, 3: 0, 4: 0 });
  const board = Array(100).fill('miss');
  [0, 2, 3, 4, 12, 13, 21, 24, 25, 33].forEach(i => board[i] = 'unknown');
  const before = [...board]; let calls = 0;
  await assert.rejects(planner.analyze(board, { ...fast, isCancelled: () => ++calls >= 2 }), /cancelled/);
  assert.deepEqual(board, before);
});

test('experimental rankings keep hit probabilities unchanged and never select closed cells', async () => {
  const planner = createPlanner(), board = emptyBoard();
  board[9] = 'miss'; board[70] = 'miss';
  const reference = await planner.analyze(board, fast);
  for (const policy of [{ huntBlend: 0.5 }, { informationWeight: 0.25 }]) {
    const result = await planner.analyze(board, { ...fast, ...policy });
    assert.deepEqual(result.probability, reference.probability);
    assert.ok(result.cells.length > 0);
    assert.ok(result.cells.every(i => board[i] === 'unknown'));
    for (const estimate of result.estimates) assert.equal(estimate.hitProbability, reference.probability[estimate.cell]);
  }
});

test('experimental hunt policies preserve damaged-ship and exact-endgame decisions', async () => {
  const damaged = emptyBoard(); damaged[44] = 'hit'; damaged[45] = 'hit'; damaged[43] = 'miss';
  const endgame = Array(100).fill('miss'); [0, 8, 44, 98].forEach(i => endgame[i] = 'unknown');
  for (const [planner, board] of [[createPlanner(), damaged], [createPlanner({ 1: 1, 2: 0, 3: 0, 4: 0 }), endgame]]) {
    const reference = await planner.analyze(board, fast);
    const result = await planner.analyze(board, { ...fast, huntBlend: 0.75, informationWeight: 0.25 });
    assert.deepEqual(result.cells, reference.cells);
    assert.deepEqual(result.probability, reference.probability);
    assert.equal(result.selection, reference.selection);
  }
});

test('invalid experimental weights are rejected before analysis', async () => {
  for (const policy of [{ huntBlend: -1 }, { huntBlend: 2 }, { huntBlend: NaN }, { informationWeight: Infinity }]) {
    await assert.rejects(createPlanner().analyze(emptyBoard(), { ...fast, ...policy }), /вес/i);
  }
});
