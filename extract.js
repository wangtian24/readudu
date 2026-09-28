// Turns page photos and/or pasted text into one learning unit with a single `claude -p` call.
// Language-agnostic: the prompt adds per-language guidance (see LANG_GUIDE).
const { spawn } = require('child_process');
const config = require('./config');

const str = { type: 'string' };
const example = { type: 'object', properties: { text: str, en: str } };
const SCHEMA = {
  type: 'object',
  required: ['language', 'title', 'title_en', 'level', 'kind', 'summary_en', 'sentences', 'phrases', 'tables', 'grammar', 'culture'],
  properties: {
    language: str,
    title: str,
    title_en: str,
    level: str,
    kind: { type: 'string', enum: ['dialog', 'prose', 'mixed'] },
    summary_en: str,
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        required: ['para', 'kind', 'text', 'en', 'literal', 'structure', 'words'],
        properties: {
          para: { type: 'integer' },
          speaker: str,
          kind: { type: 'string', enum: ['text', 'heading', 'note'] },
          text: str,
          en: str,
          literal: str,
          structure: str,
          note: str,
          words: {
            type: 'array',
            items: {
              type: 'object',
              required: ['text', 'lemma', 'pos', 'form', 'en'],
              properties: { text: str, reading: str, translit: str, lemma: str, pos: str, form: str, en: str },
            },
          },
        },
      },
    },
    phrases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'en', 'explanation', 'occurrences'],
        properties: {
          text: str,
          reading: str,
          lemma: str,
          en: str,
          category: { type: 'string', enum: ['vocab', 'phrase', 'idiom', 'grammar', 'culture'] },
          explanation: str,
          examples: { type: 'array', items: example },
          occurrences: {
            type: 'array',
            items: { type: 'object', required: ['s', 'text'], properties: { s: { type: 'integer' }, text: str } },
          },
        },
      },
    },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lemma', 'title', 'columns', 'rows'],
        properties: {
          lemma: str,
          title: str,
          kind: { type: 'string', enum: ['conjugation', 'declension', 'other'] },
          columns: { type: 'array', items: str },
          rows: { type: 'array', items: { type: 'array', items: str } },
          note: str,
        },
      },
    },
    grammar: {
      type: 'array',
      items: { type: 'object', required: ['title', 'body'], properties: { title: str, body: str, examples: { type: 'array', items: example } } },
    },
    culture: {
      type: 'array',
      items: { type: 'object', required: ['title', 'body'], properties: { title: str, body: str } },
    },
  },
};

const LANG_GUIDE = {
  ru: `RUSSIAN
- words[].reading: the word with a combining acute U+0301 after the stressed vowel (omit for one-syllable words and when the stress falls on ё). lemma also carries the stress mark.
- form: case, number, gender, aspect, tense, person, e.g. "perfective, past, masc. sg." or "fem. acc. sg.".
- structure: explain case choices, aspect, word order and zero-copula sentences.
- tables: conjugations of key verbs (present/future all persons, past, imperative, aspect partner) and declensions of key nouns/pronouns/adjectives, with stress marks.
- level: CEFR.`,
  ja: `JAPANESE
- Split words the way a learner needs: particles (は, が, を, に, で, の, と, も, か, よ, ね…) are separate words; a verb or adjective together with its attached inflection/auxiliaries (食べました, 行きたい, 高くなかった) is ONE word whose form explains the pieces. words[].text must be exact substrings in order; there are no spaces.
- words[].reading: the hiragana reading of the whole word, ONLY when it contains kanji. words[].translit: Hepburn romaji for every word. lemma: dictionary form with its reading in brackets, e.g. "食べる (たべる)".
- pos: noun, verb, i-adj, na-adj, adv, particle, aux, pron, counter, conj, interj, name. form: e.g. "polite past (ます-form)", "て-form", "plain negative", "topic marker".
- structure: explain topic vs subject, particles, verb-final order, politeness level and any dropped subject.
- phrases[].reading: hiragana reading when the phrase has kanji. Mention notable kanji in explanations (meaning + common readings).
- tables: conjugation tables for key verbs/adjectives (dictionary, ます, ない, た, て, potential, volitional, conditional as relevant) with readings.
- level: JLPT (N5–N1).`,
  es: `SPANISH
- words[].reading: omit. Contractions (al, del) and clitic pronouns attached to verbs (dímelo) are one word whose form explains the pieces.
- form: tense, mood, person, number, gender, e.g. "preterite, 3rd sg.", "present subjunctive, 1st pl.", "fem. pl.".
- structure: explain ser vs estar, preterite vs imperfect, subjunctive triggers, pronoun placement, dropped subjects.
- tables: conjugations of key verbs (present, preterite, imperfect, future, present subjunctive, as relevant) and irregular forms.
- level: CEFR. Note regional usage (Spain vs Latin America) where relevant.`,
  pt: `PORTUGUESE
- Identify the variant (Brazilian vs European) from spelling/usage and set language to "pt-BR" or "pt-PT"; note differences between variants where relevant.
- words[].reading: omit. Contractions (do, na, pelo, dele) are one word whose form explains the pieces (e.g. "de + o").
- form: tense, mood, person, number, gender, e.g. "pretérito perfeito, 3rd sg.", "personal infinitive".
- structure: explain ser vs estar, clitic placement, personal infinitive, subjunctive triggers, dropped subjects.
- tables: conjugations of key verbs (present, pretérito perfeito, imperfeito, future, present subjunctive, as relevant).
- level: CEFR.`,
};
const GENERIC_GUIDE = `OTHER LANGUAGE
- words[].reading: a pronunciation aid only if the script does not show pronunciation well (e.g. tone marks, vowel points); otherwise omit. words[].translit: romanization only for non-Latin scripts.
- form: the grammatical information a learner of this language needs. tables: key inflection tables. level: CEFR or the language's standard scale.`;

function prompt({ images, text, hint, language }) {
  const sources = [];
  if (images.length) sources.push(`Photos of textbook pages, in reading order (read each with the Read tool):\n${images.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`);
  if (text) sources.push(`Pasted text:\n"""\n${text}\n"""`);
  const code = (language || '').slice(0, 2);
  const guide = LANG_GUIDE[code]
    ? LANG_GUIDE[code]
    : `If the language is one of these, follow its guidance; otherwise follow OTHER LANGUAGE.\n\n${Object.values(LANG_GUIDE).join('\n\n')}\n\n${GENERIC_GUIDE}`;
  return `You are building a customized foreign-language reading unit for an English-speaking learner. All explanations are in English.

SOURCE
${sources.join('\n\n')}
${language ? `\nLANGUAGE: ${language}\n` : '\nLANGUAGE: detect it from the source.\n'}${hint ? `\nLEARNER'S NOTE: ${hint}\n` : ''}
Treat all sources together as ONE continuous reading (a sentence broken across a page boundary is one sentence). Ignore page numbers, running headers, English glosses printed by the textbook, and anything visibly belonging to a neighbouring page that is not part of this reading. Transcribe EXACTLY as printed (keep diacritics, punctuation and quotation marks; re-join words hyphenated across line breaks).

OUTPUT FIELDS
- language: BCP-47 code of the reading (e.g. "ru", "ja", "es", "pt-BR", "pt-PT").
- title: the heading in the original language (make one up if none). title_en: English title. level: the learner level of the text. kind: dialog, prose or mixed. summary_en: 1–2 sentences.
- sentences: the whole text split into individual sentences, in order.
  - para: groups sentences for display — the paragraph index for prose, or the turn index for dialog (all sentences of one speaker turn share a para).
  - speaker: the speaker's name for dialog lines (omit for prose). kind: "heading" for titles, "note" for stage directions, else "text".
  - text: the sentence in the original language. en: natural English. literal: word-for-word English mirroring the original word order.
  - structure: 1–3 sentences explaining how the sentence is built and anything surprising for an English speaker.
  - note: OPTIONAL short anecdote — cultural context, etymology, a memory trick, a common learner mistake, or how natives would really say it. Add one only when genuinely interesting (roughly a third of sentences). Omit otherwise.
  - words: EVERY word of "text" in order (repeat duplicates; skip punctuation). text: exactly as it appears in the sentence (same case/characters) so it can be located. reading / translit: see language guidance. lemma: dictionary form. pos: part of speech (noun/verb/adj/pron/adv/prep/conj/particle/art/num/interj/name, or the language's own categories). form: grammatical form in context. en: meaning in this context.
- phrases: the 15–35 most useful items to study — set phrases, idioms, collocations, constructions and important single words. explanation: 2–4 sentences on meaning, form and usage. examples: 1–2 new example sentences with translations. occurrences: every place it appears — "s" is the 0-based sentence index, "text" is the EXACT substring of that sentence's "text" (character-for-character, so it can be highlighted).
- tables: inflection tables for the words the learner will reuse most — typically 4–10. lemma: exactly the same string as the matching words[].lemma (so it links). columns + rows form a small grid.
- grammar: 3–6 notes on the main grammar themes of this reading, each with a clear body and 1–3 examples.
- culture: 1–4 short notes on culture, names, customs or context the reading touches on.

LANGUAGE GUIDANCE
${guide}

Return only the structured output.`;
}

// onProgress receives {phase, sentences, chars} while claude streams its answer.
function extract({ images = [], text = '', hint = '', language = '', cwd, model, signal, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt({ images, text, hint, language }),
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--json-schema', JSON.stringify(SCHEMA),
      '--allowedTools', 'Read',
      '--add-dir', cwd,
    ];
    const m = model || config.model;
    if (m) args.push('--model', m);
    const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.max_output_tokens) };
    delete env.CLAUDECODE; // allow running from inside a Claude Code session
    const child = spawn(config.claude_bin, args, { env, cwd, signal, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '', json = '', result = null, raw = [];
    const prog = { phase: 'starting', sentences: 0, chars: 0, pagesRead: 0 };
    let lastReport = 0;
    const report = force => {
      if (!force && Date.now() - lastReport < 700) return;
      lastReport = Date.now();
      prog.chars = json.length;
      prog.sentences = (json.match(/"structure"\s*:/g) || []).length;
      for (const [key, phase] of [['"culture"', 'culture notes'], ['"grammar"', 'grammar notes'], ['"tables"', 'conjugation tables'], ['"phrases"', 'key phrases'], ['"sentences"', 'sentences']])
        if (json.includes(key)) { prog.phase = phase; break; }
      onProgress({ ...prog });
    };
    const handle = line => {
      if (!line.trim()) return;
      raw.push(line);
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === 'stream_event') {
        const ev = e.event;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') { prog.phase = 'thinking'; report(true); }
        if (ev.type === 'content_block_start' && ev.content_block?.name === 'Read') { prog.pagesRead++; prog.phase = 'reading pages'; report(true); }
        if (ev.type === 'content_block_start' && ev.content_block?.name === 'StructuredOutput') { json = ''; prog.phase = 'writing'; report(true); }
        if (ev.delta?.type === 'input_json_delta' && prog.phase !== 'reading pages') { json += ev.delta.partial_json; report(); }
      } else if (e.type === 'result') result = e;
    };
    child.stdout.on('data', d => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handle); });
    child.stderr.on('data', d => (err += d));
    child.on('error', e => reject(signal?.aborted ? Object.assign(new Error('Stopped'), { cancelled: true }) : e));
    child.on('close', code => {
      if (signal?.aborted) return reject(Object.assign(new Error('Stopped'), { cancelled: true }));
      handle(buf);
      const rawText = raw.slice(-50).join('\n');
      if (!result) return reject(Object.assign(new Error(`claude exited ${code} without a result: ${err}`.slice(0, 3000)), { raw: rawText }));
      if (result.is_error || result.subtype !== 'success') return reject(Object.assign(new Error(String(result.result || result.subtype || 'claude error').slice(0, 3000)), { raw: rawText }));
      try {
        const unit = result.structured_output || JSON.parse(String(result.result).match(/\{[\s\S]*\}/)[0]);
        unit.generation = { model: Object.keys(result.modelUsage || {})[0] || m || 'default', seconds: Math.round((result.duration_ms || 0) / 1000), cost_usd: result.total_cost_usd };
        resolve(unit);
      } catch (e) {
        reject(Object.assign(new Error(`Could not parse claude output: ${e.message}`), { raw: rawText }));
      }
    });
  });
}

module.exports = { extract };
