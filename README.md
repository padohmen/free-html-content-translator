# Free HTML Translator — Static per-language pages (SEO friendly)

Quick start:
1) Copy `.env.example` to `.env` and set `DEEPL_KEY`.
2) Build & run: `docker compose up --build`
3) Open: http://localhost:8070/app/en/


## Rate limiting & batching

**Server-side limieten**
- Max. **50.000** karakters per DeepL-call (config via `RATE_MAX_CHARS`).
- **Cooldown 5s per IP** (config via `RATE_COOLDOWN_MS`).
- Optioneel **globale cooldown** (per key) via `RATE_COOLDOWN_GLOBAL_MS` (0 = uit).
- **Server-side batching**: verzoeken > `RATE_MAX_CHARS` worden intern opgesplitst en sequentieel naar DeepL gestuurd; output wordt weer samengevoegd.

**Env-variabelen (.env)**
```env
DEEPL_KEY=...:fx
DEEPL_API_URL=https://api-free.deepl.com/v2/translate

RATE_MAX_CHARS=50000
RATE_COOLDOWN_MS=5000
RATE_COOLDOWN_GLOBAL_MS=0
BATCH_INTER_DELAY_MS=0
RATE_MAX_TOTAL_CHARS=0

