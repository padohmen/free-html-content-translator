/**
 * Unit-test voor de batcher (standalone, geen DeepL).
 * - Splits lange stukken in ≤ MAX_CHARS
 * - Bouwd batches waar de som ≤ MAX_CHARS
 * - Reconstrueert per origineel item en vergelijkt met input (identiteits-"vertaling")
 */

const assert = require("assert/strict");

// Gebruik dezelfde limiet als je server (of override via env)
const MAX_CHARS = parseInt(process.env.RATE_MAX_CHARS || "50000", 10);

// ---------- helpers (gelijk aan server.cjs) ----------
// VERVANG je huidige splitStringBySize door deze:
function splitStringBySize(str, maxLen) {
  const s = String(str ?? "");
  if (s.length <= maxLen) return [s];

  const parts = [];
  let i = 0;

  while (i < s.length) {
    const remain = s.length - i;
    if (remain <= maxLen) { parts.push(s.slice(i)); break; }

    const slice = s.slice(i, i + maxLen);

    // Zoek laatste prettige break in dit slice
    const candidates = [
      { idx: slice.lastIndexOf(". "), len: 2 },
      { idx: slice.lastIndexOf("! "), len: 2 },
      { idx: slice.lastIndexOf("? "), len: 2 },
      { idx: slice.lastIndexOf("\n"), len: 1 },
      { idx: slice.lastIndexOf(" "),  len: 1 },
    ];
    let best = { idx: -1, len: 0 };
    for (const c of candidates) if (c.idx > best.idx) best = c;

    // Neem de delimiter MEE in het eerste deel, zodat concat exact origineel oplevert
    const cutEnd = best.idx >= 0 ? best.idx + best.len : slice.length;

    parts.push(slice.slice(0, cutEnd)); // geen trim!
    i += cutEnd;
  }

  return parts;
}

function buildBatches(items, maxChars) {
  const batches = [];
  let cur = [], count = 0;
  for (const it of items) {
    const len = it.text.length;
    if (cur.length && count + len > maxChars) {
      batches.push(cur);
      cur = [it];
      count = len;
    } else {
      cur.push(it);
      count += len;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---------- test utilities ----------
function randText(len, charset = "abcdefghijklmnopqrstuvwxyz ") {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += charset[(Math.random() * charset.length) | 0];
  }
  return out;
}

function runCase(name, texts) {
  // 1) split per item (zoals server.cjs)
  const items = [];
  texts.forEach((t, idx) => {
    const s = String(t ?? "");
    if (s.length === 0) return; // lege input levert lege output
    const parts = s.length > MAX_CHARS ? splitStringBySize(s, MAX_CHARS) : [s];
    parts.forEach((p) => items.push({ idx, text: p }));
  });

  // 2) bouw batches (sum ≤ MAX_CHARS)
  const batches = buildBatches(items, MAX_CHARS);

  // assert: elke batch voldoet aan limiet
  for (const b of batches) {
    const sum = b.reduce((acc, it) => acc + it.text.length, 0);
    assert.ok(
      sum <= MAX_CHARS,
      `${name}: batch length ${sum} exceeds MAX_CHARS=${MAX_CHARS}`
    );
  }

  // 3) "Vertaal": identiteitsfunctie (dummy), maar behoudt boundaries
  const piecesByIdx = new Map();
  for (const batch of batches) {
    // identiteits-output 1:1 met input (zoals DeepL zou teruggeven)
    const out = batch.map((it) => it.text);
    for (let i = 0; i < batch.length; i++) {
      const idx = batch[i].idx;
      const tr = out[i];
      if (!piecesByIdx.has(idx)) piecesByIdx.set(idx, []);
      piecesByIdx.get(idx).push(tr);
    }
  }

  // 4) reconstruct → moet exact gelijk zijn aan input
  const rebuilt = texts.map((s, idx) => (piecesByIdx.get(idx) || []).join(""));
  assert.deepEqual(rebuilt, texts, `${name}: reconstructed text mismatch`);

  console.log(`✔ ${name} — batches=${batches.length}, items=${items.length}`);
}

(function main() {
  console.log(`MAX_CHARS=${MAX_CHARS}`);

  // Case 1: één korte string
  runCase("short_single", ["hello world"]);

  // Case 2: één lange string > 2× MAX_CHARS (forceer meerdere splits)
  const long2x = randText(MAX_CHARS + Math.floor(MAX_CHARS * 1.2), "abcde .?\n");
  runCase("one_big_>2x", [long2x]);

  // Case 3: meerdere items die samen >> MAX_CHARS
  const t1 = randText(Math.floor(MAX_CHARS * 0.7), "lorem ipsum .?\n");
  const t2 = randText(Math.floor(MAX_CHARS * 0.6), "dolor sit amet .?\n");
  const t3 = randText(Math.floor(MAX_CHARS * 0.9), "consectetur adipiscing .?\n");
  runCase("multi_sum_>>max", [t1, t2, t3]);

  // Case 4: randgevallen — lege strings en unicode met accenten/nieuwe regels
  runCase("empties_and_unicode", [
    "",
    "Línea con acentos: áéíóú ñ ç — fin.\nY otra línea.",
    "Français: Voilà! Ça va? Très bien...",
    ""
  ]);

  // Case 5: doorlopende tekst zonder spaties (hard-cuts)
  const noSpaces = "x".repeat(MAX_CHARS + Math.floor(MAX_CHARS * 0.3));
  runCase("no_spaces_hardcuts", [noSpaces]);

  console.log("All tests passed.");
})();
