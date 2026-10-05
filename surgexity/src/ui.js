// ============================================================
// Surgexity — UI Controller
// ============================================================
import { uid, esc, renderMarkdown, processCitations, webSearch, fetchPageContent, generateAnswer, generateRelatedQuestions, relTime, fmtDate, simpleHash, debounce } from './app.js';
import { loadHistory, addToHistory, deleteFromHistory, clearHistory, loadSpaces, createSpace, deleteSpace, getActiveSpaceId, setActiveSpaceId, addThreadToSpace, saveHistory } from './history.js';

// ---------- State ----------
let currentThread = null;
let isGenerating = false;
let currentView = 'home';
let history = [];
let spaces = [];
let activeSpaceId = null;
let currentFocusMode = 'web';
let settings = { nsfw: true, theme: 'dark', streamResponses: true, autoRelated: true };

// Search and creation focus modes
const FOCUS_MODES = [
  { id: 'web', label: 'Search', icon: '🌐', desc: 'Search the web for answers' },
  { id: 'academic', label: 'Academic', icon: '🎓', desc: 'Search academic papers' },
  { id: 'writing', label: 'Writing', icon: '✍', desc: 'Writing assistance' },
  { id: 'videos', label: 'Videos', icon: '📺', desc: 'Find relevant videos' },
  { id: 'social', label: 'Social', icon: '💬', desc: 'Social media discussions' },
];

// ---------- DOM References ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- Init ----------
export async function initApp() {
  // Load settings
  try {
    const savedSettings = localStorage.getItem('surgexity_settings');
    const legacySettings = localStorage.getItem('perplexity_settings');
    if (!savedSettings && legacySettings) {
      localStorage.setItem('surgexity_settings', legacySettings);
      localStorage.removeItem('perplexity_settings');
    }
    settings = { ...settings, ...JSON.parse(localStorage.getItem('surgexity_settings') || '{}') };
  } catch {}
  applyTheme(settings.theme);
  $('#nsfwToggle').checked = settings.nsfw;
  $('#streamToggle').checked = settings.streamResponses;

  // Load history & spaces
  history = await loadHistory();
  spaces = await loadSpaces();
  activeSpaceId = await getActiveSpaceId();
  renderHistorySidebar();
  renderSpacesSidebar();
  renderHomeRecent();

  // Wire up events
  wireEvents();

  // Show home
  showView('home');
}

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  settings.theme = theme;
}

// ---------- Views ----------
function showView(view) {
  currentView = view;
  $$('.view').forEach(v => v.hidden = v.dataset.view !== view);
  $('#sidebar').classList.toggle('mobile-open', false);

  if (view === 'home') {
    $('#homeSearchInput').focus();
    renderHomeRecent();
  } else if (view === 'history') {
    renderHistoryPage();
  } else if (view === 'spaces') {
    renderSpacesPage();
  } else if (view === 'discover') {
    renderDiscoverPage();
  } else if (view === 'settings') {
    renderSettingsPage();
  }
}

// ---------- Home View ----------
function renderHomeRecent() {
  const ctn = $('#homeRecent');
  if (!history.length) { ctn.innerHTML = '<p class="muted">No recent searches yet.</p>'; return; }
  ctn.innerHTML = history.slice(0, 6).map(h =>
    `<div class="recent-item" data-thread="${h.id}">
      <span class="recent-icon">${esc(h.focusMode === 'academic' ? '🎓' : h.focusMode === 'writing' ? '✍' : '🔍')}</span>
      <span class="recent-title">${esc(h.title || h.messages?.[0]?.content || 'Untitled')}</span>
      <span class="recent-time">${relTime(h.updatedAt || h.createdAt)}</span>
    </div>`
  ).join('');
  ctn.querySelectorAll('.recent-item').forEach(el => {
    el.onclick = () => openThread(el.dataset.thread);
  });
}

// ---------- Thread View ----------
async function startNewThread(query, focusMode = currentFocusMode) {
  const thread = {
    id: uid(),
    title: query.slice(0, 60),
    focusMode,
    messages: [],
    sources: [],
    relatedQuestions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  currentThread = thread;
  showView('thread');
  await processQuery(thread, query);
}

async function openThread(id) {
  const h = history.find(t => t.id === id);
  if (!h) return;
  currentThread = { ...h };
  showView('thread');
  renderThread();
}

async function processQuery(thread, query, isFollowUp = false) {
  if (isGenerating) return;
  isGenerating = true;

  // Add user message
  thread.messages.push({ role: 'user', content: query, ts: Date.now() });
  renderThread(true);
  scrollThreadToBottom();

  // Create assistant placeholder
  const assistantIdx = thread.messages.length;
  thread.messages.push({ role: 'assistant', content: '', sources: [], ts: Date.now(), loading: true });
  renderThread(true);
  scrollThreadToBottom();

  // Update sidebar
  renderHistorySidebar();

  try {
    // 1) Web search
    const sources = await webSearch(query, root.appConfig?.maxSources || 6);
    thread.messages[assistantIdx].sources = sources;
    thread.sources = sources;
    renderThread(true);

    // 2) Fetch deeper content from top sources (in parallel, limited)
    const topSources = sources.slice(0, 3);
    const contents = await Promise.allSettled(topSources.map(s => fetchPageContent(s.url, 2000)));
    contents.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) topSources[i].snippet = (topSources[i].snippet + ' ' + r.value).trim().slice(0, 800);
    });

    // 3) Generate AI answer
    let answerText = '';
    const onChunk = (data) => {
      answerText = data.fullTextSoFar || '';
      thread.messages[assistantIdx].content = answerText;
      thread.messages[assistantIdx].loading = false;
      renderThreadStreaming(assistantIdx);
      scrollThreadToBottom();
    };

    const threadContext = thread.messages.slice(0, assistantIdx).filter(m => m.role === 'user' || (m.role === 'assistant' && m.content)).map(m => ({
      role: m.role,
      content: m.content,
    }));

    const result = await generateAnswer(query, sources, {
      thread: threadContext,
      nsfw: settings.nsfw,
      focusMode: thread.focusMode,
      onChunk: settings.streamResponses ? onChunk : undefined,
    });

    thread.messages[assistantIdx].content = result.text || answerText;
    thread.messages[assistantIdx].loading = false;

    // 4) Generate related questions
    if (settings.autoRelated) {
      thread.messages[assistantIdx].generatingRelated = true;
      renderThread();
      try {
        thread.relatedQuestions = await generateRelatedQuestions(query, thread.messages[assistantIdx].content, root.appConfig?.maxRelatedQuestions || 5);
      } catch {}
      thread.messages[assistantIdx].generatingRelated = false;
    }

    // Save to history
    thread.updatedAt = Date.now();
    await addToHistory(thread);

    // Add to active space if any
    if (activeSpaceId) {
      await addThreadToSpace(activeSpaceId, thread);
    }

    history = await loadHistory();
    renderHistorySidebar();
    renderThread();
  } catch (e) {
    console.error('Process query error:', e);
    thread.messages[assistantIdx].content = `I encountered an error while processing your request: ${esc(e.message || 'Unknown error')}. Please try again.`;
    thread.messages[assistantIdx].loading = false;
    thread.messages[assistantIdx].error = true;
    renderThread();
  } finally {
    isGenerating = false;
  }
}

function renderThread(streaming = false) {
  if (!currentThread) return;
  const ctn = $('#threadMessages');
  const thread = currentThread;

  // Title
  $('#threadTitle').textContent = thread.title;

  // Render messages
  ctn.innerHTML = thread.messages.map((msg, i) => {
    if (msg.role === 'user') {
      return `<div class="msg msg-user">
        <div class="msg-avatar user-avatar">U</div>
        <div class="msg-body">
          <div class="msg-role">You</div>
          <div class="msg-content user-content">${esc(msg.content)}</div>
        </div>
      </div>`;
    } else {
      return renderAssistantMessage(msg, i, thread);
    }
  }).join('');

  // Wire citation clicks
  ctn.querySelectorAll('.cite-chip').forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.dataset.cite);
      const source = thread.messages.find(m => m.sources)?.sources?.[idx] || thread.sources?.[idx];
      if (source) window.open(source.url, '_blank');
    };
  });

  // Wire source cards
  ctn.querySelectorAll('.source-card').forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.dataset.source);
      const source = thread.sources?.[idx];
      if (source) window.open(source.url, '_blank');
    };
  });

  // Wire related questions
  ctn.querySelectorAll('.related-q').forEach(el => {
    el.onclick = () => {
      if (isGenerating) return;
      const q = el.dataset.q;
      processQuery(currentThread, q, true);
    };
  });

  // Wire message actions
  ctn.querySelectorAll('.msg-action').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const action = el.dataset.action;
      const idx = parseInt(el.dataset.idx);
      handleMessageAction(action, idx);
    };
  });
}

function renderAssistantMessage(msg, idx, thread) {
  const sources = msg.sources || [];
  const sourceCards = sources.length ? `
    <div class="sources-grid">
      ${sources.map((s, si) => `
        <div class="source-card" data-source="${si}">
          <img src="${esc(s.favicon||'')}" class="source-fav" onerror="this.style.display='none'">
          <div class="source-info">
            <div class="source-title">${esc(s.title)}</div>
            <div class="source-domain">${esc(s.domain)}</div>
          </div>
          <div class="source-idx">${si+1}</div>
        </div>
      `).join('')}
    </div>` : '';

  let contentHtml;
  if (msg.loading && !msg.content) {
    contentHtml = `<div class="loading-indicator">
      <div class="loading-bar"></div><div class="loading-bar"></div><div class="loading-bar"></div>
      <span>Searching the web and synthesizing answer…</span>
    </div>`;
  } else {
    let html = renderMarkdown(msg.content || '');
    html = processCitations(html, sources);
    contentHtml = html;
    if (msg.loading) contentHtml += '<span class="cursor-blink">▋</span>';
  }

  const relatedHtml = (thread.relatedQuestions && thread.relatedQuestions.length && idx === thread.messages.length - 1) ? `
    <div class="related-section">
      <div class="related-header">Related</div>
      ${thread.relatedQuestions.map(q => `<div class="related-q" data-q="${esc(q)}">${esc(q)}</div>`).join('')}
    </div>` : (msg.generatingRelated ? '<div class="related-section"><div class="muted">Generating related questions…</div></div>' : '');

  const actions = msg.content && !msg.loading ? `
    <div class="msg-actions">
      <button class="msg-action" data-action="copy" data-idx="${idx}" title="Copy">⧉ Copy</button>
      <button class="msg-action" data-action="share" data-idx="${idx}" title="Share">↗ Share</button>
      <button class="msg-action" data-action="rewrite" data-idx="${idx}" title="Rewrite">↻ Rewrite</button>
    </div>` : '';

  return `<div class="msg msg-assistant">
    <div class="msg-avatar ai-avatar">P</div>
    <div class="msg-body">
      ${sourceCards}
      <div class="msg-content ai-content">${contentHtml}</div>
      ${actions}
      ${relatedHtml}
    </div>
  </div>`;
}

function renderThreadStreaming(assistantIdx) {
  // Lightweight streaming update — only update the specific message content
  const ctn = $('#threadMessages');
  const msgEls = ctn.querySelectorAll('.msg-assistant');
  if (!msgEls.length) return renderThread();
  const targetEl = msgEls[msgEls.length - 1];
  if (!targetEl) return renderThread();

  const msg = currentThread.messages[assistantIdx];
  if (!msg) return;
  const contentEl = targetEl.querySelector('.ai-content');
  if (contentEl) {
    let html = renderMarkdown(msg.content || '');
    html = processCitations(html, msg.sources || []);
    if (msg.loading) html += '<span class="cursor-blink">▋</span>';
    contentEl.innerHTML = html;
  }
  // Wire citation clicks in streaming content
  contentEl?.querySelectorAll('.cite-chip').forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.dataset.cite);
      const source = msg.sources?.[idx] || currentThread.sources?.[idx];
      if (source) window.open(source.url, '_blank');
    };
  });
}

function scrollThreadToBottom() {
  const ctn = $('#threadMessages');
  if (ctn) ctn.scrollTop = ctn.scrollHeight;
}

function handleMessageAction(action, idx) {
  const msg = currentThread?.messages?.[idx];
  if (!msg) return;
  if (action === 'copy') {
    navigator.clipboard.writeText(msg.content || '').then(() => showToast('Copied to clipboard'));
  } else if (action === 'share') {
    const text = `${currentThread.title}\n\n${msg.content}`;
    if (navigator.share) navigator.share({ title: currentThread.title, text }).catch(() => {});
    else { navigator.clipboard.writeText(text); showToast('Copied to clipboard'); }
  } else if (action === 'rewrite') {
    if (isGenerating) return;
    rewriteAnswer(idx);
  }
}

async function rewriteAnswer(idx) {
  const msg = currentThread.messages[idx];
  if (!msg) return;
  isGenerating = true;
  msg.loading = true;
  msg.content = '';
  renderThread();
  try {
    const result = await generateAnswer(`Please rewrite and improve this answer with more detail and clarity: ${currentThread.messages[idx-1]?.content || ''}`, msg.sources || currentThread.sources || [], {
      nsfw: settings.nsfw, focusMode: currentThread.focusMode,
      onChunk: settings.streamResponses ? (d) => { msg.content = d.fullTextSoFar||''; msg.loading = false; renderThreadStreaming(idx); } : undefined,
    });
    msg.content = result.text;
    msg.loading = false;
    renderThread();
    await addToHistory(currentThread);
  } catch (e) {
    msg.content = `Error rewriting: ${e.message}`;
    msg.loading = false;
    renderThread();
  } finally {
    isGenerating = false;
  }
}

// ---------- History Page ----------
function renderHistoryPage() {
  const ctn = $('#historyList');
  if (!history.length) { ctn.innerHTML = '<p class="muted center">No history yet. Start searching to build your history.</p>'; return; }

  // Group by date
  const groups = {};
  history.forEach(h => {
    const d = new Date(h.updatedAt || h.createdAt);
    const key = fmtDate(d.getTime());
    if (!groups[key]) groups[key] = [];
    groups[key].push(h);
  });

  ctn.innerHTML = Object.entries(groups).map(([date, items]) => `
    <div class="history-group">
      <div class="history-date">${date}</div>
      ${items.map(h => `
        <div class="history-row" data-thread="${h.id}">
          <span class="history-icon">${h.focusMode === 'academic' ? '🎓' : h.focusMode === 'writing' ? '✍' : '🔍'}</span>
          <div class="history-info">
            <div class="history-title">${esc(h.title)}</div>
            <div class="history-meta">${h.messages?.length || 0} messages · ${relTime(h.updatedAt||h.createdAt)}</div>
          </div>
          <button class="history-del" data-del="${h.id}" title="Delete">✕</button>
        </div>
      `).join('')}
    </div>
  `).join('');

  ctn.querySelectorAll('.history-row').forEach(el => { el.onclick = () => openThread(el.dataset.thread); });
  ctn.querySelectorAll('.history-del').forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      history = await deleteFromHistory(el.dataset.del);
      renderHistoryPage();
      renderHistorySidebar();
      renderHomeRecent();
    };
  });
}

// ---------- Spaces Page ----------
function renderSpacesPage() {
  const ctn = $('#spacesList');
  if (!spaces.length) {
    ctn.innerHTML = `<div class="empty-state">
      <h3>No Spaces yet</h3>
      <p class="muted">Spaces let you organize threads by topic with custom AI instructions.</p>
    </div>`;
    return;
  }
  ctn.innerHTML = spaces.map(s => `
    <div class="space-card" data-space="${s.id}">
      <div class="space-header">
        <span class="space-icon">📁</span>
        <div class="space-name">${esc(s.name)}</div>
        <button class="space-del" data-del="${s.id}">✕</button>
      </div>
      <div class="space-instructions">${esc(s.instructions || 'No custom instructions')}</div>
      <div class="space-meta">${s.threads?.length || 0} threads · ${s.nsfw ? 'NSFW on' : 'SFW'}</div>
    </div>
  `).join('');
  ctn.querySelectorAll('.space-del').forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      spaces = await deleteSpace(el.dataset.del);
      if (activeSpaceId === el.dataset.del) { activeSpaceId = null; await setActiveSpaceId(null); }
      renderSpacesPage();
      renderSpacesSidebar();
    };
  });
}

// ---------- Discover Page ----------
const DISCOVER_TOPICS = [
  { category: 'Science', items: ['What is quantum entanglement?', 'How do mRNA vaccines work?', 'Latest discoveries in astronomy', 'What is dark matter?'] },
  { category: 'Technology', items: ['How does GPT work?', 'What is Web3?', 'Latest AI breakthroughs 2024', 'How do quantum computers work?'] },
  { category: 'History', items: ['What caused the fall of Rome?', 'History of the Silk Road', 'Who built the pyramids?', 'The Renaissance explained'] },
  { category: 'Health', items: ['Benefits of intermittent fasting', 'How does sleep affect memory?', 'What is the gut microbiome?', 'Exercise and brain health'] },
  { category: 'Culture', items: ['Best books of 2024', 'History of jazz music', 'How anime became global', 'Evolution of hip hop'] },
];

function renderDiscoverPage() {
  const ctn = $('#discoverContent');
  ctn.innerHTML = DISCOVER_TOPICS.map(cat => `
    <div class="discover-cat">
      <h3 class="discover-title">${cat.category}</h3>
      <div class="discover-items">
        ${cat.items.map(q => `<div class="discover-item" data-q="${esc(q)}">${esc(q)}</div>`).join('')}
      </div>
    </div>
  `).join('');
  ctn.querySelectorAll('.discover-item').forEach(el => {
    el.onclick = () => startNewThread(el.dataset.q);
  });
}

// ---------- Settings Page ----------
function renderSettingsPage() {
  $('#nsfwToggle').checked = settings.nsfw;
  $('#streamToggle').checked = settings.streamResponses;
  $('#themeSelect').value = settings.theme;
}

// ---------- Sidebar ----------
function renderHistorySidebar() {
  const ctn = $('#sidebarHistory');
  if (!history.length) { ctn.innerHTML = '<div class="sidebar-muted">No history</div>'; return; }
  ctn.innerHTML = history.slice(0, 15).map(h =>
    `<div class="sidebar-history-item" data-thread="${h.id}">
      <span class="sb-icon">${h.focusMode === 'academic' ? '🎓' : h.focusMode === 'writing' ? '✍' : '🔍'}</span>
      <span class="sb-title">${esc(h.title)}</span>
    </div>`
  ).join('');
  ctn.querySelectorAll('.sidebar-history-item').forEach(el => {
    el.onclick = () => openThread(el.dataset.thread);
  });
}

function renderSpacesSidebar() {
  const ctn = $('#sidebarSpaces');
  if (!spaces.length) { ctn.innerHTML = '<div class="sidebar-muted">No spaces</div>'; return; }
  ctn.innerHTML = spaces.map(s =>
    `<div class="sidebar-space-item ${s.id === activeSpaceId ? 'active' : ''}" data-space="${s.id}">
      <span class="sb-icon">📁</span>
      <span class="sb-title">${esc(s.name)}</span>
    </div>`
  ).join('');
  ctn.querySelectorAll('.sidebar-space-item').forEach(el => {
    el.onclick = async () => {
      activeSpaceId = el.dataset.space;
      await setActiveSpaceId(activeSpaceId);
      renderSpacesSidebar();
      showToast(`Space: ${spaces.find(s=>s.id===activeSpaceId)?.name}`);
    };
  });
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------- Event Wiring ----------
function wireEvents() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el[ev] = fn; };
  const onClick = (sel, fn) => on(sel, 'onclick', fn);

  // New thread
  onClick('#newThreadBtn', () => { currentThread = null; showView('home'); });
  onClick('#sidebarNewBtn', () => { currentThread = null; showView('home'); });

  // Nav items
  onClick('#navHome', () => showView('home'));
  onClick('#navDiscover', () => showView('discover'));
  onClick('#navHistory', () => showView('history'));
  onClick('#navSpaces', () => showView('spaces'));
  onClick('#navSettings', () => showView('settings'));

  // Home search
  on('#homeSearchForm', 'onsubmit', (e) => {
    e.preventDefault();
    const q = $('#homeSearchInput')?.value.trim();
    if (q) startNewThread(q);
  });

  // Thread follow-up
  on('#threadInputForm', 'onsubmit', (e) => {
    e.preventDefault();
    const q = $('#threadInput')?.value.trim();
    if (q && !isGenerating) {
      $('#threadInput').value = '';
      processQuery(currentThread, q, true);
    }
  });

  // Focus mode selector (home)
  $('.focus-mode-btn').forEach(btn => {
    btn.onclick = () => {
      currentFocusMode = btn.dataset.mode;
      $('.focus-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Settings toggles
  on('#nsfwToggle', 'onchange', (e) => {
    settings.nsfw = e.target.checked;
    saveSettings();
    showToast(`NSFW mode ${e.target.checked ? 'enabled' : 'disabled'}`);
  });
  on('#streamToggle', 'onchange', (e) => { settings.streamResponses = e.target.checked; saveSettings(); });
  on('#themeSelect', 'onchange', (e) => { applyTheme(e.target.value); saveSettings(); });

  // Clear history
  onClick('#clearHistoryBtn', async () => {
    if (confirm('Clear all history? This cannot be undone.')) {
      history = await clearHistory();
      renderHistoryPage();
      renderHistorySidebar();
      renderHomeRecent();
      showToast('History cleared');
    }
  });

  // Create space
  onClick('#createSpaceBtn', async () => {
    const name = prompt('Space name:');
    if (!name) return;
    const instructions = prompt('Custom AI instructions (optional):') || '';
    const space = await createSpace(name, instructions, settings.nsfw);
    spaces = await loadSpaces();
    renderSpacesPage();
    renderSpacesSidebar();
    showToast('Space created');
  });

  // Mobile sidebar toggle
  onClick('#menuToggle', () => $('#sidebar')?.classList.toggle('mobile-open'));
  onClick('#sidebarOverlay', () => $('#sidebar')?.classList.remove('mobile-open'));

  // Auto-resize thread input
  const threadInput = $('#threadInput');
  if (threadInput) {
    threadInput.addEventListener('input', debounce(() => {
      threadInput.style.height = 'auto';
      threadInput.style.height = Math.min(threadInput.scrollHeight, 200) + 'px';
    }, 100));
  }
}

function saveSettings() {
  localStorage.setItem('surgexity_settings', JSON.stringify(settings));
}

// Export for inline handlers
window.surgexityApp = { startNewThread, openThread, showView, showToast };

// PWA install
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $('#pwaInstallBtn');
  if (btn) { btn.hidden = false; btn.onclick = async () => { deferredPrompt.prompt(); await deferredPrompt.userChoice; btn.hidden = true; }; }
});
