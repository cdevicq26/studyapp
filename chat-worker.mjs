#!/usr/bin/env node
/**
 * chat-worker.js — à lancer sur le Mac de Charles pendant qu'il utilise le Chat StudyOS.
 *
 * Poll la file d'attente Redis (alimentée par api/chat.js sur Vercel), répond aux
 * questions en cherchant dans wiki-index.json puis en invoquant `claude -p` en local
 * (utilise la session Claude Code déjà authentifiée — pas de clé API séparée, pas de coût).
 *
 * Lancer : node chat-worker.js
 * Arrêter : Ctrl+C
 */

import { Redis } from '@upstash/redis';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POLL_INTERVAL_MS = 2000;
const JOB_TTL_SECONDS = 300;
const MAX_HISTORY_TURNS = 6;
const MAX_CONTEXT_CHARS = 12000;
const TOP_N_ENTRIES = 6;
const CLAUDE_TIMEOUT_MS = 90000;

// ── Charger les identifiants Redis depuis .env.local (vercel env pull) ──
function loadEnvLocal() {
  const envPath = path.join(__dirname, '.env.local');
  const text = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const env = loadEnvLocal();
const redis = new Redis({
  url: env.KV_REST_API_URL,
  token: env.KV_REST_API_TOKEN,
});

// ── Recherche wiki (même logique que l'ancien api/chat.js) ──
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
  const filePath = path.join(__dirname, 'data', 'wiki-index.json');
  wikiIndexCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return wikiIndexCache;
}

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokenize(str) {
  return normalize(str).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
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
      score += contentNorm.split(term).length - 1;
    }
    return { entry, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, TOP_N_ENTRIES).map((s) => s.entry);
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

function buildPrompt(message, history, context) {
  const historyText = history
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((t) => `${t.role === 'user' ? 'Charles' : 'Toi'} : ${t.content}`)
    .join('\n');

  return `Tu es l'assistant du wiki scolaire de Charles (5e/6e secondaire belge). Réponds en français, de façon concise et pédagogique, en 1-2 paragraphes maximum (c'est affiché dans une bulle de chat mobile).

Voici des extraits pertinents du wiki, trouvés par recherche de mots-clés sur la question :

${context || "(aucun extrait pertinent trouvé pour cette question)"}

Règles :
- Base ta réponse sur ces extraits en priorité. Cite le chapitre/concept d'origine quand c'est pertinent.
- Si les extraits ne contiennent pas l'information demandée, dis-le explicitement plutôt que d'inventer.
- Si la question n'a rien à voir avec le contenu scolaire, réponds normalement sans forcer une référence au wiki.
- Réponds uniquement avec le texte de la réponse, sans préambule ni "Voici ma réponse:".

${historyText ? `Historique récent de la conversation :\n${historyText}\n` : ''}
Question de Charles : ${message}`;
}

async function askClaude(prompt) {
  const { stdout } = await execFileAsync('claude', ['-p', prompt, '--model', 'sonnet'], {
    timeout: CLAUDE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function processJob(jobId) {
  const raw = await redis.get(`chat:job:${jobId}`);
  if (!raw) return;
  const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

  console.log(`→ [${jobId}] ${job.message}`);

  try {
    const entries = loadWikiIndex();
    const matches = searchWiki(job.message, entries);
    const context = buildContext(matches);
    const prompt = buildPrompt(job.message, job.history || [], context);

    const reply = await askClaude(prompt);

    job.status = 'done';
    job.reply = reply;
    job.sources = matches.map((m) => m.title);
    await redis.set(`chat:job:${jobId}`, JSON.stringify(job), { ex: JOB_TTL_SECONDS });
    console.log(`✓ [${jobId}] répondu (${reply.length} caractères)`);
  } catch (err) {
    console.error(`✗ [${jobId}]`, err.message);
    job.status = 'error';
    job.error = err.message;
    await redis.set(`chat:job:${jobId}`, JSON.stringify(job), { ex: JOB_TTL_SECONDS });
  }
}

async function loop() {
  console.log('🤖 chat-worker démarré — en attente de questions...');
  while (true) {
    try {
      const jobId = await redis.rpop('chat:queue');
      if (jobId) {
        await processJob(jobId);
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error('Erreur boucle worker:', err.message);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

loop();
