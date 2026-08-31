(function (global) {
  'use strict';

  // The game's rules layer, shared verbatim by the page (game.js), the
  // headless simulator (sim.js) and the tests, so the sim's fairness
  // claims and the game can't drift apart. Everything here is pure logic
  // over plain data — no DOM, no timers, no Math.random (randomness comes
  // in as an rng argument).
  //
  // A field is { pieces, cells, erode } plus, when bounded, { w, h }:
  // pieces is the array of { cells, size, fresh }, cells a Map from "x,y"
  // to the piece occupying it, and erode the field's own way of melting a
  // fused blob down to its new tier (the dish melts from the top in
  // reading order; the colony squeezes toward its center of mass).

  const NEIGHBORS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const TIER_CYCLE = 9;
  const MERGES_PER_LEVEL = 10;

  // Difficulty ladder: the drop window sweeps tiers 1..9 and widens at a
  // turnaround. 'growtop' (the live rule since 2026-08-18) widens only at
  // the top turnaround, 'growbottom' only at the bottom one, 'pingpong'
  // at every one — 73 / 81 / 45 levels. growtop was chosen by simulation
  // (sim.js --window): it restores headroom above strong play with only
  // mild difficulty relief, and the widening lands as relief.
  function windowSequence(mode) {
    const seq = [];
    const push = (w, s) => {
      const tiers = [];
      for (let i = 0; i < w; i++) tiers.push(s + i);
      seq.push(tiers);
    };
    if (mode === 'pingpong') {
      for (let w = 1; w <= TIER_CYCLE; w++) {
        const n = TIER_CYCLE + 1 - w;
        for (let i = 1; i <= n; i++) push(w, w % 2 ? i : n + 1 - i);
      }
      return seq;
    }
    const growTop = mode === 'growtop';
    let w = 1,
      s = 1,
      dir = 1;
    push(w, s);
    while (w < TIER_CYCLE) {
      const top = TIER_CYCLE + 1 - w;
      if (dir === 1 && s === top) {
        if (growTop) {
          w++;
          s = TIER_CYCLE + 1 - w;
          dir = -1;
        } else {
          dir = -1;
          s--;
        }
      } else if (dir === -1 && s === 1) {
        if (growTop) {
          dir = 1;
          s++;
        } else {
          w++;
          s = 1;
          dir = 1;
        }
      } else {
        s += dir;
      }
      push(w, s);
    }
    return seq;
  }

  // flat pacing: every MERGES_PER_LEVEL dish merges advances one level
  function levelFor(merges, startLevel, maxLevel) {
    return Math.min(
      maxLevel,
      Math.floor(merges / MERGES_PER_LEVEL) + startLevel,
    );
  }

  // one-sided shape pools (Tetris convention), memoized — tier 9 takes
  // ~350ms to enumerate, so callers warm this off their input path
  const POOLS = new Map();
  function poolFor(tier) {
    if (!POOLS.has(tier))
      POOLS.set(tier, Polyomino.enumerate(tier, 'one-sided'));
    return POOLS.get(tier);
  }

  const key = (x, y) => x + ',' + y;

  function connected(cells) {
    const occupied = new Set(cells.map((c) => c.join(',')));
    const seen = new Set([cells[0].join(',')]);
    const stack = [cells[0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of NEIGHBORS) {
        const k = x + dx + ',' + (y + dy);
        if (occupied.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push([x + dx, y + dy]);
        }
      }
    }
    return seen.size === cells.length;
  }

  // First-cell erosion in board orientation: repeatedly remove the first cell
  // in reading order whose removal keeps the shape connected.
  function erode(cells, target) {
    while (cells.length > target) {
      const sorted = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const cell of sorted) {
        const rest = cells.filter((c) => c !== cell);
        if (connected(rest)) {
          cells = rest;
          break;
        }
      }
    }
    return cells;
  }

  function centroid(cells) {
    let sx = 0,
      sy = 0;
    for (const [x, y] of cells) {
      sx += x + 0.5;
      sy += y + 0.5;
    }
    return { x: sx / cells.length, y: sy / cells.length };
  }

  // Radial erosion, from the ball experiment: dissolve the cell farthest
  // from the given center whose loss keeps the blob connected — squeezed
  // round from the rim instead of melted from the top.
  function squeezeToward(cells, target, { x: cx, y: cy }) {
    while (cells.length > target) {
      const sorted = [...cells].sort(
        (a, b) =>
          Math.hypot(b[0] + 0.5 - cx, b[1] + 0.5 - cy) -
          Math.hypot(a[0] + 0.5 - cx, a[1] + 0.5 - cy),
      );
      for (const cell of sorted) {
        const rest = cells.filter((c) => c !== cell);
        if (connected(rest)) {
          cells = rest;
          break;
        }
      }
    }
    return cells;
  }

  function rotatedCW(cells) {
    const maxY = Math.max(...cells.map((c) => c[1]));
    return cells
      .map(([x, y]) => [maxY - y, x])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }

  // Rotate within a fixed square box (side = max bounding dimension at spawn),
  // like classic Tetris rotation systems: the box stays anchored so pieces
  // don't lurch sideways, and four rotations return exactly to the start.
  function rotatedInBox(cells, box, dir) {
    return cells
      .map(([x, y]) => (dir < 0 ? [y, box - 1 - x] : [box - 1 - y, x]))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }

  // SRS-flavored kicks generalized to any piece size, in try order: the
  // nearest offsets first — wall kicks, then down (slot entry), then up
  // (floor kick), then diagonals — expanding out to ceil(box/2). Small
  // enough to stay predictable; scales with the piece so big shapes can
  // turn near walls at all. Pure vertical kicks alone continue out to
  // box - 1: a bar lying in the far row of its box needs that much lift
  // to stand up off the stack (or drop to hang below an overhang), and a
  // shorter cap left grounded flat pieces unrotatable despite open
  // headroom. The in-place try (0,0) is the caller's.
  function kickOffsets(box, dir) {
    const range = Math.ceil(box / 2);
    // mirror the horizontal preference for CCW, like SRS mirrors its tables
    const s = dir < 0 ? -1 : 1;
    const out = [];
    for (let d = 1; d < box; d++) {
      if (d <= range) {
        out.push(
          [-d * s, 0],
          [d * s, 0],
          [0, d],
          [0, -d],
          [-d * s, d],
          [d * s, d],
          [-d * s, -d],
          [d * s, -d],
        );
      } else {
        out.push([0, d], [0, -d]);
      }
    }
    return out;
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

  // Wrap bare pieces in a field for one resolve — the map indexes the
  // very same piece objects and cell arrays, so mutations land in place.
  function fieldOf(pieces, w, h, erodeFn) {
    const cells = new Map();
    for (const p of pieces)
      for (const [x, y] of p.cells) cells.set(key(x, y), p);
    return { w, h, pieces, cells, erode: erodeFn };
  }

  // Glue every group of touching equal-size pieces, then erode the blob
  // down to its new tier. Returns one { target, count } event per fusion
  // — scoring, difficulty pacing and the census are the caller's ledger.
  // Reaching opts.topTier outgrows the field: the blob leaves instead of
  // landing, handed to opts.onLeave when the caller wants it back (the
  // dish sends size-12 emigrants to the colony; the sim's old pop rule
  // just lets go).
  function mergePass(field, opts) {
    const { topTier = Infinity, onLeave } = opts || {};
    const parent = new Map();
    const find = (p) => {
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
    const events = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const size = group[0].size;
      // Any merge yields exactly one tier up: 3+3+3 = 4, not 5. Keeps
      // multi-merges from skipping rungs of the ladder.
      const target = size + 1;
      for (const p of group) removePiece(field, p);
      const fused = group.flatMap((p) => p.cells);
      if (target >= topTier) {
        if (onLeave) onLeave(fused, target);
      } else {
        addPiece(field, field.erode(fused, target), target).fresh = true;
      }
      events.push({ target, count: group.length });
    }
    return events;
  }

  // Pieces fall as rigid units until every one is supported.
  function gravityPass(field) {
    let any = false,
      movedInSweep;
    do {
      movedInSweep = false;
      const sorted = [...field.pieces].sort(
        (a, b) =>
          Math.max(...b.cells.map((c) => c[1])) -
          Math.max(...a.cells.map((c) => c[1])),
      );
      for (const p of sorted) {
        let drop = 0;
        while (
          !collides(
            field,
            p.cells.map(([x, y]) => [x, y + drop + 1]),
            p,
          )
        )
          drop++;
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

  // Merge and fall to a fixpoint; the accumulated fusion events come back.
  function resolveField(field, opts) {
    const events = [];
    for (;;) {
      const merged = mergePass(field, opts);
      events.push(...merged);
      const fell = gravityPass(field);
      if (!merged.length && !fell) break;
    }
    return events;
  }

  // Rescue drops: sizes on the board below the window's floor stay in the
  // draw (one slot each), so no piece is ever permanently unmatchable.
  // Wrapped windows like [9,1] aren't sorted, so take the true floor.
  function strandedSizes(pieces, tiers) {
    const floor = Math.min(...tiers);
    return new Set(pieces.map((p) => p.size).filter((s) => s < floor));
  }

  // Bag-shuffle draw over { bag, bagLevel, level }: one copy of each
  // choice, refilled when empty or when the level (and thus the window)
  // changes. Rescue sizes that clear while still in the bag are skipped
  // at draw time. Compared to independent draws this floors the
  // drought/flood lottery: in the simulator it collapsed greedy's spread
  // (sd 7.2 -> 3.3, worst game level 9 -> 23).
  function drawTier(state, choices, rng) {
    for (;;) {
      if (!state.bag || !state.bag.length || state.bagLevel !== state.level) {
        state.bag = [...choices];
        for (let i = state.bag.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [state.bag[i], state.bag[j]] = [state.bag[j], state.bag[i]];
        }
        state.bagLevel = state.level;
      }
      const tier = state.bag.pop();
      if (choices.includes(tier)) return tier;
    }
  }

  // Straddle rule: only a piece resting ENTIRELY above the danger line
  // ends the game — a piece with any cell at or below it plays on.
  function lockedOut(pieces, hidden) {
    return pieces.some((p) => p.cells.every((c) => c[1] < hidden));
  }

  // --- colony physics: the zero-g world size-12 emigrants settle in ------

  // The colony's shared center of mass — its gravity well. `extra`
  // folds in cells not yet on the field (a blob mid-fusion).
  function colonyCenter(field, extra) {
    const all = field.pieces.flatMap((p) => p.cells);
    if (extra) all.push(...extra);
    return all.length ? centroid(all) : { x: 0, y: 0 };
  }

  function canShift(field, piece, dx, dy) {
    for (const [x, y] of piece.cells) {
      const q = field.cells.get(key(x + dx, y + dy));
      if (q && q !== piece) return false;
    }
    return true;
  }

  function shiftPiece(field, piece, dx, dy) {
    for (const [x, y] of piece.cells) field.cells.delete(key(x, y));
    piece.cells = piece.cells.map(([x, y]) => [x + dx, y + dy]);
    for (const [x, y] of piece.cells) field.cells.set(key(x, y), piece);
  }

  // Zero-gravity settling, from the ball experiment: sweep innermost
  // first so the core packs before the outskirts land on it; each piece
  // takes the cardinal step that most reduces its distance to the
  // shared center, if any non-colliding step reduces it at all. The
  // sweep cap is a livelock guard — the ball mock never needed one, but
  // this loop runs synchronously.
  function colonyGravityPass(field) {
    let any = false,
      moved,
      sweeps = 0;
    do {
      moved = false;
      const g = colonyCenter(field);
      const order = field.pieces
        .map((p) => {
          const c = centroid(p.cells);
          return [(c.x - g.x) ** 2 + (c.y - g.y) ** 2, p, c];
        })
        .sort((a, b) => a[0] - b[0]);
      for (const [d2, p, c] of order) {
        let best = null,
          bestD2 = d2 - 1e-9;
        for (const [dx, dy] of NEIGHBORS) {
          const nd2 = (c.x + dx - g.x) ** 2 + (c.y + dy - g.y) ** 2;
          if (nd2 < bestD2 && canShift(field, p, dx, dy)) {
            bestD2 = nd2;
            best = [dx, dy];
          }
        }
        if (best) {
          shiftPiece(field, p, best[0], best[1]);
          moved = any = true;
        }
      }
    } while (moved && ++sweeps < 999);
    return any;
  }

  // Drift and fuse to a fixpoint (the colony's resolve); events come back.
  function settle(field) {
    const events = [];
    for (;;) {
      const drifted = colonyGravityPass(field);
      const merged = mergePass(field);
      events.push(...merged);
      if (!merged.length && !drifted) break;
    }
    return events;
  }

  // Where an emigrant lands: it keeps the shape it broke free with,
  // arrives from an rng-chosen direction just outside the settlement's
  // hull (shared gravity then walks it inward until first contact), and
  // the first settler founds the world at the origin. Returns the
  // [ox, oy] translation to apply to its cells.
  function emigrantOffset(field, cells, rng) {
    const c = centroid(cells);
    if (!field.pieces.length) return [-Math.round(c.x), -Math.round(c.y)];
    const g = colonyCenter(field);
    let hull = 0;
    for (const p of field.pieces) {
      for (const [x, y] of p.cells) {
        hull = Math.max(hull, Math.hypot(x + 0.5 - g.x, y + 0.5 - g.y));
      }
    }
    let reach = 0;
    for (const [x, y] of cells) {
      reach = Math.max(reach, Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y));
    }
    const a = rng() * 2 * Math.PI;
    const r = hull + reach + 2;
    return [
      Math.round(g.x + Math.cos(a) * r - c.x),
      Math.round(g.y + Math.sin(a) * r - c.y),
    ];
  }

  const api = {
    NEIGHBORS,
    TIER_CYCLE,
    MERGES_PER_LEVEL,
    windowSequence,
    levelFor,
    poolFor,
    key,
    connected,
    erode,
    centroid,
    squeezeToward,
    rotatedCW,
    rotatedInBox,
    kickOffsets,
    collides,
    addPiece,
    removePiece,
    fieldOf,
    mergePass,
    gravityPass,
    resolveField,
    strandedSizes,
    drawTier,
    lockedOut,
    colonyCenter,
    colonyGravityPass,
    settle,
    emigrantOffset,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Rules = api;
})(this);
