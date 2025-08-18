// proxy/server.cjs
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.set('trust proxy', true); // respecteer X-Forwarded-For vanaf nginx
app.use(bodyParser.json({ limit: '1mb' }));
app.use(cors({ origin: true }));

// --------- Config / ENV ---------
const PORT = process.env.PORT || 8787;

// Sanitize key & kies endpoint op basis van :fx (Free) vs Pro
const rawKey = process.env.DEEPL_KEY || '';
const DEEPL_KEY = rawKey.trim().replace(/^['"]+|['"]+$/g, ''); // strip quotes/spaties
const isFreeKey = /:fx$/i.test(DEEPL_KEY);

const API_URL = (process.env.DEEPL_API_URL || (isFreeKey
  ? 'https://api-free.deepl.com/v2/translate'
  : 'https://api.deepl.com/v2/translate')).trim();

// Rate limiting settings (naar wens aanpasbaar via .env)
const RATE_MAX_CHARS = Number.parseInt(process.env.RATE_MAX_CHARS || '50000', 10);   // max karakters per request
const RATE_COOLDOWN_MS = Number.parseInt(process.env.RATE_COOLDOWN_MS || '5000', 10); // cooldown per IP
const RATE_COOLDOWN_GLOBAL_MS = Number.parseInt(process.env.RATE_COOLDOWN_GLOBAL_MS || '0', 10); // optioneel: globale cooldown (0 = uit)

// --------- In-memory state voor rate limiting ---------
const lastHitByIp = new Map(); // ip -> timestamp (ms)
let lastGlobalHit = 0;

// Kleine housekeeping om memory schoon te houden
setInterval(() => {
  const now = Date.now();
  for (const [ip, t] of lastHitByIp.entries()) {
    if (now - t > Math.max(RATE_COOLDOWN_MS, 60_000)) lastHitByIp.delete(ip);
  }
}, 60_000).unref();

// --------- Helpers ---------
function clientIp(req) {
  // Met trust proxy: req.ip is al de juiste client (laatste uit XFF)
  return (req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').toString();
}

function totalChars(texts) {
  try {
    return texts.reduce((sum, t) => sum + String(t ?? '').length, 0);
  } catch {
    return Infinity;
  }
}

// Middleware: max chars per request
function enforceCharLimit(req, res, next) {
  const { texts } = req.body || {};
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: 'texts must be a non-empty array' });
  }
  const total = totalChars(texts);
  if (total > RATE_MAX_CHARS) {
    // 413 = Payload Too Large
    return res.status(413).json({
      error: 'Too many characters for a single request.',
      limit: RATE_MAX_CHARS,
      total
    });
  }
  next();
}

// Middleware: 5s cooldown per IP (+ optioneel globale cooldown)
function enforceCooldown(req, res, next) {
  const now = Date.now();
  const ip = clientIp(req);

  // Per-IP
  const last = lastHitByIp.get(ip) || 0;
  const remainingMs = RATE_COOLDOWN_MS - (now - last);
  if (remainingMs > 0) {
    const seconds = Math.ceil(remainingMs / 1000);
    res.set('Retry-After', String(seconds));
    return res.status(429).json({ error: `Too many requests. Cooldown ${seconds}s.` });
  }

  // Optioneel: globale cooldown (per key)
  if (RATE_COOLDOWN_GLOBAL_MS > 0) {
    const remainingGlobalMs = RATE_COOLDOWN_GLOBAL_MS - (now - lastGlobalHit);
    if (remainingGlobalMs > 0) {
      const seconds = Math.ceil(remainingGlobalMs / 1000);
      res.set('Retry-After', String(seconds));
      return res.status(429).json({ error: `Service cooldown ${seconds}s.` });
    }
  }

  // Markeer als ‘recent gebruikt’; hiermee voorkomen we request-storms
  lastHitByIp.set(ip, now);
  if (RATE_COOLDOWN_GLOBAL_MS > 0) lastGlobalHit = now;

  next();
}

// --------- Routes ---------
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/translate', enforceCharLimit, enforceCooldown, async (req, res) => {
  try {
    const { texts, targetLang } = req.body || {};
    if (!targetLang) {
      return res.status(400).json({ error: 'targetLang is required' });
    }
    if (!DEEPL_KEY) {
      return res.status(500).json({ error: 'DEEPL_KEY is not set on server' });
    }

    const params = new URLSearchParams();
    texts.forEach(t => params.append('text', String(t ?? '')));
    params.append('target_lang', String(targetLang).toUpperCase());

    const resp = await axios.post(API_URL, params.toString(), {
      headers: {
        Authorization: `DeepL-Auth-Key ${DEEPL_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });

    const translations = Array.isArray(resp.data?.translations)
      ? resp.data.translations.map(t => t.text)
      : [];

    return res.json({ translations });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    // Geef Retry-After door als DeepL het meegeeft
    const retry = err.response?.headers?.['retry-after'];
    if (retry) res.set('Retry-After', String(retry));
    return res.status(status).json({ error: detail || 'translation failed' });
  }
});

// --------- Start ---------
app.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
  console.log(`DeepL endpoint: ${API_URL}`);
  console.log(`Rate limits: maxChars=${RATE_MAX_CHARS}, cooldownPerIpMs=${RATE_COOLDOWN_MS}, cooldownGlobalMs=${RATE_COOLDOWN_GLOBAL_MS}`);
});
