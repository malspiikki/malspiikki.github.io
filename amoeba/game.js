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
  const board = { w: W, h: H, pieces: [], cells: new Map(), erode };
  const colony = { pieces: [], cells: new Map(), erode: erodeToCenter };
  // Specimen census for the game-over field report: how many of each
  // size came into being, split by origin — merged (fused into existence,
  // dish or colony) vs dropped (locked into the dish from the supply).
  const census = []; // tier -> { merged, dropped }
  function recordSpecimen(tier, kind) {
    const c = census[tier] || (census[tier] = { merged: 0, dropped: 0 });
    c[kind]++;
  }
  const key = (x, y) => x + ',' + y;
  // piece look (berry palette + jelly SVG) lives in jelly.js, shared with
  // the style guide at explorer/styleguide.html so the two can never drift
  const { shapePaths } = Jelly;
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

  function collides(field, cells, ignore) {
    for (const [x, y] of cells) {
      // no ceiling: y < 0 is open headroom above the field, so pieces can
      // spawn above a tall stack and floor kicks work near the top
      if (x < 0 || x >= field.w || y >= field.h) return true;
      const p = field.cells.get(key(x, y));
      if (p && p !== ignore) return true;
    }
    return false;
  }

  function addPiece(field, cells, size) {
    const piece = { cells, size, fresh: false };
    field.pieces.push(piece);
    for (const [x, y] of cells) field.cells.set(key(x, y), piece);
    return piece;
  }

  function removePiece(field, piece) {
    for (const [x, y] of piece.cells) field.cells.delete(key(x, y));
    field.pieces.splice(field.pieces.indexOf(piece), 1);
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

  function centroid(cells) {
    let sx = 0, sy = 0;
    for (const [x, y] of cells) { sx += x + 0.5; sy += y + 0.5; }
    return { x: sx / cells.length, y: sy / cells.length };
  }

  // The colony's shared center of mass — its gravity well. `extra`
  // folds in cells not yet on the field (a blob mid-fusion).
  function colonyCenter(extra) {
    const all = colony.pieces.flatMap(p => p.cells);
    if (extra) all.push(...extra);
    return all.length ? centroid(all) : { x: 0, y: 0 };
  }

  // Radial erosion, from the ball experiment: dissolve the cell farthest
  // from the given center whose loss keeps the blob connected — squeezed
  // round from the rim instead of melted from the top.
  function squeezeToward(cells, target, { x: cx, y: cy }) {
    while (cells.length > target) {
      const sorted = [...cells].sort((a, b) =>
        Math.hypot(b[0] + 0.5 - cx, b[1] + 0.5 - cy) -
        Math.hypot(a[0] + 0.5 - cx, a[1] + 0.5 - cy));
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

  // Colony fusions erode against the settlement's common center of
  // mass, snapshotted per fusion.
  function erodeToCenter(cells, target) {
    return squeezeToward(cells, target, colonyCenter(cells));
  }

  // Glue every group of touching equal-size pieces, then erode the blob down
  // to its new tier.
  function mergePass(field) {
    const parent = new Map();
    const find = p => {
      while (parent.get(p) !== p) {
        parent.set(p, parent.get(parent.get(p)));
        p = parent.get(p);
      }
      return p;
    };
    for (const p of field.pieces) parent.set(p, p);
    for (const p of field.pieces) {
      for (const [x, y] of p.cells) {
        for (const [dx, dy] of NEIGHBORS) {
          const q = field.cells.get(key(x + dx, y + dy));
          if (q && q !== p && q.size === p.size) parent.set(find(p), find(q));
        }
      }
    }
    const groups = new Map();
    for (const p of field.pieces) {
      const root = find(p);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(p);
    }
    let merged = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      merged = true;
      // only dish merges pace the difficulty; the colony runs on its own
      if (field === board) state.merges++;
      const size = group[0].size;
      // Any merge yields exactly one tier up: 3+3+3 = 4, not 5. Keeps
      // multi-merges from skipping rungs of the ladder.
      const target = size + 1;
      for (const p of group) removePiece(field, p);
      const fused = group.flatMap(p => p.cells);
      // Reaching the colony tier outgrows the dish: instead of popping
      // away (the old 11 + 11 = 0 watermelon rule) the size-12 blob
      // emigrates to the colony, still handing back the space it was
      // hogging. Breaking free of the dish's gravity, it balls up
      // around its own center as it departs — so settlers arrive round,
      // not in the dish's top-melted shape. Colony merges climb past 12
      // with no cap — the berry palette cycles.
      if (field === board && target === COLONY_TIER) {
        sendToColony(squeezeToward(fused, target, centroid(fused)));
      } else {
        addPiece(field, field.erode(fused, target), target).fresh = true;
      }
      recordSpecimen(target, 'merged');
      state.score += target * target * (group.length - 1);
    }
    return merged;
  }

  // Pieces fall as rigid units until every one is supported.
  function gravityPass(field) {
    let any = false, movedInSweep;
    do {
      movedInSweep = false;
      const sorted = [...field.pieces]
        .sort((a, b) => Math.max(...b.cells.map(c => c[1])) - Math.max(...a.cells.map(c => c[1])));
      for (const p of sorted) {
        let drop = 0;
        while (!collides(field, p.cells.map(([x, y]) => [x, y + drop + 1]), p)) drop++;
        if (drop > 0) {
          for (const [x, y] of p.cells) field.cells.delete(key(x, y));
          p.cells = p.cells.map(([x, y]) => [x, y + drop]);
          for (const [x, y] of p.cells) field.cells.set(key(x, y), p);
          movedInSweep = any = true;
        }
      }
    } while (movedInSweep);
    return any;
  }

  // Land a size-12 emigrant: it keeps the shape it broke free with,
  // arrives from a random direction just outside the settlement's hull,
  // and shared gravity walks it inward until first contact. The first
  // settler founds the world at the origin.
  function sendToColony(cells) {
    const c = centroid(cells);
    let ox = -Math.round(c.x), oy = -Math.round(c.y);
    if (colony.pieces.length) {
      const g = colonyCenter();
      let hull = 0;
      for (const p of colony.pieces) {
        for (const [x, y] of p.cells) {
          hull = Math.max(hull, Math.hypot(x + 0.5 - g.x, y + 0.5 - g.y));
        }
      }
      let reach = 0;
      for (const [x, y] of cells) {
        reach = Math.max(reach, Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y));
      }
      const a = Math.random() * 2 * Math.PI;
      const r = hull + reach + 2;
      ox = Math.round(g.x + Math.cos(a) * r - c.x);
      oy = Math.round(g.y + Math.sin(a) * r - c.y);
    }
    addPiece(colony, cells.map(([x, y]) => [x + ox, y + oy]), COLONY_TIER).fresh = true;
    settleColony();
  }

  function canShift(piece, dx, dy) {
    for (const [x, y] of piece.cells) {
      const q = colony.cells.get(key(x + dx, y + dy));
      if (q && q !== piece) return false;
    }
    return true;
  }

  function shiftPiece(piece, dx, dy) {
    for (const [x, y] of piece.cells) colony.cells.delete(key(x, y));
    piece.cells = piece.cells.map(([x, y]) => [x + dx, y + dy]);
    for (const [x, y] of piece.cells) colony.cells.set(key(x, y), piece);
  }

  // Zero-gravity settling, from the ball experiment: sweep innermost
  // first so the core packs before the outskirts land on it; each piece
  // takes the cardinal step that most reduces its distance to the
  // shared center, if any non-colliding step reduces it at all. The
  // sweep cap is a livelock guard — the ball mock never needed one, but
  // this loop runs synchronously.
  function colonyGravityPass() {
    let any = false, moved, sweeps = 0;
    do {
      moved = false;
      const g = colonyCenter();
      const order = colony.pieces
        .map(p => { const c = centroid(p.cells); return [(c.x - g.x) ** 2 + (c.y - g.y) ** 2, p, c]; })
        .sort((a, b) => a[0] - b[0]);
      for (const [d2, p, c] of order) {
        let best = null, bestD2 = d2 - 1e-9;
        for (const [dx, dy] of NEIGHBORS) {
          const nd2 = (c.x + dx - g.x) ** 2 + (c.y + dy - g.y) ** 2;
          if (nd2 < bestD2 && canShift(p, dx, dy)) { bestD2 = nd2; best = [dx, dy]; }
        }
        if (best) { shiftPiece(p, best[0], best[1]); moved = any = true; }
      }
    } while (moved && ++sweeps < 999);
    return any;
  }

  function settleColony() {
    for (;;) {
      const drifted = colonyGravityPass();
      const merged = mergePass(colony);
      if (!merged && !drifted) break;
    }
    renderColony();
  }

  function resolve() {
    for (;;) {
      const merged = mergePass(board);
      const fell = gravityPass(board);
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
    return new Set(board.pieces.map(p => p.size).filter(s => s < floor));
  }

  function renderLevel() {
    const tiers = dropTiers(state.level);
    levelEl.textContent = `level ${state.level}`;
    const dropping = new Set(tiers);
    const rescue = strandedSizes(tiers);
    tierEls.forEach((span, i) => {
      const t = i + 1;
      Jelly.stripDot(span, t, dropping.has(t) ? 'drop' : rescue.has(t) ? 'rescue' : 'off');
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
    while (collides(board, fallingCells(state.falling)) && state.falling.y > -h) state.falling.y--;
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
    if (collides(board, moved)) return false;
    state.falling.x += dx || 0;
    state.falling.y += dy || 0;
    if (cells) {
      state.falling.cells = cells;
      if (!state.hold) renderHold(); // keep the empty-slot ghost's rotation live
    }
    return true;
  }

  // SRS-flavored kicks generalized to any piece size: try the nearest
  // offsets first — wall kicks, then down (slot entry), then up (floor
  // kick), then diagonals — expanding out to ceil(box/2). Small enough to
  // stay predictable; scales with the piece so big shapes can turn near
  // walls at all. Pure vertical kicks alone continue out to box - 1: a
  // bar lying in the far row of its box needs that much lift to stand up
  // off the stack (or drop to hang below an overhang), and the short cap
  // left grounded flat pieces unrotatable despite open headroom.
  function tryRotate(dir) {
    const cells = rotatedInBox(state.falling.cells, state.falling.box, dir);
    if (tryMove(0, 0, cells)) return true;
    const range = Math.ceil(state.falling.box / 2);
    // mirror the horizontal preference for CCW, like SRS mirrors its tables
    const s = dir < 0 ? -1 : 1;
    for (let d = 1; d < state.falling.box; d++) {
      const offsets = d <= range
        ? [[-d * s, 0], [d * s, 0], [0, d], [0, -d], [-d * s, d], [d * s, d], [-d * s, -d], [d * s, -d]]
        : [[0, d], [0, -d]];
      for (const [dx, dy] of offsets) {
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
    // a supply piece is encountered when it actually joins the culture,
    // so a piece parked in hold at game over never counts
    recordSpecimen(state.falling.tier, 'dropped');
    addPiece(board, fallingCells(state.falling), state.falling.tier);
    state.falling = null;
    state.canHold = true;
    resolve();
    // Straddle rule: only a piece resting ENTIRELY above the danger line
    // ends the game — a piece with any cell at or below it plays on.
    if (board.pieces.some(p => p.cells.every(c => c[1] < HIDDEN))) {
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const piece of colony.pieces) {
      for (const [x, y] of piece.cells) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      colonyLayer.appendChild(
        shapePaths(piece.cells, piece.size, { cls: piece.fresh ? 'fresh' : '' }));
      piece.fresh = false;
    }
    const empty = !colony.pieces.length;
    // the porthole only exists once the first settler arrives — until
    // then there is nothing out there to look at
    colonyWrap.hidden = empty;
    const cx = empty ? 0 : (minX + maxX + 1) / 2;
    const cy = empty ? 0 : (minY + maxY + 1) / 2;
    const side = Math.max(8, empty ? 0 : 1.45 * Math.max(maxX + 1 - minX, maxY + 1 - minY));
    colonySvg.setAttribute('viewBox',
      `${fmt(cx - side / 2)} ${fmt(cy - side / 2)} ${fmt(side)} ${fmt(side)}`);
  }

  function render() {
    pieceLayer.textContent = '';
    ghostLayer.textContent = '';
    fallingLayer.textContent = '';
    for (const piece of board.pieces) {
      pieceLayer.appendChild(
        shapePaths(piece.cells, piece.size, { cls: piece.fresh ? 'fresh' : '' }));
      piece.fresh = false;
    }
    if (state.falling) {
      let drop = 0;
      while (!collides(board, fallingCells(state.falling, 0, drop + 1))) drop++;
      if (drop > 0) {
        ghostLayer.appendChild(
          shapePaths(fallingCells(state.falling, 0, drop), state.falling.tier, { ghost: true }));
      }
      fallingLayer.appendChild(
        shapePaths(fallingCells(state.falling), state.falling.tier));
    }
  }

  function renderNext() {
    nextSvg.textContent = '';
    const { tier, cells } = state.next;
    const { w, h } = Polyomino.bounds(cells);
    const pad = 0.2;
    nextSvg.setAttribute('viewBox', `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`);
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
      const minX = Math.min(...state.falling.cells.map(c => c[0]));
      const minY = Math.min(...state.falling.cells.map(c => c[1]));
      tier = state.falling.tier;
      cells = state.falling.cells.map(([x, y]) => [x - minX, y - minY]);
    } else {
      return;
    }
    const { w, h } = Polyomino.bounds(cells);
    const pad = 0.2;
    holdSvg.setAttribute('viewBox', `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`);
    holdSvg.appendChild(shapePaths(cells, tier, state.hold ? {} : { ghost: true }));
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
    if (e.key === 'h' || e.key === 'H' || e.key === '?') return toggleHelp();
    if (state.helpOpen) { // help swallows the rest; esc backs out of it
      if (e.key === 'Escape') toggleHelp();
      return;
    }
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') return togglePause();
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
