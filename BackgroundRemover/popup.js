// popup.js — Extension popup UI.
// The AI inference runs in sandbox.html (loaded in a hidden iframe) because
// onnxruntime-web requires blob: dynamic imports, which Chrome MV3 blocks on
// normal extension pages but allows in sandboxed pages.

const dropZone      = document.getElementById('drop-zone');
const sandboxFrame  = document.getElementById('sandbox-frame');
const pasteTarget   = document.getElementById('paste-target');
const statusEl      = document.getElementById('status');
const spinnerEl     = document.getElementById('spinner');
const spinnerText   = document.getElementById('spinner-text');
const previewSection= document.getElementById('preview-section');
const imgBefore     = document.getElementById('img-before');
const imgAfter      = document.getElementById('img-after');
const btnDownload   = document.getElementById('btn-download');
const btnReset      = document.getElementById('btn-reset');

let resultUrl   = null;
let beforeUrl   = null;
let sandboxReady= false;
let pendingFile = null;   // file queued before sandbox was ready
let requestId   = 0;
let activeId    = null;   // id of the in-flight request

// Focus hidden textarea immediately so Ctrl+V works without clicking first
pasteTarget.focus();

// ── Sandbox communication ─────────────────────────────────────────────────────

window.addEventListener('message', (e) => {
  // Only accept messages from our sandbox iframe
  if (e.source !== sandboxFrame.contentWindow) return;

  const { type, id, buffer, message, stack } = e.data ?? {};

  if (type === 'sandbox-ready') {
    sandboxReady = true;
    if (pendingFile) {
      const f = pendingFile;
      pendingFile = null;
      handleImage(f);
    }
    return;
  }

  if (id !== activeId) return; // stale response

  if (type === 'result') {
    const blob = new Blob([buffer], { type: 'image/png' });
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    imgAfter.src = resultUrl;
    hideSpinner();
    previewSection.hidden = false;
    return;
  }

  if (type === 'error') {
    hideSpinner();
    dropZone.hidden = false;
    showStatus(`Error: ${message}${stack ? '\n\n' + stack : ''}`, 'error');
  }
});

function sendToSandbox(file) {
  return file.arrayBuffer().then((buffer) => {
    activeId = ++requestId;
    sandboxFrame.contentWindow.postMessage(
      { type: 'process', id: activeId, buffer, mimeType: file.type },
      '*',
      [buffer]   // transfer zero-copy
    );
  });
}

// ── Image handling ────────────────────────────────────────────────────────────

async function handleImage(file) {
  if (!sandboxReady) {
    pendingFile = file;
    showSpinner('Loading AI engine... (first use downloads ~50 MB model)');
    dropZone.hidden = true;
    return;
  }

  revokeUrls();
  beforeUrl = URL.createObjectURL(file);
  imgBefore.src = beforeUrl;

  dropZone.hidden = true;
  previewSection.hidden = true;
  hideStatus();
  showSpinner('Removing background... (first use downloads ~50 MB model)');

  try {
    await sendToSandbox(file);
    // Result arrives via the 'message' event handler above
  } catch (err) {
    hideSpinner();
    dropZone.hidden = false;
    showStatus(`Error preparing image: ${err?.message ?? err}`, 'error');
  }
}

// ── Paste & drag-drop ─────────────────────────────────────────────────────────

function handlePasteEvent(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      handleImage(item.getAsFile());
      return;
    }
  }
}

pasteTarget.addEventListener('paste', handlePasteEvent);
document.addEventListener('paste', handlePasteEvent);

// Re-focus paste target after any click so Ctrl+V keeps working
document.addEventListener('click', (e) => {
  if (e.target === btnDownload || e.target === btnReset) return;
  pasteTarget.focus();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file?.type.startsWith('image/')) handleImage(file);
});

dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    showStatus('Press Ctrl+V to paste an image from your clipboard.', 'info');
  }
});

// ── Buttons ───────────────────────────────────────────────────────────────────

btnDownload.addEventListener('click', () => {
  if (!resultUrl) return;
  const a = document.createElement('a');
  a.href = resultUrl;
  a.download = 'background-removed.png';
  a.click();
});

btnReset.addEventListener('click', () => {
  previewSection.hidden = true;
  dropZone.hidden = false;
  hideStatus();
  revokeUrls();
  pasteTarget.focus();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function showSpinner(text) {
  spinnerText.textContent = text;
  spinnerEl.hidden = false;
}
function hideSpinner() { spinnerEl.hidden = true; }

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.dataset.type = type;
  statusEl.hidden = false;
}
function hideStatus() { statusEl.hidden = true; }

function revokeUrls() {
  if (beforeUrl) { URL.revokeObjectURL(beforeUrl); beforeUrl = null; }
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
}
