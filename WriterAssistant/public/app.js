'use strict';

// ── State ──────────────────────────────────────────────────────────────
let sessionId = localStorage.getItem('wa_session_id');
let currentPhase = 'OVERVIEW';
let isStreaming = false;
let pendingTransition = null;
let pdfReady = false;

const PHASE_ORDER = ['OVERVIEW', 'CHARACTER_DEEP_DIVE', 'STORY_STRUCTURE', 'SCENE_BREAKDOWN', 'OPEN_EDITING'];

// ── DOM refs ────────────────────────────────────────────────────────────
const screenWelcome   = document.getElementById('screen-welcome');
const screenChat      = document.getElementById('screen-chat');
const chatMessages    = document.getElementById('chat-messages');
const chatInput       = document.getElementById('chat-input');
const btnSend         = document.getElementById('btn-send');
const btnStart        = document.getElementById('btn-start');
const btnPdf          = document.getElementById('btn-pdf');
const btnNewStory     = document.getElementById('btn-new-story');
const transitionCard  = document.getElementById('transition-card');
const transitionMsg   = document.getElementById('transition-message');
const btnTransConfirm = document.getElementById('btn-transition-confirm');
const btnTransCancel  = document.getElementById('btn-transition-cancel');

// ── Init ────────────────────────────────────────────────────────────────
(async function init() {
  if (sessionId) {
    try {
      const state = await apiFetch(`/api/state/${sessionId}`);
      currentPhase = state.phase;
      pdfReady = state.pdfReady;
      pendingTransition = state.pendingTransition;
      showChatScreen();
      updatePhaseBar(currentPhase);
      if (pdfReady) btnPdf.classList.remove('hidden');
      if (pendingTransition) showTransitionCard(pendingTransition);
    } catch (_) {
      // Session expired or not found — start fresh
      sessionId = null;
      localStorage.removeItem('wa_session_id');
    }
  }
})();

// ── Welcome screen ──────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting…';
  try {
    const data = await apiFetch('/api/session', 'POST', {});
    sessionId = data.sessionId;
    localStorage.setItem('wa_session_id', sessionId);
    showChatScreen();
    updatePhaseBar('OVERVIEW');
    // Kick off the first AI message
    await sendMessage('__init__', true);
  } catch (err) {
    btnStart.disabled = false;
    btnStart.textContent = 'Start Writing';
    showToast('Could not connect to server. Is it running?');
  }
});

// ── Chat screen ─────────────────────────────────────────────────────────
function showChatScreen() {
  screenWelcome.classList.add('hidden');
  screenWelcome.classList.remove('active');
  screenChat.classList.remove('hidden');
  screenChat.classList.add('active');
}

// ── Send message ────────────────────────────────────────────────────────
async function sendMessage(text, isInit = false) {
  if (isStreaming) return;

  const message = isInit ? 'Hello! I am ready to start.' : text.trim();
  if (!message) return;

  if (!isInit) {
    appendMessage('user', text.trim());
    chatInput.value = '';
    autoResizeInput();
  }

  setStreaming(true);

  const loadingEl = appendLoadingMessage();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let assistantEl = null;
    let assistantText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let evt;
        try { evt = JSON.parse(raw); } catch (_) { continue; }

        if (evt.type === 'chunk') {
          if (!assistantEl) {
            loadingEl.remove();
            assistantEl = appendMessage('assistant', '');
          }
          assistantText += evt.text;
          setMessageText(assistantEl, assistantText, true);

        } else if (evt.type === 'phase_signal') {
          pendingTransition = { phase: evt.nextPhase, characterIndex: evt.characterIndex };
          const charName = evt.nextCharacterName;
          showTransitionCard(pendingTransition, evt.currentPhase, charName);

        } else if (evt.type === 'done') {
          if (assistantEl) setMessageText(assistantEl, assistantText, false);

        } else if (evt.type === 'error') {
          if (!assistantEl) loadingEl.remove();
          appendMessage('assistant', evt.message);
        }
      }
    }

    // Finalize any remaining text
    if (assistantEl) setMessageText(assistantEl, assistantText, false);

  } catch (err) {
    loadingEl.remove();
    appendMessage('assistant', 'Sorry, something went wrong. Please try again.');
    console.error(err);
  }

  setStreaming(false);
  scrollToBottom();
}

// ── Input handlers ──────────────────────────────────────────────────────
btnSend.addEventListener('click', () => sendMessage(chatInput.value));

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

chatInput.addEventListener('input', autoResizeInput);

function autoResizeInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
}

// ── Phase transition ────────────────────────────────────────────────────
function showTransitionCard(transition, fromPhase, charName) {
  let msg = '';
  if (transition.phase === 'CHARACTER_DEEP_DIVE' && transition.characterIndex !== null && charName) {
    msg = `Ready to move on to developing <strong>${charName}</strong>?`;
  } else if (transition.phase === 'CHARACTER_DEEP_DIVE') {
    msg = `Ready to start developing your characters?`;
  } else if (transition.phase === 'STORY_STRUCTURE') {
    msg = `Characters are well-developed. Ready to build your Three-Act structure?`;
  } else if (transition.phase === 'SCENE_BREAKDOWN') {
    msg = `Story structure is solid. Ready to map out your scenes and chapters?`;
  } else if (transition.phase === 'OPEN_EDITING') {
    msg = `Scene breakdown is complete. Ready to enter the refinement phase?`;
  } else {
    msg = `Ready to move to the next phase?`;
  }
  transitionMsg.innerHTML = msg;
  transitionCard.classList.remove('hidden');
}

btnTransConfirm.addEventListener('click', async () => {
  transitionCard.classList.add('hidden');
  if (!pendingTransition) return;

  try {
    const result = await apiFetch(`/api/transition/${sessionId}`, 'POST', { confirm: true });
    currentPhase = result.newPhase;
    pdfReady = result.pdfReady;
    pendingTransition = null;

    updatePhaseBar(currentPhase);
    if (pdfReady) btnPdf.classList.remove('hidden');

    // Send a transition kickoff message to the AI
    await sendMessage('__transition__', true);
  } catch (err) {
    showToast('Could not advance phase. Please try again.');
  }
});

btnTransCancel.addEventListener('click', async () => {
  transitionCard.classList.add('hidden');
  pendingTransition = null;
  await apiFetch(`/api/transition/${sessionId}`, 'POST', { confirm: false });
});

// ── PDF download ────────────────────────────────────────────────────────
btnPdf.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = `/api/pdf/${sessionId}`;
  a.download = 'story-structure.pdf';
  a.click();
  showToast('Generating your PDF…');
});

// ── New story ───────────────────────────────────────────────────────────
btnNewStory.addEventListener('click', () => {
  if (!confirm('Start a new story? Your current session will be lost.')) return;
  localStorage.removeItem('wa_session_id');
  window.location.reload();
});

// ── Phase bar ───────────────────────────────────────────────────────────
function updatePhaseBar(phase) {
  const steps = document.querySelectorAll('.phase-step');
  const connectors = document.querySelectorAll('.phase-connector');
  const activeIdx = PHASE_ORDER.indexOf(phase);

  steps.forEach((step, i) => {
    step.classList.remove('active', 'done');
    if (i < activeIdx) step.classList.add('done');
    else if (i === activeIdx) step.classList.add('active');
  });

  connectors.forEach((conn, i) => {
    conn.classList.toggle('done', i < activeIdx);
  });
}

// ── Message rendering ───────────────────────────────────────────────────
function appendMessage(role, text) {
  const el = document.createElement('div');
  el.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'You' : 'W';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (text) {
    bubble.textContent = text;
  }

  el.appendChild(avatar);
  el.appendChild(bubble);
  chatMessages.appendChild(el);
  scrollToBottom();
  return el;
}

function setMessageText(el, text, showCursor) {
  const bubble = el.querySelector('.message-bubble');
  bubble.textContent = text;
  // Remove any existing cursor
  const cursor = bubble.querySelector('.typing-cursor');
  if (cursor) cursor.remove();
  if (showCursor) {
    const c = document.createElement('span');
    c.className = 'typing-cursor';
    bubble.appendChild(c);
  }
  scrollToBottom();
}

function appendLoadingMessage() {
  const el = document.createElement('div');
  el.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = 'W';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';

  el.appendChild(avatar);
  el.appendChild(bubble);
  chatMessages.appendChild(el);
  scrollToBottom();
  return el;
}

// ── Helpers ─────────────────────────────────────────────────────────────
function setStreaming(val) {
  isStreaming = val;
  btnSend.disabled = val;
  chatInput.disabled = val;
  if (!val) chatInput.focus();
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function apiFetch(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

let toastTimer;
function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
