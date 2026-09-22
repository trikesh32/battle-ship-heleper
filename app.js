'use strict';
const $ = selector => document.querySelector(selector);
const letters = 'АБВГДЕЖЗИК';
const coordinate = i => letters[i % 10] + (Math.floor(i / 10) + 1);
const labels = { unknown: 'неизвестно', miss: 'промах', auto: 'промах, рядом с потопленным кораблём', hit: 'попал', sunk: 'убил' };
const storageKey = 'battleship-helper-v1';
let board = Array(100).fill('unknown'), history = [], selected = null;
let analysisVersion = 0, analysisWorker = null;
const planner = createBattleshipPlanner(Battleship.FLEET);
const workerCode = `const planner = (${createBattleshipPlanner.toString()})(${JSON.stringify(Battleship.FLEET)});
  onmessage = async ({data}) => {
    try {
      const result = await planner.analyze(data.board, {onProgress: progress => postMessage({progress})});
      postMessage({result});
    } catch (error) { postMessage({error: error.message}); }
  };`;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  const valid = value => Array.isArray(value) && value.length === 100 && value.every(v => Object.hasOwn(labels, v));
  if (saved && valid(saved.board) && Array.isArray(saved.history) && saved.history.every(valid)) { board = saved.board; history = saved.history; }
} catch { /* Storage may be unavailable; the game still works. */ }
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify({ board, history })); }
  catch { $('.offline').textContent = 'Сохранение недоступно в этом браузере'; }
}
function render() {
  analysisVersion++;
  analysisWorker?.terminate(); analysisWorker = null;
  $('#forecast').hidden = true;
  $('.tip-card').setAttribute('aria-busy', 'false');
  const recommendation = Battleship.recommend(board), fleet = Battleship.remaining(board);
  const fragment = document.createDocumentFragment();
  const axis = (label, row = false) => { const el = document.createElement('span'); el.className = 'axis' + (row ? ' row-axis' : ''); el.textContent = label; el.setAttribute('aria-hidden', 'true'); fragment.append(el); };
  axis(''); [...letters].forEach(letter => axis(letter));
  board.forEach((state, i) => {
    if (i % 10 === 0) axis(Math.floor(i / 10) + 1, true);
    const button = document.createElement('button'), recommended = recommendation.cells.includes(i);
    button.className = `cell ${state}${recommended ? ' recommended' : ''}`;
    button.textContent = ['hit', 'sunk'].includes(state) ? '×' : ['miss', 'auto'].includes(state) ? '·' : '';
    button.setAttribute('aria-label', `${coordinate(i)}: ${labels[state]}${recommended ? ', рекомендуемый выстрел' : ''}`);
    button.title = `${coordinate(i)} · ${labels[state]}`;
    button.disabled = ['miss', 'auto', 'sunk'].includes(state) || recommendation.complete;
    button.dataset.index = i;
    button.addEventListener('click', () => openCell(i));
    fragment.append(button);
  });
  $('#board').replaceChildren(fragment);
  $('#turn').textContent = recommendation.complete ? 'Победа!' : `Ход ${history.length + 1}`;
  $('#undo').disabled = !history.length;
  $('#suggestion').textContent = recommendation.complete ? 'Весь флот потоплен!' : !recommendation.cells.length ? 'Проверьте отметки' : recommendation.hunting ? 'Добейте раненый корабль' : 'Выбирайте жёлтую клетку';
  $('#tip').textContent = recommendation.complete ? 'Все 10 кораблей найдены. Можно начинать новую игру.' : !recommendation.cells.length ? 'Нет подходящих позиций для оставшихся кораблей. Отмените ошибочный ход и проверьте результаты выстрелов.' : recommendation.hunting ? 'Подсвечены лучшие клетки рядом с попаданиями с учётом направления и длины оставшихся кораблей.' : 'Здесь помещается больше возможных кораблей. Подсказки учитывают промахи и оставшийся флот — это оценка, а не гарантия попадания.';
  $('#recommendation-count').textContent = recommendation.complete ? 'Отличная работа' : `Лучших вариантов: ${recommendation.cells.length}`;
  $('#fleet-count').textContent = `Осталось: ${Object.values(fleet).reduce((a, b) => a + b, 0)}`;
  $('#deck-count').textContent = `${board.filter(v => v === 'sunk').length} / 20`;
  $('#fleet').innerHTML = [4, 3, 2, 1].map(length => `<div class="fleet-row"><div class="ship-list">${Array.from({ length: Battleship.FLEET[length] }, (_, i) => `<span class="ship ${i >= fleet[length] ? 'dead' : ''}" aria-label="${length} палуб: ${i >= fleet[length] ? 'потоплен' : 'остался'}">${'<i class="deck"></i>'.repeat(length)}</span>`).join('')}</div><span class="fleet-label">${fleet[length]} / ${Battleship.FLEET[length]}</span></div>`).join('');
  if (!recommendation.complete) startAnalysis(analysisVersion);
}
function highlight(cells, probability) {
  $('#board').querySelectorAll('.cell').forEach(button => {
    const i = Number(button.dataset.index), recommended = cells.includes(i);
    button.classList.toggle('recommended', recommended);
    button.setAttribute('aria-label', `${coordinate(i)}: ${labels[board[i]]}${recommended ? ', рекомендуемый выстрел' : ''}`);
    button.title = `${coordinate(i)} · ${labels[board[i]]}${probability && board[i] === 'unknown' ? ` · попадание ≈ ${Math.round(probability[i] * 100)}%` : ''}`;
  });
}
function startAnalysis(version) {
  const snapshot = [...board];
  $('#suggestion').textContent = 'Выбираем следующий выстрел';
  $('#tip').textContent = 'Оцениваем возможные расстановки и ходы до победы. Пока жёлтым показана предварительная подсказка.';
  $('#recommendation-count').textContent = 'Подбираем допустимые расстановки…';
  $('.tip-card').setAttribute('aria-busy', 'true');
  const progress = value => {
    if (version !== analysisVersion) return;
    $('#recommendation-count').textContent = value.phase === 'endgame' ? 'Просчитываем последние корабли…' : `Расстановки: ${value.samples} / ${value.target}`;
  };
  const finish = result => {
    if (version !== analysisVersion) return;
    analysisWorker?.terminate(); analysisWorker = null;
    $('.tip-card').setAttribute('aria-busy', 'false');
    if (result.status === 'ready') {
      highlight(result.cells, result.probability);
      const best = result.estimates[0];
      $('#suggestion').textContent = result.cells.length > 1 ? 'Выбирайте жёлтую клетку' : `Цель — ${coordinate(best.cell)}`;
      $('#tip').textContent = result.selection === 'endgame'
        ? `Этот ход минимизирует среднее число оставшихся выстрелов в расчётной модели: около ${result.expectedShots.toFixed(1).replace('.', ',')} до победы. Конкретная партия может закончиться раньше или позже.`
        : 'Подсвечены клетки с максимальным расчётным шансом попадания. Оценка приблизительная и зависит от выборки расстановок.';
      $('#forecast').hidden = false;
      const chances = result.estimates.map(estimate => Math.round(estimate.hitProbability * 100));
      const low = Math.min(...chances), high = Math.max(...chances);
      $('#hit-chance').textContent = low === high ? `≈ ${low}%` : `≈ ${low}–${high}%`;
      $('#recommendation-count').textContent = `${result.samples} расстановок`;
      if (result.cells.length > 1) $('#tip').textContent += result.selection === 'endgame'
        ? ' Подсвеченные ходы равноценны по ожидаемому числу выстрелов.'
        : ' У подсвеченных клеток одинаковый расчётный шанс.';
      $('#announcement').textContent = `Рекомендуется ${coordinate(best.cell)}. Шанс попадания около ${Math.round(best.hitProbability * 100)}%.`;
    } else if (result.status === 'inconsistent') {
      highlight([]);
      $('#suggestion').textContent = 'Проверьте отметки';
      $('#tip').textContent = 'Нет полной расстановки флота, совместимой с полем. Проверьте попадания и размеры кораблей. Если все палубы корабля отмечены, выберите «Убил».';
      $('#recommendation-count').textContent = 'Расстановка невозможна';
    } else {
      $('#suggestion').textContent = 'Предварительная подсказка';
      $('#tip').textContent = 'Полный расчёт не завершён. Жёлтые клетки выбраны по допустимым положениям отдельных кораблей; вероятности пока не рассчитаны.';
      $('#recommendation-count').textContent = 'Упрощённая оценка';
    }
  };
  const fallback = () => {
    if (version !== analysisVersion) return;
    analysisWorker?.terminate(); analysisWorker = null;
    // File URLs or browser policies may block workers. Cooperative yields keep
    // the local-file version usable and cancellation prevents stale results.
    setTimeout(() => planner.analyze(snapshot, { onProgress: progress, isCancelled: () => version !== analysisVersion })
      .then(finish).catch(error => { if (error.message !== 'cancelled') finish({ status: 'limited' }); }), 0);
  };
  try {
    const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
    try { analysisWorker = new Worker(url); } finally { URL.revokeObjectURL(url); }
    analysisWorker.onmessage = ({ data }) => { if (data.progress) progress(data.progress); else if (data.result) finish(data.result); else finish({ status: 'limited' }); };
    analysisWorker.onerror = event => { event.preventDefault(); fallback(); };
    analysisWorker.postMessage({ board: snapshot });
  } catch { fallback(); }
}
function openCell(i) {
  selected = i;
  $('#cell-name').textContent = coordinate(i);
  $('#cell-error').textContent = '';
  $('[data-result=hit]').disabled = board[i] === 'hit';
  $('#cell-dialog').showModal();
}
document.querySelectorAll('[data-result]').forEach(button => button.addEventListener('click', () => {
  try {
    const next = Battleship.mark(board, selected, button.dataset.result);
    history.push([...board]); board = next;
    $('#cell-dialog').close(); save(); render();
    $('#announcement').textContent = `${coordinate(selected)}: ${labels[button.dataset.result]}. ${$('#suggestion').textContent}`;
    const target = $('#board').querySelector(`[data-index="${selected}"]:not(:disabled)`) || $('#board .recommended') || $('#undo');
    target.focus();
  } catch (error) { $('#cell-error').textContent = error.message; }
}));
$('#undo').addEventListener('click', () => { if (history.length) { board = history.pop(); save(); render(); $('#announcement').textContent = 'Последний ход отменён'; } });
$('#reset').addEventListener('click', () => {
  if (history.length && !confirm('Начать новую игру? Текущие отметки будут удалены.')) return;
  board = Array(100).fill('unknown'); history = []; save(); render();
});
$('#cell-dialog').addEventListener('click', event => { if (event.target === $('#cell-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
render();
