'use strict';

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════
const SUBJECTS_ORDER = ['geo', 'philo', 'bio', 'francais', 'maths', 'chimie'];
const LEITNER_INTERVALS = [0, 1, 2, 3]; // jours par boîte (1-3)
const DB_NAME = 'studyapp-v1';
const DB_VERSION = 1;

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
let db = null;
let subjects = {};
let currentSubject = null;
let fcSession = { cards: [], idx: 0, correct: 0, wrong: 0 };
let qcmSession = { questions: [], idx: 0, correct: 0 };

// ═══════════════════════════════════════════════════
// INDEXEDDB
// ═══════════════════════════════════════════════════
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  return new Promise(resolve => {
    const tx = db.transaction('progress', 'readonly');
    const req = tx.objectStore('progress').get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
  });
}

async function dbSet(key, value) {
  return new Promise(resolve => {
    const tx = db.transaction('progress', 'readwrite');
    tx.objectStore('progress').put({ key, value });
    tx.oncomplete = resolve;
  });
}

async function dbClear() {
  return new Promise(resolve => {
    const tx = db.transaction('progress', 'readwrite');
    tx.objectStore('progress').clear();
    tx.oncomplete = resolve;
  });
}

// ═══════════════════════════════════════════════════
// LEITNER LOGIC
// ═══════════════════════════════════════════════════
async function getCardProgress(subjectId) {
  const data = await dbGet(`progress-${subjectId}`);
  return data || {};
}

async function saveCardProgress(subjectId, progress) {
  await dbSet(`progress-${subjectId}`, progress);
}

// score: 'oui' | 'bof' | 'non'
async function updateCard(subjectId, cardId, score) {
  const progress = await getCardProgress(subjectId);
  const card = progress[cardId] || { box: 1, nextReview: 0 };

  if (score === 'oui') {
    card.box = Math.min(card.box + 1, 3);
  } else if (score === 'bof') {
    card.box = 2;
  } else {
    card.box = 1;
  }

  card.nextReview = Date.now() + LEITNER_INTERVALS[card.box] * 86400000;
  card.lastAnswered = Date.now();
  progress[cardId] = card;
  await saveCardProgress(subjectId, progress);
  return card;
}

async function getDueCards(subjectId) {
  const subject = subjects[subjectId];
  if (!subject) return [];
  const progress = await getCardProgress(subjectId);
  const now = Date.now();
  return subject.flashcards.filter(card => {
    const p = progress[card.id];
    if (!p) return true; // never seen
    return p.nextReview <= now;
  });
}

// Collecte toute la progression IndexedDB pour export/sync
async function getAllProgress() {
  const result = {};
  for (const subjectId of SUBJECTS_ORDER) {
    const progress = await getCardProgress(subjectId);
    const subject = subjects[subjectId];
    if (!subject || !Object.keys(progress).length) continue;
    result[subjectId] = {};
    for (const [cardId, p] of Object.entries(progress)) {
      const card = subject.flashcards.find(c => c.id === cardId);
      if (card) {
        result[subjectId][cardId] = { box: p.box, term: card.term, lastAnswered: p.lastAnswered || 0 };
      }
    }
  }
  return result;
}

async function getSubjectStats(subjectId) {
  const subject = subjects[subjectId];
  if (!subject) return { boxes: [0,0,0], total: 0, mastered: 0, pct: 0 };
  const progress = await getCardProgress(subjectId);
  const boxes = [0, 0, 0]; // box 1-3
  let mastered = 0;
  subject.flashcards.forEach(card => {
    const p = progress[card.id];
    const box = p ? p.box - 1 : 0;
    boxes[Math.max(0, Math.min(2, box))]++;
    if (p && p.box === 3) mastered++;
  });
  const total = subject.flashcards.length;
  const score = boxes.reduce((s, n, i) => s + n * (i / 2), 0);
  const pct = Math.round(score / total * 100);
  return { boxes, total, mastered, pct };
}

// ═══════════════════════════════════════════════════
// LEITNER POUR LES QCM (clé séparée : qcm-{subjectId})
// ═══════════════════════════════════════════════════
async function getQCMProgress(subjectId) {
  const data = await dbGet(`qcm-progress-${subjectId}`);
  return data || {};
}

async function updateQCM(subjectId, qId, correct) {
  const progress = await getQCMProgress(subjectId);
  const entry = progress[qId] || { box: 1, nextReview: 0 };

  if (correct) {
    entry.box = Math.min(entry.box + 1, 3);
  } else {
    entry.box = Math.max(entry.box - 1, 1);
  }

  entry.nextReview = Date.now() + LEITNER_INTERVALS[entry.box] * 86400000;
  entry.lastAnswered = Date.now();
  progress[qId] = entry;
  await dbSet(`qcm-progress-${subjectId}`, progress);
}

async function getDueQCMs(subjectId) {
  const subject = subjects[subjectId];
  if (!subject) return [];
  const progress = await getQCMProgress(subjectId);
  const now = Date.now();
  return subject.qcm.filter(q => {
    const p = progress[q.id];
    if (!p) return true; // jamais vu
    return p.nextReview <= now;
  });
}

async function getQCMStats(subjectId) {
  const subject = subjects[subjectId];
  if (!subject) return { due: 0, total: 0 };
  const due = await getDueQCMs(subjectId);
  return { due: due.length, total: subject.qcm.length };
}

// ═══════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════
async function loadSubject(id) {
  if (subjects[id]) return subjects[id];
  const res = await fetch(`/data/${id}.json`);
  subjects[id] = await res.json();
  return subjects[id];
}

async function loadAllSubjects() {
  await Promise.all(SUBJECTS_ORDER.map(id => loadSubject(id)));
}

// ═══════════════════════════════════════════════════
// ROUTER / SCREEN MANAGEMENT
// ═══════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════
function daysUntil(dateStr) {
  const exam = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  exam.setHours(0, 0, 0, 0);
  return Math.ceil((exam - now) / 86400000);
}

function toast(msg, duration = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long' });
}

// ═══════════════════════════════════════════════════
// HOME SCREEN
// ═══════════════════════════════════════════════════
async function renderHome() {
  const screen = document.getElementById('screen-home');

  // Greeting
  const h = new Date().getHours();
  const greeting = h >= 18 ? 'Bonsoir' : h >= 12 ? 'Bon après-midi' : 'Bonjour';
  const dateStr = new Date().toLocaleDateString('fr-BE', { weekday:'long', day:'numeric', month:'long' });

  // Aggregate Leitner boxes across all subjects
  const globalBoxes = [0, 0, 0];
  let totalCards = 0;

  const cards = await Promise.all(SUBJECTS_ORDER.map(async id => {
    const s = subjects[id];
    const stats = await getSubjectStats(id);
    const due = await getDueCards(id);
    globalBoxes[0] += stats.boxes[0];
    globalBoxes[1] += stats.boxes[1];
    globalBoxes[2] += stats.boxes[2];
    totalCards += stats.total;

    const days = daysUntil(s.exam);
    const urgency = days <= 3 ? '#ef4444' : days <= 7 ? '#f59e0b' : s.color;

    return `
    <div class="subject-card" onclick="openSubject('${id}')">
      <div class="sc-stripe" style="background: ${s.color}"></div>
      <div class="countdown-badge" style="color: ${urgency}">${days}j</div>
      <div class="sc-tag" style="color: ${s.color}">${s.type}</div>
      <div class="sc-name">${s.name}</div>
      <div class="sc-exam">${formatDate(s.exam)}</div>
      <div class="sc-bar-bg">
        <div class="sc-bar" style="width: ${stats.pct}%; background: ${s.color}"></div>
      </div>
      <div class="sc-stats" style="color: ${s.color}">${stats.pct}% · ${due.length} à revoir</div>
    </div>`;
  }));

  // Box bar widths
  const maxBox = Math.max(...globalBoxes, 1);
  const bw = globalBoxes.map(n => Math.round(n / maxBox * 100));

  screen.innerHTML = `
  <div class="home-header">
    <div class="home-header-left">
      <div class="greeting">${dateStr}</div>
      <h1>${greeting}, Charles 👋</h1>
    </div>
    <button class="home-stats-btn" onclick="showStatsScreen()">📊</button>
  </div>

  <div class="leitner-widgets">
    <div class="lw-card" onclick="startAllDue()">
      <div class="lw-accent" style="background:#ef4444"></div>
      <div class="lw-num" style="color:#dc2626">${globalBoxes[0]}</div>
      <div class="lw-bar-wrap"><div class="lw-bar" style="width:${bw[0]}%; background:#ef4444"></div></div>
      <div class="lw-label">Demain</div>
    </div>
    <div class="lw-card">
      <div class="lw-accent" style="background:#d97706"></div>
      <div class="lw-num" style="color:#b45309">${globalBoxes[1]}</div>
      <div class="lw-bar-wrap"><div class="lw-bar" style="width:${bw[1]}%; background:#d97706"></div></div>
      <div class="lw-label">Après-demain</div>
    </div>
    <div class="lw-card">
      <div class="lw-accent" style="background:#16a34a"></div>
      <div class="lw-num" style="color:#15803d">${globalBoxes[2]}</div>
      <div class="lw-bar-wrap"><div class="lw-bar" style="width:${bw[2]}%; background:#16a34a"></div></div>
      <div class="lw-label">Dans 3j</div>
    </div>
  </div>

  <div class="section-title">Session mixte</div>
  <div class="mix-row">
    <div class="mix-card" onclick="startMix('flashcard')">
      <div class="mix-icon">🎲</div>
      <div class="mix-label">Mix Flashcards</div>
      <div class="mix-sub">Toutes matières mélangées</div>
    </div>
    <div class="mix-card" onclick="startMix('qcm')">
      <div class="mix-icon">🎲</div>
      <div class="mix-label">Mix QCM</div>
      <div class="mix-sub">Toutes matières mélangées</div>
    </div>
  </div>

  <div class="section-title">Matières</div>
  <div class="subject-grid">${cards.join('')}</div>
  `;
}

async function startAllDue() {
  const urgentId = SUBJECTS_ORDER.find(async id => (await getDueCards(id)).length > 0) || SUBJECTS_ORDER[0];
  openSubject(urgentId);
}

// ═══════════════════════════════════════════════════
// MODE MIXTE — toutes matières mélangées
// ═══════════════════════════════════════════════════
async function startMix(mode) {
  if (mode === 'flashcard') {
    let allCards = [];
    for (const id of SUBJECTS_ORDER) {
      const s = subjects[id];
      s.flashcards.forEach(c => allCards.push({ ...c, _subject: id, _color: s.color, _name: s.name }));
    }
    allCards = shuffle(allCards);
    fcSession = {
      subjectId: 'mix', cards: allCards,
      idx: 0, correct: 0, bof: 0, wrong: 0, mode: 'mix'
    };
    renderFlashcardMix();
    showScreen('flashcard');
  } else {
    let allQCM = [];
    for (const id of SUBJECTS_ORDER) {
      const s = subjects[id];
      s.qcm.forEach(q => allQCM.push({ ...q, _subject: id, _name: s.name }));
    }
    qcmSession = {
      subjectId: 'mix', questions: shuffle(allQCM).slice(0, 20),
      idx: 0, correct: 0, mode: 'mix'
    };
    renderQCM();
    showScreen('qcm');
  }
}

function renderFlashcardMix() {
  const { cards, idx } = fcSession;
  const screen = document.getElementById('screen-flashcard');
  if (idx >= cards.length) { renderFlashcardEnd(); return; }
  const card = cards[idx];
  const color = card._color || '#6366f1';
  const pct = Math.round((idx / cards.length) * 100);
  screen.innerHTML = `
  <div class="fc-header">
    <button class="back-btn" onclick="exitFlashcards('geo')">←</button>
    <div class="fc-progress-bar">
      <div class="fc-progress-fill" style="width:${pct}%; background:${color}"></div>
    </div>
    <div class="fc-counter">${idx + 1}/${cards.length}</div>
  </div>
  <div class="fc-arena">
    <div class="flashcard" id="fc-card" onclick="flipCard()">
      <div class="fc-face fc-front">
        <div class="fc-cat">${card._name || card.cat} · ${card.cat}</div>
        <div class="fc-box" id="fc-box-display">—</div>
        <div class="fc-term">${card.term}</div>
        <div class="fc-hint">Appuie · swipe ← Non · ↑ Bof · → Oui</div>
      </div>
      <div class="fc-face fc-back">
        <div class="fc-cat-back">${card._name || ''} · ${card.cat}</div>
        <div class="fc-term-back">${card.term}</div>
        <div class="fc-def">${card.def}</div>
        ${card.ex ? `<div class="fc-ex">${card.ex}</div>` : ''}
      </div>
    </div>
    <div class="fc-buttons" id="fc-btns" style="display:none">
      <button class="fc-btn fc-btn-no" onclick="answerCardMix('non')">✗ Non</button>
      <button class="fc-btn fc-btn-bof" onclick="answerCardMix('bof')">~ Bof</button>
      <button class="fc-btn fc-btn-yes" onclick="answerCardMix('oui')">✓ Oui</button>
    </div>
    <div class="fc-swipe-hint" id="fc-hint">Appuie sur la carte pour révéler</div>
  </div>`;
  initSwipe();
  // swipe appelle answerCard — on patch pour le mix
  window._isMix = true;
  getCardProgress(card._subject).then(progress => {
    const p = progress[card.id];
    const el = document.getElementById('fc-box-display');
    if (el && p) el.textContent = `📦 B${p.box}`;
  });
}

async function answerCardMix(score) {
  const { cards, idx } = fcSession;
  const card = cards[idx];
  await updateCard(card._subject, card.id, score);
  if (score === 'oui') fcSession.correct++;
  else if (score === 'bof') fcSession.bof = (fcSession.bof || 0) + 1;
  else fcSession.wrong++;
  fcSession.idx++;
  renderFlashcardMix();
}

// ═══════════════════════════════════════════════════
// SUBJECT SCREEN
// ═══════════════════════════════════════════════════
async function openSubject(id) {
  currentSubject = id;
  const s = subjects[id];
  const stats = await getSubjectStats(id);
  const due = await getDueCards(id);
  const qcmStats = await getQCMStats(id);
  const screen = document.getElementById('screen-subject');

  const days = daysUntil(s.exam);

  const leitnerBoxes = stats.boxes.map((n, i) => `
    <div class="leitner-box">
      <div class="lb-num" style="color: ${['#ef4444','#d97706','#16a34a'][i]}">${n}</div>
      <div class="lb-label">${['Non vu','Bof','Oui'][i]}</div>
    </div>`).join('');

  screen.innerHTML = `
  <div class="subject-hero">
    <button class="back-btn" onclick="goHome()">←</button>
    <div style="height:12px"></div>
    <div class="sh-tag" style="color: ${s.color}">${s.type} · ${days}j avant l'exam</div>
    <h2>${s.name}</h2>
    <div class="sh-exam" style="color: var(--muted)">${formatDate(s.exam)}</div>

    <div class="progress-row">
      <div class="pr-bar-bg">
        <div class="pr-bar" style="width: ${stats.pct}%; background: ${s.color}"></div>
      </div>
      <div class="pr-nums">
        <span style="color:#ef4444">Non ${stats.boxes[0]}</span>
        <span style="color:#d97706">Bof ${stats.boxes[1]}</span>
        <span style="color:#16a34a">Oui ${stats.boxes[2]}</span>
        <span style="color:var(--muted)">${stats.pct}%</span>
      </div>
    </div>
  </div>

  <div class="section-title">Modes d'étude</div>
  <div class="mode-grid" style="padding: 0 20px 24px">
    <div class="mode-card" onclick="startFlashcards('${id}', 'due')">
      <div class="mc-icon">🔁</div>
      <div class="mc-name">À revoir</div>
      <div class="mc-desc">Cartes dues selon Leitner</div>
      <div class="mc-count" style="color: ${due.length > 0 ? '#f59e0b' : '#4ade80'}">${due.length} cartes</div>
    </div>
    <div class="mode-card" onclick="startFlashcards('${id}', 'all')">
      <div class="mc-icon">🃏</div>
      <div class="mc-name">Toutes les cartes</div>
      <div class="mc-desc">Session libre complète</div>
      <div class="mc-count">${s.flashcards.length} cartes</div>
    </div>
    <div class="mode-card" onclick="startQCM('${id}', 'due')">
      <div class="mc-icon">🧠</div>
      <div class="mc-name">QCM à revoir</div>
      <div class="mc-desc">Questions Leitner dues</div>
      <div class="mc-count" style="color:${qcmStats.due > 0 ? '#d97706' : '#16a34a'}">${qcmStats.due} à revoir</div>
    </div>
    <div class="mode-card" onclick="startQCM('${id}', 'quick')">
      <div class="mc-icon">⚡</div>
      <div class="mc-name">QCM rapide</div>
      <div class="mc-desc">5 questions aléatoires</div>
      <div class="mc-count">5 questions</div>
    </div>
    <div class="mode-card" onclick="startQCM('${id}', 'all')">
      <div class="mc-icon">📋</div>
      <div class="mc-name">Tous les QCM</div>
      <div class="mc-desc">Session complète</div>
      <div class="mc-count">${s.qcm.length} questions</div>
    </div>
  </div>

  <div class="section-title">Boîtes Leitner — Flashcards</div>
  <div class="leitner-row">
    <div class="leitner-boxes">${leitnerBoxes}</div>
    <div style="font-size:11px; color:var(--muted); margin-top:8px; line-height:1.6">
      Non → demain · Bof → après-demain · Oui → dans 3j
    </div>
  </div>
  `;

  showScreen('subject');
}

// ═══════════════════════════════════════════════════
// FLASHCARD MODE
// ═══════════════════════════════════════════════════
async function startFlashcards(subjectId, mode) {
  const s = subjects[subjectId];
  let cards = mode === 'due' ? await getDueCards(subjectId) : [...s.flashcards];

  if (cards.length === 0) {
    toast('🎉 Toutes les cartes sont à jour !');
    return;
  }

  cards = shuffle(cards);
  fcSession = { subjectId, cards, idx: 0, correct: 0, bof: 0, wrong: 0, mode };
  renderFlashcard();
  showScreen('flashcard');
}

function renderFlashcard() {
  const { subjectId, cards, idx, correct, wrong } = fcSession;
  const s = subjects[subjectId];
  const screen = document.getElementById('screen-flashcard');

  if (idx >= cards.length) {
    renderFlashcardEnd();
    return;
  }

  const card = cards[idx];
  const pct = Math.round((idx / cards.length) * 100);

  screen.innerHTML = `
  <div class="fc-header">
    <button class="back-btn" onclick="exitFlashcards('${subjectId}')">←</button>
    <div class="fc-progress-bar">
      <div class="fc-progress-fill" style="width:${pct}%; background:${s.color}"></div>
    </div>
    <div class="fc-counter">${idx + 1}/${cards.length}</div>
  </div>

  <div class="fc-arena">
    <div class="flashcard" id="fc-card" onclick="flipCard()">
      <div class="fc-face fc-front">
        <div class="fc-cat">${card.cat}</div>
        <div class="fc-box">⬜ Boîte ?</div>
        <div class="fc-term">${card.term}</div>
        <div class="fc-hint">Appuie · swipe ← Non · ↑ Bof · → Oui</div>
      </div>
      <div class="fc-face fc-back">
        <div class="fc-cat-back">${card.cat}</div>
        <div class="fc-term-back">${card.term}</div>
        <div class="fc-def">${card.def}</div>
        ${card.ex ? `<div class="fc-ex">${card.ex}</div>` : ''}
      </div>
    </div>

    <div class="fc-buttons" id="fc-btns" style="display:none">
      <button class="fc-btn fc-btn-no" onclick="answerCard('non')">✗ Non</button>
      <button class="fc-btn fc-btn-bof" onclick="answerCard('bof')">~ Bof</button>
      <button class="fc-btn fc-btn-yes" onclick="answerCard('oui')">✓ Oui</button>
    </div>
    <div class="fc-swipe-hint" id="fc-hint">Appuie sur la carte pour révéler la définition</div>
  </div>
  `;

  initSwipe();

  // Load current box
  getCardProgress(subjectId).then(progress => {
    const p = progress[card.id];
    const boxEl = screen.querySelector('.fc-box');
    if (boxEl && p) {
      boxEl.textContent = `📦 Boîte ${p.box}`;
    }
  });
}

function flipCard() {
  const card = document.getElementById('fc-card');
  const btns = document.getElementById('fc-btns');
  const hint = document.getElementById('fc-hint');
  if (!card.classList.contains('flipped')) {
    card.classList.add('flipped');
    if (btns) btns.style.display = 'grid';
    if (hint) hint.style.display = 'none';
  }
}

function initSwipe() {
  const arena = document.querySelector('.fc-arena');
  if (!arena) return;
  let sx, sy, st;
  arena.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    st = Date.now();
  }, { passive: true });
  arena.addEventListener('touchend', e => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    const dt = Date.now() - st;
    sx = sy = null;
    if (dt > 600) return;
    const card = document.getElementById('fc-card');
    if (!card?.classList.contains('flipped')) return;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const fn = fcSession.mode === 'mix' ? answerCardMix : answerCard;
    if (ax > 60 && ax > ay * 1.2) {
      dx > 0 ? fn('oui') : fn('non');
    } else if (dy < -60 && ay > ax * 1.2) {
      fn('bof');
    }
  }, { passive: true });
}

function exitFlashcards(subjectId) {
  const { idx, correct, bof, wrong } = fcSession;
  const done = correct + (bof || 0) + wrong;
  if (done > 0) toast(`Session sauvegardée · ${done} carte${done > 1 ? 's' : ''} répondue${done > 1 ? 's' : ''}`);
  openSubject(subjectId);
}

async function answerCard(score) {
  const { subjectId, cards, idx } = fcSession;
  const card = cards[idx];

  await updateCard(subjectId, card.id, score);

  if (score === 'oui') fcSession.correct++;
  else if (score === 'bof') fcSession.bof = (fcSession.bof || 0) + 1;
  else fcSession.wrong++;

  fcSession.idx++;
  renderFlashcard();
}

function renderFlashcardEnd() {
  const { subjectId, cards, correct, bof, wrong } = fcSession;
  const s = subjects[subjectId];
  const screen = document.getElementById('screen-flashcard');
  const pct = Math.round(((correct + (bof || 0) * 0.5) / cards.length) * 100);
  const emoji = pct >= 80 ? '🎉' : pct >= 55 ? '💪' : '📚';
  const msg = pct >= 80 ? 'Excellent travail !' : pct >= 55 ? 'Continue comme ça !' : 'Révise encore ce soir !';

  screen.innerHTML = `
  <div class="fc-header">
    <button class="back-btn" onclick="openSubject('${subjectId}')">←</button>
    <div style="font-size:15px; font-weight:700; flex:1; text-align:center; color:var(--text)">Session terminée</div>
    <div style="width:38px"></div>
  </div>
  <div class="session-end">
    <div class="se-icon">${emoji}</div>
    <h2>${msg}</h2>
    <p>${s.name} · ${cards.length} cartes</p>
    <div class="session-score">
      <div class="ss-item">
        <div class="ss-num" style="color:#16a34a">${correct}</div>
        <div class="ss-label">Oui</div>
      </div>
      <div class="ss-item">
        <div class="ss-num" style="color:#d97706">${bof || 0}</div>
        <div class="ss-label">Bof</div>
      </div>
      <div class="ss-item">
        <div class="ss-num" style="color:#ef4444">${wrong}</div>
        <div class="ss-label">Non</div>
      </div>
    </div>
    <button class="btn-primary" onclick="startFlashcards('${subjectId}', '${fcSession.mode}')">Recommencer</button>
    <button class="btn-secondary" onclick="openSubject('${subjectId}')">Retour à ${s.name}</button>
  </div>
  `;
}

// ═══════════════════════════════════════════════════
// QCM MODE
// ═══════════════════════════════════════════════════
async function startQCM(subjectId, mode = 'due') {
  const s = subjects[subjectId];
  let questions;

  if (mode === 'quick') {
    questions = shuffle([...s.qcm]).slice(0, 5);
  } else if (mode === 'all') {
    questions = shuffle([...s.qcm]);
  } else {
    // 'due' : questions dont c'est le moment de revoir
    const due = await getDueQCMs(subjectId);
    questions = due.length > 0 ? shuffle(due) : shuffle([...s.qcm]).slice(0, 10);
    if (due.length === 0) toast('Toutes à jour — session de 10 questions aléatoires');
  }

  qcmSession = { subjectId, questions, idx: 0, correct: 0, mode };
  renderQCM();
  showScreen('qcm');
}

function renderQCM() {
  const { subjectId, questions, idx } = qcmSession;
  const s = subjects[subjectId];
  const screen = document.getElementById('screen-qcm');

  if (idx >= questions.length) {
    renderQCMEnd();
    return;
  }

  const q = questions[idx];
  const pct = Math.round((idx / questions.length) * 100);

  // Shuffle options, track new correct index
  const shuffledIdx = shuffle([0, 1, 2, 3].slice(0, q.opts.length));
  const shuffledOpts = shuffledIdx.map(i => q.opts[i]);
  const newAns = shuffledIdx.indexOf(q.ans);
  qcmSession.currentAns = newAns;

  const opts = shuffledOpts.map((opt, i) => `
    <button class="qcm-opt" onclick="answerQCM(${i})">${opt}</button>
  `).join('');

  screen.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="openSubject('${subjectId}')">←</button>
    <div class="fc-progress-bar">
      <div class="fc-progress-fill" style="width:${pct}%; background:${s.color}"></div>
    </div>
    <div class="fc-counter">${idx + 1}/${questions.length}</div>
  </div>
  <div class="qcm-arena">
    <div class="qcm-question">${q.q}</div>
    <div class="qcm-options">${opts}</div>
    <div id="qcm-expl"></div>
  </div>
  <button class="qcm-next-btn" id="qcm-next" onclick="nextQCM()">
    ${idx + 1 < questions.length ? 'Question suivante →' : 'Voir les résultats'}
  </button>
  `;
}

function answerQCM(chosen) {
  const { subjectId, questions, idx, currentAns } = qcmSession;
  const q = questions[idx];
  const opts = document.querySelectorAll('.qcm-opt');
  const correct = chosen === currentAns;

  opts.forEach(o => o.classList.add('disabled'));
  opts[currentAns].classList.add('correct');

  if (correct) {
    qcmSession.correct++;
    toast('✓ Bonne réponse !');
  } else {
    opts[chosen].classList.add('wrong');
    toast('✗ Pas tout à fait…');
  }

  // Mise à jour Leitner QCM
  updateQCM(subjectId, q.id, correct);

  if (q.exp) {
    document.getElementById('qcm-expl').innerHTML = `
      <div class="qcm-explanation">💡 ${q.exp}</div>`;
  }

  const nextBtn = document.getElementById('qcm-next');
  if (nextBtn) nextBtn.classList.add('show');
}

function nextQCM() {
  qcmSession.idx++;
  renderQCM();
}

function renderQCMEnd() {
  const { subjectId, questions, correct } = qcmSession;
  const s = subjects[subjectId];
  const screen = document.getElementById('screen-qcm');
  const pct = Math.round((correct / questions.length) * 100);
  const emoji = pct >= 80 ? '🎉' : pct >= 60 ? '💪' : '📖';
  const msg = pct >= 80 ? 'Excellente maîtrise !' : pct >= 60 ? 'Bon travail !' : 'Révise les notions manquées !';

  screen.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="openSubject('${subjectId}')">←</button>
    <div style="font-size:15px; font-weight:700; flex:1; text-align:center">QCM terminé</div>
    <div style="width:36px"></div>
  </div>
  <div class="session-end">
    <div class="se-icon">${emoji}</div>
    <h2>${msg}</h2>
    <p>${s.name} · ${questions.length} questions</p>
    <div class="session-score">
      <div class="ss-item">
        <div class="ss-num" style="color:#4ade80">${correct}</div>
        <div class="ss-label">Correctes</div>
      </div>
      <div class="ss-item">
        <div class="ss-num" style="color:#f87171">${questions.length - correct}</div>
        <div class="ss-label">Fausses</div>
      </div>
      <div class="ss-item">
        <div class="ss-num" style="color:${s.color}">${pct}%</div>
        <div class="ss-label">Score</div>
      </div>
    </div>
    <button class="btn-primary" onclick="startQCM('${subjectId}', '${qcmSession.mode}')">Recommencer</button>
    <button class="btn-secondary" onclick="openSubject('${subjectId}')">Retour à ${s.name}</button>
  </div>
  `;
}

// ═══════════════════════════════════════════════════
// STATS SCREEN
// ═══════════════════════════════════════════════════
async function showStatsScreen() {
  const screen = document.getElementById('screen-stats');

  const rows = await Promise.all(SUBJECTS_ORDER.map(async id => {
    const s = subjects[id];
    const stats = await getSubjectStats(id);
    const qp = await getQCMProgress(id);
    const qBoxes = [0, 0, 0];
    Object.values(qp).forEach(p => { qBoxes[Math.max(0, Math.min(2, p.box - 1))]++; });
    const qTotal = s.qcm.length;
    const qSeen = Object.keys(qp).length;
    const qPct = qTotal ? Math.round(qSeen / qTotal * 100) : 0;
    return `
    <div class="stats-subject">
      <div class="ss-stripe" style="background:${s.color}"></div>
      <div class="ss-name">${s.name}</div>
      <div class="ss-row-label">Flashcards</div>
      <div class="ss-bar-bg">
        <div class="ss-bar" style="width:${stats.pct}%; background:${s.color}"></div>
      </div>
      <div class="ss-detail">
        <span style="color:#ef4444">✗ ${stats.boxes[0]}</span>
        <span style="color:#d97706">~ ${stats.boxes[1]}</span>
        <span style="color:#16a34a">✓ ${stats.boxes[2]}</span>
        <span style="color:var(--muted)">${stats.pct}%</span>
      </div>
      <div class="ss-row-label" style="margin-top:10px">QCM</div>
      <div class="ss-bar-bg">
        <div class="ss-bar" style="width:${qPct}%; background:${s.color}; opacity:.6"></div>
      </div>
      <div class="ss-detail">
        <span style="color:#ef4444">✗ ${qBoxes[0]}</span>
        <span style="color:#d97706">~ ${qBoxes[1]}</span>
        <span style="color:#16a34a">✓ ${qBoxes[2]}</span>
        <span style="color:var(--muted)">${qSeen}/${qTotal} vus</span>
      </div>
    </div>`;
  }));

  screen.innerHTML = `
  <div class="stats-header">
    <button class="back-btn" onclick="goHome()">←</button>
    <h1>Statistiques</h1>
  </div>
  ${rows.join('')}
  <div class="stats-actions">
    <button class="action-btn action-sync" onclick="syncWithWiki()">
      <span class="ab-icon">🔄</span>
      <div><div class="ab-title">Sync Wiki</div><div class="ab-desc">Mise à jour checklists (WiFi maison)</div></div>
    </button>
    <button class="action-btn action-export" onclick="exportProgress()">
      <span class="ab-icon">📤</span>
      <div><div class="ab-title">Exporter</div><div class="ab-desc">Télécharger ma progression JSON</div></div>
    </button>
  </div>
  <button class="reset-btn" onclick="resetProgress()">🗑️ Réinitialiser la progression</button>
  `;

  showScreen('stats');
}

async function exportProgress() {
  const progress = await getAllProgress();
  const blob = new Blob([JSON.stringify({ progress, exported: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `studyapp-progress-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  toast('Progression exportée !');
}

async function syncWithWiki() {
  const btn = document.querySelector('.action-sync');
  if (btn) { btn.querySelector('.ab-title').textContent = 'Syncing…'; btn.disabled = true; }

  try {
    const progress = await getAllProgress();
    const total = Object.values(progress).reduce((s, sub) => s + Object.keys(sub).length, 0);
    if (total === 0) { toast('Aucune progression à synchroniser'); return; }

    const res = await fetch('http://localhost:8000/api/sync-studyapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress }),
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    toast(`✓ Wiki mis à jour · ${data.updated_count} items`);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'TypeError') {
      toast('StudyOS non joignable — connecte-toi au WiFi maison');
    } else {
      toast('Erreur sync : ' + e.message);
    }
  } finally {
    if (btn) { btn.querySelector('.ab-title').textContent = 'Sync Wiki'; btn.disabled = false; }
  }
}

async function resetProgress() {
  if (!confirm('Remettre toute la progression à zéro ?')) return;
  await dbClear();
  toast('Progression réinitialisée');
  goHome();
}

// ═══════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════
function goHome() {
  renderHome().then(() => showScreen('home'));
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
async function init() {
  try {
    db = await openDB();
    await loadAllSubjects();
    await renderHome();
    showScreen('home');

    // Register service worker + notification de mise à jour
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data?.type === 'SW_UPDATED') {
          const b = document.createElement('div');
          b.className = 'update-banner';
          b.innerHTML = `Nouvelle version disponible <button onclick="location.reload()">Recharger</button>`;
          document.body.appendChild(b);
          setTimeout(() => b.remove(), 12000);
        }
      });
    }
  } catch (err) {
    console.error('Init error:', err);
    document.getElementById('screen-home').innerHTML = `
      <div style="padding:40px 24px; text-align:center; color:#f87171">
        <div style="font-size:48px; margin-bottom:16px">⚠️</div>
        <h2>Erreur de chargement</h2>
        <p style="color:#a7a9be; margin-top:8px">Vérifie ta connexion puis recharge la page.</p>
      </div>`;
    showScreen('home');
  }
}

document.addEventListener('DOMContentLoaded', init);
