(function () {
  'use strict';

  const W = 9;
  const H = 16;
  const HIDDEN = 3; // spawn zone at the top; a piece locked entirely above here ends the game
  // Straddle rule: a locked piece may poke above the board as long as one
  // cell sits at or below the danger line, so cells can legally live above
  // row 0 — where the board does NOT render them. Deliberate: playing the
  // overhang half blind is part of the drama (playtested: always showing
  // sky rows wastes too much screen). If blind play doesn't hold up,
  // consider an endgame zoom instead of permanent sky.
  const TICK_MS = 550;
  const LOCK_DELAY_MS = 500;
  const LOCK_RESETS = 15; // cap so wiggling in place can't stall forever
  const SPAWN_GRACE_MS = 1000; // a fresh piece can't lock this soon after spawning
  const WIN_TIER = 12;
  const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Difficulty: every 10 merges the drop window advances one level. The
  // window sweeps tiers 1..9 and widens only at the top turnaround
  // (grow-at-top): each width sweeps down and back up before the next
  // widening — [1], ... [9], [8,9] down to [1,2] and back up to [8,9],
  // then [7,8,9], ... — 73 levels ending on [1..9]. Chosen over
  // widen-at-every-turnaround (45 levels) by simulation (sim.js --window):
  // it restores headroom above strong play with only mild difficulty
  // relief, keeps skill visible, and the widening lands as relief — the
  // new smaller tier unlocks mid-big-piece era.
  const MERGES_PER_LEVEL = 10;
  const START_LEVEL = 1; // default: the full ladder from [1]; the selector skips ahead
  const TIER_CYCLE = 9;
  const WINDOWS = (() => {
    const seq = [];
    const push = (w, s) => {
      const tiers = [];
      for (let i = 0; i < w; i++) tiers.push(s + i);
      seq.push(tiers);
    };
    let w = 1, s = 1, dir = 1;
    push(w, s);
    while (w < TIER_CYCLE) {
      const top = TIER_CYCLE + 1 - w;
      if (dir === 1 && s === top) { w++; s = TIER_CYCLE + 1 - w; dir = -1; }
      else if (dir === -1 && s === 1) { dir = 1; s++; }
      else s += dir;
      push(w, s);
    }
    return seq;
  })();
  const MAX_LEVEL = WINDOWS.length;
  function dropTiers(level) {
    return WINDOWS[Math.min(level, MAX_LEVEL) - 1];
  }
  const POOLS = new Map();
  function poolFor(tier) {
    if (!POOLS.has(tier)) POOLS.set(tier, Polyomino.enumerate(tier, 'one-sided'));
    return POOLS.get(tier);
  }

  // Starting difficulty: pick the level (and thus the drop window) a new
  // game opens on, mirroring sim.js --start. Applied on restart; lives in
  // the URL hash (#level=N, same deep-link style as the pipes mock).
  function levelFromHash() {
    const m = /(?:#|&)level=(\d+)/.exec(location.hash);
    const fromUrl = m ? parseInt(m[1], 10) : NaN;
    return fromUrl >= 1 && fromUrl <= MAX_LEVEL ? fromUrl : START_LEVEL;
  }
  let startLevel = levelFromHash();

  const boardSvg = document.getElementById('board');
  const nextSvg = document.getElementById('next');
  const holdSvg = document.getElementById('hold');
  const scoreEl = document.getElementById('score');
  const levelEl = document.getElementById('level-tag');
  const nextNameEl = document.getElementById('next-name');
  const holdNameEl = document.getElementById('hold-name');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayScore = document.getElementById('overlay-score');
  // 1..9 above the board: cyan = in the drop window, red = rescue drop,
  // gray = not dropping right now
  const tierStrip = document.getElementById('tier-strip');
  const tierEls = [];
  for (let t = 1; t <= TIER_CYCLE; t++) {
    const span = document.createElement('span');
    span.textContent = t;
    tierStrip.appendChild(span);
    tierEls.push(span);
  }

  const startSelect = document.getElementById('start-level');
  for (let L = 1; L <= MAX_LEVEL; L++) {
    const opt = document.createElement('option');
    opt.value = L;
    opt.textContent = `${L} · drops ${dropTiers(L).join(' ')}`;
    startSelect.appendChild(opt);
  }
  startSelect.value = startLevel;
  startSelect.addEventListener('change', () => {
    startLevel = parseInt(startSelect.value, 10);
    history.replaceState(null, '', '#level=' + startLevel);
    startSelect.blur(); // hand the arrow keys back to the game
    restart();
  });
  // editing #level=N in the address bar doesn't reload the page, so apply
  // it live (our own replaceState writes never fire hashchange)
  window.addEventListener('hashchange', () => {
    const fromUrl = levelFromHash();
    if (fromUrl === startLevel) return;
    startLevel = fromUrl;
    startSelect.value = fromUrl;
    restart();
  });

  const state = {
    pieces: [],
    falling: null,
    next: null,
    hold: null,
    canHold: true,
    bag: null,
    bagLevel: 0,
    score: 0,
    merges: 0,
    level: startLevel,
    over: false,
    paused: false,
  };
  const cellMap = new Map();
  const key = (x, y) => x + ',' + y;
  // piece look (berry palette + jelly SVG) lives in jelly.js, shared with
  // the style guide at explorer/styleguide.html so the two can never drift
  const { tierName, colors: tierColors, shapePaths } = Jelly;
  const fmt = v => Math.round(v * 1000) / 1000;

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function connected(cells) {
    const occupied = new Set(cells.map(c => c.join(',')));
    const seen = new Set([cells[0].join(',')]);
    const stack = [cells[0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of NEIGHBORS) {
        const k = (x + dx) + ',' + (y + dy);
        if (occupied.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push([x + dx, y + dy]);
        }
      }
    }
    return seen.size === cells.length;
  }

  function collides(cells, ignore) {
    for (const [x, y] of cells) {
      // no ceiling: y < 0 is open headroom above the board, so pieces can
      // spawn above a tall stack and floor kicks work near the top
      if (x < 0 || x >= W || y >= H) return true;
      const p = cellMap.get(key(x, y));
      if (p && p !== ignore) return true;
    }
    return false;
  }

  function addPiece(cells, size) {
    const piece = { cells, size, fresh: false };
    state.pieces.push(piece);
    for (const [x, y] of cells) cellMap.set(key(x, y), piece);
    return piece;
  }

  function removePiece(piece) {
    for (const [x, y] of piece.cells) cellMap.delete(key(x, y));
    state.pieces.splice(state.pieces.indexOf(piece), 1);
  }

  // First-cell erosion in board orientation: repeatedly remove the first cell
  // in reading order whose removal keeps the shape connected.
  function erode(cells, target) {
    while (cells.length > target) {
      const sorted = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const cell of sorted) {
        const rest = cells.filter(c => c !== cell);
        if (connected(rest)) {
          cells = rest;
          break;
        }
      }
    }
    return cells;
  }

  // Glue every group of touching equal-size pieces, then erode the blob down
  // to its new tier.
  function mergePass() {
    const parent = new Map();
    const find = p => {
      while (parent.get(p) !== p) {
        parent.set(p, parent.get(parent.get(p)));
        p = parent.get(p);
      }
      return p;
    };
    for (const p of state.pieces) parent.set(p, p);
    for (const p of state.pieces) {
      for (const [x, y] of p.cells) {
        for (const [dx, dy] of NEIGHBORS) {
          const q = cellMap.get(key(x + dx, y + dy));
          if (q && q !== p && q.size === p.size) parent.set(find(p), find(q));
        }
      }
    }
    const groups = new Map();
    for (const p of state.pieces) {
      const root = find(p);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(p);
    }
    let merged = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      merged = true;
      state.merges++;
      const size = group[0].size;
      // Any merge yields exactly one tier up: 3+3+3 = 4, not 5. Keeps
      // multi-merges from skipping rungs of the ladder.
      const target = size + 1;
      for (const p of group) removePiece(p);
      // Reaching the win tier pops the blob outright (11 + 11 = 0), like
      // two watermelons cancelling in suika — no 12-mino ever sits on the
      // board, and the pop hands back the space it was hogging.
      if (target < WIN_TIER) {
        const cells = group.flatMap(p => p.cells);
        const piece = addPiece(erode(cells, target), target);
        piece.fresh = true;
      }
      state.score += target * target * (group.length - 1);
    }
    return merged;
  }

  // Pieces fall as rigid units until every one is supported.
  function gravityPass() {
    let any = false, movedInSweep;
    do {
      movedInSweep = false;
      const sorted = [...state.pieces]
        .sort((a, b) => Math.max(...b.cells.map(c => c[1])) - Math.max(...a.cells.map(c => c[1])));
      for (const p of sorted) {
        let drop = 0;
        while (!collides(p.cells.map(([x, y]) => [x, y + drop + 1]), p)) drop++;
        if (drop > 0) {
          for (const [x, y] of p.cells) cellMap.delete(key(x, y));
          p.cells = p.cells.map(([x, y]) => [x, y + drop]);
          for (const [x, y] of p.cells) cellMap.set(key(x, y), p);
          movedInSweep = any = true;
        }
      }
    } while (movedInSweep);
    return any;
  }

  function resolve() {
    for (;;) {
      const merged = mergePass();
      const fell = gravityPass();
      if (!merged && !fell) break;
    }
    // flat pacing: every MERGES_PER_LEVEL merges advances the window one step
    const level = Math.min(MAX_LEVEL, Math.floor(state.merges / MERGES_PER_LEVEL) + startLevel);
    if (level > state.level) {
      state.level = level;
      const tiers = dropTiers(level);
      // enumerate any new tier's pool off the input path (tier 9 takes ~350ms)
      setTimeout(() => tiers.forEach(poolFor), 0);
    }
    renderLevel();
  }

  // Rescue drops: sizes on the board below the window's floor stay in the
  // draw (one slot each), so no piece is ever permanently unmatchable.
  // Wrapped windows like [9,1] aren't sorted, so take the true floor.
  function strandedSizes(tiers) {
    const floor = Math.min(...tiers);
    return new Set(state.pieces.map(p => p.size).filter(s => s < floor));
  }

  function renderLevel() {
    const tiers = dropTiers(state.level);
    levelEl.textContent = `level ${state.level}`;
    const dropping = new Set(tiers);
    const rescue = strandedSizes(tiers);
    tierEls.forEach((span, i) => {
      const t = i + 1;
      const cls = dropping.has(t) ? 'drop' : rescue.has(t) ? 'rescue' : 'off';
      span.className = cls;
      if (cls === 'off') {
        span.removeAttribute('style');
      } else {
        // berry-colored specimen dots; rescue fades the body but keeps the
        // number at full strength so it stays readable (AA-audited inks)
        const c = tierColors(t);
        span.style.background = cls === 'rescue' ? c.rescueFill : c.stripFill;
        span.style.borderColor = c.line;
        span.style.color = cls === 'rescue' ? c.rescueInk : c.labelInk;
      }
    });
  }

  // Bag-shuffle draw: tiers come from a shuffled bag holding one copy of
  // each window tier plus each stranded size, refilled when it empties or
  // the level (and thus the window) changes. Rescue sizes that clear while
  // still in the bag are skipped at draw time. Compared to independent
  // draws this floors the drought/flood lottery: in the simulator it
  // collapsed greedy's spread (sd 7.2 -> 3.3, worst game level 9 -> 23).
  function drawTier(choices) {
    for (;;) {
      if (!state.bag || !state.bag.length || state.bagLevel !== state.level) {
        state.bag = [...choices];
        for (let i = state.bag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [state.bag[i], state.bag[j]] = [state.bag[j], state.bag[i]];
        }
        state.bagLevel = state.level;
      }
      const tier = state.bag.pop();
      if (choices.includes(tier)) return tier;
    }
  }

  // Shape choice within a size comes from a persistent shuffled queue over
  // the size's whole pool — guideline 7-bag generalized (tier 4 is exactly
  // the 7 tetrominoes). Queues survive window changes: a size that leaves
  // the window resumes where it left off when the window returns. Only
  // restart clears them. For big tiers the pool is huge, so this is
  // indistinguishable from uniform there; for small tiers it caps repeats.
  const shapeQueues = new Map(); // size -> shuffled indices into poolFor(size)
  function drawShape(tier) {
    const pool = poolFor(tier);
    let queue = shapeQueues.get(tier);
    if (!queue || !queue.length) {
      queue = pool.map((_, i) => i);
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      shapeQueues.set(tier, queue);
    }
    return pool[queue.pop()];
  }

  function randomPiece() {
    const tiers = dropTiers(state.level);
    const stranded = strandedSizes(tiers);
    const choices = [...stranded, ...tiers];
    const tier = drawTier(choices);
    let cells = drawShape(tier);
    const turns = Math.floor(Math.random() * 4);
    for (let i = 0; i < turns; i++) cells = rotatedCW(cells);
    return { tier, cells };
  }

  function rotatedCW(cells) {
    const maxY = Math.max(...cells.map(c => c[1]));
    return cells
      .map(([x, y]) => [maxY - y, x])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }

  // Rotate within a fixed square box (side = max bounding dimension at spawn),
  // like classic Tetris rotation systems: the box stays anchored so pieces
  // don't lurch sideways, and four rotations return exactly to the start.
  function rotatedInBox(cells, box, dir) {
    return cells
      .map(([x, y]) => dir < 0 ? [y, box - 1 - x] : [box - 1 - y, x])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }

  function fallingCells(falling, dx, dy, cells) {
    return (cells || falling.cells).map(([x, y]) => [x + falling.x + (dx || 0), y + falling.y + (dy || 0)]);
  }

  function spawn(forced) {
    const piece = forced || state.next || randomPiece();
    if (!forced) state.next = randomPiece();
    const w = Math.max(...piece.cells.map(c => c[0])) + 1;
    const h = Math.max(...piece.cells.map(c => c[1])) + 1;
    const box = Math.max(w, h);
    state.falling = { cells: piece.cells, tier: piece.tier, box, x: Math.floor((W - box) / 2), y: 0, lowY: 0, resets: 0, bornAt: Date.now() };
    clearLockTimer();
    // Spawn protection: if the stack reaches the spawn area, raise the piece
    // into the headroom above the board instead of ending the game unseen.
    // The player still loses if it locks entirely above the danger line.
    while (collides(fallingCells(state.falling)) && state.falling.y > -h) state.falling.y--;
    state.falling.lowY = state.falling.y;
    if (collides(fallingCells(state.falling))) gameOver();
    renderNext();
  }

  // Hold: stash the falling piece (keeping its current rotation) and play
  // the held piece instead — or the previewed one when the slot is empty.
  // One hold per spawn: the slot relocks until a piece actually locks down.
  function holdPiece() {
    if (!state.canHold) return;
    state.canHold = false;
    const minX = Math.min(...state.falling.cells.map(c => c[0]));
    const minY = Math.min(...state.falling.cells.map(c => c[1]));
    const stash = {
      tier: state.falling.tier,
      cells: state.falling.cells.map(([x, y]) => [x - minX, y - minY]),
    };
    const out = state.hold;
    state.hold = stash;
    spawn(out);
    renderHold();
  }

  function tryMove(dx, dy, cells) {
    const moved = fallingCells(state.falling, dx, dy, cells);
    if (collides(moved)) return false;
    state.falling.x += dx || 0;
    state.falling.y += dy || 0;
    if (cells) state.falling.cells = cells;
    return true;
  }

  // SRS-flavored kicks generalized to any piece size: try the nearest
  // offsets first — wall kicks, then down (slot entry), then up (floor
  // kick), then diagonals — expanding out to ceil(box/2). Small enough to
  // stay predictable; scales with the piece so big shapes can turn near
  // walls at all.
  function tryRotate(dir) {
    const cells = rotatedInBox(state.falling.cells, state.falling.box, dir);
    if (tryMove(0, 0, cells)) return true;
    const range = Math.ceil(state.falling.box / 2);
    // mirror the horizontal preference for CCW, like SRS mirrors its tables
    const s = dir < 0 ? -1 : 1;
    for (let d = 1; d <= range; d++) {
      for (const [dx, dy] of [[-d * s, 0], [d * s, 0], [0, d], [0, -d], [-d * s, d], [d * s, d], [-d * s, -d], [d * s, -d]]) {
        if (tryMove(dx, dy, cells)) return true;
      }
    }
    return false;
  }

  let lockTimer = null;

  function clearLockTimer() {
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  }

  function grounded() {
    return state.falling && collides(fallingCells(state.falling, 0, 1));
  }

  // Guideline-style lock delay: a landed piece gets LOCK_DELAY_MS before it
  // locks, and each successful move or rotation restarts the clock, up to
  // LOCK_RESETS times. Reaching a new lowest row refunds the resets, so real
  // descent re-earns leniency but wiggling in place eventually locks.
  function updateLockState(acted) {
    if (!state.falling) return;
    if (state.falling.y > state.falling.lowY) {
      state.falling.lowY = state.falling.y;
      state.falling.resets = 0;
    }
    if (!grounded()) { clearLockTimer(); return; }
    // Spawn protection: the timer never fires within SPAWN_GRACE_MS of
    // spawning, so a piece landing on a tall stack still gets reading time.
    const delay = Math.max(LOCK_DELAY_MS, state.falling.bornAt + SPAWN_GRACE_MS - Date.now());
    if (!lockTimer) {
      lockTimer = setTimeout(fireLock, delay);
    } else if (acted && state.falling.resets < LOCK_RESETS) {
      state.falling.resets++;
      clearLockTimer();
      lockTimer = setTimeout(fireLock, delay);
    }
  }

  function fireLock() {
    lockTimer = null;
    if (state.over || !state.falling || !grounded()) return;
    lock();
    render();
  }

  function lock() {
    clearLockTimer();
    addPiece(fallingCells(state.falling), state.falling.tier);
    state.falling = null;
    state.canHold = true;
    resolve();
    // Straddle rule: only a piece resting ENTIRELY above the danger line
    // ends the game — a piece with any cell at or below it plays on.
    if (state.pieces.some(p => p.cells.every(c => c[1] < HIDDEN))) {
      gameOver();
    } else {
      spawn();
    }
    scoreEl.textContent = state.score;
  }

  // Pausing must stop the clocks, not just gravity: the lock timer would
  // fire mid-pause, and the spawn grace is wall-clock based, so we cancel
  // the timer and push bornAt forward by the pause duration on resume.
  function togglePause() {
    if (state.over) return;
    state.paused = !state.paused;
    if (state.paused) {
      state.pausedAt = Date.now();
      clearLockTimer();
      overlayTitle.textContent = 'paused';
      overlayScore.textContent = '';
      overlay.classList.remove('hidden');
    } else {
      if (state.falling) state.falling.bornAt += Date.now() - state.pausedAt;
      overlay.classList.add('hidden');
      updateLockState(false);
    }
  }

  function tick() {
    if (state.over || state.paused || !state.falling) return;
    tryMove(0, 1);
    updateLockState(false); // gravity landing arms the timer but never resets it
    render();
  }

  function hardDrop() {
    while (tryMove(0, 1));
    lock();
    render();
  }

  function gameOver() {
    state.over = true;
    state.falling = null;
    overlayTitle.textContent = 'game over';
    overlayScore.textContent = state.score;
    overlay.classList.remove('hidden');
  }

  function restart() {
    state.pieces = [];
    cellMap.clear();
    state.score = 0;
    state.merges = 0;
    state.level = startLevel;
    state.over = false;
    state.paused = false;
    state.next = null;
    state.hold = null;
    state.canHold = true;
    state.bag = null;
    state.bagLevel = 0;
    shapeQueues.clear();
    renderHold();
    overlay.classList.add('hidden');
    scoreEl.textContent = '0';
    renderLevel();
    spawn();
    render();
  }

  boardSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  boardSvg.appendChild(el('rect', { class: 'board-bg', width: W, height: H }));
  // the danger line is a soft wavy thread on the liquid, not a hazard stripe
  let dangerD = `M0 ${HIDDEN} Q0.45 ${HIDDEN - 0.13} 0.9 ${HIDDEN}`;
  for (let x = 1.8; x <= W + 0.01; x += 0.9) dangerD += ` T${fmt(x)} ${HIDDEN}`;
  boardSvg.appendChild(el('path', { class: 'danger', d: dangerD }));
  const pieceLayer = el('g', {});
  const ghostLayer = el('g', { class: 'ghost' });
  const fallingLayer = el('g', {});
  boardSvg.appendChild(pieceLayer);
  boardSvg.appendChild(ghostLayer);
  boardSvg.appendChild(fallingLayer);

  function render() {
    pieceLayer.textContent = '';
    ghostLayer.textContent = '';
    fallingLayer.textContent = '';
    for (const piece of state.pieces) {
      pieceLayer.appendChild(
        shapePaths(piece.cells, piece.size, { cls: piece.fresh ? 'fresh' : '' }));
      piece.fresh = false;
    }
    if (state.falling) {
      let drop = 0;
      while (!collides(fallingCells(state.falling, 0, drop + 1))) drop++;
      if (drop > 0) {
        ghostLayer.appendChild(
          shapePaths(fallingCells(state.falling, 0, drop), state.falling.tier, { ghost: true }));
      }
      fallingLayer.appendChild(
        shapePaths(fallingCells(state.falling), state.falling.tier));
    }
  }

  const speciesName = tier => `${tierName(tier).toLowerCase()} amoeba`;

  function renderNext() {
    nextSvg.textContent = '';
    const { tier, cells } = state.next;
    const { w, h } = Polyomino.bounds(cells);
    const pad = 0.2;
    nextSvg.setAttribute('viewBox', `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`);
    nextSvg.appendChild(shapePaths(cells, tier));
    nextNameEl.textContent = speciesName(tier);
  }

  function renderHold() {
    holdSvg.textContent = '';
    holdNameEl.textContent = state.hold ? speciesName(state.hold.tier) : '';
    if (!state.hold) return;
    const { tier, cells } = state.hold;
    const { w, h } = Polyomino.bounds(cells);
    const pad = 0.2;
    holdSvg.setAttribute('viewBox', `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`);
    holdSvg.appendChild(shapePaths(cells, tier));
  }

  const actions = {
    left: () => updateLockState(tryMove(-1, 0)),
    right: () => updateLockState(tryMove(1, 0)),
    rotate: () => updateLockState(tryRotate(1)),
    rotateCcw: () => updateLockState(tryRotate(-1)),
    down: () => { tryMove(0, 1); updateLockState(false); }, // hard drop is the instant commit
    drop: () => hardDrop(),
    hold: () => holdPiece(),
  };

  document.addEventListener('keydown', e => {
    if (e.target === startSelect) return; // arrows there browse the selector
    // Tetris-guideline layout (Z/X/C + Shift), so mainstream muscle memory
    // transfers; PgUp/PgDn are legacy aliases for Toni's laptop.
    const keyAct = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotate',
      ArrowDown: 'down', ' ': 'drop',
      x: 'rotate', X: 'rotate', z: 'rotateCcw', Z: 'rotateCcw',
      c: 'hold', C: 'hold', Shift: 'hold',
      PageDown: 'rotateCcw', PageUp: 'hold',
    }[e.key];
    if (keyAct) e.preventDefault();
    if (e.key === 'r' || e.key === 'R') return restart();
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') return togglePause();
    if (state.over || state.paused || !state.falling || !keyAct) return;
    actions[keyAct]();
    render();
  });

  document.getElementById('restart').addEventListener('click', restart);

  renderLevel();
  spawn();
  render();
  setInterval(tick, TICK_MS);
})();
