# AGENTS.md: guide for coding agents (and humans) working on Readudu

Readudu turns photos/text in a foreign language into a structured reading lesson. It is a zero-dependency
Node app: a small HTTP server, one generation module, and a single-page vanilla-JS frontend.

## Setup checklist (do this for a new user)

1. Check `node --version` (18+ needed: global `fetch`, `AbortController`).
2. Check the generation backend. By default this is Claude Code: `claude --version`, then
   `claude -p "reply with ok"` must succeed (the user must be logged in). If they can't or don't want
   to use Claude Code, see "Swap the LLM" below before continuing.
3. Run `cp env.example.yml env.yml` and fill it in with the user. **Never commit `env.yml`** (it holds keys and is git-ignored).
   - Audio: `elevenlabs_api_key`, or `tts_provider: say` (macOS), or `tts_provider: none`.
4. Run `npm start` and open http://localhost:4321. Smoke test: paste 2–3 sentences, generate, and wait for it to finish (1–2 min).

## Architecture

```
config.js        loads env.yml + UPPER_CASE env vars → config object (the only place settings are read)
extract.js       SCHEMA + prompt (with per-language guidance) + extract(): ONE headless `claude -p` call per unit,
                 streamed (stream-json) so progress can be reported; returns the unit object
server.js        HTTP API, unit storage, a small run queue (max_parallel_runs), stop/cancel, TTS + audio cache
public/index.html  the whole UI (CSS + JS in one file, no build step)
public/logo.svg
data/            user data (git-ignored): units/<id>/{page-N.jpg, source.txt, unit.json}, tts/, state.json
```

**Design rule: exactly one AI call per unit.** Everything else is deterministic code and must stay that way
(it keeps cost predictable and results cached). This includes locating words in sentences, highlighting,
stress/furigana placement, sentence grouping, the glossary, progress and speaker voices. Don't add per-click AI calls.

### Data flow
1. The UI POSTs `/api/units` with `{images: [dataURL], text, hint, language, model}`. Identical input returns the
   existing unit (`hash`), so nothing is regenerated unless the user presses Regenerate.
2. `server.js` saves files, queues the unit, and calls `extract()`; progress is kept in memory and polled by the UI.
3. The result is merged into `unit.json` with `status: 'ready'` and `generation: {model, seconds, cost_usd}`.
4. The UI's `prepare()` locates each `words[].text` in order inside `sentences[].text`. This works without spaces
   (Japanese). It also locates `phrases[].occurrences[].text` for highlighting.

### Unit schema (see `SCHEMA` in extract.js)
- `language` (BCP-47), `title`, `title_en`, `level`, `kind` (dialog/prose/mixed), `summary_en`
- `sentences[]`: `para` (paragraph/turn group), `speaker?`, `kind` (text/heading/note), `text`, `en`, `literal`,
  `structure`, `note?`, `words[]`
  - `words[]`: `text` (exact substring, in order), `reading?` (Russian: stressed form with U+0301; Japanese:
    hiragana), `translit?` (romanization), `lemma`, `pos`, `form`, `en`
- `phrases[]`: `text`, `reading?`, `lemma?`, `en`, `category`, `explanation`, `examples[]`, `occurrences[{s, text}]`
- `tables[]` (`lemma` must equal a `words[].lemma` to link), `grammar[]`, `culture[]`

Old units that used Russian-specific fields (`title_ru`, `sentences[].ru`, `words[].stressed`) are mapped by
`normalize()` in server.js when read, so never break stored data. Add a mapping there if you change the schema.

## Recipes

### Swap the LLM (OpenAI, Gemini, the Anthropic API, a local model…)
Only `extract()` in `extract.js` needs to change. Keep its contract:
- input: `{ images: [absolute paths], text, hint, language, cwd, model, signal, onProgress }`
- output: a Promise of an object matching `SCHEMA`, plus
  `generation: { model, seconds, cost_usd }` (use `null` for cost if it's unknown)
- honor `signal` (AbortSignal) so Stop works: reject with an error that has `cancelled: true`.
- `onProgress({ phase, sentences, chars })` is optional, but it drives the progress UI. Phases used:
  `starting`, `thinking`, `reading pages`, `writing`, `sentences`, `key phrases`, `conjugation tables`, `grammar notes`, `culture notes`.
  Counting `"structure":` occurrences in streamed JSON is how `sentences` is estimated.

Reuse `prompt()` and `SCHEMA` as they are: send the prompt, attach images as base64 (the CLI version passes file
paths and lets Claude read them), and request JSON-schema / structured output. Put new keys (API key, base
URL, model) in `DEFAULTS` in `config.js` and document them in `env.example.yml` and the README table.

### Change or add a language
- Prompt: add an entry to `LANG_GUIDE` in `extract.js` (word segmentation, what `reading`/`translit` hold,
  what `form` should say, which tables to produce, level scale).
- UI: add it to `LANGS` in `public/index.html` (`reading: 'inline'` = the same word plus combining marks, such as stress or vowels;
  `'ruby'` = furigana-style annotation; `null` = none; also the toggle label, `translit`, `translitInMeaning`, `dir: 'rtl'`),
  add a flag to `FLAGS`, and add it to the language `<select>` in the composer. Right-to-left scripts need `dir: 'rtl'` (sentence blocks get
  `dir="rtl"`; English glosses inside them are forced to `dir="ltr"`). For script-specific fonts or sizes, add a `#app[data-lang=xx]` CSS rule
  that sets `--tl-font` / `--tlz`.
- TTS: ElevenLabs multilingual handles most languages; `say` picks an installed voice by locale automatically.

### Swap the TTS provider
Only `elevenSpeech()` in `server.js` needs to change (or add a sibling function and a `tts_provider` value). Contract: return the path of a
cached audio file under `data/tts/` or `null` to fall back. Always cache by a hash of
(provider, voice, model, language, text), because users pay per character. Slow playback is done in the
browser (`playbackRate`), so never generate slow variants.

## Conventions
- No dependencies and no build step; keep it that way unless there's a strong reason.
- The UI is one file. `render()` rebuilds the main view from `state` + `unit`. Settings and progress persist via
  `PUT /api/state` (server-side JSON, not localStorage).
- The header has a fixed geometry: pixel sizes and fixed-width toggle buttons, so toggles never shift the layout.
- Match the existing code style (2-space indent, single quotes, terse comments explaining *why*).

## Testing
There is no test suite. Verify changes by running the app:
- `node --check server.js`. For the UI script, extract the `<script>` body and run `node --check` on it.
- Syntax isn't enough for UI changes: drive a real browser (e.g. Playwright headless) through Read, Guided, the
  composer and the camera dialog, and check for `pageerror`s.
- Generation is slow and costs money. Test with a 2–3 sentence pasted text, and reuse existing units for UI work.
