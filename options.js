// Options page. Storage follows bridge.js: { editor: string, roots: { [origin]: absPath } }
// Use storage.local rather than sync because absolute disk paths are device-specific.

const EDITORS = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
];
const DEFAULTS = { editor: 'vscode', roots: {} };

const $ = (id) => document.getElementById(id);
const savedTip = $('saved');

function flashSaved() {
  savedTip.classList.add('show');
  setTimeout(() => savedTip.classList.remove('show'), 1200);
}

/** An origin must be scheme + host (+port); normalize it so a path or query cannot prevent matching. */
function normalizeOrigin(input) {
  const raw = input.trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).origin;
  } catch {
    return null;
  }
}

const normalizeRoot = (input) => input.trim().replace(/\/+$/, '');

function renderEditor(selected) {
  const sel = $('editor');
  sel.replaceChildren();
  for (const editor of EDITORS) {
    const opt = document.createElement('option');
    opt.value = editor.id;
    opt.textContent = editor.label;
    sel.append(opt);
  }
  sel.value = EDITORS.some((e) => e.id === selected) ? selected : DEFAULTS.editor;
}

function renderRoots(roots) {
  const tbody = $('roots');
  tbody.replaceChildren();
  const entries = Object.entries(roots).sort(([a], [b]) => a.localeCompare(b));
  $('empty').hidden = entries.length > 0;

  for (const [origin, root] of entries) {
    const tr = document.createElement('tr');

    const tdOrigin = document.createElement('td');
    tdOrigin.className = 'path';
    tdOrigin.textContent = origin;

    // Make the path directly editable and save on blur instead of requiring edit/save steps.
    const tdRoot = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = root;
    input.style.width = '100%';
    input.onchange = async () => {
      const next = normalizeRoot(input.value);
      const { roots: current = {} } = await chrome.storage.local.get({ roots: {} });
      if (next) current[origin] = next;
      else delete current[origin]; // Clearing the input removes this entry.
      await chrome.storage.local.set({ roots: current });
      flashSaved();
      if (!next) load();
    };
    tdRoot.append(input);

    const tdActions = document.createElement('td');
    tdActions.className = 'actions';
    const del = document.createElement('button');
    del.className = 'link-danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      const { roots: current = {} } = await chrome.storage.local.get({ roots: {} });
      delete current[origin];
      await chrome.storage.local.set({ roots: current });
      flashSaved();
      load();
    };
    tdActions.append(del);

    tr.append(tdOrigin, tdRoot, tdActions);
    tbody.append(tr);
  }
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  renderEditor(stored.editor);
  renderRoots(stored.roots || {});
}

$('editor').onchange = async (e) => {
  await chrome.storage.local.set({ editor: e.target.value });
  flashSaved();
};

$('add').onclick = async () => {
  const origin = normalizeOrigin($('new-origin').value);
  const root = normalizeRoot($('new-root').value);
  if (!origin) {
    $('new-origin').focus();
    return void alert('Enter a valid site origin, for example http://localhost:3000');
  }
  if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root)) {
    $('new-root').focus();
    return void alert('Enter an absolute disk path for the project root, for example /Users/you/project');
  }
  const { roots = {} } = await chrome.storage.local.get({ roots: {} });
  roots[origin] = root;
  await chrome.storage.local.set({ roots });
  $('new-origin').value = '';
  $('new-root').value = '';
  flashSaved();
  load();
};

// Refresh this page when configuration changes from an in-page card.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') load();
});

load();
