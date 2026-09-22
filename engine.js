(function (root) {
  'use strict';
  const SIZE = 10;
  const FLEET = { 1: 4, 2: 3, 3: 2, 4: 1 };
  const neighbors = (i, diagonal = false) => {
    const result = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if ((!dr && !dc) || (!diagonal && Math.abs(dr) + Math.abs(dc) !== 1)) continue;
      const r = Math.floor(i / SIZE) + dr, c = i % SIZE + dc;
      if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) result.push(r * SIZE + c);
    }
    return result;
  };
  function groups(board, state) {
    const seen = new Set(), result = [];
    board.forEach((value, i) => {
      if (value !== state || seen.has(i)) return;
      const group = [i]; seen.add(i);
      for (let n = 0; n < group.length; n++) for (const j of neighbors(group[n])) {
        if (board[j] === state && !seen.has(j)) { seen.add(j); group.push(j); }
      }
      result.push(group);
    });
    return result;
  }
  function remaining(board) {
    const fleet = { ...FLEET };
    groups(board, 'sunk').forEach(g => fleet[g.length]--);
    return fleet;
  }
  function mark(board, index, result) {
    if (!Number.isInteger(index) || index < 0 || index >= 100 || !['miss', 'hit', 'sunk'].includes(result)) throw new Error('Некорректный выстрел.');
    if (!['unknown', 'hit'].includes(board[index])) throw new Error('Эта клетка уже закрыта. Отмените предыдущий ход, чтобы исправить её.');
    const next = [...board];
    next[index] = result === 'sunk' ? 'hit' : result;
    if (result === 'sunk') {
      const ship = groups(next, 'hit').find(g => g.includes(index));
      const straight = ship.every(i => Math.floor(i / 10) === Math.floor(ship[0] / 10)) || ship.every(i => i % 10 === ship[0] % 10);
      if (!straight || ship.length > 4) throw new Error('Корабль должен быть прямым и занимать от 1 до 4 клеток.');
      if (!(remaining(board)[ship.length] > 0)) throw new Error(`Все корабли длиной ${ship.length} уже потоплены. Проверьте отметки.`);
      if (ship.some(i => neighbors(i, true).some(j => !ship.includes(j) && ['hit', 'sunk'].includes(next[j])))) throw new Error('Корабли не могут соприкасаться, даже углами. Проверьте отметки.');
      ship.forEach(i => next[i] = 'sunk');
      ship.forEach(i => neighbors(i, true).forEach(j => { if (next[j] === 'unknown') next[j] = 'auto'; }));
    }
    return next;
  }
  function recommend(board) {
    const fleet = remaining(board), hits = groups(board, 'hit'), scores = Array(100).fill(0);
    for (let length = 1; length <= 4; length++) {
      if (fleet[length] <= 0) continue;
      for (let row = 0; row < 10; row++) for (let col = 0; col < 10; col++) for (const horizontal of (length === 1 ? [true] : [true, false])) {
        if ((horizontal ? col : row) + length > 10) continue;
        const cells = Array.from({ length }, (_, n) => (row + (horizontal ? 0 : n)) * 10 + col + (horizontal ? n : 0));
        if (cells.some(i => !['unknown', 'hit'].includes(board[i]))) continue;
        if (cells.some(i => neighbors(i, true).some(j => board[j] === 'sunk' || (board[j] === 'hit' && !cells.includes(j))))) continue;
        const covered = hits.filter(g => g.every(i => cells.includes(i)));
        if (hits.length && !covered.length) continue;
        for (const i of cells) {
          if (board[i] !== 'unknown') continue;
          if (hits.length && !neighbors(i).some(j => board[j] === 'hit')) continue;
          scores[i] += fleet[length];
        }
      }
    }
    const best = Math.max(...scores);
    return { cells: best ? scores.flatMap((score, i) => score === best ? [i] : []) : [], scores, hunting: hits.length > 0, complete: !hits.length && Object.values(fleet).every(n => n === 0) };
  }
  const api = { FLEET, neighbors, groups, remaining, mark, recommend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Battleship = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
