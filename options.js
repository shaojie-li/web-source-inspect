// 选项页。存储结构和 bridge.js 约定一致：{ editor: string, roots: { [origin]: absPath } }
// 用 storage.local 而不是 sync —— 配的是磁盘绝对路径，跨设备同步只会带来错的路径。

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

/** origin 必须是 scheme + host(+port)，多余的 path/query 会让匹配永远失败，所以规范化后再存 */
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

    // 路径做成可编辑输入框，改完失焦即存 —— 比"编辑/保存"两步顺手
    const tdRoot = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = root;
    input.style.width = '100%';
    input.onchange = async () => {
      const next = normalizeRoot(input.value);
      const { roots: current = {} } = await chrome.storage.local.get({ roots: {} });
      if (next) current[origin] = next;
      else delete current[origin]; // 清空输入等于删掉这条
      await chrome.storage.local.set({ roots: current });
      flashSaved();
      if (!next) load();
    };
    tdRoot.append(input);

    const tdActions = document.createElement('td');
    tdActions.className = 'actions';
    const del = document.createElement('button');
    del.className = 'link-danger';
    del.textContent = '删除';
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
    return void alert('站点 origin 填得不对，形如 http://localhost:3000');
  }
  if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root)) {
    $('new-root').focus();
    return void alert('项目根要填磁盘绝对路径，形如 /Users/你/项目目录');
  }
  const { roots = {} } = await chrome.storage.local.get({ roots: {} });
  roots[origin] = root;
  await chrome.storage.local.set({ roots });
  $('new-origin').value = '';
  $('new-root').value = '';
  flashSaved();
  load();
};

// 页面卡片上改了配置，选项页开着的话同步刷新
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') load();
});

load();
