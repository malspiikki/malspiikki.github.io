(function (global) {
  'use strict';

  // A polyomino is an array of [x, y] cells, screen coordinates (y grows down).

  function normalize(cells) {
    let minX = Infinity,
      minY = Infinity;
    for (const [x, y] of cells) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }
    return cells
      .map(([x, y]) => [x - minX, y - minY])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }

  function cellsKey(cells) {
    return cells.map((c) => c.join(',')).join(';');
  }

  const TRANSFORMS = [
    ([x, y]) => [x, y],
    ([x, y]) => [-y, x],
    ([x, y]) => [-x, -y],
    ([x, y]) => [y, -x],
    ([x, y]) => [-x, y],
    ([x, y]) => [y, x],
    ([x, y]) => [x, -y],
    ([x, y]) => [-y, -x],
  ];

  // free: rotations + reflections equal, one-sided: rotations only, fixed: translations only
  const SYMMETRY_COUNT = { free: 8, 'one-sided': 4, fixed: 1 };

  function canonicalForm(cells, symmetry) {
    const count = SYMMETRY_COUNT[symmetry];
    let bestKey = null,
      bestCells = null;
    for (let i = 0; i < count; i++) {
      const candidate = normalize(cells.map(TRANSFORMS[i]));
      const key = cellsKey(candidate);
      if (bestKey === null || key < bestKey) {
        bestKey = key;
        bestCells = candidate;
      }
    }
    return { key: bestKey, cells: bestCells };
  }

  const NEIGHBORS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  function enumerate(n, symmetry) {
    if (!(symmetry in SYMMETRY_COUNT))
      throw new Error('bad symmetry: ' + symmetry);
    let shapes = [[[0, 0]]];
    for (let size = 2; size <= n; size++) {
      const seen = new Set();
      const next = [];
      for (const cells of shapes) {
        const occupied = new Set(cells.map((c) => c.join(',')));
        for (const [x, y] of cells) {
          for (const [dx, dy] of NEIGHBORS) {
            const nx = x + dx,
              ny = y + dy;
            if (occupied.has(nx + ',' + ny)) continue;
            const { key, cells: canon } = canonicalForm(
              cells.concat([[nx, ny]]),
              symmetry,
            );
            if (!seen.has(key)) {
              seen.add(key);
              next.push(canon);
            }
          }
        }
      }
      shapes = next;
    }
    return shapes;
  }

  // Random n-omino via weighted boundary growth. Uniform sampling over all
  // n-ominoes is infeasible at large n; each model instead biases growth
  // toward a shape character. Weights take the candidate's occupied-neighbor
  // count and how many cells ago it was last touched by growth.
  // base: candidate weight (or, for aged models, acceptance probability)
  // from its occupied-neighbor count.
  // aging (optional): per-step decay so growth follows recently touched sites.
  const GROWTH_MODELS = {
    blob: { base: (c) => c * c },
    branch: { base: (c) => (c === 1 ? 1 : 0.02) },
    worm: { base: (c) => (c === 1 ? 1 : 0.05), aging: 0.85 },
  };

  function randomPolyomino(n, model) {
    const spec = GROWTH_MODELS[model];
    if (!spec) throw new Error('bad model: ' + model);
    const { base, aging } = spec;

    const cap = 3 * n + 8;
    const slotX = new Int32Array(cap);
    const slotY = new Int32Array(cap);
    const slotNeighbors = new Uint8Array(cap);

    const HALF = 131072; // coordinates stay within ±n < 2^17
    const pack = (x, y) => (x + HALF) * 262144 + (y + HALF);

    const cells = [];
    const occupied = new Set();
    const candidates = new Map(); // packed coord -> slot
    const freeSlots = [];
    let nextSlot = 0;

    // Non-aged models: Fenwick tree, O(log n) weighted sample per step.
    // Weights are bounded (0.02..16) so float drift stays negligible.
    const tree = aging ? null : new Float64Array(cap + 1);
    const weightAt = aging ? null : new Float64Array(cap);
    const highBit = 1 << (31 - Math.clz32(cap));

    const setWeight = (slot, w) => {
      const delta = w - weightAt[slot];
      weightAt[slot] = w;
      for (let i = slot + 1; i <= cap; i += i & -i) tree[i] += delta;
    };
    const treeTotal = () => {
      let sum = 0;
      for (let i = cap; i > 0; i -= i & -i) sum += tree[i];
      return sum;
    };
    const treeSample = (r) => {
      let pos = 0;
      for (let step = highBit; step > 0; step >>= 1) {
        const next = pos + step;
        if (next <= cap && tree[next] < r) {
          r -= tree[next];
          pos = next;
        }
      }
      return pos;
    };

    // Aged models: geometric sampling over a recency stack, plus rejection on
    // base(). Explicit exponential weights would span hundreds of orders of
    // magnitude and float absorption would corrupt any running sum, so
    // recency is positional instead of numeric.
    const stack = aging ? [] : null;
    const logAging = aging ? Math.log(aging) : 0;
    const liveAt = (idx) => {
      const s = stack[idx];
      return candidates.get(pack(slotX[s], slotY[s])) === s ? s : -1;
    };

    const touchCandidate = (x, y) => {
      const key = pack(x, y);
      if (occupied.has(key)) return;
      let slot = candidates.get(key);
      if (slot === undefined) {
        slot = freeSlots.length ? freeSlots.pop() : nextSlot++;
        candidates.set(key, slot);
        slotX[slot] = x;
        slotY[slot] = y;
        slotNeighbors[slot] = 1;
      } else {
        slotNeighbors[slot]++;
      }
      if (aging) stack.push(slot);
      else setWeight(slot, base(slotNeighbors[slot]));
    };

    const addCell = (x, y) => {
      occupied.add(pack(x, y));
      cells.push([x, y]);
      for (const [dx, dy] of NEIGHBORS) touchCandidate(x + dx, y + dy);
    };

    const pickAged = () => {
      for (let attempt = 0; attempt < 64; attempt++) {
        const k = Math.floor(Math.log(1 - Math.random()) / logAging);
        const idx = stack.length - 1 - k;
        if (idx < 0) continue;
        const s = liveAt(idx);
        if (s < 0) continue;
        if (Math.random() < base(slotNeighbors[s])) return s;
      }
      for (let idx = stack.length - 1; idx >= 0; idx--) {
        const s = liveAt(idx);
        if (s >= 0) return s;
      }
      return candidates.values().next().value;
    };

    const pickWeighted = () => {
      const slot = treeSample(Math.random() * treeTotal());
      if (slot < cap && weightAt[slot] > 0) return slot;
      return candidates.values().next().value; // float-drift safety
    };

    addCell(0, 0);
    while (cells.length < n) {
      const slot = aging ? pickAged() : pickWeighted();
      const x = slotX[slot],
        y = slotY[slot];
      candidates.delete(pack(x, y));
      if (!aging) setWeight(slot, 0);
      freeSlots.push(slot);
      addCell(x, y);
    }
    return normalize(cells);
  }

  // Metropolis chain over fixed n-ominoes: move one uniformly random cell to
  // a uniformly random perimeter site, reject moves that disconnect the
  // shape, and accept with min(1, |perim before| / |perim after|) so the
  // stationary distribution is exactly uniform. Approximate uniformity in
  // practice, since any finite run only approaches stationarity.
  function uniformPolyomino(n, steps, start) {
    if (n < 2) return [[0, 0]];
    // A worm-grown start is sparse and tree-ish like a typical animal, so
    // the chain decorrelates instead of reshaping from scratch.
    if (!start) start = randomPolyomino(n, 'worm');

    // Flat grid window, recentered/regrown when the shape nears the border.
    let W = 0;
    /** @type {Uint8Array} */ let grid;
    let posOf, perimAt, vis, labelG;
    let cellsIdx = [];
    let perimArr = [];
    let stamp = 0;
    const DIRS = [1, -1, 0, 0];

    const refreshSite = (idx) => {
      const p =
        !grid[idx] &&
        (grid[idx + 1] || grid[idx - 1] || grid[idx + W] || grid[idx - W])
          ? 1
          : 0;
      const at = perimAt[idx];
      if (p && !at) {
        perimArr.push(idx);
        perimAt[idx] = perimArr.length;
      } else if (!p && at) {
        const last = perimArr.pop();
        if (at - 1 < perimArr.length) {
          perimArr[at - 1] = last;
          perimAt[last] = at;
        }
        perimAt[idx] = 0;
      }
    };

    const rebuild = (coords) => {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const [x, y] of coords) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const need = Math.max(maxX - minX, maxY - minY) * 2 + 32;
      if (W < need) {
        W = 64;
        while (W < need) W *= 2;
        grid = new Uint8Array(W * W);
        posOf = new Int32Array(W * W);
        perimAt = new Int32Array(W * W);
        vis = new Int32Array(W * W);
        labelG = new Uint8Array(W * W);
        stamp = 0;
      } else {
        grid.fill(0);
        posOf.fill(0);
        perimAt.fill(0);
      }
      DIRS[2] = W;
      DIRS[3] = -W;
      const ox = ((W - (maxX - minX)) >> 1) - minX;
      const oy = ((W - (maxY - minY)) >> 1) - minY;
      cellsIdx = coords.map(([x, y]) => (y + oy) * W + (x + ox));
      perimArr = [];
      for (const idx of cellsIdx) grid[idx] = 1;
      for (let i = 0; i < cellsIdx.length; i++) posOf[cellsIdx[i]] = i + 1;
      for (const idx of cellsIdx) for (const d of DIRS) refreshSite(idx + d);
    };

    const toCoords = () => cellsIdx.map((idx) => [idx % W, (idx / W) | 0]);
    rebuild(start);

    const moveCell = (from, to) => {
      const i = posOf[from];
      grid[from] = 0;
      posOf[from] = 0;
      grid[to] = 1;
      posOf[to] = i;
      cellsIdx[i - 1] = to;
      refreshSite(from);
      refreshSite(to);
      for (const d of DIRS) {
        refreshSite(from + d);
        refreshSite(to + d);
      }
    };

    // Multi-source alternating BFS over the shape minus c: expands each of
    // c's neighbors in lockstep and union-finds them together, so the cost is
    // ~4x the smallest piece rather than the whole shape.
    const frontiers = [[], [], [], []];
    const heads = [0, 0, 0, 0];
    const parent = [0, 1, 2, 3];
    const find = (a) => {
      while (parent[a] !== a) a = parent[a] = parent[parent[a]];
      return a;
    };
    const staysConnectedWithout = (c) => {
      const around = [];
      for (const d of DIRS) if (grid[c + d]) around.push(c + d);
      if (around.length <= 1) return true;
      stamp++;
      let groups = around.length;
      for (let a = 0; a < around.length; a++) {
        parent[a] = a;
        frontiers[a].length = 0;
        heads[a] = 0;
        frontiers[a].push(around[a]);
        vis[around[a]] = stamp;
        labelG[around[a]] = a;
      }
      while (groups > 1) {
        let progressed = false;
        for (let a = 0; a < around.length; a++) {
          const frontier = frontiers[a];
          if (heads[a] >= frontier.length) continue;
          progressed = true;
          const node = frontier[heads[a]++];
          for (const d of DIRS) {
            const m = node + d;
            if (m === c || !grid[m]) continue;
            if (vis[m] === stamp) {
              const ra = find(labelG[node]),
                rb = find(labelG[m]);
              if (ra !== rb) {
                parent[ra] = rb;
                if (--groups === 1) return true;
              }
            } else {
              vis[m] = stamp;
              labelG[m] = labelG[node];
              frontier.push(m);
            }
          }
        }
        if (!progressed) return false;
      }
      return true;
    };

    const nearBorder = (idx) => {
      const x = idx % W,
        y = (idx / W) | 0;
      return x < 3 || y < 3 || x >= W - 3 || y >= W - 3;
    };

    for (let step = 0; step < steps; step++) {
      const c = cellsIdx[(Math.random() * n) | 0];
      const s = perimArr[(Math.random() * perimArr.length) | 0];
      let support = 0;
      for (const d of DIRS) if (grid[s + d] && s + d !== c) support++;
      if (!support) continue;
      if (!staysConnectedWithout(c)) continue;
      const perimBefore = perimArr.length;
      moveCell(c, s);
      if (Math.random() * perimArr.length >= perimBefore) moveCell(s, c);
      else if (nearBorder(s)) rebuild(toCoords());
    }

    return normalize(toCoords());
  }

  function bounds(cells) {
    let w = 0,
      h = 0;
    for (const [x, y] of cells) {
      if (x + 1 > w) w = x + 1;
      if (y + 1 > h) h = y + 1;
    }
    return { w, h };
  }

  // One SVG subpath per horizontal run of cells; used for fill so hole
  // topology never matters.
  function fillPath(cells) {
    const sorted = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    let d = '';
    for (let i = 0; i < sorted.length;) {
      const [x, y] = sorted[i];
      let j = i + 1;
      while (
        j < sorted.length &&
        sorted[j][1] === y &&
        sorted[j][0] === sorted[j - 1][0] + 1
      )
        j++;
      d += `M${x} ${y}h${j - i}v1h${i - j}z`;
      i = j;
    }
    return d;
  }

  // Boundary edges chained into closed loops (outer border plus any holes),
  // with collinear vertices merged away. The outer loop runs clockwise and
  // holes counterclockwise, so a nonzero-rule fill leaves holes open.
  function boundaryLoops(cells) {
    const occupied = new Set(cells.map((c) => c.join(',')));
    const has = (x, y) => occupied.has(x + ',' + y);

    const edges = new Map();
    const addEdge = (x1, y1, x2, y2) => {
      const key = x1 + ',' + y1;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push([x2, y2]);
    };
    for (const [x, y] of cells) {
      if (!has(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!has(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!has(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!has(x - 1, y)) addEdge(x, y + 1, x, y);
    }

    const sameDir = (a, b, c) =>
      Math.sign(b[0] - a[0]) === Math.sign(c[0] - b[0]) &&
      Math.sign(b[1] - a[1]) === Math.sign(c[1] - b[1]);

    const loops = [];
    while (edges.size) {
      const startKey = edges.keys().next().value;
      const [sx, sy] = startKey.split(',').map(Number);
      const starts = edges.get(startKey);
      let [cx, cy] = starts.pop();
      if (!starts.length) edges.delete(startKey);
      let dx = cx - sx,
        dy = cy - sy;
      const loop = [[sx, sy]];
      while (cx !== sx || cy !== sy) {
        if (
          loop.length > 1 &&
          sameDir(loop[loop.length - 2], loop[loop.length - 1], [cx, cy])
        ) {
          loop[loop.length - 1] = [cx, cy];
        } else {
          loop.push([cx, cy]);
        }
        const key = cx + ',' + cy;
        const candidates = edges.get(key);
        let pick = 0;
        if (candidates.length > 1) {
          // At a checkerboard corner keep loops separate: prefer the left turn.
          const prefs = [
            [dy, -dx],
            [dx, dy],
            [-dy, dx],
          ];
          outer: for (const [px, py] of prefs) {
            for (let i = 0; i < candidates.length; i++) {
              if (
                candidates[i][0] - cx === px &&
                candidates[i][1] - cy === py
              ) {
                pick = i;
                break outer;
              }
            }
          }
        }
        const [ex, ey] = candidates.splice(pick, 1)[0];
        if (!candidates.length) edges.delete(key);
        dx = ex - cx;
        dy = ey - cy;
        cx = ex;
        cy = ey;
      }
      // the trace can't merge across the seam, so clean up around the start
      if (
        loop.length > 2 &&
        sameDir(loop[loop.length - 2], loop[loop.length - 1], loop[0])
      )
        loop.pop();
      if (loop.length > 2 && sameDir(loop[loop.length - 1], loop[0], loop[1]))
        loop.shift();
      loops.push(loop);
    }
    return loops;
  }

  // With a radius, corners become quadratic curves: each edge stops radius
  // short of the vertex and the vertex itself is the control point. Concave
  // corners round the same way, giving merged blobs a soft, grouted look.
  function outlinePath(cells, radius) {
    const fmt = (v) => Math.round(v * 1000) / 1000;
    let d = '';
    for (const loop of boundaryLoops(cells)) {
      if (!radius) {
        d +=
          loop.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('') + 'Z';
        continue;
      }
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const p = loop[(i + n - 1) % n],
          v = loop[i],
          q = loop[(i + 1) % n];
        const lenIn = Math.abs(v[0] - p[0]) + Math.abs(v[1] - p[1]);
        const lenOut = Math.abs(q[0] - v[0]) + Math.abs(q[1] - v[1]);
        const r = Math.min(radius, lenIn / 2, lenOut / 2);
        const ax = v[0] - Math.sign(v[0] - p[0]) * r,
          ay = v[1] - Math.sign(v[1] - p[1]) * r;
        const bx = v[0] + Math.sign(q[0] - v[0]) * r,
          by = v[1] + Math.sign(q[1] - v[1]) * r;
        d += `${i ? 'L' : 'M'}${fmt(ax)} ${fmt(ay)}Q${v[0]} ${v[1]} ${fmt(bx)} ${fmt(by)}`;
      }
      d += 'Z';
    }
    return d;
  }

  const api = {
    normalize,
    canonicalForm,
    enumerate,
    randomPolyomino,
    uniformPolyomino,
    bounds,
    fillPath,
    outlinePath,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Polyomino = api;
})(this);
