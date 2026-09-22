const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const engine = require('./engine.js');
const source = readFileSync(__dirname + '/app.js', 'utf8');

// DOM/Worker contract tests; these do not replace a visual browser check.
function harness(workerAvailable = true) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.className = ''; this.textContent = ''; this.hidden = false; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    append(child) { this.children.push(child); }
    replaceChildren(fragment) { this.children = fragment.children; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { this.focused = true; }
    get classList() { return { toggle: (name, on) => { const classes = new Set(this.className.split(' ')); if (on) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); } }; }
    querySelectorAll(selector) { return this.children.filter(child => child.className.split(' ').includes(selector.slice(1))); }
    querySelector(selector) {
      if (selector === '.recommended') return this.querySelectorAll(selector)[0];
      const match = selector.match(/data-index="(\d+)"/);
      return match ? this.children.find(child => String(child.dataset.index) === match[1] && !child.disabled) : null;
    }
  }
  const elements = new Map(), timers = [], workers = [], pending = [], stored = new Map();
  const get = selector => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  const results = ['miss', 'hit', 'sunk'].map(result => { const element = get(`[data-result=${result}]`); element.dataset.result = result; return element; });
  const document = { querySelector: get, querySelectorAll: () => results, createElement: () => new Element(), createDocumentFragment: () => new Element() };
  class Worker {
    constructor() { if (!workerAvailable) throw new Error('Workers unavailable'); workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
    deliver(data) { this.onmessage({ data }); }
  }
  function fallbackPlanner() { return { analyze: (board, options) => new Promise(resolve => pending.push({ board, options, resolve })) }; }
  const api = new Function('document', 'localStorage', 'Battleship', 'createBattleshipPlanner', 'Worker', 'URL', 'Blob', 'setTimeout', 'confirm', source + '\nreturn {board:()=>board, history:()=>history};')(
    document, { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }, engine, fallbackPlanner, Worker,
    { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }, function Blob() {}, callback => timers.push(callback), () => true
  );
  const click = (index, result) => {
    get('#board').children.find(child => child.dataset.index === index).listeners.click();
    get(`[data-result=${result}]`).listeners.click();
  };
  return { get, workers, timers, pending, api, click };
}
const ready = cell => ({ status: 'ready', cells: [cell], estimates: [{ cell, mean: 35.2, hitProbability: 0.5 }], samples: 512, simulations: 800, probability: Array(100).fill(0.5), selection: 'rollout' });

test('new moves cancel workers and stale responses cannot change the target', () => {
  const h = harness(), old = h.workers[0];
  assert.equal(h.get('#board').querySelectorAll('.cell').length, 100);
  h.click(44, 'hit');
  assert.equal(old.terminated, true); assert.equal(h.api.board()[44], 'hit');
  old.deliver({ result: ready(0) });
  assert.equal(h.get('#suggestion').textContent, 'Ищем короткий путь к победе');
  h.workers[1].deliver({ result: ready(45) });
  assert.equal(h.get('#suggestion').textContent, 'Цель — Е5');
  assert.equal(h.get('#forecast').hidden, false);
  assert.equal(h.get('#expected-shots').textContent, '≈ 35.2');
  assert.equal(h.get('#board').querySelectorAll('.recommended').length, 1);
  h.get('#undo').listeners.click();
  assert.equal(h.api.board()[44], 'unknown'); assert.equal(h.get('#forecast').hidden, true);
});
test('undo and reset restore automatic closures while cancelling calculations', () => {
  const h = harness(); h.click(44, 'hit'); h.click(45, 'sunk');
  assert.equal(h.api.board()[44], 'sunk'); assert.equal(h.api.board()[33], 'auto');
  const current = h.workers.at(-1); h.get('#undo').listeners.click();
  assert.equal(current.terminated, true); assert.equal(h.api.board()[44], 'hit'); assert.equal(h.api.board()[33], 'unknown');
  const next = h.workers.at(-1); h.get('#reset').listeners.click();
  assert.equal(next.terminated, true); assert.deepEqual(h.api.board(), Array(100).fill('unknown'));
  assert.equal(h.api.history().length, 0);
});
test('worker-free fallback ignores results from an obsolete board', async () => {
  const h = harness(false); h.timers.shift()();
  const first = h.pending[0]; h.click(44, 'miss');
  assert.equal(first.options.isCancelled(), true);
  first.resolve(ready(44)); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.get('#forecast').hidden, true);
  h.timers.shift()(); const second = h.pending[1];
  second.resolve(ready(45)); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.get('#suggestion').textContent, 'Цель — Е5');
});
test('impossible board clears provisional highlights and loading state', () => {
  const h = harness(); h.workers[0].deliver({ result: { status: 'inconsistent' } });
  assert.equal(h.get('#board').querySelectorAll('.recommended').length, 0);
  assert.equal(h.get('#suggestion').textContent, 'Проверьте отметки');
  assert.equal(h.get('.tip-card').attributes['aria-busy'], 'false');
});
