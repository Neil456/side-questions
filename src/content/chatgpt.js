// Everything that depends on ChatGPT's page structure lives in this file. When ChatGPT changes its
// markup, the selectors and the click sequences below are what need updating.
(() => {
  const MG = (globalThis.MG = globalThis.MG || {});

  const SEL = {
    message: '[data-message-author-role]',
    assistant: '[data-message-author-role="assistant"]',
    turn: 'article, [data-testid^="conversation-turn"]',
    content: '.markdown, .whitespace-pre-wrap',
    composer: '#prompt-textarea, .ProseMirror[contenteditable="true"], textarea[name="prompt-textarea"]',
    send: '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]',
    stop: '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]',
    turnActions: '[data-testid="copy-turn-action-button"], button[aria-label="Copy"]',
    menuItem: '[role="menuitem"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Resolves with the first truthy value of test(), re-checked on every DOM mutation and on a timer.
  function waitFor(test, timeout = 15000, label = 'condition') {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        mo.disconnect();
        clearInterval(iv);
        clearTimeout(to);
        fn(v);
      };
      const check = () => {
        let v;
        try {
          v = test();
        } catch {
          v = null;
        }
        if (v) finish(resolve, v);
      };
      const mo = new MutationObserver(check);
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const iv = setInterval(check, 250);
      const to = setTimeout(() => finish(reject, new Error(`Timed out waiting for ${label}`)), timeout);
      check();
    });
  }

  // Resolves once value() has stayed the same for `quiet` ms.
  async function waitStable(value, quiet = 700, timeout = 10000) {
    const start = Date.now();
    let last = value();
    let since = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(150);
      const v = value();
      if (v !== last) {
        last = v;
        since = Date.now();
      } else if (Date.now() - since >= quiet) return;
    }
  }

  function visible(el) {
    return !!el && !el.disabled && el.getClientRects().length > 0;
  }

  // Radix menus (which ChatGPT uses) open on pointerdown, not click, so send the full sequence.
  function press(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    const pointer = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', pointer));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...pointer, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function hover(el) {
    const opts = { bubbles: true, composed: true };
    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
  }

  function key(el, k) {
    const init = { key: k, code: k, bubbles: true, cancelable: true, composed: true };
    if (k === 'Enter') init.keyCode = init.which = 13;
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // ---- reading the conversation ----

  const messages = () => [...document.querySelectorAll(SEL.message)];
  const assistantMessages = () => [...document.querySelectorAll(SEL.assistant)];
  const messageOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest(SEL.message) || null;
  const messageId = (msg) => msg?.getAttribute('data-message-id') || null;
  const roleOf = (msg) => msg?.getAttribute('data-message-author-role') || null;
  const messageById = (id) => (id ? document.querySelector(`[data-message-id="${CSS.escape(id)}"]`) : null);
  const contentOf = (msg) => msg.querySelector(SEL.content) || msg;
  const turnOf = (msg) => msg.closest(SEL.turn) || msg.parentElement?.parentElement || msg;

  function conversationId(url) {
    const m = /\/c\/([0-9a-zA-Z-]{8,})/.exec(new URL(url, location.origin).pathname);
    return m ? m[1] : null;
  }

  // Where a new chat should start so it keeps the same project / custom GPT as `url`.
  function freshChatUrl(url) {
    const u = new URL(url, location.origin);
    const m = /^\/g\/([^/]+)/.exec(u.pathname);
    if (!m) return `${u.origin}/`;
    return m[1].startsWith('g-p-') ? `${u.origin}/g/${m[1]}/project` : `${u.origin}/g/${m[1]}`;
  }

  function transcript(maxChars = 60000) {
    const text = messages()
      .map((m) => `${roleOf(m) === 'user' ? 'Me' : 'ChatGPT'}:\n${m.innerText.trim()}`)
      .join('\n\n');
    return text.length > maxChars ? `[…earlier messages trimmed…]\n${text.slice(-maxChars)}` : text;
  }

  const composer = () => [...document.querySelectorAll(SEL.composer)].find((el) => el.getClientRects().length) || null;
  const sendButton = () => [...document.querySelectorAll(SEL.send)].find(visible) || null;
  const stopButton = () => [...document.querySelectorAll(SEL.stop)].find((el) => el.getClientRects().length) || null;

  async function waitForComposer() {
    return waitFor(composer, 30000, 'the ChatGPT message box');
  }

  async function waitForConversation() {
    await waitFor(() => messages().length && composer(), 30000, 'the conversation to load');
    await waitStable(() => messages().length);
  }

  // ---- branching ----

  class BranchUnavailable extends Error {
    constructor() {
      super('ChatGPT did not offer “Branch in new chat” for this conversation.');
      this.code = 'NO_BRANCH';
    }
  }

  function findMoreActions(turn) {
    return [...turn.querySelectorAll('button')].find((b) => {
      const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''}`;
      return /more actions|more options|more-actions/i.test(label);
    });
  }

  const findBranchItem = () =>
    [...document.querySelectorAll(SEL.menuItem)].find((el) => /branch/i.test(el.textContent || ''));

  function closeMenus() {
    key(document.activeElement || document.body, 'Escape');
  }

  // Opens "Branch in new chat" on the latest finished response. ChatGPT then navigates this tab to a
  // new conversation that carries the full history (including uploaded files) of the original.
  async function branchFromLatest() {
    const startPath = location.pathname;
    const all = assistantMessages();
    for (let i = all.length - 1; i >= Math.max(0, all.length - 3); i--) {
      const turn = turnOf(all[i]);
      hover(turn);
      const btn = await waitFor(() => findMoreActions(turn), 3000, 'the More actions button').catch(() => null);
      if (!btn) continue;
      press(btn);
      let item = await waitFor(findBranchItem, 2500, 'the Branch menu item').catch(() => null);
      if (!item) {
        btn.focus();
        key(btn, 'Enter');
        item = await waitFor(findBranchItem, 1500, 'the Branch menu item').catch(() => null);
      }
      if (!item) {
        closeMenus();
        continue;
      }
      press(item);
      await waitFor(
        () => location.pathname !== startPath && conversationId(location.href),
        20000,
        'the branched chat to open',
      );
      await waitForConversation();
      return location.href;
    }
    throw new BranchUnavailable();
  }

  // ---- sending a prompt and reading the answer ----

  async function typeIntoComposer(text) {
    const el = await waitForComposer();
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const selectAll = () => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const landed = () => norm(el.innerText).includes(norm(text).slice(0, 60));

    selectAll();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(150);
    if (landed()) return;

    selectAll();
    document.execCommand('insertText', false, text);
    await sleep(150);
    if (!landed()) throw new Error('Could not type into the ChatGPT message box.');
  }

  async function submitPrompt(text) {
    await typeIntoComposer(text);
    const btn = await waitFor(sendButton, 8000, 'the Send button').catch(() => null);
    if (btn) press(btn);
    else key(composer(), 'Enter');
    const sent = () => stopButton() || !(composer()?.innerText || composer()?.value || '').trim();
    const ok = await waitFor(sent, 6000, 'the message to send').catch(() => null);
    if (!ok) {
      key(composer(), 'Enter');
      await waitFor(sent, 6000, 'the message to send');
    }
  }

  const knownAssistantIds = () => new Set(assistantMessages().map(messageId));

  // Streams the newest answer (one not in `known`) to onChunk(html, className) until it finishes.
  async function readResponse(known, onChunk, { appearTimeout = 5 * 60000, maxTime = 15 * 60000 } = {}) {
    const findNew = () => {
      const all = assistantMessages();
      for (let i = all.length - 1; i >= 0; i--) if (!known.has(messageId(all[i]))) return all[i];
      return null;
    };
    await waitFor(findNew, appearTimeout, 'ChatGPT to start answering');

    return new Promise((resolve, reject) => {
      const start = Date.now();
      let last = '';
      let lastChange = Date.now();
      let finished = false;
      const finish = (fn, v) => {
        if (finished) return;
        finished = true;
        mo.disconnect();
        clearInterval(iv);
        fn(v);
      };
      const tick = () => {
        if (finished) return;
        const msg = findNew();
        const body = msg && contentOf(msg);
        const html = body ? body.innerHTML : '';
        if (html !== last) {
          last = html;
          lastChange = Date.now();
          if (html) onChunk(html, body.className);
        }
        const streaming = !!stopButton();
        const hasActions = msg && turnOf(msg).querySelector(SEL.turnActions);
        const quiet = Date.now() - lastChange > 1500;
        if (html && !streaming && (hasActions || quiet)) {
          finish(resolve, { html, className: body.className, text: body.innerText });
        } else if (Date.now() - start > maxTime) {
          finish(reject, new Error('Timed out waiting for the answer to finish.'));
        }
      };
      const mo = new MutationObserver(tick);
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      const iv = setInterval(tick, 500);
      tick();
    });
  }

  // Removes a conversation from the ChatGPT sidebar (the same call ChatGPT's own Delete makes).
  async function hideConversation(id) {
    const session = await fetch(`${location.origin}/api/auth/session`, { credentials: 'include' }).then((r) => r.json());
    if (!session?.accessToken) throw new Error('Not signed in to ChatGPT');
    const res = await fetch(`${location.origin}/backend-api/conversation/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_visible: false }),
    });
    if (!res.ok) throw new Error(`ChatGPT returned ${res.status}`);
  }

  MG.gpt = {
    SEL,
    sleep,
    waitFor,
    messages,
    messageOf,
    messageId,
    messageById,
    roleOf,
    contentOf,
    conversationId,
    freshChatUrl,
    transcript,
    waitForComposer,
    waitForConversation,
    branchFromLatest,
    submitPrompt,
    knownAssistantIds,
    readResponse,
    hideConversation,
  };
})();
