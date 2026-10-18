// Text-quote anchors: a highlight is stored as its text plus a little context on either side, so it can
// be found again after ChatGPT re-renders a message or the page reloads. Offsets count the characters
// of the message's text nodes in document order.
(() => {
  const MG = (globalThis.MG = globalThis.MG || {});
  const CONTEXT = 40;

  function index(root) {
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    return { nodes, text };
  }

  function offsetOf(idx, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const hit = idx.nodes.find((e) => e.node === container);
      if (hit) return hit.start + offset;
    }
    const point = document.createRange();
    point.setStart(container, offset);
    let total = 0;
    for (const { node, start } of idx.nodes) {
      if (point.comparePoint(node, 0) < 0) total = start + node.data.length;
      else break;
    }
    return total;
  }

  function locate(idx, off, isEnd) {
    for (const { node, start } of idx.nodes) {
      const end = start + node.data.length;
      if (isEnd ? off > start && off <= end : off >= start && off < end) return [node, off - start];
    }
    const last = idx.nodes[idx.nodes.length - 1];
    return [last.node, last.node.data.length];
  }

  // Describes `range` (which must lie inside `root`), trimming surrounding whitespace.
  function describe(range, root) {
    const idx = index(root);
    let start = offsetOf(idx, range.startContainer, range.startOffset);
    let end = offsetOf(idx, range.endContainer, range.endOffset);
    while (start < end && /\s/.test(idx.text[start])) start++;
    while (end > start && /\s/.test(idx.text[end - 1])) end--;
    if (end <= start) return null;
    return {
      quote: idx.text.slice(start, end),
      prefix: idx.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: idx.text.slice(end, end + CONTEXT),
      start,
      end,
    };
  }

  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  function commonSuffix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  // Returns a score for how well `a` matches inside `root` and the Range, or null if the quote is gone.
  function find(a, root) {
    const idx = index(root);
    if (!a?.quote || !idx.nodes.length) return null;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = idx.text.indexOf(a.quote); i !== -1; i = idx.text.indexOf(a.quote, i + 1)) {
      const before = idx.text.slice(Math.max(0, i - a.prefix.length), i);
      const after = idx.text.slice(i + a.quote.length, i + a.quote.length + a.suffix.length);
      const score = commonSuffix(before, a.prefix) + commonPrefix(after, a.suffix) - Math.abs(i - a.start) / 1e6;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return null;
    const range = document.createRange();
    range.setStart(...locate(idx, best, false));
    range.setEnd(...locate(idx, best + a.quote.length, true));
    return { range, score: bestScore };
  }

  const resolve = (a, root) => find(a, root)?.range || null;

  MG.anchor = { describe, find, resolve };
})();
