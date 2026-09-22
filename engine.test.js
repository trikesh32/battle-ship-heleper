const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mark, recommend, remaining } = require('./engine.js');
const empty = () => Array(100).fill('unknown');
test('sinking a ship closes all surrounding cells including diagonals', () => {
  let board = mark(empty(), 44, 'hit');
  board = mark(board, 45, 'sunk');
  assert.equal(board[44], 'sunk'); assert.equal(board[45], 'sunk');
  for (const i of [33,34,35,36,43,46,53,54,55,56]) assert.equal(board[i], 'auto');
  assert.equal(remaining(board)[2], 2);
});
test('corner ship closes only in-bounds neighbors and preserves explicit misses', () => {
  let board = mark(empty(), 1, 'miss'); board = mark(board, 0, 'sunk');
  assert.equal(board[1], 'miss'); assert.equal(board[10], 'auto'); assert.equal(board[11], 'auto');
  assert.equal(board[9], 'unknown'); assert.equal(board[99], 'unknown');
});
test('aligned hits recommend only extensions of the ship', () => {
  let board = mark(empty(), 44, 'hit'); board = mark(board, 45, 'hit');
  assert.deepEqual(recommend(board).cells, [43, 46]);
  board = mark(board, 43, 'miss'); assert.deepEqual(recommend(board).cells, [46]);
});
test('one hit recommends orthogonal neighbors', () => {
  assert.deepEqual(recommend(mark(empty(), 44, 'hit')).cells, [34,43,45,54]);
});
test('invalid bent ships cannot be sunk', () => {
  let board = mark(empty(), 44, 'hit'); board = mark(board, 45, 'hit');
  assert.throws(() => mark(board, 55, 'sunk'), /прямым/);
});
test('cannot sink more ships than the fleet allows', () => {
  let board = empty(); for (const i of [0, 3, 6, 9]) board = mark(board, i, 'sunk');
  assert.throws(() => mark(board, 30, 'sunk'), /уже потоплены/);
});
test('a hit may be marked sunk later and input board stays unchanged', () => {
  const board = mark(empty(), 44, 'hit'); const next = mark(board, 44, 'sunk');
  assert.equal(board[44], 'hit'); assert.equal(next[44], 'sunk');
});
test('separate damaged ships remain valid targets', () => {
  let board = mark(empty(), 0, 'hit'); board = mark(board, 99, 'hit');
  assert.deepEqual(recommend(board).cells, [1,10,89,98]);
});
test('complete standard fleet gives victory and no recommendations', () => {
  let board = empty();
  for (const ship of [[0,1,2,3],[20,21,22],[40,41,42],[60,61],[80,81],[6,16],[36],[56],[76],[96]]) {
    ship.slice(0,-1).forEach(i => board = mark(board, i, 'hit'));
    board = mark(board, ship.at(-1), 'sunk');
  }
  assert.equal(recommend(board).complete, true); assert.deepEqual(recommend(board).cells, []);
});
