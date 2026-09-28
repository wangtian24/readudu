// Loads settings from env.yml (git-ignored) with environment variables taking precedence.
// env.yml is a flat "key: value" file — see env.example.yml for every option.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 4321,
  host: '127.0.0.1',
  data_dir: './data',
  claude_bin: 'claude',
  model: 'opus',
  max_parallel_runs: 3,
  max_output_tokens: 64000,
  tts_provider: 'elevenlabs',
  elevenlabs_api_key: '',
  elevenlabs_model: 'eleven_multilingual_v2',
  elevenlabs_voice_female: 'EXAVITQu4vr4xnSDxMaL',
  elevenlabs_voice_male: 'JBFqnCBsd6RMkjVDRZzb',
};

// Minimal parser for flat YAML: `key: value`, `# comments`, optional quotes.
function parseFlatYaml(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1].toLowerCase()] = v;
  }
  return out;
}

function load() {
  const root = __dirname;
  const file = process.env.READUDU_CONFIG || path.join(root, 'env.yml');
  let fromFile = {};
  try { fromFile = parseFlatYaml(fs.readFileSync(file, 'utf8')); } catch { /* no env.yml: defaults + env vars */ }
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const env = process.env[k.toUpperCase()] ?? (k === 'elevenlabs_api_key' ? process.env.ELEVEN_LABS_API_KEY : undefined);
    const v = env ?? fromFile[k];
    if (v !== undefined && v !== '') cfg[k] = typeof DEFAULTS[k] === 'number' ? Number(v) : v;
  }
  // Per-language voices: elevenlabs_voice_<lang>, elevenlabs_voice_<lang>_female / _male (e.g. elevenlabs_voice_fr_female).
  const extra = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) extra[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(extra)) if (/^elevenlabs_voice_[a-z]{2,3}(_(female|male))?$/.test(k) && v) cfg[k] = v;
  cfg.data_dir = path.resolve(root, cfg.data_dir);
  return cfg;
}

module.exports = load();
