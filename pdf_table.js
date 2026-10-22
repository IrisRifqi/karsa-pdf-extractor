'use strict';
/**
 * pdf_table.js -- coordinate-aware table extractor for lab-report PDFs.
 *
 * Node port of tools/pdf_table.py using pdfjs-dist, keeping the same output
 * contract so the n8n workflow only needs its extractorUrl changed:
 *
 *   { "kolam": ["A8","B2",...], "page": 2,
 *     "rows": [ {"label":"Chlorella","values":[240000,null,...]}, ... ] }
 *
 * Why it exists: n8n's "Extract from File" (pdf-parse) joins every text item on a
 * shared baseline with no separator and reorders items by the PDF content stream, so
 * a table row comes out as glued digits and the row labels land in a separate block.
 * PDF.js exposes the same items with their x/y, so a row's label and its per-column
 * values stay together and blank cells are explicit nulls.
 *
 * Usage:  node pdf_table.js <file.pdf> [--out path] [--debug]
 */

const fs = require('fs');

// pdfjs-dist v4 ships ESM only, so it is loaded with a dynamic import from this
// CommonJS file. The legacy build is the one that runs without a browser/worker.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const CODE_RE = /^[A-Za-z]{1,3}\d{1,3}[A-Za-z]?$/;
const ROW_TOL = 3.0; // pt: words within this vertical distance are one row
const COL_TOL_RATIO = 0.45; // fraction of column pitch counted as "belongs to this column"

/**
 * '78,57' -> 78.57 | '110.000' -> 110000 | '100000' -> 100000 | else null
 * Thousands first: these reports write 110.000 for one hundred ten thousand and use
 * a comma for decimals, so a dot-grouped number must not fall through as 110.
 */
function toNum(tok) {
  if (tok === null || tok === undefined) return null;
  let t = String(tok).trim();
  if (!t) return null;
  t = t.replace(/%/g, '').trim();
  if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) return parseFloat(t.replace(/\./g, ''));
  if (/^-?\d+,\d+$/.test(t)) return parseFloat(t.replace(',', '.'));
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return null;
}

/** Group words into visual rows by their top coordinate. */
function clusterRows(words, tol = ROW_TOL) {
  if (!words.length) return [];
  const sorted = words.slice().sort((a, b) => (a.top - b.top) || (a.x0 - b.x0));
  const rows = [];
  let cur = [sorted[0]];
  let curTop = sorted[0].top;
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    if (Math.abs(w.top - curTop) <= tol) cur.push(w);
    else { rows.push(cur); cur = [w]; curTop = w.top; }
  }
  rows.push(cur);
  return rows.map((r) => r.slice().sort((a, b) => a.x0 - b.x0));
}

/** The column header row: every token is a short sample code (F1..F7, A1.., etc.). */
function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const toks = rows[i].map((w) => w.text);
    if (toks.length >= 2 && toks.every((t) => CODE_RE.test(t))) return { index: i, row: rows[i] };
  }
  return { index: -1, row: null };
}

/** Open the PDF and return, per page, the text items placed in top-left coordinates. */
async function pageWords(pdfjs, pdfBytes) {
  const doc = await pdfjs.getDocument({
    data: pdfBytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const words = [];
    for (const item of tc.items) {
      const s = String(item.str == null ? '' : item.str);
      if (!s.trim()) continue;
      // viewport.transform flips y, giving a distance from the top of the page --
      // the same frame pdfplumber's `top` uses.
      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      const x0 = tx[4];
      const top = tx[5];
      const w = (item.width || 0) * viewport.scale;
      words.push({ text: s.trim(), raw: s, x0, x1: x0 + w, top });
    }
    pages.push({ page: p, words, text: tc.items.map((i) => i.str).join(' ') });
  }
  return pages;
}

/**
 * @param {Buffer|Uint8Array|string} input  PDF bytes, or a path to a PDF.
 * @returns {Promise<{kolam?:string[], page?:number, rows?:object[], error?:string}>}
 */
async function extract(input, opts = {}) {
  const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array
    ? new Uint8Array(input.buffer ? input : input)
    : new Uint8Array(fs.readFileSync(String(input)));

  const pdfjs = await loadPdfjs();
  const pages = await pageWords(pdfjs, bytes);

  // Locate the plankton table by content, never by page index.
  const target = pages.find((pg) => {
    const up = pg.text.toUpperCase();
    return up.includes('PLANKTON') && up.includes('JENIS');
  });
  if (!target) return { error: 'no plankton table found', kolam: [], rows: [] };

  const rows = clusterRows(target.words, ROW_TOL);
  const { index: hidx, row: header } = findHeader(rows);
  if (hidx < 0) return { error: 'no sample-code header row found', kolam: [], rows: [] };

  const kolam = header.map((w) => w.text);
  const centers = header.map((w) => (w.x0 + w.x1) / 2);
  const pitch = centers.length > 1 ? (centers[centers.length - 1] - centers[0]) / (centers.length - 1) : 0;
  const colTol = pitch * COL_TOL_RATIO;

  const outRows = [];
  let detailStarted = false;
  for (let r = hidx + 1; r < rows.length; r++) {
    const cells = new Array(kolam.length).fill(null);
    const labelParts = [];
    for (const w of rows[r]) {
      const cx = (w.x0 + w.x1) / 2;
      let placed = false;
      if (pitch > 0) {
        for (let ci = 0; ci < centers.length; ci++) {
          if (Math.abs(cx - centers[ci]) <= colTol) {
            cells[ci] = cells[ci] !== null ? (cells[ci] + ' ' + w.text).trim() : w.text;
            placed = true;
            break;
          }
        }
      }
      if (!placed) labelParts.push(w.text);
    }
    const label = labelParts.join(' ').trim();
    const vals = cells.map(toNum);
    if (!label && vals.every((v) => v === null)) continue;
    // the detail table is closed by its own repeated "Total Plankton" footer;
    // everything past it is signature/letterhead, not table data
    if (detailStarted && /^Total\s+Plankton$/i.test(label)) break;
    // the footer repeats the total values on an unlabelled line just above that
    // marker -- drop it so the grand total is not emitted twice
    if (detailStarted && !label && vals.some((v) => v !== null)) break;
    if (/^\d+\.\s/.test(label)) detailStarted = true;
    if (opts.debug) process.stderr.write(label.padEnd(34) + ' | ' + JSON.stringify(vals) + '\n');
    outRows.push({ label, values: vals });
  }

  return { kolam, page: target.page, rows: outRows };
}

async function main() {
  const argv = process.argv.slice(2);
  let outPath = null;
  const i = argv.indexOf('--out');
  if (i >= 0) { outPath = argv[i + 1]; argv.splice(i, 2); }
  const args = argv.filter((a) => !a.startsWith('--'));
  if (!args.length) { process.stderr.write('usage: node pdf_table.js <file.pdf> [--out path] [--debug]\n'); process.exit(2); }

  const res = await extract(args[0], { debug: argv.includes('--debug') });
  const payload = JSON.stringify(res) + '\n';
  if (outPath) fs.writeFileSync(outPath, payload, 'utf8');
  else process.stdout.write(payload);
  process.exit(res.error ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1); });
}

module.exports = { extract, toNum, clusterRows, findHeader, pageWords, loadPdfjs };
