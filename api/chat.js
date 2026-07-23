import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const MODEL = 'claude-haiku-4-5';
const MAX_HISTORY_TURNS = 6;
const MAX_CONTEXT_CHARS = 12000;
const TOP_N_ENTRIES = 6;

const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'à', 'a',
  'est', 'en', 'que', 'qui', 'ce', 'se', 'pour', 'dans', 'sur', 'par', 'avec',
  'ne', 'pas', 'ça', 'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils',
  'elles', 'mon', 'ma', 'mes', 'son', 'sa', 'ses', 'au', 'aux', 'c', 'l', 'd',
  'quoi', 'comment', 'pourquoi', 'quel', 'quelle', 'quels', 'quelles',
]);

let wikiIndexCache = null;
function loadWikiIndex() {
  if (wikiIndexCache) return wikiIndexCache;
  const filePath = path.join(process.cwd(), 'data', 'wiki-index.json');
  wikiIndexCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return wikiIndexCache;
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function tokenize(str) {
  return normalize(str)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function searchWiki(query, entries) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored = entries.map((entry) => {
    const titleNorm = normalize(entry.title || '');
    const contentNorm = normalize(entry.content || '');
    let score = 0;
    for (const term of terms) {
      if (titleNorm.includes(term)) score += 5;
      const matches = contentNorm.split(term).length - 1;
      score += matches;
    }
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N_ENTRIES)
    .map((s) => s.entry);
}

function buildContext(matches) {
  let context = '';
  for (const m of matches) {
    const block = `## ${m.title}${m.matiere ? ` (${m.matiere})` : ''}\n${m.content}\n\n`;
    if (context.length + block.length > MAX_CONTEXT_CHARS) break;
    context += block;
  }
  return context;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante côté serveur' });
  }

  const { message, history } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message requis' });
  }

  try {
    const entries = loadWikiIndex();
    const matches = searchWiki(message, entries);
    const context = buildContext(matches);

    const systemPrompt = `Tu es l'assistant du wiki scolaire de Charles (5e/6e secondaire belge). Réponds en français, de façon concise et pédagogique.

Voici des extraits pertinents du wiki, trouvés par recherche de mots-clés sur la question :

${context || "(aucun extrait pertinent trouvé pour cette question)"}

Règles :
- Base ta réponse sur ces extraits en priorité. Cite le chapitre/concept d'origine quand c'est pertinent (ex: "d'après ton chapitre de biologie sur...").
- Si les extraits ne contiennent pas l'information demandée, dis-le explicitement plutôt que d'inventer — propose à Charles d'ingérer le sujet dans le wiki si besoin.
- Si la question n'a rien à voir avec le contenu scolaire (bavardage, question générale), réponds normalement sans forcer une référence au wiki.`;

    const client = new Anthropic({ apiKey });

    const messages = [];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-MAX_HISTORY_TURNS * 2)) {
        if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
          messages.push({ role: turn.role, content: turn.content });
        }
      }
    }
    messages.push({ role: 'user', content: message });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock ? textBlock.text : '';

    return res.status(200).json({ reply, sources: matches.map((m) => m.title) });
  } catch (err) {
    console.error('chat error:', err);
    return res.status(500).json({ error: 'Erreur lors de l\'appel au chat' });
  }
}
