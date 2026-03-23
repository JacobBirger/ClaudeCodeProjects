/**
 * One-time setup script for BG Remover extension.
 * Run: node setup.js
 *
 * What it does:
 *  1. Bundles @imgly/background-removal + onnxruntime-web into vendor/background-removal.bundle.js
 *  2. Generates extension icons (icons/icon16.png, icon48.png, icon128.png)
 */

const { build } = require('esbuild');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;

// ─── Step 1: Bundle the background-removal library ───────────────────────────

async function bundleLibrary() {
  const outDir = path.join(ROOT, 'vendor');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Bundling @imgly/background-removal...');

  await build({
    entryPoints: [path.join(ROOT, 'bg-removal-entry.js')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outfile: path.join(outDir, 'background-removal.bundle.js'),
    // WASM binaries are fetched from staticimgly.com CDN at runtime — mark as external
    external: ['*.wasm'],
    // Force single-threaded WASM: Chrome MV3 CSP blocks blob: URL workers,
    // which onnxruntime-web creates when numThreads > 1.
    // Replacing hardwareConcurrency with 1 makes maxNumThreads() return 1,
    // so onnxruntime-web uses single-threaded mode and creates no workers.
    define: {
      'navigator.hardwareConcurrency': '1',
    },
    // Silence warnings about Node.js built-ins used by dependencies
    logLevel: 'warning',
    // Minify for a smaller extension
    minify: true,
  });

  console.log('  -> vendor/background-removal.bundle.js');
}

// ─── Step 2: Generate PNG icons ──────────────────────────────────────────────
// Creates simple solid-color PNG files using Node.js built-ins only (no canvas required).

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.allocUnsafe(4);
  crcVal.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function createSolidPNG(size, r, g, b) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit-depth=8, colorType=2 (RGB), compress=0, filter=0, interlace=0
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw image data: filter byte (0x00) + RGB pixels per row
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    const base = y * rowLen;
    raw[base] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const px = base + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function generateIcons() {
  const iconDir = path.join(ROOT, 'icons');
  fs.mkdirSync(iconDir, { recursive: true });

  // Purple brand color: #6c63ff → (108, 99, 255)
  const sizes = [16, 48, 128];
  for (const size of sizes) {
    const png = createSolidPNG(size, 108, 99, 255);
    const outPath = path.join(iconDir, `icon${size}.png`);
    fs.writeFileSync(outPath, png);
    console.log(`  -> icons/icon${size}.png`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await bundleLibrary();
    console.log('\nGenerating icons...');
    generateIcons();
    console.log('\nSetup complete! Load the extension:');
    console.log('  Chrome: chrome://extensions -> Developer Mode -> Load Unpacked');
    console.log('  Select this folder: ' + ROOT);
  } catch (err) {
    console.error('\nSetup failed:', err.message || err);
    process.exit(1);
  }
}

main();
