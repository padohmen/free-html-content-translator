// proxy/server.cjs
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.set('trust proxy', true);
app.use(bodyParser.json({ limit: '1mb' }));
app.use(cors({ origin: true }));

// --------- Config / ENV ---------
const PORT = process.env.PORT || 8787;

// Sanitize key & endpoint
const rawKey = process.env.DEEPL_KEY || '';
const DEEPL_KEY = rawKey.trim().replace(/^['"]+|['"]+$/g, '');
const isFreeKey = /:fx$/i.test(DEEPL_KEY);
const API_URL = (process.env.DEEPL_API_URL || (isFreeKey
  ? 'https://api-free.deepl.com/v2/translate'
  : 'https://api.deepl.com/v2/translate')).trim();

// Limits
const RATE_MAX_CHARS = parseInt(process.env.RATE_MAX_CHARS || '50000', 10);      // per DeepL call
const RATE_COOLDOWN_MS = parseInt(process.env.RATE_COOLDOWN_MS || '5000', 10);   // per IP
const RATE_COOLDOWN_GLOBAL_MS = parseInt(process.env.RATE_COOLDOWN_GLOBAL_MS || '0', 10);
const BATCH_INTER_DELAY_MS = parseInt(process.env.BATCH_INTER_DELAY_MS || '0', 10);
const RATE_MAX_TOTAL_CHARS = parseInt(process.env.RATE_MAX_TOTAL_CHARS || '0', 10); // 0 = off
const ENABLE_METRICS = /^(1|true|yes)$/i.test(process.env.ENABLE_METRICS || '');


// --------- Metrics (simpel & in-memory) ---------
const metrics = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  totalDeepLCalls: 0,
  http2xx: 0,
  http4xx: 0,
  http5xx: 0,
  http429: 0,
  perIp: new Map(), // ip -> { count, lastAt, lastStatus, statusCounts:{}, lastChars }
};
function note(ip, status, deepLCalls, totalChars) {
  metrics.totalRequests += 1;
  metrics.totalDeepLCalls += deepLCalls;
  if (status >= 500) metrics.http5xx += 1;
  else if (status === 429) metrics.http429 += 1, metrics.http4xx += 1;
  else if (status >= 400) metrics.http4xx += 1;
  else metrics.http2xx += 1;

  const rec = metrics.perIp.get(ip) || { count: 0, lastAt: null, lastStatus: null, statusCounts: {}, lastChars: 0 };
  rec.count += 1;
  rec.lastAt = new Date().toISOString();
  rec.lastStatus = status;
  rec.lastChars = totalChars;
  rec.statusCounts[status] = (rec.statusCounts[status] || 0) + 1;
  metrics.perIp.set(ip, rec);
}
function ipSummary() {
  const out = {};
  for (const [ip, r] of metrics.perIp.entries()) out[ip] = r;
  return out;
}

// --------- Rate limiting state ---------
const lastHitByIp = new Map();
let lastGlobalHit = 0;
setInterval(() => {
  const now = Date.now();
  for (const [ip, t] of lastHitByIp.entries()) {
    if (now - t > Math.max(RATE_COOLDOWN_MS, 60_000)) lastHitByIp.delete(ip);
  }
}, 60_000).unref();

// --------- Helpers ----------
function clientIp(req) {
  return (req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').toString();
}
function totalChars(arr) {
  try { return arr.reduce((s, v) => s + String(v ?? '').length, 0); } catch { return Infinity; }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// split preserving delimiters so join == original
function splitStringBySize(str, maxLen) {
  const s = String(str ?? "");
  if (s.length <= maxLen) return [s];

  const parts = [];
  let i = 0;

  while (i < s.length) {
    const remain = s.length - i;
    if (remain <= maxLen) { parts.push(s.slice(i)); break; }

    const slice = s.slice(i, i + maxLen);

    const candidates = [
      { idx: slice.lastIndexOf(". "), len: 2 },
      { idx: slice.lastIndexOf("! "), len: 2 },
      { idx: slice.lastIndexOf("? "), len: 2 },
      { idx: slice.lastIndexOf("\n"), len: 1 },
      { idx: slice.lastIndexOf(" "),  len: 1 },
    ];
    let best = { idx: -1, len: 0 };
    for (const c of candidates) if (c.idx > best.idx) best = c;

    const cutEnd = best.idx >= 0 ? best.idx + best.len : slice.length;
    parts.push(slice.slice(0, cutEnd));
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

// ---------- Middlewares ----------
function enforceCooldown(req, res, next) {
  const now = Date.now();
  const ip = clientIp(req);

  const last = lastHitByIp.get(ip) || 0;
  const remain = RATE_COOLDOWN_MS - (now - last);
  if (remain > 0) {
    const secs = Math.ceil(remain / 1000);
    res.set('Retry-After', String(secs));
    note(ip, 429, 0, 0);
    return res.status(429).json({ error: `Too many requests. Cooldown ${secs}s.` });
  }

  if (RATE_COOLDOWN_GLOBAL_MS > 0) {
    const remainG = RATE_COOLDOWN_GLOBAL_MS - (now - lastGlobalHit);
    if (remainG > 0) {
      const secs = Math.ceil(remainG / 1000);
      res.set('Retry-After', String(secs));
      note(ip, 429, 0, 0);
      return res.status(429).json({ error: `Service cooldown ${secs}s.` });
    }
  }

  lastHitByIp.set(ip, now);
  if (RATE_COOLDOWN_GLOBAL_MS > 0) lastGlobalHit = now;
  next();
}

// ---------- Routes ----------

if (ENABLE_METRICS) {
	app.get('/metrics', (req, res) => {
	  res.json({
		startedAt: metrics.startedAt,
		totalRequests: metrics.totalRequests,
		totalDeepLCalls: metrics.totalDeepLCalls,
		http2xx: metrics.http2xx,
		http4xx: metrics.http4xx,
		http5xx: metrics.http5xx,
		http429: metrics.http429,
		perIp: ipSummary(),
		rate: {
		  perCallMaxChars: RATE_MAX_CHARS,
		  cooldownPerIpMs: RATE_COOLDOWN_MS,
		  cooldownGlobalMs: RATE_COOLDOWN_GLOBAL_MS,
		  batchInterDelayMs: BATCH_INTER_DELAY_MS,
		  maxTotalChars: RATE_MAX_TOTAL_CHARS
		}
	  });
	});
}
app.get('/health', (req, res) => res.json({ ok: true }));


app.post('/translate', enforceCooldown, async (req, res) => {
  const ip = clientIp(req);
  const started = Date.now();

  try {
    const { texts, targetLang } = req.body || {};
    if (!Array.isArray(texts) || texts.length === 0) {
      note(ip, 400, 0, 0);
      return res.status(400).json({ error: 'texts must be a non-empty array' });
    }
    if (!targetLang) {
      note(ip, 400, 0, 0);
      return res.status(400).json({ error: 'targetLang is required' });
    }
    if (!DEEPL_KEY) {
      note(ip, 500, 0, 0);
      return res.status(500).json({ error: 'DEEPL_KEY is not set on server' });
    }
    const totalIn = totalChars(texts);
    if (RATE_MAX_TOTAL_CHARS > 0 && totalIn > RATE_MAX_TOTAL_CHARS) {
      note(ip, 413, 0, totalIn);
      return res.status(413).json({ error: 'Total input too large', limit: RATE_MAX_TOTAL_CHARS });
    }

    // 1) split per item indien nodig
    const items = [];
    texts.forEach((t, idx) => {
      const s = String(t ?? '');
      if (s.length === 0) return;
      const parts = s.length > RATE_MAX_CHARS ? splitStringBySize(s, RATE_MAX_CHARS) : [s];
      parts.forEach(p => items.push({ idx, text: p }));
    });

    // 2) batches
    const batches = buildBatches(items, RATE_MAX_CHARS);

    // 3) sequence naar DeepL
    const piecesByIdx = new Map();
    let deepLCalls = 0;

    for (const batch of batches) {
      deepLCalls++;
      const params = new URLSearchParams();
      batch.forEach(it => params.append('text', it.text));
      params.append('target_lang', String(targetLang).toUpperCase());

      const resp = await axios.post(API_URL, params.toString(), {
        headers: {
          Authorization: `DeepL-Auth-Key ${DEEPL_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
      });

      const out = Array.isArray(resp.data?.translations) ? resp.data.translations : [];
      if (out.length !== batch.length) {
        note(ip, 502, deepLCalls, totalIn);
        return res.status(502).json({ error: 'translation count mismatch in batch' });
      }

      for (let i = 0; i < batch.length; i++) {
        const idx = batch[i].idx;
        const tr = out[i]?.text ?? '';
        if (!piecesByIdx.has(idx)) piecesByIdx.set(idx, []);
        piecesByIdx.get(idx).push(tr);
      }

      if (BATCH_INTER_DELAY_MS > 0) await delay(BATCH_INTER_DELAY_MS);
    }

    // 4) reconstruct
    const translations = texts.map((s, idx) => {
      const pieces = piecesByIdx.get(idx);
      if (!pieces || pieces.length === 0) return '';
      return pieces.join('');
    });

    note(ip, 200, deepLCalls, totalIn);
    const ms = Date.now() - started;
    console.log(`[OK] ip=${ip} status=200 texts=${texts.length} chars=${totalIn} items=${items.length} batches=${batches.length} deepLCalls=${deepLCalls} ms=${ms}`);

    return res.json({ translations });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    const retry = err.response?.headers?.['retry-after'];
    if (retry) res.set('Retry-After', String(retry));

    note(clientIp(req), status, 0, 0);
    const ms = Date.now() - started;
    console.warn(`[ERR] ip=${clientIp(req)} status=${status} msg="${detail}" ms=${ms}`);

    return res.status(status).json({ error: detail || 'translation failed' });
  }
});

// --------- Start ---------
app.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
  console.log(`DeepL endpoint: ${API_URL}`);
  console.log(`Rate limits: perCallMaxChars=${RATE_MAX_CHARS}, cooldownPerIpMs=${RATE_COOLDOWN_MS}, cooldownGlobalMs=${RATE_COOLDOWN_GLOBAL_MS}, batchInterDelayMs=${BATCH_INTER_DELAY_MS}, maxTotalChars=${RATE_MAX_TOTAL_CHARS}`);
});
