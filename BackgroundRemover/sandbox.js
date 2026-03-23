// Sandboxed page worker — runs inside sandbox.html embedded as an iframe in the popup.
// onnxruntime-web's blob: dynamic imports are allowed in sandbox pages.

import { removeBackground } from './vendor/background-removal.bundle.js';

// Tell the popup we're ready
window.parent.postMessage({ type: 'sandbox-ready' }, '*');

window.addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'process') return;

  const { id, buffer, mimeType } = e.data;

  try {
    const file = new File([buffer], 'image', { type: mimeType || 'image/png' });
    const resultBlob = await removeBackground(file);
    const resultBuffer = await resultBlob.arrayBuffer();

    // Transfer the ArrayBuffer back zero-copy
    window.parent.postMessage(
      { type: 'result', id, buffer: resultBuffer },
      '*',
      [resultBuffer]
    );
  } catch (err) {
    window.parent.postMessage(
      { type: 'error', id, message: err?.message ?? String(err), stack: err?.stack ?? '' },
      '*'
    );
  }
});
