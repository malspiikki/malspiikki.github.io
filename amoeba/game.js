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
  const COLONY_TIER = 12; // this size outgrows the dish and emigrates to the colony
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The rules layer (windows, merging, gravity, erosion, the bag draw,
  // colony physics) lives in rules.js, shared with sim.js and the tests;
  // this file is the real-time layer — the falling piece, clocks, input,
  // rendering. grow-at-top: each width sweeps down and back up before
  // widening — 73 levels ending on [1..9]; chosen by simulation
  // (sim.js --window), the whole story told in rules.js.
  const START_LEVEL = 1; // default: the full ladder from [1]; the selector skips ahead
  const TIER_CYCLE = Rules.TIER_CYCLE;
  const WINDOWS = Rules.windowSequence('growtop');
  const MAX_LEVEL = WINDOWS.length;
  function dropTiers(level) {
    return WINDOWS[Math.min(level, MAX_LEVEL) - 1];
  }
  const { collides, addPiece, poolFor } = Rules;

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
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const helpEl = document.getElementById('help');
  const resumeBtn = document.getElementById('resume');
  const tallyEl = document.getElementById('tally');
  // 1..9 above the board: berry-lit = in the drop window, dashed faded
  // berry = rescue drop, dashed gray = not dropping right now (painted by
  // Jelly.stripDot, shared with the style guide)
  const tierStrip = document.getElementById('tier-strip');
  const tierEls = [];
  for (let t = 1; t <= TIER_CYCLE; t++) {
    const span = document.createElement('span');
    span.textContent = String(t);
    tierStrip.appendChild(span);
    tierEls.push(span);
  }

  const startSelect = /** @type {HTMLSelectElement} */ (
    document.getElementById('start-level')
  );
  for (let L = 1; L <= MAX_LEVEL; L++) {
    const opt = document.createElement('option');
    opt.value = String(L);
    opt.textContent = `${L} · drops ${dropTiers(L).join(' ')}`;
    startSelect.appendChild(opt);
  }
  startSelect.value = String(startLevel);
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
    startSelect.value = String(fromUrl);
    restart();
  });

  const state = {
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
    helpOpen: false,
    pausedByHelp: false,
  };
  // Two fields share the merge rules but not the gravity. The dish (the
  // playfield) pulls down and erodes in reading order. The colony — the
  // free-floating world under the score where size-12 blobs, the first
  // of their kind to leave home, settle beyond the player's reach — has no
  // up: it pulls toward its own shared center of mass and erodes from
  // the rim inward (both adopted from the ball experiment), so the
  // settlement packs itself round. It is unbounded; the camera zooms
  // out as it grows.
  const board = {
    w: W,
    h: H,
    pieces: [],
    cells: new Map(),
    erode: Rules.erode,
  };
  // Colony fusions erode against the settlement's common center of
  // mass, snapshotted per fusion.
  const colony = {
    pieces: [],
    cells: new Map(),
    erode: (cells, target) =>
      Rules.squeezeToward(cells, target, Rules.colonyCenter(colony, cells)),
  };
  // Specimen census for the game-over field report: how many of each
  // size came into being, split by origin — merged (fused into existence,
  // dish or colony) vs dropped (locked into the dish from the supply).
  const census = []; // tier -> { merged, dropped }
  function recordSpecimen(tier, kind) {
    const c = census[tier] || (census[tier] = { merged: 0, dropped: 0 });
    c[kind]++;
  }
  // piece look (berry palette + jelly SVG) lives in jelly.js, shared with
  // the style guide at explorer/styleguide.html so the two can never drift
  const { shapePaths } = Jelly;
  const fmt = (v) => Math.round(v * 1000) / 1000;

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // Land a size-12 emigrant (arrival spot chosen by
  // Rules.emigrantOffset: just outside the hull, from a random
  // direction; the first settler founds the world at the origin).
  function sendToColony(cells) {
    const [ox, oy] = Rules.emigrantOffset(colony, cells, Math.random);
    Rules.addPiece(
      colony,
      cells.map(([x, y]) => [x + ox, y + oy]),
      COLONY_TIER,
    ).fresh = true;
    // zero-g settling and colony fusions (Rules.settle); colony merges
    // feed the score and the census but never pace the difficulty
    for (const { target, count } of Rules.settle(colony)) {
      recordSpecimen(target, 'merged');
      state.score += target * target * (count - 1);
    }
    renderColony();
  }

  function resolve() {
    const events = Rules.resolveField(board, {
      // reaching the colony tier outgrows the dish: the size-12 blob
      // emigrates instead of popping (the old watermelon rule), balling
      // up around its own center as it breaks free of the dish's gravity
      topTier: COLONY_TIER,
      onLeave: (fused, target) =>
        sendToColony(Rules.squeezeToward(fused, target, Rules.centroid(fused))),
    });
    for (const { target, count } of events) {
      state.merges++; // only dish merges pace the difficulty
      recordSpecimen(target, 'merged');
      state.score += target * target * (count - 1);
    }
    // flat pacing: every MERGES_PER_LEVEL merges advances the window one step
    const level = Rules.levelFor(state.merges, startLevel, MAX_LEVEL);
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
  const strandedSizes = (tiers) => Rules.strandedSizes(board.pieces, tiers);

  function renderLevel() {
    const tiers = dropTiers(state.level);
    levelEl.textContent = `level ${state.level}`;
    const dropping = new Set(tiers);
    const rescue = strandedSizes(tiers);
    tierEls.forEach((span, i) => {
      const t = i + 1;
      Jelly.stripDot(
        span,
        t,
        dropping.has(t) ? 'drop' : rescue.has(t) ? 'rescue' : 'off',
      );
    });
  }

  // Bag-shuffle tier draw (Rules.drawTier): one copy of each window tier
  // plus each stranded size, refilled on empty or level change.
  const drawTier = (choices) => Rules.drawTier(state, choices, Math.random);

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
    for (let i = 0; i < turns; i++) cells = Rules.rotatedCW(cells);
    return { tier, cells };
  }

  function fallingCells(falling, dx, dy, cells) {
    return (cells || falling.cells).map(([x, y]) => [
      x + falling.x + (dx || 0),
      y + falling.y + (dy || 0),
    ]);
  }

  function spawn(forced) {
    const piece = forced || state.next || randomPiece();
    if (!forced) state.next = randomPiece();
    const w = Math.max(...piece.cells.map((c) => c[0])) + 1;
    const h = Math.max(...piece.cells.map((c) => c[1])) + 1;
    const box = Math.max(w, h);
    state.falling = {
      cells: piece.cells,
      tier: piece.tier,
      box,
      x: Math.floor((W - box) / 2),
      y: 0,
      lowY: 0,
      resets: 0,
      bornAt: Date.now(),
    };
    clearLockTimer();
    // Spawn protection: if the stack reaches the spawn area, raise the piece
    // into the headroom above the board instead of ending the game unseen.
    // The player still loses if it locks entirely above the danger line.
    while (collides(board, fallingCells(state.falling)) && state.falling.y > -h)
      state.falling.y--;
    state.falling.lowY = state.falling.y;
    if (collides(board, fallingCells(state.falling))) gameOver();
    renderNext();
    renderHold(); // the empty-slot ghost tracks the new falling piece
  }

  // Hold: stash the falling piece (keeping its current rotation) and play
  // the held piece instead — or the previewed one when the slot is empty.
  // One hold per spawn: the slot relocks until a piece actually locks down.
  function holdPiece() {
    if (!state.canHold) return;
    state.canHold = false;
    const minX = Math.min(...state.falling.cells.map((c) => c[0]));
    const minY = Math.min(...state.falling.cells.map((c) => c[1]));
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
    if (collides(board, moved)) return false;
    state.falling.x += dx || 0;
    state.falling.y += dy || 0;
    if (cells) {
      state.falling.cells = cells;
      if (!state.hold) renderHold(); // keep the empty-slot ghost's rotation live
    }
    return true;
  }

  // SRS-flavored kicks, generalized to any piece size and scaled with it
  // (Rules.kickOffsets tells the whole story, vertical box - 1 reach
  // included); the in-place try comes first.
  function tryRotate(dir) {
    const cells = Rules.rotatedInBox(
      state.falling.cells,
      state.falling.box,
      dir,
    );
    if (tryMove(0, 0, cells)) return true;
    for (const [dx, dy] of Rules.kickOffsets(state.falling.box, dir)) {
      if (tryMove(dx, dy, cells)) return true;
    }
    return false;
  }

  let lockTimer = null;

  function clearLockTimer() {
    if (lockTimer) {
      clearTimeout(lockTimer);
      lockTimer = null;
    }
  }

  function grounded() {
    return state.falling && collides(board, fallingCells(state.falling, 0, 1));
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
    if (!grounded()) {
      clearLockTimer();
      return;
    }
    // Spawn protection: the timer never fires within SPAWN_GRACE_MS of
    // spawning, so a piece landing on a tall stack still gets reading time.
    const delay = Math.max(
      LOCK_DELAY_MS,
      state.falling.bornAt + SPAWN_GRACE_MS - Date.now(),
    );
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
    // a supply piece is encountered when it actually joins the culture,
    // so a piece parked in hold at game over never counts
    recordSpecimen(state.falling.tier, 'dropped');
    addPiece(board, fallingCells(state.falling), state.falling.tier);
    state.falling = null;
    state.canHold = true;
    resolve();
    // Straddle rule (Rules.lockedOut): only a piece resting ENTIRELY
    // above the danger line ends the game
    if (Rules.lockedOut(board.pieces, HIDDEN)) {
      gameOver();
    } else {
      spawn();
    }
    scoreEl.textContent = state.score.toLocaleString();
  }

  // Pausing must stop the clocks, not just gravity: the lock timer would
  // fire mid-pause, and the spawn grace is wall-clock based, so we cancel
  // the timer and push bornAt forward by the pause duration on resume.
  function stopClocks() {
    state.paused = true;
    state.pausedAt = Date.now();
    clearLockTimer();
  }

  function resumeClocks() {
    state.paused = false;
    if (state.falling) state.falling.bornAt += Date.now() - state.pausedAt;
    updateLockState(false);
  }

  function togglePause() {
    if (state.over) return;
    if (state.paused) {
      overlay.classList.add('hidden');
      resumeClocks();
    } else {
      stopClocks();
      overlayTitle.textContent = 'paused';
      tallyEl.textContent = ''; // empty collapses it (CSS :empty)
      resumeBtn.hidden = false;
      overlay.classList.remove('hidden');
    }
  }

  // Help freezes a live game the same way pause does, but leaves an
  // existing pause or game-over untouched so closing it returns there.
  function toggleHelp() {
    state.helpOpen = !state.helpOpen;
    if (state.helpOpen) {
      if (!state.over && !state.paused) {
        stopClocks();
        state.pausedByHelp = true;
      }
      helpEl.classList.remove('hidden');
    } else {
      helpEl.classList.add('hidden');
      if (state.pausedByHelp) {
        state.pausedByHelp = false;
        resumeClocks();
      }
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
    // no score line: the score already stands above the dish, and the
    // frosted veil keeps it in view
    overlayTitle.textContent = 'game over';
    // the specimen tally (tally.js, shared with the explorer game-over
    // mock): rarest first, padded with unobserved rows down the whole
    // dish cycle
    Tally.render(tallyEl, census, COLONY_TIER);
    resumeBtn.hidden = true;
    overlay.classList.remove('hidden');
    Tally.openAtBest(tallyEl);
  }

  function restart() {
    board.pieces.length = 0;
    board.cells.clear();
    colony.pieces.length = 0;
    colony.cells.clear();
    state.score = 0;
    state.merges = 0;
    state.level = startLevel;
    state.over = false;
    state.paused = false;
    state.helpOpen = false;
    state.pausedByHelp = false;
    state.next = null;
    state.hold = null;
    state.canHold = true;
    state.bag = null;
    state.bagLevel = 0;
    census.length = 0;
    shapeQueues.clear();
    renderHold();
    overlay.classList.add('hidden');
    helpEl.classList.add('hidden');
    scoreEl.textContent = '0';
    renderLevel();
    renderColony();
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

  const colonySvg = document.getElementById('colony');
  const colonyWrap = document.getElementById('colony-wrap');
  const colonyLayer = el('g', {});
  colonySvg.appendChild(colonyLayer);

  // The colony camera: a square window centered on the settlement,
  // zooming out as it grows. 1.45× the bounding box keeps every cell
  // inside the circular vessel (the inscribed circle of the square
  // element); the floor of 8 keeps the first settler from filling the
  // porthole edge to edge.
  function renderColony() {
    colonyLayer.textContent = '';
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const piece of colony.pieces) {
      for (const [x, y] of piece.cells) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      colonyLayer.appendChild(
        shapePaths(piece.cells, piece.size, {
          cls: piece.fresh ? 'fresh' : '',
        }),
      );
      piece.fresh = false;
    }
    const empty = !colony.pieces.length;
    // the porthole only exists once the first settler arrives — until
    // then there is nothing out there to look at
    colonyWrap.hidden = empty;
    const cx = empty ? 0 : (minX + maxX + 1) / 2;
    const cy = empty ? 0 : (minY + maxY + 1) / 2;
    const side = Math.max(
      8,
      empty ? 0 : 1.45 * Math.max(maxX + 1 - minX, maxY + 1 - minY),
    );
    colonySvg.setAttribute(
      'viewBox',
      `${fmt(cx - side / 2)} ${fmt(cy - side / 2)} ${fmt(side)} ${fmt(side)}`,
    );
  }

  function render() {
    pieceLayer.textContent = '';
    ghostLayer.textContent = '';
    fallingLayer.textContent = '';
    for (const piece of board.pieces) {
      pieceLayer.appendChild(
        shapePaths(piece.cells, piece.size, {
          cls: piece.fresh ? 'fresh' : '',
        }),
      );
      piece.fresh = false;
    }
    if (state.falling) {
      let drop = 0;
      while (!collides(board, fallingCells(state.falling, 0, drop + 1))) drop++;
      if (drop > 0) {
        ghostLayer.appendChild(
          shapePaths(fallingCells(state.falling, 0, drop), state.falling.tier, {
            ghost: true,
          }),
        );
      }
      fallingLayer.appendChild(
        shapePaths(fallingCells(state.falling), state.falling.tier),
      );
    }
  }

  function renderNext() {
    nextSvg.textContent = '';
    const { tier, cells } = state.next;
    const { w, h } = Polyomino.bounds(cells);
    const pad = 0.2;
    nextSvg.setAttribute(
      'viewBox',
      `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`,
    );
    nextSvg.appendChild(shapePaths(cells, tier));
  }

  // An empty slot previews the falling piece in ghost style — what a
  // press of hold would stash there right now, rotation included.
  function renderHold() {
    holdSvg.textContent = '';
    let tier, cells;
    if (state.hold) {
      ({ tier, cells } = state.hold);
    } else if (state.falling) {
      const minX = Math.min(...state.falling.cells.map((c) => c[0]));
      const minY = Math.min(...state.falling.cells.map((c) => c[1]));
      tier = state.falling.tier;
      cells = state.falling.cells.map(([x, y]) => [x - minX, y - minY]);
    } else {
      return;
    }
    const { w, h } = Polyomino.bounds(cells);
    const pad = 0.2;
    holdSvg.setAttribute(
      'viewBox',
      `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`,
    );
    holdSvg.appendChild(
      shapePaths(cells, tier, state.hold ? {} : { ghost: true }),
    );
  }

  const actions = {
    left: () => updateLockState(tryMove(-1, 0)),
    right: () => updateLockState(tryMove(1, 0)),
    rotate: () => updateLockState(tryRotate(1)),
    rotateCcw: () => updateLockState(tryRotate(-1)),
    down: () => {
      tryMove(0, 1);
      updateLockState(false);
    }, // hard drop is the instant commit
    drop: () => hardDrop(),
    hold: () => holdPiece(),
  };

  document.addEventListener('keydown', (e) => {
    if (e.target === startSelect) return; // arrows there browse the selector
    // Tetris-guideline layout (Z/X/C + Shift), so mainstream muscle memory
    // transfers; PgUp/PgDn are legacy aliases for Toni's laptop.
    const keyAct = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'rotate',
      ArrowDown: 'down',
      ' ': 'drop',
      x: 'rotate',
      X: 'rotate',
      z: 'rotateCcw',
      Z: 'rotateCcw',
      c: 'hold',
      C: 'hold',
      Shift: 'hold',
      PageDown: 'rotateCcw',
      PageUp: 'hold',
    }[e.key];
    if (keyAct) e.preventDefault();
    if (e.key === 'r' || e.key === 'R') return restart();
    if (e.key === 'h' || e.key === 'H' || e.key === '?') return toggleHelp();
    if (state.helpOpen) {
      // help swallows the rest; esc backs out of it
      if (e.key === 'Escape') toggleHelp();
      return;
    }
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape')
      return togglePause();
    if (state.over || state.paused || !state.falling || !keyAct) return;
    actions[keyAct]();
    render();
  });

  document.getElementById('restart').addEventListener('click', restart);
  resumeBtn.addEventListener('click', () => {
    resumeBtn.blur(); // hand the keys back to the game
    togglePause();
  });
  const helpClose = document.getElementById('help-close');
  helpClose.addEventListener('click', () => {
    helpClose.blur(); // hand the keys back to the game
    toggleHelp();
  });

  renderLevel();
  renderColony();
  spawn();
  render();
  setInterval(tick, TICK_MS);
})();
