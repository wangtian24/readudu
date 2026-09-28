// Readudu — local reading-unit app for language learners. Zero dependencies: `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { extract } = require('./extract');

const config = require('./config');
const PORT = config.port;
const ROOT = __dirname;
const DATA = config.data_dir;
const UNITS = path.join(DATA, 'units');
const STATE = path.join(DATA, 'state.json');
const TTS = path.join(DATA, 'tts');
for (const d of [UNITS, TTS]) fs.mkdirSync(d, { recursive: true });

const MIME = { '.svg': 'image/svg+xml', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
const unitDir = id => path.join(UNITS, id);
// Units created before multi-language support used Russian-specific field names; map them on read.
function normalize(u) {
  if (!u || u.title !== undefined || u.title_ru === undefined) return u;
  const ex = e => ({ text: e.ru, en: e.en });
  u.title = u.title_ru; delete u.title_ru;
  u.language ||= 'ru';
  (u.sentences || []).forEach(s => {
    s.text = s.ru; delete s.ru;
    (s.words || []).forEach(w => { if (w.stressed) w.reading = w.stressed; delete w.stressed; });
  });
  (u.phrases || []).forEach(p => { p.text = p.ru; delete p.ru; p.examples = (p.examples || []).map(ex); });
  (u.grammar || []).forEach(g => { g.examples = (g.examples || []).map(ex); });
  return u;
}
const readUnit = id => normalize(readJSON(unitFile(id)));
const unitFile = id => path.join(unitDir(id), 'unit.json');

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req, limit = 200e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => err ? send(res, 404, { error: 'not found' }) : send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'));
}

// Up to 3 claude runs in parallel; live progress is kept in memory.
const MAX_RUNS = config.max_parallel_runs;
let running = 0; const waiting = [];
const progress = {};
const runs = {}; // id → AbortController of the running claude process
function cancel(id) {
  const i = waiting.indexOf(id); if (i >= 0) waiting.splice(i, 1);
  runs[id]?.abort();
}
function enqueue(id) { waiting.push(id); pump(); }
function pump() {
  while (running < MAX_RUNS && waiting.length) {
    running++;
    processUnit(waiting.shift()).finally(() => { running--; pump(); });
  }
}
async function processUnit(id) {
  const f = unitFile(id);
  const unit = readJSON(f);
  if (!unit) return;
  writeJSON(f, { ...unit, status: 'processing', startedAt: new Date().toISOString() });
  const dir = unitDir(id);
  const text = unit.hasText ? fs.readFileSync(path.join(dir, 'source.txt'), 'utf8') : '';
  try {
    progress[id] = { phase: 'starting', sentences: 0, chars: 0 };
    runs[id] = new AbortController();
    const result = await extract({
      images: unit.images.map(i => path.join(dir, i)), text, hint: unit.hint, language: unit.langHint, model: unit.model, cwd: dir, signal: runs[id].signal,
      onProgress: pr => { progress[id] = pr; },
    });
    const cur = readJSON(f);
    if (!cur) return; // deleted meanwhile
    writeJSON(f, { ...cur, ...result, status: 'ready', error: null, updated: new Date().toISOString() });
    console.log(`unit ${id} ready: [${result.language}] ${result.title} (${result.sentences.length} sentences)`);
  } catch (e) {
    if (e.cancelled) {
      console.log(`unit ${id} stopped`);
      const cur = readJSON(f);
      // A stopped regeneration keeps the previous version; a first run becomes "stopped".
      if (cur) writeJSON(f, { ...cur, status: cur.sentences ? 'ready' : 'error', error: cur.sentences ? null : 'Stopped by you.' });
      return;
    }
    console.error(`unit ${id} failed:`, e.message);
    if (e.raw) fs.writeFileSync(path.join(dir, 'claude-raw.txt'), e.raw);
    const cur = readJSON(f);
    if (cur) writeJSON(f, { ...cur, status: 'error', error: e.message });
  } finally {
    delete progress[id]; delete runs[id];
  }
}

// Speech: ElevenLabs (tts_provider: elevenlabs + elevenlabs_api_key in env.yml), else macOS `say`.
// A native voice per language sounds far better than an English voice speaking French/Arabic; see env.example.yml.
function elevenVoice(lang, gender) {
  const g = gender === 'male' ? 'male' : 'female';
  return config[`elevenlabs_voice_${lang}_${g}`] || config[`elevenlabs_voice_${lang}`] || config[`elevenlabs_voice_${g}`];
}
// Concurrent requests for the same clip (the browser can ask twice) share one generation, so it's paid once.
const inflight = new Map();
// Every clip is generated once and kept in data/tts; index.jsonl records what each file says.
function logClip(file, meta) {
  fs.appendFileSync(path.join(TTS, 'index.jsonl'), JSON.stringify({ file: path.basename(file), ...meta, created: new Date().toISOString() }) + '\n');
}
async function elevenSpeech(text, voice, lang) {
  const key = config.elevenlabs_api_key;
  if (config.tts_provider !== 'elevenlabs' || !key) return null;
  const voiceId = elevenVoice(lang, voice);
  const model = config.elevenlabs_model;
  const speed = 0.95; // slow playback is done in the browser, so each text is paid for once
  // Russian keeps the original cache key so clips made before multi-language support are reused.
  const hash = crypto.createHash('sha1').update(['el', voiceId, model, speed, ...(lang === 'ru' ? [] : [lang]), text].join('|')).digest('hex');
  const out = path.join(TTS, hash + '.mp3');
  if (fs.existsSync(out)) return out;
  if (inflight.has(out)) return inflight.get(out);
  const job = elevenFetch(out, key, voiceId, model, speed, text, lang, voice).finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}
async function elevenFetch(out, key, voiceId, model, speed, text, lang, voice) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, language_code: lang, voice_settings: { stability: 0.6, similarity_boost: 0.75, speed } }),
  });
  if (!r.ok) { console.error('ElevenLabs failed:', r.status, (await r.text()).slice(0, 300)); return null; }
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  logClip(out, { provider: 'elevenlabs', lang, voice, voiceId, model, chars: text.length, text });
  return out;
}

// Fallback: macOS `say`, using the best installed voice for the language (right locale, then Premium > Enhanced > basic).
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, (e, out) => (e ? fail(e) : ok(out))));
async function sayVoice(lang, locale) {
  const voices = (await run('say', ['-v', '?'])).split('\n')
    .map(l => l.match(/^(.+?)\s+([a-z]{2,3})_([A-Z]{2})/)).filter(m => m && m[2] === lang);
  const rank = m => (locale && m[3] !== locale ? 10 : 0) + (/premium/i.test(m[1]) ? 0 : /enhanced/i.test(m[1]) ? 1 : 2);
  return voices.sort((a, b) => rank(a) - rank(b)).map(m => m[1].trim())[0];
}
async function speech(text, lang, locale) {
  const voice = await sayVoice(lang, locale);
  if (!voice) throw new Error(`No ${lang} voice installed (System Settings → Accessibility → Spoken Content → Manage Voices)`);
  const rate = '165';
  const key = crypto.createHash('sha1').update([voice, rate, text].join('|')).digest('hex');
  const out = path.join(TTS, key + '.m4a');
  if (!fs.existsSync(out)) {
    const aiff = out + '.aiff';
    await run('say', ['-v', voice, '-r', rate, '-o', aiff, text]);
    await run('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, out]);
    fs.rmSync(aiff, { force: true });
    logClip(out, { provider: 'macos-say', lang, voice, text });
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/') return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    if (p === '/api/config') return send(res, 200, { model: config.model, tts: config.tts_provider });
    if (p === '/logo.svg') return serveFile(res, path.join(ROOT, 'public', 'logo.svg'));

    if (p === '/api/tts') {
      const text = (url.searchParams.get('text') || '').replace(/\u0301/g, '').slice(0, 2000).trim();
      const tag = url.searchParams.get('lang') || 'ru';
      const lang = tag.slice(0, 2).toLowerCase(), locale = (tag.split('-')[1] || '').toUpperCase();
      if (!text) return send(res, 400, { error: 'no text' });
      if (config.tts_provider === 'none') return send(res, 404, { error: 'text-to-speech disabled (tts_provider: none)' });
      const file = (await elevenSpeech(text, url.searchParams.get('voice'), lang).catch(e => (console.error(e), null))) || await speech(text, lang, locale);
      return serveFile(res, file);
    }

    let m = p.match(/^\/files\/([\w-]+)\/([\w.-]+)$/);
    if (m) return serveFile(res, path.join(unitDir(m[1]), m[2]));

    if (p === '/api/units' && req.method === 'GET') {
      const list = fs.readdirSync(UNITS).map(readUnit).filter(Boolean).map(u => ({
        id: u.id, title: u.title, title_en: u.title_en, language: u.language || u.langHint, generation: u.generation, level: u.level, kind: u.kind,
        status: u.status, error: u.error, created: u.created, startedAt: u.startedAt,
        sentences: u.sentences?.length, pages: u.images.length, hasText: u.hasText, progress: progress[u.id],
      })).sort((a, b) => (a.created < b.created ? 1 : -1));
      return send(res, 200, list);
    }

    if (p === '/api/units' && req.method === 'POST') {
      const { images = [], text = '', hint = '', model = '', language = '' } = JSON.parse((await readBody(req)).toString());
      if (!images.length && !text.trim()) return send(res, 400, { error: 'Add at least one photo or some text.' });
      // Same pages/text/note as an existing unit → reuse it instead of calling claude again.
      const hash = crypto.createHash('sha256').update(JSON.stringify([images, text.trim(), hint.trim(), language])).digest('hex');
      const existing = fs.readdirSync(UNITS).map(d => readJSON(unitFile(d))).find(u => u && u.hash === hash && u.status !== 'error');
      if (existing) return send(res, 200, { id: existing.id, cached: true });
      const now = new Date();
      const id = now.toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
      const dir = unitDir(id);
      fs.mkdirSync(dir);
      const names = images.map((dataUrl, i) => {
        const mm = /^data:(image\/[\w+]+);base64,(.*)$/s.exec(dataUrl);
        if (!mm || !EXT[mm[1]]) throw new Error('Images must be JPEG, PNG or WebP');
        const name = `page-${i + 1}${EXT[mm[1]]}`;
        fs.writeFileSync(path.join(dir, name), Buffer.from(mm[2], 'base64'));
        return name;
      });
      if (text.trim()) fs.writeFileSync(path.join(dir, 'source.txt'), text.trim());
      writeJSON(unitFile(id), { id, images: names, hasText: !!text.trim(), hint: hint.trim(), langHint: language, model, hash, status: 'queued', created: now.toISOString() });
      enqueue(id);
      return send(res, 202, { id });
    }

    m = p.match(/^\/api\/units\/([\w-]+)(\/regenerate|\/stop)?$/);
    if (m) {
      const id = m[1], f = unitFile(id);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      if (m[2] === '/stop' && req.method === 'POST') {
        cancel(id);
        const u = readJSON(f);
        if (u.status === 'queued') writeJSON(f, { ...u, status: u.sentences ? 'ready' : 'error', error: u.sentences ? null : 'Stopped by you.' });
        return send(res, 200, { ok: true });
      }
      if (m[2] === '/regenerate' && req.method === 'POST') {
        const u = readJSON(f);
        const { model } = JSON.parse((await readBody(req)).toString() || '{}');
        writeJSON(f, { ...u, status: 'queued', error: null, ...(model !== undefined ? { model } : {}) });
        enqueue(id);
        return send(res, 202, { id });
      }
      if (req.method === 'GET') {
        const u = readUnit(id);
        u.progress = progress[id];
        if (u.hasText) u.text = fs.readFileSync(path.join(unitDir(id), 'source.txt'), 'utf8');
        return send(res, 200, u);
      }
      if (req.method === 'DELETE') {
        cancel(id);
        fs.rmSync(unitDir(id), { recursive: true, force: true });
        const s = readJSON(STATE, {});
        if (s.progress) { delete s.progress[id]; writeJSON(STATE, s); }
        return send(res, 200, { ok: true });
      }
    }

    if (p === '/api/state') {
      if (req.method === 'GET') return send(res, 200, readJSON(STATE, {}));
      if (req.method === 'PUT') { writeJSON(STATE, JSON.parse((await readBody(req, 5e6)).toString())); return send(res, 200, { ok: true }); }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// Resume anything interrupted by a restart.
for (const id of fs.readdirSync(UNITS)) {
  const u = readJSON(unitFile(id));
  if (u && (u.status === 'processing' || u.status === 'queued')) enqueue(id);
}

server.listen(PORT, config.host, () => console.log(`Readudu → http://localhost:${PORT}`));
