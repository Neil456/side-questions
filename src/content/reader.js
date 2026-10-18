// The margin UI in the tab you're reading: the Ask button on a selection, highlights, and the cards.
(() => {
  const MG = (globalThis.MG = globalThis.MG || {});
  const { gpt, anchor } = MG;

  const DEFAULTS = { mode: 'branch', deleteBranchChats: true };
  const STORE = (id) => `mg:conv:${id}`;
  const SILENCE_MS = 90000;

  const ICON = {
    ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };

  let root;
  let askBtn;
  let settings = { ...DEFAULTS };
  let convId = null;
  let threads = [];
  const views = new Map(); // thread id -> { card, pill, refs, range }
  let openId = null;
  let pendingSelection = null;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.filter((c) => c != null));
    return el;
  }

  // Answers come from ChatGPT's own rendered DOM; strip anything interactive before showing them.
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, form, button, input, textarea').forEach((n) => n.remove());
    for (const el of doc.body.querySelectorAll('*')) {
      for (const { name, value } of [...el.attributes]) {
        if (/^on/i.test(name) || (/^(href|src|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(value))) {
          el.removeAttribute(name);
        }
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return doc.body.firstChild.innerHTML;
  }

  // ---- persistence ----

  const persisted = (t) => ({
    id: t.id,
    messageId: t.messageId,
    role: t.role,
    anchor: t.anchor,
    context: t.context,
    branchUrl: t.branchUrl,
    createdAt: t.createdAt,
    turns: t.turns.map(({ id, q, a, cls, error, pending, at }) => ({ id, q, a, cls, error, pending, at })),
  });

  function save() {
    if (!convId) return;
    const list = threads.filter((t) => t.turns.length).map(persisted);
    if (list.length) chrome.storage.local.set({ [STORE(convId)]: list });
    else chrome.storage.local.remove(STORE(convId));
  }

  async function loadConversation(id) {
    for (const t of threads) destroyView(t);
    threads = [];
    openId = null;
    convId = id;
    hideAsk();
    paint();
    if (!id) return;
    const data = await chrome.storage.local.get(STORE(id));
    if (convId !== id) return;
    threads = (data[STORE(id)] || []).map((t) => ({ ...t, collapsed: true }));
    resolveAll();
  }

  // ---- anchoring ----

  function resolveThread(t) {
    const v = ensureView(t);
    if (v.range && v.range.startContainer.isConnected && v.range.toString() === t.anchor.quote) return;
    v.range = null;
    const msg = gpt.messageById(t.messageId);
    if (msg) v.range = anchor.resolve(t.anchor, msg);
    if (!v.range) {
      // The message id can change (e.g. it was still streaming when highlighted); search all messages.
      let best = null;
      for (const m of gpt.messages()) {
        const hit = anchor.find(t.anchor, m);
        if (hit && (!best || hit.score > best.score)) best = { ...hit, msg: m };
      }
      if (best) {
        v.range = best.range;
        t.messageId = gpt.messageId(best.msg) || t.messageId;
      }
    }
  }

  function resolveAll() {
    for (const t of threads) resolveThread(t);
    paint();
  }

  function contextFor(range, msg, a) {
    let node = range.startContainer;
    if (node.nodeType !== 1) node = node.parentElement;
    const block = node?.closest('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th');
    let text = (block && msg.contains(block) ? block.innerText : msg.innerText).trim();
    if (text.length > 1500) {
      const at = Math.max(0, text.indexOf(a.quote));
      text = `…${text.slice(Math.max(0, at - 700), at + a.quote.length + 700)}…`;
    }
    return text;
  }

  function buildPrompt(t, question) {
    const who = t.role === 'user' ? 'my message' : 'your response';
    const quoted = t.context
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    return [
      "Side question. Answer just this, as a focused aside; I'll continue the main conversation separately.",
      '',
      `In ${who} earlier in this conversation there's this passage:`,
      quoted,
      '',
      `I'm asking about this part: "${t.anchor.quote}"`,
      '',
      question,
    ].join('\n');
  }

  // ---- views ----

  function ensureView(t) {
    let v = views.get(t.id);
    if (v) return v;
    const input = h('textarea', { class: 'mg-input', rows: '1' });
    const body = h('div', { class: 'mg-body' });
    const openLink = h('a', {
      class: 'mg-icon',
      title: 'Open this side thread in ChatGPT',
      target: '_blank',
      rel: 'noopener',
      html: ICON.open,
    });
    const card = h(
      'div',
      { class: 'mg-card', 'data-thread': t.id },
      h(
        'div',
        { class: 'mg-head' },
        h('div', { class: 'mg-quote', title: t.anchor.quote }, `“${clip(t.anchor.quote, 140)}”`),
        h(
          'div',
          { class: 'mg-tools' },
          openLink,
          h('button', { class: 'mg-icon mg-collapse', title: 'Collapse (Esc)', html: ICON.collapse, onclick: () => collapse(t) }),
          h('button', { class: 'mg-icon mg-delete', title: 'Delete this side thread', html: ICON.close, onclick: () => remove(t) }),
        ),
      ),
      body,
      h('div', { class: 'mg-foot' }, input),
    );
    const count = h('span');
    const pill = h(
      'button',
      { class: 'mg-pill', title: `Side thread: “${clip(t.anchor.quote, 80)}”`, onclick: () => expand(t) },
      h('span', { class: 'mg-pill-icon', html: ICON.ask }),
      count,
    );

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit(t, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        collapse(t);
      }
      e.stopPropagation();
    });
    input.addEventListener('input', () => autosize(input));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') collapse(t);
    });

    v = { card, pill, range: null, refs: { input, body, openLink, count } };
    views.set(t.id, v);
    root.append(card, pill);
    render(t);
    return v;
  }

  function destroyView(t) {
    const v = views.get(t.id);
    if (!v) return;
    v.card.remove();
    v.pill.remove();
    views.delete(t.id);
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  const busy = (t) => t.turns.some((x) => x.pending);

  function render(t) {
    const v = views.get(t.id);
    if (!v) return;
    const { input, body, openLink, count } = v.refs;
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
    body.replaceChildren(...t.turns.flatMap((turn) => turnNodes(t, turn)));
    if (stick) body.scrollTop = body.scrollHeight;

    input.disabled = busy(t);
    input.placeholder = t.turns.length ? 'Ask a follow-up…' : 'Ask about this…';
    if (t.branchUrl) {
      openLink.href = t.branchUrl;
      openLink.style.display = '';
    } else openLink.style.display = 'none';

    count.textContent = String(t.turns.length || '');
    v.pill.classList.toggle('mg-busy', busy(t));
    v.pill.classList.toggle('mg-unread', !!t.unread);
  }

  function turnNodes(t, turn) {
    const nodes = [h('div', { class: 'mg-q' }, turn.q)];
    if (turn.a) {
      nodes.push(h('div', { class: `mg-a ${turn.cls || 'markdown prose'}`, 'data-turn': turn.id, html: sanitize(turn.a) }));
    }
    if (turn.error) {
      nodes.push(
        h(
          'div',
          { class: 'mg-error' },
          h('span', {}, turn.error),
          h('button', { class: 'mg-retry', onclick: () => retry(t, turn) }, 'Retry'),
        ),
      );
    } else if (turn.pending && !turn.a) {
      nodes.push(h('div', { class: 'mg-status' }, h('span', { class: 'mg-spinner' }), turn.status || 'Queued…'));
    }
    return nodes;
  }

  // Streaming update: replace only the answer being written, so the rest of the card doesn't flicker.
  function renderAnswer(t, turn) {
    const v = views.get(t.id);
    const node = v?.refs.body.querySelector(`[data-turn="${turn.id}"]`);
    if (!node) return render(t);
    const body = v.refs.body;
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
    node.innerHTML = sanitize(turn.a);
    if (stick) body.scrollTop = body.scrollHeight;
  }

  // ---- layout ----

  let rafQueued = false;
  function scheduleLayout() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(layout);
  }

  function layout() {
    rafQueued = false;
    const vw = document.documentElement.clientWidth;
    const items = [];
    for (const t of threads) {
      const v = views.get(t.id);
      if (!v) continue;
      const showCard = t.id === openId && !t.collapsed;
      const node = showCard ? v.card : v.pill;
      (showCard ? v.pill : v.card).style.display = 'none';
      const rect = v.range?.getClientRects()[0];
      if (!rect) {
        node.style.display = 'none';
        continue;
      }
      node.style.display = '';
      const last = v.range.getClientRects();
      const msg = gpt.messageById(t.messageId);
      items.push({
        t,
        node,
        showCard,
        top: rect.top,
        bottom: last[last.length - 1].bottom,
        colRight: msg ? msg.getBoundingClientRect().right : rect.right,
      });
    }
    items.sort((a, b) => a.top - b.top);

    let floor = -Infinity;
    for (const it of items) {
      let left;
      let want = it.top - 6;
      if (it.showCard) {
        const room = vw - (it.colRight + 24) - 16;
        let width;
        if (room >= 280) {
          // Wide window: in the margin, level with the highlight.
          width = Math.min(420, room);
          left = it.colRight + 24;
        } else {
          // No margin to spare: open just under the highlighted line, so it stays readable.
          width = Math.min(420, vw - 32);
          left = Math.max(16, Math.min(it.colRight - width, vw - width - 16));
          want = it.bottom + 8;
        }
        it.node.style.width = `${width}px`;
      } else {
        left = Math.min(it.colRight + 12, vw - 56);
      }
      const top = Math.max(want, floor + 8);
      it.node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      floor = top + it.node.offsetHeight;
    }
  }

  function paint() {
    if (globalThis.CSS?.highlights && typeof Highlight === 'function') {
      const quiet = [];
      const active = [];
      for (const t of threads) {
        const r = views.get(t.id)?.range;
        if (r) (t.id === openId && !t.collapsed ? active : quiet).push(r);
      }
      CSS.highlights.set('mg-thread', new Highlight(...quiet));
      CSS.highlights.set('mg-active', new Highlight(...active));
    }
    scheduleLayout();
  }

  // ---- thread actions ----

  function dropDrafts(except) {
    for (const t of [...threads]) {
      if (t !== except && !t.turns.length) {
        destroyView(t);
        threads.splice(threads.indexOf(t), 1);
      }
    }
  }

  function expand(t, focus = true) {
    dropDrafts(t);
    for (const other of threads) other.collapsed = other !== t;
    t.collapsed = false;
    t.unread = false;
    openId = t.id;
    render(t);
    paint();
    if (focus) {
      const { input } = views.get(t.id).refs;
      requestAnimationFrame(() => input.disabled || input.focus({ preventScroll: true }));
    }
  }

  function collapse(t) {
    t.collapsed = true;
    if (openId === t.id) openId = null;
    if (!t.turns.length) return remove(t);
    render(t);
    paint();
  }

  function remove(t) {
    const i = threads.indexOf(t);
    if (i >= 0) threads.splice(i, 1);
    if (openId === t.id) openId = null;
    destroyView(t);
    save();
    paint();
    send({ type: 'mg:cancel', threadId: t.id });
    const branchId = t.branchUrl && gpt.conversationId(t.branchUrl);
    if (settings.deleteBranchChats && branchId && branchId !== convId) {
      gpt.hideConversation(branchId).catch((e) => console.warn('[Marginalia] could not delete branch chat', e));
    }
  }

  async function submit(t, text) {
    const q = text.trim();
    if (!q || busy(t)) return;
    const { input } = views.get(t.id).refs;
    input.value = '';
    autosize(input);

    const turn = { id: uid(), q, a: '', cls: '', pending: true, status: 'Queued…', at: Date.now() };
    t.turns.push(turn);
    render(t);
    save();

    const first = !t.branchUrl;
    const job = {
      id: turn.id,
      convId,
      threadId: t.id,
      kind: first ? settings.mode : 'followup',
      mainUrl: location.origin + location.pathname,
      branchUrl: t.branchUrl,
      freshUrl: gpt.freshChatUrl(location.href),
      prompt: first ? buildPrompt(t, q) : q,
    };
    if (job.kind === 'fresh') job.transcript = gpt.transcript();
    const res = await send({ type: 'mg:ask', job });
    if (!res?.ok) fail(t, turn, res?.error || 'The extension’s background script did not respond.');
  }

  function retry(t, turn) {
    t.turns.splice(t.turns.indexOf(turn), 1);
    submit(t, turn.q);
  }

  function fail(t, turn, error) {
    turn.pending = false;
    turn.error = error;
    render(t);
    save();
  }

  // ---- messages from the background script ----

  async function onJobMessage(msg) {
    const apply = (t, turn) => {
      turn.at = Date.now();
      if (msg.type === 'mg:job-progress') {
        if (msg.status) turn.status = msg.status;
        if (msg.html) {
          turn.a = msg.html;
          turn.cls = msg.className;
        }
        return 'stream';
      }
      turn.pending = false;
      if (msg.type === 'mg:job-done') {
        turn.a = msg.html;
        turn.cls = msg.className;
        turn.error = null;
        if (msg.branchUrl) t.branchUrl = msg.branchUrl;
        if (t.collapsed) t.unread = true;
      } else {
        turn.error = msg.error || 'Something went wrong.';
      }
      return 'final';
    };

    if (msg.convId === convId) {
      const t = threads.find((x) => x.id === msg.threadId);
      const turn = t?.turns.find((x) => x.id === msg.jobId);
      if (!turn) return;
      const hadAnswer = !!turn.a;
      if (apply(t, turn) === 'stream') {
        if (hadAnswer && turn.a) renderAnswer(t, turn);
        else render(t);
      } else {
        render(t);
        save();
      }
      scheduleLayout();
    } else if (msg.type !== 'mg:job-progress') {
      // The answer belongs to a conversation that's no longer on screen; store it for later.
      const key = STORE(msg.convId);
      const list = (await chrome.storage.local.get(key))[key] || [];
      const t = list.find((x) => x.id === msg.threadId);
      const turn = t?.turns.find((x) => x.id === msg.jobId);
      if (!turn) return;
      apply(t, turn);
      await chrome.storage.local.set({ [key]: list });
    }
  }

  function watchdog() {
    for (const t of threads) {
      for (const turn of t.turns) {
        if (turn.pending && Date.now() - turn.at > SILENCE_MS) {
          fail(t, turn, 'No response from the helper tab. Is it open and signed in to ChatGPT?');
        }
      }
    }
  }

  // ---- selection → Ask button ----

  function hideAsk() {
    pendingSelection = null;
    if (askBtn) askBtn.style.display = 'none';
  }

  function onPointerUp(e) {
    if (root.contains(e.target)) return;
    setTimeout(() => {
      const sel = getSelection();
      if (!convId || !sel || sel.isCollapsed || !sel.rangeCount) return hideAsk();
      const range = sel.getRangeAt(0);
      const msg = gpt.messageOf(range.commonAncestorContainer);
      if (!msg || !gpt.messageId(msg) || !range.toString().trim()) return hideAsk();
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] || range.getBoundingClientRect();
      pendingSelection = { range: range.cloneRange(), msg };
      askBtn.style.display = '';
      const vw = document.documentElement.clientWidth;
      const left = Math.max(8, Math.min(last.right - 40, vw - 90));
      askBtn.style.transform = `translate(${Math.round(left)}px, ${Math.round(last.bottom + 8)}px)`;
    }, 0);
  }

  function startFromSelection() {
    if (!pendingSelection) return;
    const { range, msg } = pendingSelection;
    const a = anchor.describe(range, msg);
    hideAsk();
    if (!a) return;
    getSelection().removeAllRanges();
    const t = {
      id: uid(),
      messageId: gpt.messageId(msg),
      role: gpt.roleOf(msg),
      anchor: a,
      context: contextFor(range, msg, a),
      branchUrl: null,
      createdAt: Date.now(),
      turns: [],
      collapsed: false,
    };
    threads.push(t);
    resolveThread(t);
    expand(t);
  }

  // Clicking highlighted text reopens its thread.
  function onClick(e) {
    if (root.contains(e.target) || !getSelection().isCollapsed) return;
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!pos) return;
    const t = threads.find((x) => {
      const r = views.get(x.id)?.range;
      try {
        return r && r.isPointInRange(pos.startContainer, pos.startOffset);
      } catch {
        return false;
      }
    });
    if (t && (t.collapsed || openId !== t.id)) expand(t);
  }

  // ---- startup ----

  MG.startReader = async function () {
    root = h('div', { id: 'mg-root' });
    askBtn = h(
      'button',
      {
        class: 'mg-ask',
        title: 'Ask a side question about this',
        onmousedown: (e) => e.preventDefault(),
        onclick: startFromSelection,
      },
      h('span', { class: 'mg-pill-icon', html: ICON.ask }),
      'Ask',
    );
    askBtn.style.display = 'none';
    root.append(askBtn);
    document.body.appendChild(root);

    const stored = await chrome.storage.sync.get('mg:settings');
    settings = { ...DEFAULTS, ...stored['mg:settings'] };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes['mg:settings']) settings = { ...DEFAULTS, ...changes['mg:settings'].newValue };
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type?.startsWith('mg:job-')) onJobMessage(msg);
    });

    document.addEventListener('mouseup', onPointerUp, true);
    document.addEventListener('keyup', (e) => e.shiftKey && onPointerUp(e), true);
    document.addEventListener('click', onClick, true);
    document.addEventListener(
      'scroll',
      () => {
        hideAsk();
        scheduleLayout();
      },
      { capture: true, passive: true },
    );
    window.addEventListener('resize', scheduleLayout);

    let resolveQueued = false;
    new MutationObserver((records) => {
      if (resolveQueued || records.every((r) => root.contains(r.target))) return;
      resolveQueued = true;
      setTimeout(() => {
        resolveQueued = false;
        resolveAll();
      }, 200);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    // ChatGPT is a single-page app: watch for moving to another conversation.
    setInterval(() => {
      const id = gpt.conversationId(location.href);
      if (id !== convId) loadConversation(id);
    }, 400);
    setInterval(watchdog, 5000);

    await loadConversation(gpt.conversationId(location.href));
  };
})();
