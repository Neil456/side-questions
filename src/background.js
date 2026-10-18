// Routes side questions from the tabs you read in to one pinned helper tab, one question at a time.

const LOAD_TIMEOUT_MS = 30000;
const SILENCE_MS = 120000;

let workerTabId = null;
let workerReady = false; // the helper tab's content script has checked in since its last page load
let workerUrl = null;
let queue = []; // { job, mainTabId, retries }
let current = null; // { job, mainTabId, retries, target, dispatched, lastSeen }

const ready = chrome.storage.session.get('workerTabId').then(async ({ workerTabId: id }) => {
  if (id != null && (await chrome.tabs.get(id).catch(() => null))) workerTabId = id;
});

const pathOf = (url) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
};

const targetFor = (job) => (job.kind === 'branch' ? job.mainUrl : job.kind === 'followup' ? job.branchUrl : job.freshUrl);

function toReader(item, type, fields) {
  const payload = { type, convId: item.job.convId, threadId: item.job.threadId, jobId: item.job.id, ...fields };
  chrome.tabs.sendMessage(item.mainTabId, payload).catch(() => {
    if (type !== 'mg:job-progress') storeResult(payload);
  });
}

// The reading tab was closed: write the answer straight into storage so it's there next time.
async function storeResult(msg) {
  const key = `mg:conv:${msg.convId}`;
  const list = (await chrome.storage.local.get(key))[key] || [];
  const turn = list.find((t) => t.id === msg.threadId)?.turns.find((x) => x.id === msg.jobId);
  if (!turn) return;
  turn.pending = false;
  if (msg.type === 'mg:job-done') {
    turn.a = msg.html;
    turn.cls = msg.className;
    turn.error = null;
    if (msg.branchUrl) list.find((t) => t.id === msg.threadId).branchUrl = msg.branchUrl;
  } else turn.error = msg.error;
  await chrome.storage.local.set({ [key]: list });
}

function finish(type, fields) {
  if (!current) return;
  toReader(current, type, fields);
  current = null;
  pump();
}

async function pump() {
  if (current || !queue.length) return;
  current = { ...queue.shift(), dispatched: false, lastSeen: Date.now() };
  const item = current;
  item.target = targetFor(item.job);
  try {
    if (!item.target) throw new Error('Nothing to open for this side thread.');
    let tab = workerTabId != null ? await chrome.tabs.get(workerTabId).catch(() => null) : null;
    if (tab && workerReady && item.job.kind === 'followup' && pathOf(workerUrl) === pathOf(item.target)) {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'mg:run', job: item.job }).catch(() => null);
      if (res?.ok) {
        item.dispatched = true;
        return;
      }
    }
    workerReady = false;
    if (tab) {
      await chrome.tabs.update(tab.id, { url: item.target });
    } else {
      const main = await chrome.tabs.get(item.mainTabId).catch(() => null);
      tab = await chrome.tabs.create({ url: item.target, active: false, pinned: true, windowId: main?.windowId });
      workerTabId = tab.id;
      chrome.storage.session.set({ workerTabId });
      chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    }
    setTimeout(() => {
      if (current === item && !item.dispatched) {
        finish('mg:job-failed', { error: 'ChatGPT didn’t load in the helper tab. Are you signed in?' });
      }
    }, LOAD_TIMEOUT_MS);
  } catch (e) {
    if (current === item) finish('mg:job-failed', { error: e.message || String(e) });
  }
}

setInterval(() => {
  if (current?.dispatched && Date.now() - current.lastSeen > SILENCE_MS) {
    finish('mg:job-failed', { error: 'The helper tab stopped responding.' });
  }
}, 10000);

async function handle(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  const fromWorker = tabId != null && tabId === workerTabId;
  const mine = fromWorker && current && current.job.id === msg.jobId;
  if (mine) current.lastSeen = Date.now();

  switch (msg.type) {
    case 'mg:hello': {
      if (!fromWorker) return { role: 'reader' };
      workerReady = true;
      workerUrl = msg.url;
      if (current && !current.dispatched && pathOf(msg.url) === pathOf(current.target)) {
        current.dispatched = true;
        current.lastSeen = Date.now();
        return { role: 'worker', job: current.job };
      }
      return { role: 'worker', job: null };
    }
    case 'mg:ask':
      queue.push({ job: msg.job, mainTabId: tabId, retries: 0 });
      pump();
      return { ok: true };
    case 'mg:cancel':
      queue = queue.filter((q) => q.job.threadId !== msg.threadId);
      return { ok: true };
    case 'mg:progress':
      if (mine) toReader(current, 'mg:job-progress', { status: msg.status, html: msg.html, className: msg.className });
      return { ok: true };
    case 'mg:done':
      if (mine) {
        workerUrl = msg.branchUrl || workerUrl;
        finish('mg:job-done', { html: msg.html, className: msg.className, branchUrl: msg.branchUrl });
      }
      return { ok: true };
    case 'mg:fail':
      if (!mine) return { ok: true };
      if (msg.fallback) {
        // No "Branch in new chat" here: start a new chat that carries the conversation as text instead.
        const item = current;
        toReader(item, 'mg:job-progress', { status: 'Branching isn’t available here; starting a new chat with the transcript…' });
        current = null;
        queue.unshift({ ...item, job: { ...item.job, kind: 'fresh', transcript: msg.fallback.transcript } });
        pump();
      } else finish('mg:job-failed', { error: msg.error });
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ ok: false, error: e?.message || String(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== workerTabId) return;
  workerTabId = null;
  workerReady = false;
  chrome.storage.session.remove('workerTabId');
  if (!current) return;
  const item = current;
  current = null;
  if (item.retries < 1) queue.unshift({ job: item.job, mainTabId: item.mainTabId, retries: item.retries + 1 });
  else toReader(item, 'mg:job-failed', { error: 'The helper tab was closed.' });
  pump();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === workerTabId && info.status === 'loading' && info.url) workerReady = false;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
