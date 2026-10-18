const DEFAULTS = { mode: 'branch', deleteBranchChats: true };
const saved = document.getElementById('saved');

function flash(text) {
  saved.textContent = text;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (saved.textContent = ''), 1500);
}

async function load() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get('mg:settings'))['mg:settings'] };
  document.querySelector(`input[name="mode"][value="${settings.mode}"]`).checked = true;
  document.getElementById('deleteBranchChats').checked = settings.deleteBranchChats;
}

async function store() {
  await chrome.storage.sync.set({
    'mg:settings': {
      mode: document.querySelector('input[name="mode"]:checked').value,
      deleteBranchChats: document.getElementById('deleteBranchChats').checked,
    },
  });
  flash('Saved');
}

document.querySelectorAll('input').forEach((el) => el.addEventListener('change', store));

document.getElementById('clear').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('mg:conv:'));
  await chrome.storage.local.remove(keys);
  flash(`Forgot ${keys.length} conversation${keys.length === 1 ? '' : 's'}`);
});

load();
