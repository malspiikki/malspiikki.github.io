(function (global) {
  'use strict';

  // The game's piece renderer: berry-tier palette and jelly SVG drawing
  // (design canvas 2026-08-20/21). Shared by the game page and the style
  // guide so the guide can never drift from what the game shows.

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CORNER_RADIUS = 0.4;
  const WIN_TIER = 12; // outgrows the dish; in the game it emigrates to the colony

  // Tier identity: berry marmalade (canvas Berry Pantry, 2026-08-21).
  // Every tier IS a berry, ordered by ripeness/concentration — paler is
  // younger, darker is bigger. Toni's picks: white currant, cloudberry,
  // sea buckthorn, juniper, sweet cherry, bilberry, black currant,
  // elderberry; fillers to reach 11 (swappable): green gooseberry,
  // red currant, raspberry.
  const TIERS = [
    { name: 'White currant', L: 85, C: 0.045, h: 80 },
    { name: 'Green gooseberry', L: 74, C: 0.11, h: 130 },
    { name: 'Cloudberry', L: 72, C: 0.13, h: 70 },
    // 4 and 5 deliberately swapped out of lightness order: tier 4 is the
    // tetromino tier, and giving it sea buckthorn's show-stealing orange
    // made the game read more Tetris, not less
    { name: 'Red currant', L: 60, C: 0.19, h: 22 },
    { name: 'Sea buckthorn', L: 67, C: 0.19, h: 45 },
    { name: 'Raspberry', L: 54, C: 0.20, h: 2 },
    { name: 'Juniper berry', L: 52, C: 0.07, h: 235 },
    { name: 'Sweet cherry', L: 40, C: 0.15, h: 12 },
    { name: 'Bilberry', L: 35, C: 0.13, h: 295 },
    { name: 'Black currant', L: 30, C: 0.12, h: 330 },
    { name: 'Elderberry', L: 22, C: 0.05, h: 290 },
  ];
  // Past elderberry the colony keeps counting, so the berries cycle:
  // tier 12 is a white currant again (the nucleus number tells them apart).
  const berry = t => TIERS[(t - 1) % TIERS.length];
  const tierName = t => berry(t).name;
  // Species naming: every size is a berry amoeba while it belongs to
  // the dish's own cycle; the sizes past elderberry — the ones that
  // only exist out in the colony — are amonauts, the same berries on
  // their second lap, born under a new sun.
  const speciesName = t =>
    `${tierName(t).toLowerCase()} ${t > TIERS.length ? 'amonaut' : 'amoeba'}`;

  // daylight petri-dish palette: berry marmalade lit from within. Dark
  // berries flip the recipe — glossy light membrane and a light nucleus
  // with dark text, since darker-than-the-fill would vanish.
  function colors(t) {
    const g = berry(t);
    const { h, L, C } = g;
    const dark = L < 45;
    return {
      h, L, C, dark,
      fill: `oklch(${L}% ${C} ${h} / 0.85)`,
      line: dark
        ? `oklch(${L + 16}% ${Math.min(0.19, C + 0.05)} ${h})`
        : `oklch(${Math.max(18, L - 24)}% ${Math.min(0.19, C + 0.03)} ${h})`,
      rim: `oklch(97% ${Math.min(0.06, C)} ${h})`,
      // core lightness is clamped away from mid-scale so the number ink
      // always clears WCAG AA 4.5:1 (audited over fill over the dish)
      core: dark
        ? `oklch(${Math.max(L + 26, 63)}% ${Math.min(0.15, C + 0.03)} ${h} / 0.95)`
        : `oklch(${Math.min(45, Math.max(22, L - 28))}% ${Math.min(0.17, C + 0.02)} ${h} / 0.92)`,
      coreText: dark ? `oklch(18% 0.04 ${h})` : `oklch(97% 0.02 ${h})`,
      labelInk: dark ? `oklch(96% 0.02 ${h})` : `oklch(18% ${Math.min(0.09, C)} ${h})`,
      // tier-strip dots: lighter wash than the board fill so labelInk hits
      // AA on the mid berries; rescue fades the body only and flips to the
      // dark ink, since a 0.42 wash over the light page is always light
      stripFill: `oklch(${L}% ${C} ${h} / 0.7)`,
      rescueFill: `oklch(${L}% ${C} ${h} / 0.42)`,
      rescueInk: `oklch(18% ${Math.min(0.09, C)} ${h})`,
      ink: `oklch(24% ${Math.min(0.09, C)} ${h})`,
      debris: dark ? `oklch(${L + 34}% 0.06 ${h})` : `oklch(24% ${Math.min(0.09, C)} ${h})`,
      sclera: `oklch(97% 0.02 ${h})`,
    };
  }

  const fmt = v => Math.round(v * 1000) / 1000;
  // deterministic jitter, hashed on piece-relative cell coords so organelles
  // ride along as the piece falls instead of reshuffling every row
  const rnd = (a, b, c) => {
    const x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return x - Math.floor(x);
  };

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // Center of the cell nearest the centroid, so the nucleus stays on the
  // piece even for concave shapes whose centroid falls outside them.
  function labelPos(cells) {
    const cx = cells.reduce((s, c) => s + c[0], 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c[1], 0) / cells.length;
    let best = cells[0], bestD = Infinity;
    for (const [x, y] of cells) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
    return [best[0] + 0.5, best[1] + 0.5];
  }

  let svgUid = 0;

  // nucleus + vacuoles + waking eyes + suspended debris + gem signatures
  function organelles(group, cells, t, C) {
    const minX = Math.min(...cells.map(c => c[0]));
    const minY = Math.min(...cells.map(c => c[1]));
    const rrel = (x, y, salt) => rnd(x - minX, y - minY, salt + t * 17);
    const [nx, ny] = labelPos(cells);
    const isNucleus = (x, y) => x + 0.5 === nx && y + 0.5 === ny;
    // vacuoles: drifting bubbles in cells away from the nucleus
    for (const [x, y] of cells) {
      if (isNucleus(x, y) || rrel(x, y, 1) < 0.45) continue;
      group.appendChild(el('circle', {
        cx: fmt(x + 0.28 + 0.44 * rrel(x, y, 2)),
        cy: fmt(y + 0.28 + 0.44 * rrel(x, y, 3)),
        r: fmt(0.05 + 0.07 * rrel(x, y, 4)),
        fill: C.rim, opacity: 0.35,
      }));
    }
    const others = cells.filter(([x, y]) => !isNucleus(x, y));
    // suspended debris shards (gelatinous-cube nod) from tier 8
    if (t >= 8) {
      const picks = [...others].sort((a, b) => rrel(a[0], a[1], 9) - rrel(b[0], b[1], 9)).slice(0, 3);
      for (const [x, y] of picks) {
        const cx = x + 0.35 + 0.3 * rrel(x, y, 21), cy = y + 0.35 + 0.3 * rrel(x, y, 22);
        const ang = Math.round(rrel(x, y, 23) * 180 - 90);
        group.appendChild(el('rect', {
          x: fmt(cx - 0.16), y: fmt(cy - 0.035), width: 0.32, height: 0.07, rx: 0.03,
          transform: `rotate(${ang} ${fmt(cx)} ${fmt(cy)})`,
          fill: C.debris, opacity: 0.35,
        }));
      }
    }
    // eyes wake at tier 5 and accumulate; slit pupils
    const eyeCount = t >= 5 ? Math.min(1 + Math.floor((t - 5) / 2), 4) : 0;
    if (eyeCount) {
      const picks = [...others].sort((a, b) => rrel(a[0], a[1], 5) - rrel(b[0], b[1], 5)).slice(0, eyeCount);
      picks.forEach(([x, y], i) => {
        const ex = x + 0.5 + 0.14 * (rrel(x, y, 31) - 0.5);
        const ey = y + 0.5 + 0.14 * (rrel(x, y, 32) - 0.5);
        const s = 0.8 + 0.5 * rrel(x, y, 33 + i);
        group.appendChild(el('ellipse', {
          cx: fmt(ex), cy: fmt(ey), rx: fmt(0.19 * s), ry: fmt(0.155 * s),
          fill: C.sclera, stroke: C.line, 'stroke-width': 0.028, opacity: 0.97,
        }));
        group.appendChild(el('ellipse', {
          cx: fmt(ex), cy: fmt(ey), rx: fmt(0.05 * s), ry: fmt(0.115 * s), fill: C.ink,
        }));
      });
    }
    // nucleus carries the tier number
    const tilt = Math.round(rrel(nx, ny, 7) * 40 - 20);
    group.appendChild(el('ellipse', {
      cx: fmt(nx), cy: fmt(ny), rx: 0.30, ry: 0.24,
      transform: `rotate(${tilt} ${fmt(nx)} ${fmt(ny)})`, fill: C.core,
    }));
    const label = el('text', {
      x: fmt(nx), y: fmt(ny + 0.13),
      'text-anchor': 'middle',
      'font-size': 0.375,
      'font-weight': 700,
      'font-family': "'Space Grotesk', system-ui, sans-serif",
      fill: C.coreText,
    });
    label.textContent = t;
    group.appendChild(label);
  }

  function shapePaths(cells, tier, opts = {}) {
    const C = colors(tier);
    const d = Polyomino.outlinePath(cells, CORNER_RADIUS);
    const group = el('g', { class: opts.cls || '' });
    if (opts.ghost) {
      // outline only: a translucent fill goes muddy and reads as a piece
      group.appendChild(el('path', {
        d, fill: 'none', stroke: C.line,
        'stroke-width': 0.09, 'stroke-linejoin': 'round', 'stroke-dasharray': '0.22 0.16',
      }));
      return group;
    }
    const id = 'jelly' + svgUid++;
    // backlit-wax fill: radial gradient brightest at the nucleus
    const [nx, ny] = labelPos(cells);
    let gr = 0.8;
    for (const [x, y] of cells) {
      const dd = Math.hypot(x + 0.5 - nx, y + 0.5 - ny) + 0.8;
      if (dd > gr) gr = dd;
    }
    const grad = el('radialGradient', {
      id: id + 'g', gradientUnits: 'userSpaceOnUse', cx: fmt(nx), cy: fmt(ny), r: fmt(gr),
    });
    grad.appendChild(el('stop', { offset: '0%', 'stop-color': `oklch(${C.L + 11}% ${Math.max(0.04, C.C - 0.03)} ${C.h} / 0.94)` }));
    grad.appendChild(el('stop', { offset: '60%', 'stop-color': C.fill }));
    grad.appendChild(el('stop', { offset: '100%', 'stop-color': `oklch(${C.L - 6}% ${C.C + 0.02} ${C.h} / 0.9)` }));
    group.appendChild(grad);
    const clip = el('clipPath', { id: id + 'c' });
    clip.appendChild(el('path', { d }));
    group.appendChild(clip);
    group.appendChild(el('path', { d, fill: `url(#${id}g)` }));
    // inner rim glow: wide light stroke clipped to the body — the jelly membrane
    group.appendChild(el('path', {
      d, fill: 'none', stroke: C.rim, 'stroke-width': 0.26,
      'stroke-linejoin': 'round', opacity: 0.45, 'clip-path': `url(#${id}c)`,
    }));
    group.appendChild(el('path', {
      d, fill: 'none', stroke: C.line, 'stroke-width': 0.08, 'stroke-linejoin': 'round',
    }));
    organelles(group, cells, tier, C);
    return group;
  }

  // tier-strip LEDs: paint one dot for tier t in state 'drop' | 'rescue' |
  // 'off'. Lives here beside stripFill/rescueFill so the game and the style
  // guide share one painter and can't drift. Rescue reads as a phantom
  // window member — ghost-dashed ring, no glow, faded body — because fill
  // opacity alone was too close to a lit dot at both ends of the ramp; the
  // number keeps full-strength ink so it stays readable (AA-audited).
  function stripDot(span, t, state) {
    span.className = state;
    if (state === 'off') { span.removeAttribute('style'); return; }
    const c = colors(t);
    const rescue = state === 'rescue';
    span.style.background = rescue ? c.rescueFill : c.stripFill;
    span.style.border = `2px ${rescue ? 'dashed' : 'solid'} ${c.line}`;
    span.style.boxShadow = rescue ? 'none' : '';
    span.style.color = rescue ? c.rescueInk : c.labelInk;
  }

  const api = { TIERS, WIN_TIER, CORNER_RADIUS, tierName, speciesName, colors, labelPos, shapePaths, stripDot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Jelly = api;
})(this);
