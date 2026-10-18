// A small stand-in for chatgpt.com with the parts of its DOM the extension relies on: message
// elements with ids and roles, a Radix-style "More actions" menu that opens on pointerdown, a
// contenteditable composer that handles paste, and send/stop buttons around a streamed answer.
// State lives in localStorage so it survives reloads and is shared between tabs.
(() => {
  const SEED = '11111111-1111-4111-8111-111111111111';
  const seedMessages = () => [
    {
      id: 'msg-seed-user',
      role: 'user',
      text: 'Can you explain scaled dot-product attention from the Transformer paper? I keep getting lost.',
    },
    {
      id: 'msg-seed-assistant',
      role: 'assistant',
      html:
        '<p>Attention lets every token decide how much to look at every other token. Each token is projected into a <strong>query</strong>, a <strong>key</strong> and a <strong>value</strong>.</p>' +
        '<p>To score how relevant token B is to token A, take the dot product of A’s query with B’s key. Those scores are scaled by the square root of the key dimension before the softmax, which keeps them from growing so large that the softmax saturates.</p>' +
        '<p>The softmax turns the scores into weights that sum to one, and the output for A is the weighted sum of all the values. Multi-head attention runs several of these in parallel with different projections, so each head can specialise in a different kind of relationship.</p>' +
        '<ul><li>Queries ask “what am I looking for?”</li><li>Keys answer “what do I contain?”</li><li>Values carry the information that gets mixed.</li></ul>',
    },
  ];

  const uuid = () => crypto.randomUUID();
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const getJSON = (k, d) => JSON.parse(localStorage.getItem(k) || 'null') ?? d;
  const setJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  if (localStorage.getItem('mock:theme') === 'dark') document.documentElement.classList.add('dark');
  if (!localStorage.getItem(`mock:conv:${SEED}`)) {
    setJSON(`mock:conv:${SEED}`, { title: 'Scaled dot-product attention', messages: seedMessages() });
  }

  const thread = document.getElementById('thread');
  const box = document.getElementById('prompt-textarea');
  const sendBtn = document.getElementById('send');
  let streaming = false;

  const currentId = () => (/\/c\/([^/]+)/.exec(location.pathname) || [])[1] || null;
  const load = (id) => getJSON(`mock:conv:${id}`, null);
  const save = (id, conv) => setJSON(`mock:conv:${id}`, conv);

  function renderHistory() {
    const nav = document.getElementById('history');
    const ids = Object.keys(localStorage)
      .filter((k) => k.startsWith('mock:conv:'))
      .map((k) => k.slice(10));
    nav.innerHTML = ids
      .map((id) => `<a href="/c/${id}" class="${id === currentId() ? 'on' : ''}">${esc(load(id).title)}</a>`)
      .join('');
  }

  function messageEl(m, finished = true) {
    const article = document.createElement('article');
    article.dataset.testid = `conversation-turn-${thread.children.length + 1}`;
    if (m.role === 'user') {
      article.innerHTML = `<div data-message-author-role="user" data-message-id="${m.id}"><div class="whitespace-pre-wrap">${esc(m.text)}</div></div>`;
    } else {
      article.innerHTML = `<div data-message-author-role="assistant" data-message-id="${m.id}"><div class="markdown prose w-full">${m.html}</div></div>`;
      if (finished) addActions(article);
    }
    return article;
  }

  function addActions(article) {
    const bar = document.createElement('div');
    bar.className = 'actions';
    bar.innerHTML =
      '<button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button>' +
      '<button aria-label="More actions" aria-haspopup="menu">•••</button>';
    bar.querySelector('[aria-label="More actions"]').addEventListener('pointerdown', (e) => {
      if (e.button === 0) openMenu(e.currentTarget);
    });
    article.appendChild(bar);
  }

  function render() {
    closeMenu();
    thread.innerHTML = '';
    const id = currentId();
    const conv = id && load(id);
    if (conv) for (const m of conv.messages) thread.appendChild(messageEl(m));
    renderHistory();
  }

  // ---- More actions menu ----

  function closeMenu() {
    document.querySelector('[role="menu"]')?.remove();
  }

  function openMenu(trigger) {
    closeMenu();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const items = ['Read aloud'];
    if (localStorage.getItem('mock:nobranch') !== '1') items.unshift('Branch in new chat');
    menu.innerHTML = items.map((t) => `<div role="menuitem" tabindex="-1">${t}</div>`).join('');
    const r = trigger.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[role="menuitem"]');
      if (item?.textContent === 'Branch in new chat') branch(trigger.closest('article'));
      closeMenu();
    });
    document.body.appendChild(menu);
  }

  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

  function branch(article) {
    const conv = load(currentId());
    const msgId = article.querySelector('[data-message-id]').dataset.messageId;
    const upto = conv.messages.findIndex((m) => m.id === msgId);
    const id = uuid();
    save(id, { title: `Branch · ${conv.title}`, messages: conv.messages.slice(0, upto + 1), branchedFrom: currentId() });
    history.pushState(null, '', `/c/${id}`);
    render();
  }

  // ---- composer ----

  const composerText = () => box.innerText.replace(/\n{2,}/g, '\n').trim();
  const syncSend = () => (sendBtn.disabled = streaming || !composerText());

  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    box.innerHTML = text
      .split('\n')
      .map((l) => `<p>${esc(l) || '<br>'}</p>`)
      .join('');
    syncSend();
  });
  box.addEventListener('input', syncSend);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });
  sendBtn.addEventListener('click', () => {
    if (sendBtn.dataset.testid === 'stop-button') return;
    if (!sendBtn.disabled) sendMessage();
  });

  function setStreaming(on) {
    streaming = on;
    sendBtn.dataset.testid = on ? 'stop-button' : 'send-button';
    sendBtn.setAttribute('aria-label', on ? 'Stop streaming' : 'Send prompt');
    sendBtn.textContent = on ? '■' : '↑';
    sendBtn.disabled = false;
    if (!on) syncSend();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sendMessage() {
    const prompt = box.innerText.replace(/\n\n/g, '\n').trim();
    box.innerHTML = '';
    let id = currentId();
    let conv = id && load(id);
    const isNew = !conv;
    if (isNew) {
      id = uuid();
      conv = { title: prompt.slice(0, 40), messages: [] };
    }
    const priorMessages = conv.messages.length;
    const user = { id: `msg-${uuid()}`, role: 'user', text: prompt };
    conv.messages.push(user);
    save(id, conv);
    setJSON('mock:log', [...getJSON('mock:log', []), { conv: id, prompt, priorMessages, isNew }]);
    thread.appendChild(messageEl(user));
    setStreaming(true);
    if (isNew) history.pushState(null, '', `/c/${id}`);

    const lines = prompt.split('\n').filter(Boolean);
    const question = lines[lines.length - 1];
    const words = `Here is a focused answer with a few sentences of explanation so that the margin card has something to stream while the response is being written out word by word.`.split(' ');
    const finalHtml =
      `<p>Mock answer to: <strong>${esc(question)}</strong></p>` +
      `<p>${words.join(' ')}</p>` +
      '<ul><li>First point, with <code>inline code</code></li><li>Second point</li></ul>';

    await sleep(300);
    const reply = { id: `msg-${uuid()}`, role: 'assistant', html: '' };
    const article = messageEl(reply, false);
    thread.appendChild(article);
    const body = article.querySelector('.markdown');
    for (let i = 1; i <= words.length; i += 3) {
      body.innerHTML = `<p>${words.slice(0, i).join(' ')}</p>`;
      await sleep(40);
    }
    body.innerHTML = finalHtml;
    reply.html = finalHtml;
    conv.messages.push(reply);
    save(id, conv);
    addActions(article);
    setStreaming(false);
    renderHistory();
  }

  window.addEventListener('popstate', render);
  render();
})();
