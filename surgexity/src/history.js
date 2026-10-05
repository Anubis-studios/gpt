// ============================================================
// Surgexity — History & Spaces Management (KV-backed)
// ============================================================
import { uid, relTime } from './app.js';

const HISTORY_KEY = 'perplexity_history';
const SPACES_KEY = 'perplexity_spaces';
const ACTIVE_SPACE_KEY = 'perplexity_active_space';

function getFolder() {
  return root.kv ? root.kv.perplexity : null;
}

// Fallback localStorage layer (used if KV not available)
function lsGet(key, def) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || def; } catch { return def; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ---------- History ----------
export async function loadHistory() {
  const folder = getFolder();
  if (folder) {
    try {
      const data = await folder.get(HISTORY_KEY);
      if (data) return data;
    } catch {}
  }
  return lsGet(HISTORY_KEY, []);
}

export async function saveHistory(history) {
  const folder = getFolder();
  if (folder) {
    try { await folder.set(HISTORY_KEY, history); } catch {}
  }
  lsSet(HISTORY_KEY, history);
}

export async function addToHistory(thread) {
  const history = await loadHistory();
  const existingIdx = history.findIndex(h => h.id === thread.id);
  if (existingIdx >= 0) {
    history[existingIdx] = { ...history[existingIdx], ...thread, updatedAt: Date.now() };
  } else {
    history.unshift({ ...thread, createdAt: Date.now(), updatedAt: Date.now() });
  }
  await saveHistory(history);
  return history;
}

export async function deleteFromHistory(id) {
  const history = await loadHistory();
  const filtered = history.filter(h => h.id !== id);
  await saveHistory(filtered);
  return filtered;
}

export async function clearHistory() {
  await saveHistory([]);
  return [];
}

// ---------- Spaces ----------
export async function loadSpaces() {
  const folder = getFolder();
  if (folder) {
    try {
      const data = await folder.get(SPACES_KEY);
      if (data) return data;
    } catch {}
  }
  return lsGet(SPACES_KEY, []);
}

export async function saveSpaces(spaces) {
  const folder = getFolder();
  if (folder) {
    try { await folder.set(SPACES_KEY, spaces); } catch {}
  }
  lsSet(SPACES_KEY, spaces);
}

export async function createSpace(name, instructions = '', nsfw = true) {
  const spaces = await loadSpaces();
  const space = {
    id: uid(),
    name,
    instructions,
    nsfw,
    createdAt: Date.now(),
    threads: [],
  };
  spaces.push(space);
  await saveSpaces(spaces);
  return space;
}

export async function deleteSpace(id) {
  const spaces = await loadSpaces();
  const filtered = spaces.filter(s => s.id !== id);
  await saveSpaces(filtered);
  return filtered;
}

export async function getActiveSpaceId() {
  return lsGet(ACTIVE_SPACE_KEY, null);
}

export async function setActiveSpaceId(id) {
  lsSet(ACTIVE_SPACE_KEY, id);
}

export async function addThreadToSpace(spaceId, thread) {
  const spaces = await loadSpaces();
  const space = spaces.find(s => s.id === spaceId);
  if (space) {
    if (!space.threads) space.threads = [];
    const idx = space.threads.findIndex(t => t.id === thread.id);
    if (idx >= 0) space.threads[idx] = thread;
    else space.threads.push(thread);
    await saveSpaces(spaces);
  }
  return spaces;
}
