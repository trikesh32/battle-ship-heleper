/* Self-contained so the same planner can run in a Blob worker or without workers. */
function createBattleshipPlanner(fleetDefinition) {
  'use strict';
  fleetDefinition = fleetDefinition ?? { 1: 4, 2: 3, 3: 2, 4: 1 };
  const UNKNOWN = 0, MISS = 1, HIT = 2, SUNK = 3, AUTO = 4;
  const states = { unknown: UNKNOWN, miss: MISS, hit: HIT, sunk: SUNK, auto: AUTO };
  const around = Array.from({ length: 100 }, (_, i) => {
    const cells = [];
    for (let r = Math.max(0, (i / 10 | 0) - 1); r <= Math.min(9, (i / 10 | 0) + 1); r++) {
      for (let c = Math.max(0, i % 10 - 1); c <= Math.min(9, i % 10 + 1); c++) cells.push(r * 10 + c);
    }
    return cells;
  });
  const adjacent = around.map((cells, i) => cells.filter(j => Math.abs((i / 10 | 0) - (j / 10 | 0)) + Math.abs(i % 10 - j % 10) === 1));
  const placements = [[], [], [], [], []];
  for (let length = 1; length <= 4; length++) for (let i = 0; i < 100; i++) for (const step of (length === 1 ? [1] : [1, 10])) {
    if ((step === 1 ? i % 10 : i / 10 | 0) + length > 10) continue;
    const cells = Array.from({ length }, (_, n) => i + step * n);
    const halo = [...new Set(cells.flatMap(j => around[j]))];
    placements[length].push({ cells, halo, ring: halo.filter(j => !cells.includes(j)), length });
  }
  function random(seed) {
    let value = seed >>> 0 || 1;
    return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
  }
  function boardSeed(board) {
    let seed = 2166136261;
    for (const cell of board) seed = Math.imul(seed ^ cell, 16777619);
    return seed >>> 0;
  }
  function prepare(input) {
    if (!Array.isArray(input) || input.length !== 100 || input.some(s => states[s] === undefined)) throw new Error('Некорректное поле.');
    const board = Uint8Array.from(input, s => states[s]), fleet = { ...fleetDefinition }, seen = new Set();
    for (let i = 0; i < 100; i++) {
      if (board[i] !== SUNK || seen.has(i)) continue;
      const group = [i]; seen.add(i);
      for (let n = 0; n < group.length; n++) for (const j of adjacent[group[n]]) if (board[j] === SUNK && !seen.has(j)) { seen.add(j); group.push(j); }
      const straight = group.every(j => (j / 10 | 0) === (i / 10 | 0)) || group.every(j => j % 10 === i % 10);
      if (!straight || !fleet[group.length]) throw new Error('Проверьте размеры потопленных кораблей.');
      fleet[group.length]--;
      for (const j of group) for (const k of around[j]) {
        if ((board[k] === SUNK && !group.includes(k)) || board[k] === HIT) throw new Error('Корабли не могут соприкасаться.');
        if (board[k] === UNKNOWN) board[k] = AUTO;
      }
    }
    const hits = [...board.keys()].filter(i => board[i] === HIT);
    const pool = placements.map(list => list.filter(p => p.cells.every(i => board[i] === UNKNOWN || board[i] === HIT)
      && p.cells.some(i => board[i] === UNKNOWN) && p.ring.every(i => board[i] !== HIT)));
    return { board, fleet, hits, pool };
  }
  function shuffle(list, rng) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
    return copy;
  }
  // Find a legal initial state. Search exhaustion is distinct from a time/node limit.
  function seedLayout(context, rng, nodeLimit, deadline = Infinity) {
    const blocked = new Uint8Array(100), occupied = new Uint8Array(100), counts = { ...context.fleet }, chosen = [];
    const lists = context.pool.map(list => shuffle(list, rng));
    let nodes = 0, limited = false;
    function visit() {
      if (++nodes > nodeLimit || (nodes % 128 === 0 && Date.now() >= deadline)) { limited = true; return false; }
      let options = null;
      for (const hit of context.hits) {
        if (occupied[hit]) continue;
        const candidates = [];
        for (let length = 1; length <= 4; length++) if (counts[length]) for (const p of lists[length]) {
          if (p.cells.includes(hit) && p.cells.every(i => !blocked[i])) candidates.push(p);
        }
        if (!candidates.length) return false;
        if (!options || candidates.length < options.length) options = candidates;
      }
      if (!options) {
        const length = [4, 3, 2, 1].find(n => counts[n] > 0);
        if (!length) return true;
        options = lists[length].filter(p => p.cells.every(i => !blocked[i]));
      }
      for (const p of options) {
        counts[p.length]--; chosen.push(p);
        p.halo.forEach(i => blocked[i]++); p.cells.forEach(i => occupied[i]++);
        if (visit()) return true;
        p.halo.forEach(i => blocked[i]--); p.cells.forEach(i => occupied[i]--);
        counts[p.length]++; chosen.pop();
        if (limited) break;
      }
      return false;
    }
    const found = visit();
    return { layout: found ? chosen : null, limited, nodes };
  }
  // Conditional Gibbs updates: uniform legal single-ship replacement and uniform
  // two-ship proposals. Their stationary distribution is uniform over legal fleets
  // with labelled ships; each unlabelled fleet has the same label multiplicity.
  function makeChain(context, initial, rng) {
    const layout = [...initial], blocked = new Uint8Array(100), occupied = new Uint8Array(100);
    const change = (p, delta) => { p.halo.forEach(i => blocked[i] += delta); p.cells.forEach(i => occupied[i] += delta); };
    layout.forEach(p => change(p, 1));
    return {
      layout,
      step() {
        if (!layout.length) return;
        const a = Math.floor(rng() * layout.length);
        let b = -1;
        if (layout.length > 1 && rng() < 0.35) { b = Math.floor(rng() * (layout.length - 1)); if (b >= a) b++; }
        const oldA = layout[a], oldB = b >= 0 ? layout[b] : null;
        change(oldA, -1); if (oldB) change(oldB, -1);
        const required = context.hits.filter(i => !occupied[i]);
        if (!oldB) {
          const legal = context.pool[oldA.length].filter(p => p.cells.every(i => !blocked[i]) && required.every(i => p.cells.includes(i)));
          layout[a] = legal[Math.floor(rng() * legal.length)];
        } else {
          const listA = context.pool[oldA.length], listB = context.pool[oldB.length];
          for (let attempt = 0; attempt < 32; attempt++) {
            const pa = listA[Math.floor(rng() * listA.length)], pb = listB[Math.floor(rng() * listB.length)];
            if (pa.cells.some(i => blocked[i]) || pb.cells.some(i => blocked[i] || pa.halo.includes(i))) continue;
            if (!required.every(i => pa.cells.includes(i) || pb.cells.includes(i))) continue;
            layout[a] = pa; layout[b] = pb; break;
          }
        }
        change(layout[a], 1); if (oldB) change(layout[b], 1);
      }
    };
  }
  // The continuation policy ONLY receives observed state, never the hidden fleet.
  function chooseShot(board, fleet, pool, rng) {
    const scores = new Float64Array(100);
    let hunting = false;
    for (let i = 0; i < 100; i++) if (board[i] === HIT) { hunting = true; break; }
    for (let length = 1; length <= 4; length++) {
      if (!fleet[length]) continue;
      const list = pool[length]; let kept = 0;
      for (let n = 0; n < list.length; n++) {
        const p = list[n]; let hits = 0, unknown = 0, valid = true;
        for (const i of p.cells) {
          if (board[i] === HIT) hits++;
          else if (board[i] === UNKNOWN) unknown++;
          else { valid = false; break; }
        }
        if (!valid || !unknown) continue;
        if (hunting && p.ring.some(i => board[i] === HIT)) continue;
        list[kept++] = p;
        if (hunting && !hits) continue;
        for (const i of p.cells) if (board[i] === UNKNOWN && (!hunting || adjacent[i].some(j => board[j] === HIT))) scores[i] += fleet[length];
      }
      list.length = kept;
    }
    // One random salt per turn keeps common-random-number comparisons aligned
    // even when two paths encounter different numbers of equally ranked cells.
    const salt = Math.floor(rng() * 4294967296);
    let best = -1, score = -1, priority = -1;
    for (let i = 0; i < 100; i++) if (board[i] === UNKNOWN) {
      let tie = Math.imul((i + 1) ^ salt, 0x45d9f3b);
      tie = Math.imul(tie ^ (tie >>> 16), 0x45d9f3b); tie = (tie ^ (tie >>> 16)) >>> 0;
      if (scores[i] > score || (scores[i] === score && tie > priority)) { score = scores[i]; best = i; priority = tie; }
    }
    return best;
  }
  function makeWorld(layout) {
    const owner = new Int8Array(100).fill(-1);
    layout.forEach((p, id) => p.cells.forEach(i => owner[i] = id));
    return { layout, owner };
  }
  function symmetries(board) {
    const transforms = [
      (r, c) => [r, c], (r, c) => [c, 9 - r], (r, c) => [9 - r, 9 - c], (r, c) => [9 - c, r],
      (r, c) => [r, 9 - c], (r, c) => [9 - r, c], (r, c) => [c, r], (r, c) => [9 - c, 9 - r]
    ];
    return transforms.map(fn => Array.from({ length: 100 }, (_, i) => { const [r, c] = fn(i / 10 | 0, i % 10); return r * 10 + c; }))
      .filter(map => map.every((j, i) => board[i] === board[j]));
  }
  function rollout(context, world, firstShot, seed) {
    const board = context.board.slice(), fleet = { ...context.fleet }, pool = context.pool.map(list => [...list]), rng = random(seed);
    const left = world.layout.map(p => p.cells.filter(i => board[i] === UNKNOWN).length);
    let alive = left.filter(n => n > 0).length, shots = 0, target = firstShot;
    while (alive && shots < 100) {
      if (target < 0 || board[target] !== UNKNOWN) throw new Error('Недопустимый выстрел в симуляции.');
      shots++;
      const ship = world.owner[target];
      if (ship < 0) board[target] = MISS;
      else {
        board[target] = HIT;
        if (--left[ship] === 0) {
          const p = world.layout[ship]; alive--; fleet[p.length]--;
          p.cells.forEach(i => board[i] = SUNK);
          p.halo.forEach(i => { if (board[i] === UNKNOWN) board[i] = AUTO; });
        }
      }
      if (alive) target = chooseShot(board, fleet, pool, rng);
    }
    if (alive) throw new Error('Симуляция не завершилась.');
    return shots;
  }
  // Exact belief-state search for small endgames. A state contains every fleet
  // still compatible with the feedback, and the cells already fired upon.
  // We branch on miss / hit / sunk (including the revealed ship cells).
  async function solveEndgame(context, checkpoint, deadline, options) {
    const lengths = [4, 3, 2, 1].flatMap(length => Array(context.fleet[length] || 0).fill(length));
    if (!lengths.length || lengths.length > 3) return null;
    const unknown = [...context.board.keys()].filter(i => context.board[i] === UNKNOWN);
    if (unknown.length > 12) return null;
    const bit = new Map(unknown.map((cell, i) => [cell, 1 << i]));
    const layouts = [];
    function enumerate(chosen, blocked, start) {
      if (chosen.length === lengths.length) {
        if (context.hits.every(i => chosen.some(p => p.cells.includes(i)))) layouts.push(chosen.map(p => ({
          mask: p.cells.reduce((mask, i) => mask | (bit.get(i) || 0), 0),
          sunk: `sunk:${p.cells.join(',')}`
        })));
        return;
      }
      const list = context.pool[lengths[chosen.length]];
      for (let i = start; i < list.length; i++) {
        const p = list[i];
        if (p.cells.some(cell => blocked.has(cell))) continue;
        enumerate([...chosen, p], new Set([...blocked, ...p.halo]), lengths[chosen.length + 1] === p.length ? i + 1 : 0);
      }
    }
    enumerate([], new Set(), 0);
    if (!layouts.length) return { status: 'inconsistent', cells: [], samples: 0, simulations: 0 };
    const occupied = layouts.map(layout => layout.reduce((mask, ship) => mask | ship.mask, 0));
    const memo = new Map();
    let nodes = 0;
    const limit = options.endgameNodes ?? 50000;
    const exhausted = Symbol('endgame budget');
    async function solve(ids, fired) {
      const key = `${fired}:${ids.join(',')}`;
      if (memo.has(key)) return memo.get(key);
      if (++nodes > limit || Date.now() >= deadline) throw exhausted;
      if (nodes % 128 === 0) await checkpoint({ phase: 'endgame', states: nodes, samples: layouts.length, target: layouts.length });
      const possible = ids.reduce((mask, id) => mask | occupied[id], 0) & ~fired;
      if (!possible) return { cost: 0, mask: 0 };
      const certain = ids.reduce((mask, id) => mask & occupied[id], possible) & ~fired;
      // If every surviving fleet has the same occupied cells, every remaining
      // shot hits. Ship segmentation no longer affects the cost to completion.
      if (certain === possible) return { cost: unknown.filter((_, i) => possible & (1 << i)).length, mask: possible };
      let best = Infinity, bestMask = 0;
      // A certain hit must be fired in every winning continuation. Moving that
      // shot earlier cannot add a shot and can only reveal information sooner.
      const candidates = certain || possible;
      for (let index = 0; index < unknown.length; index++) {
        const shot = 1 << index;
        if (!(candidates & shot)) continue;
        const outcomes = new Map();
        for (const id of ids) {
          const ship = layouts[id].find(p => p.mask & shot);
          const outcome = !ship ? 'miss' : (ship.mask & ~fired) === shot ? ship.sunk : 'hit';
          if (!outcomes.has(outcome)) outcomes.set(outcome, []);
          outcomes.get(outcome).push(id);
        }
        let cost = 1;
        for (const group of outcomes.values()) {
          cost += group.length / ids.length * (await solve(group, fired | shot)).cost;
          if (cost > best + 1e-10) break;
        }
        if (cost < best - 1e-10) { best = cost; bestMask = shot; }
        else if (Math.abs(cost - best) < 1e-10) bestMask |= shot;
      }
      const result = { cost: best, mask: bestMask };
      memo.set(key, result);
      return result;
    }
    try {
      const result = await solve(layouts.map((_, i) => i), 0);
      const probability = Array(100).fill(0);
      unknown.forEach((cell, i) => probability[cell] = occupied.filter(mask => mask & (1 << i)).length / layouts.length);
      const cells = unknown.filter((_, i) => result.mask & (1 << i));
      return { status: 'ready', cells, probability, selection: 'endgame', mode: context.hits.length ? 'target' : 'hunt',
        estimates: cells.map(cell => ({ cell, hitProbability: probability[cell], expectedShots: result.cost })),
        expectedShots: result.cost, samples: layouts.length, distinct: layouts.length, simulations: 0, states: nodes, exact: true };
    } catch (error) {
      if (error !== exhausted) throw error;
      return null;
    }
  }
  async function analyze(input, options = {}) {
    if (options.isCancelled?.()) throw new Error('cancelled');
    const started = Date.now(), context = prepare(input), rng = random(options.seed ?? boardSeed(context.board));
    const sampleCount = options.samples ?? 512, chains = options.chains ?? 4, burn = options.burn ?? 160, thin = options.thin ?? 8;
    const huntBlend = options.huntBlend ?? 0, informationWeight = options.informationWeight ?? 0;
    if (!Number.isFinite(huntBlend) || huntBlend < 0 || huntBlend > 1 || !Number.isFinite(informationWeight) || informationWeight < 0) throw new Error('Некорректные веса стратегии.');
    const maxMs = options.maxMs ?? 12000;
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || !Number.isInteger(chains) || chains < 1 || !Number.isInteger(burn) || burn < 0 || !Number.isInteger(thin) || thin < 1) throw new Error('Некорректные параметры расчёта.');
    let lastYield = Date.now(), lastProgress = 0;
    async function checkpoint(progress) {
      if (options.isCancelled?.()) throw new Error('cancelled');
      if (Date.now() - lastYield >= 16) {
        if (Date.now() - lastProgress >= 150) { options.onProgress?.(progress); lastProgress = Date.now(); }
        await new Promise(resolve => setTimeout(resolve, 0));
        lastYield = Date.now();
        if (options.isCancelled?.()) throw new Error('cancelled');
      }
    }
    if (!Object.values(context.fleet).some(n => n > 0)) {
      return { status: context.hits.length ? 'inconsistent' : 'complete', cells: [], samples: 0, simulations: 0 };
    }
    if (options.endgame !== false) {
      const exact = await solveEndgame(context, checkpoint, Math.min(started + maxMs, Date.now() + 1500), options);
      if (exact) return { ...exact, elapsedMs: Date.now() - started };
    }
    const worlds = [];
    for (let chainIndex = 0; chainIndex < Math.min(chains, sampleCount); chainIndex++) {
      const initial = seedLayout(context, rng, options.nodeLimit ?? 12000, started + maxMs);
      if (!initial.layout) {
        if (!worlds.length) return { status: initial.limited ? 'limited' : 'inconsistent', cells: [], samples: 0, simulations: 0 };
        break;
      }
      const chain = makeChain(context, initial.layout, rng);
      const take = Math.floor(sampleCount / Math.min(chains, sampleCount)) + (chainIndex < sampleCount % Math.min(chains, sampleCount) ? 1 : 0);
      for (let step = 0; step < burn + take * thin; step++) {
        chain.step();
        if (step >= burn && (step - burn) % thin === 0) worlds.push(makeWorld([...chain.layout]));
        if (step % 16 === 0) await checkpoint({ phase: 'sampling', samples: worlds.length, target: sampleCount });
        if (Date.now() - started > maxMs) return { status: 'limited', cells: [], samples: worlds.length, simulations: 0 };
      }
    }
    const occupancy = Array(100).fill(0), maps = symmetries(context.board);
    for (const world of worlds) world.owner.forEach((ship, i) => { if (ship >= 0 && context.board[i] === UNKNOWN) occupancy[i] += 1 / worlds.length; });
    const probability = occupancy.map((_, i) => Math.min(1, maps.reduce((sum, map) => sum + occupancy[map[i]], 0) / maps.length));
    const scores = [...probability];
    let selection = 'probability';
    // Experimental policies are opt-in. Ranking scores are not probabilities.
    // Keep both the target phase and the exact endgame unchanged.
    if (!context.hits.length && huntBlend > 0) {
      const density = Array(100).fill(0);
      for (let length = 1; length <= 4; length++) for (const p of (context.fleet[length] ? context.pool[length] : [])) {
        for (const i of p.cells) if (context.board[i] === UNKNOWN) density[i] += context.fleet[length];
      }
      const total = density.reduce((a, b) => a + b, 0), decks = probability.reduce((a, b) => a + b, 0);
      if (total > 0) density.forEach((value, i) => scores[i] = (1 - huntBlend) * probability[i] + huntBlend * value / total * decks);
      selection = 'blend';
    }
    if (!context.hits.length && informationWeight > 0) {
      const single = Array(100).fill(0);
      for (const world of worlds) for (const ship of world.layout) if (ship.length === 1) single[ship.cells[0]] += 1 / worlds.length;
      for (let i = 0; i < 100; i++) {
        const sunk = maps.reduce((sum, map) => sum + single[map[i]], 0) / maps.length;
        const outcomes = [1 - probability[i], probability[i] - sunk, sunk];
        const entropy = -outcomes.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
        scores[i] += informationWeight * entropy;
      }
      selection = 'information';
    }
    const best = Math.max(...scores);
    const cells = scores.flatMap((score, cell) => context.board[cell] === UNKNOWN && score > 0 && Math.abs(score - best) < 1e-12 ? [cell] : []);
    const estimates = cells.map(cell => ({ cell, hitProbability: probability[cell] }));
    const distinct = new Set(worlds.map(w => w.layout.map(p => p.cells.join(',')).sort().join(';'))).size;
    return { status: 'ready', cells, estimates, selection, samples: worlds.length, distinct, simulations: 0, probability, scores, elapsedMs: Date.now() - started };
  }
  return { analyze, prepare, seedLayout, makeChain, makeWorld, rollout, chooseShot, random, symmetries };
}
if (typeof module !== 'undefined' && module.exports) module.exports = createBattleshipPlanner;
