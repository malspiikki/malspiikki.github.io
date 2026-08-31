(function (global) {
  'use strict';

  // The game-over specimen tally: every size that came into being this
  // game, rarest (largest) first — muted drops lead, merged count
  // trails in bold ("45 + 2"), reading as the story unfolds: the dealt
  // hand first, then what was earned from it. Sizes
  // never encountered keep their row as an unnamed silhouette, so the
  // ledger doubles as an undiscovered-specimen tease. Shared by the
  // game page and the explorer mock (explorer/gameover.html) so the
  // mock can never drift from what the game shows. Berry dots come
  // from Jelly.stripDot; the layout classes live in style.css.

  // census: tier -> { merged, dropped }. floorTop pads the ledger with
  // unobserved rows up to at least that size — the game passes its
  // colony tier so the ledger always reaches the last berry of the
  // dish cycle, however short the game.
  function render(container, census, floorTop) {
    container.textContent = '';
    const top = Math.max(floorTop || 0, census.length - 1);
    const cycle = Jelly.TIERS.length; // the berry palette recycles every 11 sizes
    const cell = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text) node.textContent = text;
      return node;
    };
    // The ledger is a real table (CSS grid; rows are display:contents)
    // so both number columns align vertically. One head line, shaped
    // like the rows it explains ("dropped + grown"), spans the whole
    // grid — per-column head cells were tried first, but the words are
    // wider than the numbers and strangled the name column. "grown",
    // not "merged": a merge destroys two and creates one, and this
    // column counts the created side — grown is the help text's word
    // for it ("sizes 10 and 11 never drop — you can only grow them").
    container.append(cell('span', 'tally-head', 'dropped + grown'));
    for (let t = top; t >= 1; t--) {
      const { merged = 0, dropped = 0 } = census[t] || {};
      const seen = merged > 0 || dropped > 0;
      const row = document.createElement('div');
      row.className = 'tally-row' + (seen ? '' : ' unseen');
      // group the ledger in palette cycles: extra space above each
      // elderberry row (the top of a cycle, reading down), so the seam
      // where the colors recycle is a visible break — it also sets the
      // colony sizes apart from the dish's own eleven
      if (t % cycle === 0 && t !== top) row.classList.add('cycle-top');
      const dot = document.createElement('span');
      Jelly.stripDot(dot, t, seen ? 'drop' : 'off');
      dot.classList.add('dot');
      dot.textContent = String(t);
      const name = cell('span', 'name');
      if (seen) {
        // the berry carries the row; the repeated species word
        // (amoeba/amonaut) is muted so eleven of them don't shout
        const words = Jelly.speciesName(t).split(' ');
        const species = words.pop();
        name.append(words.join(' ') + ' ', cell('span', 'species', species));
      } else {
        name.textContent = 'unobserved';
      }
      const drops = cell(
        'small',
        'dropped',
        dropped ? dropped.toLocaleString() : '',
      );
      const merges = cell('b', 'merged');
      if (merged) {
        // the joining + stays muted with the drops — only the earned
        // number itself gets the bold ink
        if (dropped) merges.append(cell('span', 'plus', '+ '));
        merges.append(document.createTextNode(merged.toLocaleString()));
      }
      if (!seen) merges.textContent = '—';
      row.append(dot, name, drops, merges);
      container.appendChild(row);
    }
  }

  // When the ledger has to scroll, open it on the best specimen
  // actually observed — the unobserved silhouettes wait a scroll
  // above. Call after the container is visible; offsets are zero
  // inside display:none.
  function openAtBest(container) {
    // rows are display:contents (no box of their own), so measure the
    // row's first cell instead
    const firstSeen = container.querySelector('.tally-row:not(.unseen)');
    const box = firstSeen && firstSeen.firstElementChild;
    if (box) container.scrollTop = box.offsetTop - container.offsetTop;
  }

  const api = { render, openAtBest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Tally = api;
})(this);
