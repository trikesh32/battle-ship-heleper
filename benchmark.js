// Reproducible complete games. The policy only sees observations, never ships.
// Usage: node benchmark.js [games=200] [samples=512] [seed=20260922]
'use strict';
const createPlanner = require('./planner.js');
const { mark, remaining, recommend } = require('./engine.js');
const [games = 200, samples = 512, seed = 20260922] = process.argv.slice(2).map(Number);
const placement = process.env.PLACEMENT || 'random';
if (!['random', 'edges'].includes(placement)) throw new Error('Unknown placement profile');
if (![games, samples, seed].every(Number.isInteger) || games < 1 || samples < 1) throw new Error('Invalid benchmark arguments');
const planner = createPlanner(), blank = () => Array(100).fill('unknown');
const context = planner.prepare(blank());
function layoutFor(index) {
  const rng = planner.random(seed + index * 7919);
  // Sequential random legal placement with whole-fleet restarts. This is a
  // declared synthetic distribution, not a claim of uniformly random fleets.
  for (;;) {
    const ships = [], blocked = new Set();
    for (const length of [4, 3, 3, 2, 2, 2, 1, 1, 1, 1]) {
      let legal = context.pool[length].filter(p => p.cells.every(i => !blocked.has(i)));
      if (placement === 'edges' && length > 1) {
        const border = legal.filter(p => p.cells.every(i => (i / 10 | 0) === 0 || (i / 10 | 0) === 9 || i % 10 === 0 || i % 10 === 9));
        if (border.length) legal = border;
      }
      if (!legal.length) break;
      const p = legal[Math.floor(rng() * legal.length)];
      ships.push(p); p.halo.forEach(i => blocked.add(i));
    }
    if (ships.length === 10) return ships;
  }
}
async function play(layout, policy, index) {
  let board = blank(), shots = 0, elapsed = 0, limited = 0, exact = 0;
  const rng = planner.random(seed + index * 104729);
  while (Object.values(remaining(board)).some(n => n > 0)) {
    const huntBlend = policy.startsWith('blend') ? Number(policy.slice(5)) : 0;
    const informationWeight = policy.startsWith('information') ? Number(policy.slice(11)) : 0;
    const result = await planner.analyze(board, { samples, endgame: policy !== 'baseline', huntBlend, informationWeight, maxMs: 12000 });
    elapsed += result.elapsedMs || 0;
    if (result.exact) exact++;
    let cells = result.cells;
    if (result.status !== 'ready') { limited++; cells = recommend(board).cells; }
    if (!cells.length || shots >= 100) throw new Error(`Invalid policy ${policy}`);
    const shot = cells[Math.floor(rng() * cells.length)];
    if (board[shot] !== 'unknown') throw new Error('Repeated shot');
    const ship = layout.find(p => p.cells.includes(shot));
    const feedback = !ship ? 'miss' : ship.cells.every(i => i === shot || board[i] === 'hit') ? 'sunk' : 'hit';
    board = mark(board, shot, feedback); shots++;
  }
  return { shots, elapsed, limited, exact };
}
async function main() {
  const policies = (process.env.POLICIES || 'baseline,improved').split(',');
  if (policies.some(policy => !['baseline', 'improved', 'blend0.25', 'blend0.5', 'blend0.75', 'information0.25'].includes(policy))) throw new Error('Unknown benchmark policy');
  const results = Object.fromEntries(policies.map(p => [p, []]));
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  for (let i = 0; i < games; i++) {
    const layout = layoutFor(i);
    for (const policy of policies) results[policy].push(await play(layout, policy, i));
    console.log(JSON.stringify({ game: i + 1, shots: Object.fromEntries(policies.map(p => [p, results[p][i].shots])) }));
  }
  for (const policy of policies) {
    const rows = results[policy], shots = rows.map(r => r.shots).sort((a, b) => a - b);
    const differences = rows.map((r, i) => r.shots - results[policies[0]][i].shots);
    const delta = mean(differences);
    const se = games > 1 ? Math.sqrt(differences.reduce((sum, d) => sum + (d - delta) ** 2, 0) / (games - 1) / games) : null;
    console.log(JSON.stringify({ policy, games, samples, seed, placement, mean: mean(shots), median: shots[Math.floor(games / 2)], p90: shots[Math.ceil(games * 0.9) - 1], delta, pairedSE: se, pairedCI95: se === null ? null : [delta - 1.96 * se, delta + 1.96 * se], msPerShot: rows.reduce((s, r) => s + r.elapsed, 0) / shots.reduce((a, b) => a + b, 0), limited: rows.reduce((s, r) => s + r.limited, 0), exactMoves: rows.reduce((s, r) => s + r.exact, 0) }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
