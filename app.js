'use strict';

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════
// Garder en phase avec CACHE dans sw.js à chaque déploiement
const APP_VERSION = 'v55';

const SUBJECTS_ORDER = ['geo', 'philo', 'bio', 'maths', 'francais', 'chimie'];

const SUBJECT_COLORS = {
  geo:      { primary: '#16a34a', light: '#f0fdf4', emoji: '🌍' },
  philo:    { primary: '#ea580c', light: '#fff7ed', emoji: '🧠' },
  bio:      { primary: '#0891b2', light: '#ecfeff', emoji: '🧬' },
  francais: { primary: '#ca8a04', light: '#fffbeb', emoji: '📚' },
  maths:    { primary: '#7c3aed', light: '#f5f3ff', emoji: '📐' },
  chimie:   { primary: '#db2777', light: '#fdf2f8', emoji: '⚗️' },
};

const LEITNER_DAYS = [1, 3, 7]; // par boîte 1, 2, 3

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
let db;
let subjects = {};
let currentSubject = null;
let fcSession = null;
let qcmSession = null;
let dashboardData = null;
let currentView = 'home';
let learnSubView = 'grid'; // 'grid' | 'detail' | 'flashcard' | 'qcm'
let studyTab = 'reviser'; // 'reviser' | 'explorer'

// Agenda
let agendaWeeks = [], agendaWeekIdx = 0, agendaDaySelected = null;

const WDAY_NAMES = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const FR_MONTHS_A = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'];

// ═══════════════════════════════════════════════════
// INDEXEDDB — spec-exact schema
// ═══════════════════════════════════════════════════
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('studyapp', 4);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress');
      if (!d.objectStoreNames.contains('qcm_progress')) d.createObjectStore('qcm_progress');
      if (!d.objectStoreNames.contains('controle_responses')) d.createObjectStore('controle_responses');
      if (!d.objectStoreNames.contains('questions')) d.createObjectStore('questions', { keyPath: 'id' });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e);
  });
}

async function dbGet(key) {
  return new Promise(res => {
    const tx = db.transaction('progress', 'readonly');
    tx.objectStore('progress').get(key).onsuccess = e => res(e.target.result);
  });
}

async function dbSet(key, value) {
  return new Promise(res => {
    const tx = db.transaction('progress', 'readwrite');
    tx.objectStore('progress').put(value, key);
    tx.oncomplete = () => res();
  });
}

async function dbClear() {
  return new Promise(res => {
    const tx = db.transaction(['progress', 'qcm_progress'], 'readwrite');
    tx.objectStore('progress').clear();
    tx.objectStore('qcm_progress').clear();
    tx.oncomplete = () => res();
  });
}

// ═══════════════════════════════════════════════════
// LEITNER — FLASHCARDS (spec-exact)
// ═══════════════════════════════════════════════════
async function getCardProgress(subjectId) {
  return (await dbGet(`cards_${subjectId}`)) || {};
}

async function saveCardProgress(subjectId, progress) {
  await dbSet(`cards_${subjectId}`, progress);
}

// score: 0 = Non, 1 = Bof, 2 = Oui
async function updateCard(subjectId, cardId, score) {
  const progress = await getCardProgress(subjectId);
  const now = Date.now();
  const p = progress[cardId] || { box: 1, nextReview: 0, streak: 0 };
  if (score === 2) {
    p.box = Math.min(3, p.box + 1);
    p.streak = (p.streak || 0) + 1;
  } else if (score === 0) {
    p.box = 1; p.streak = 0;
  }
  // score === 1 (Bof) : boîte inchangée
  p.nextReview = now + LEITNER_DAYS[p.box - 1] * 86400000;
  p.lastAnswered = now;
  progress[cardId] = p;
  await saveCardProgress(subjectId, progress);
  return p;
}

async function getDueCards(subjectId) {
  const s = subjects[subjectId];
  if (!s) return [];
  const progress = await getCardProgress(subjectId);
  const now = Date.now();
  return s.flashcards.filter(c => {
    const p = progress[c.id];
    return !p || p.nextReview <= now;
  });
}

async function getSubjectStats(subjectId) {
  const s = subjects[subjectId];
  if (!s) return { total: 0, b1: 0, b2: 0, b3: 0, due: 0 };
  const progress = await getCardProgress(subjectId);
  const now = Date.now();
  let b1 = 0, b2 = 0, b3 = 0, due = 0;
  s.flashcards.forEach(c => {
    const p = progress[c.id];
    if (!p) { b1++; due++; return; }
    if (p.box === 1) b1++;
    else if (p.box === 2) b2++;
    else b3++;
    if (p.nextReview <= now) due++;
  });
  return { total: s.flashcards.length, b1, b2, b3, due };
}

// ═══════════════════════════════════════════════════
// QCM — spec-exact
// ═══════════════════════════════════════════════════
async function getQCMProgress(subjectId) {
  return new Promise(res => {
    const tx = db.transaction('qcm_progress', 'readonly');
    tx.objectStore('qcm_progress').get(subjectId).onsuccess = e => res(e.target.result || {});
  });
}

async function saveQCMProgress(subjectId, progress) {
  return new Promise(res => {
    const tx = db.transaction('qcm_progress', 'readwrite');
    tx.objectStore('qcm_progress').put(progress, subjectId);
    tx.oncomplete = () => res();
  });
}

async function updateQCM(subjectId, qId, correct) {
  const progress = await getQCMProgress(subjectId);
  if (!progress[qId]) progress[qId] = { attempts: 0, correct: 0 };
  progress[qId].attempts++;
  if (correct) progress[qId].correct++;
  await saveQCMProgress(subjectId, progress);
}

async function getDueQCMs(subjectId) {
  const s = subjects[subjectId];
  if (!s) return [];
  const progress = await getQCMProgress(subjectId);
  return s.qcm.filter(q => {
    const p = progress[q.id];
    if (!p || p.attempts === 0) return true;
    return (p.correct / p.attempts) < 0.75;
  });
}

async function getQCMStats(subjectId) {
  const s = subjects[subjectId];
  if (!s) return { total: 0, mastered: 0, attempts: 0 };
  const progress = await getQCMProgress(subjectId);
  let mastered = 0, totalAttempts = 0;
  s.qcm.forEach(q => {
    const p = progress[q.id];
    if (p && p.attempts > 0) {
      totalAttempts += p.attempts;
      if (p.correct / p.attempts >= 0.75) mastered++;
    }
  });
  return { total: s.qcm.length, mastered, attempts: totalAttempts };
}

// ═══════════════════════════════════════════════════
// QUESTIONS — "?" pour signaler une incompréhension
// ═══════════════════════════════════════════════════
let questionContext = null;

function buildQuestionContext() {
  if (learnSubView === 'flashcard' && fcSession) {
    const card = fcSession.cards[fcSession.idx];
    const subId = card._subject || fcSession.subjectId;
    return {
      type: 'flashcard',
      subject: (subjects[subId] || {}).name || subId,
      id: card.id,
      label: `Carte : ${card.term}`,
      term: card.term,
      def: card.def
    };
  }
  if (learnSubView === 'qcm' && qcmSession) {
    const q = qcmSession.questions[qcmSession.idx];
    const subId = q._subject || qcmSession.subjectId;
    return {
      type: q.img ? 'qcm-image' : 'qcm',
      subject: (subjects[subId] || {}).name || subId,
      id: q.id,
      label: `QCM : ${q.q}`,
      question: q.q,
      img: q.img || null,
      opts: q.opts,
      ans: q.opts[q.ans]
    };
  }
  return { type: 'autre', label: 'Question générale', view: learnSubView };
}

function openQuestionModal() {
  questionContext = buildQuestionContext();
  document.getElementById('qmodal-context').textContent = questionContext.label;
  document.getElementById('qmodal-input').value = '';
  document.getElementById('question-modal').classList.add('show');
}

function closeQuestionModal() {
  document.getElementById('question-modal').classList.remove('show');
  questionContext = null;
}

async function saveQuestion() {
  const text = document.getElementById('qmodal-input').value.trim();
  if (!text) { toast('Écris ta question d\'abord'); return; }

  const tx = db.transaction('questions', 'readwrite');
  tx.objectStore('questions').put({
    id: `q-${Date.now()}`,
    date: new Date().toISOString(),
    question: text,
    context: questionContext
  });
  await new Promise(res => tx.oncomplete = res);

  toast('Question enregistrée !');
  closeQuestionModal();
}

async function getAllQuestions() {
  return new Promise(res => {
    const tx = db.transaction('questions', 'readonly');
    const req = tx.objectStore('questions').getAll();
    req.onsuccess = () => res(req.result);
  });
}

async function exportQuestions() {
  const questions = await getAllQuestions();
  if (!questions.length) { toast('Aucune question enregistrée'); return; }
  const blob = new Blob(['﻿' + JSON.stringify({ questions, exported: new Date().toISOString() }, null, 2)], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `studyapp-questions-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast(`${questions.length} question(s) exportée(s) !`);
}

// ═══════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════
async function loadSubject(id) {
  if (subjects[id]) return;
  const res = await fetch(`/data/${id}.json`);
  subjects[id] = await res.json();
}

async function loadAllSubjects() {
  await Promise.all(SUBJECTS_ORDER.map(id => loadSubject(id)));
}

const VOCAB_SOURCES = {
  bio:      { file: '/data/vocabulaire-bio.json',      name: 'Vocabulaire Biologie',   emoji: '🧬', color: '#0891b2' },
  geo:      { file: '/data/vocabulaire-geo.json',      name: 'Vocabulaire Géographie', emoji: '🌍', color: '#16a34a' },
  chimie:   { file: '/data/vocabulaire-chimie.json',   name: 'Vocabulaire Chimie',     emoji: '⚗️', color: '#db2777' },
  philo:    { file: '/data/vocabulaire-philo.json',    name: 'Vocabulaire Philo',      emoji: '🏛️', color: '#ea580c' },
  francais: { file: '/data/vocabulaire-francais.json', name: 'Vocabulaire Français',   emoji: '📖', color: '#ca8a04' },
};
const vocabCache = {};
async function loadVocabSource(id) {
  if (vocabCache[id]) return;
  try {
    const res = await fetch(VOCAB_SOURCES[id].file);
    vocabCache[id] = await res.json();
  } catch(e) { vocabCache[id] = { flashcards: [] }; }
}
// Legacy alias
async function loadVocab() { await loadVocabSource('bio'); }
Object.defineProperty(window, 'vocabData', { get: () => vocabCache['bio'] || null });

async function loadDashboard() {
  try {
    const res = await fetch('/data/dashboard.json');
    dashboardData = await res.json();
  } catch(e) { dashboardData = null; }
}

// ═══════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════
function daysUntil(dateStr) {
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const n = new Date(); n.setHours(0, 0, 0, 0);
  return Math.ceil((d - n) / 86400000);
}

function toast(msg, duration = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
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

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long' });
}

function capFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ═══════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const viewEl = document.getElementById(`view-${name}`);
  if (!viewEl) return;
  viewEl.classList.add('active');
  const btn = document.querySelector(`[data-nav="${name}"]`);
  if (btn) btn.classList.add('active');
  currentView = name;
  if (name === 'home') renderHome();
  else if (name === 'learn') {
    if (learnSubView === 'grid') renderStudyView();
  }
  else if (name === 'agenda') renderAgenda();
  else if (name === 'stats') renderStats();
}

// Navigate to subject from home card
function goToSubject(id) {
  showView('learn');
  openSubjectDetail(id);
}

// ═══════════════════════════════════════════════════
// VIEW 1 — HOME
// ═══════════════════════════════════════════════════
async function renderHome() {
  const view = document.getElementById('view-home');

  // Greeting
  const h = new Date().getHours();
  const greeting = h >= 18 ? 'Bonsoir Charles' : (h >= 12 ? 'Bon après-midi' : 'Bonjour Charles');
  const dateStr = new Date().toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });

  // Next exam hero card
  let nextExamHTML = '';
  if (dashboardData && dashboardData.next_exam) {
    const ne = dashboardData.next_exam;
    const days = daysUntil(ne.date);
    const col = SUBJECT_COLORS[ne.subject] || { primary: '#5C6BC0', light: '#EEF0FA' };
    const daysColor = days <= 3 ? '#dc2626' : days <= 7 ? '#d97706' : '#16a34a';
    // Maîtrise B3 de la matière concernée
    const neSubject = subjects[ne.subject];
    let masteryPctNE = 0;
    if (neSubject) {
      const neProgress = await getCardProgress(ne.subject);
      let neB1 = 0, neB2 = 0, neB3 = 0;
      neSubject.flashcards.forEach(c => {
        const p = neProgress[c.id];
        if (!p) return;
        if (p.box === 1) neB1++;
        else if (p.box === 2) neB2++;
        else neB3++;
      });
      const neScore = neB1 * 0.25 + neB2 * 0.6 + neB3 * 1.0;
      masteryPctNE = neSubject.flashcards.length ? Math.round(neScore / neSubject.flashcards.length * 100) : 0;
    }
    nextExamHTML = `
    <div class="section-label">Prochain examen</div>
    <div class="next-exam-card" onclick="showView('agenda')">
      <div class="nec-top">
        <div class="nec-emoji">${ne.emoji || col.emoji || '📅'}</div>
        <div class="nec-info">
          <div class="nec-name">${ne.name}</div>
          <div class="nec-type">${ne.type} · ${formatDate(ne.date)}</div>
        </div>
        <div class="nec-days" style="color:${daysColor}">${days}j</div>
      </div>
      <div style="margin-top:14px">
        <div class="nec-prog-label">Concepts maîtrisés (B3)</div>
        <div class="prog-track" style="margin-top:6px">
          <div class="prog-fill" style="width:${masteryPctNE}%;background:${col.primary}"></div>
        </div>
        <div class="nec-prog-num">${masteryPctNE}%</div>
      </div>
    </div>`;
  }

  // Subject grid
  const dashSubjects = (dashboardData && dashboardData.subjects) ? dashboardData.subjects : {};
  const progCards = await Promise.all(SUBJECTS_ORDER.map(async id => {
    const s = subjects[id];
    if (!s) return '';
    const col = SUBJECT_COLORS[id] || { primary: '#5C6BC0', light: '#EEF0FA', emoji: '📖' };
    const days = daysUntil(s.exam);
    const progress = await getCardProgress(id);
    const total = s.flashcards.length;
    let b1 = 0, b2 = 0, b3 = 0;
    s.flashcards.forEach(c => {
      const p = progress[c.id];
      if (!p) return;
      if (p.box === 1) b1++;
      else if (p.box === 2) b2++;
      else b3++;
    });
    // Score pondéré : B1=25%, B2=60%, B3=100%
    const score = b1 * 0.25 + b2 * 0.6 + b3 * 1.0;
    const masteryPct = total ? Math.round(score / total * 100) : 0;

    return `
    <div class="subject-cell" onclick="goToSubject('${id}')">
      <div class="sc-emoji">${col.emoji}</div>
      <div class="sc-name">${s.name}</div>
      <div class="sc-days" style="color:${col.primary}">${days}j</div>
      <div class="prog-track" style="margin-top:8px">
        <div class="prog-fill" style="width:${masteryPct}%;background:${col.primary}"></div>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:3px;font-weight:600">${masteryPct}%</div>
    </div>`;
  }));

  // Today planning
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayPlan = dashboardData ? (dashboardData.planning || []).find(p => p.fullDate === todayStr) : null;
  let todayTasksHTML = '';
  if (todayPlan) {
    if (todayPlan.isExam) {
      const examColor = todayPlan.examColor || 'var(--accent)';
      const examTask = todayPlan.tasks && todayPlan.tasks[0];
      todayTasksHTML += `<div class="today-exam-band" style="background:${examColor}">🎯 EXAM — ${examTask ? examTask.text : 'Jour d\'examen'}</div>`;
      (todayPlan.tasks || []).slice(1).forEach(t => {
        todayTasksHTML += `<div class="today-slot"><div class="today-task"><span class="today-task-place">${t.place || ''}</span><span class="today-task-text">${t.text}</span></div></div>`;
      });
    } else {
      const slots = { 'Matin': [], 'Après-midi': [], 'Soir': [] };
      const slotEmoji = { 'Matin': '🌅', 'Après-midi': '☀️', 'Soir': '🌙' };
      const tasks = todayPlan.tasks || [];
      if (tasks.length > 0) {
        tasks.forEach(t => {
          const slot = slots[t.time] !== undefined ? t.time : 'Matin';
          slots[slot].push(t);
        });
        Object.entries(slots).forEach(([slot, items]) => {
          if (!items.length) return;
          const rows = items.map(t =>
            `<div class="today-task"><span class="today-task-place">${t.place || ''}</span><span class="today-task-text">${t.text}</span></div>`
          ).join('');
          todayTasksHTML += `<div class="today-slot"><div class="today-slot-title">${slotEmoji[slot]} ${slot}</div>${rows}</div>`;
        });
      } else {
        todayTasksHTML = `<div class="today-empty">Rien de prévu aujourd'hui</div>`;
      }
    }
  } else {
    todayTasksHTML = `<div class="today-empty">Rien de prévu aujourd'hui</div>`;
  }

  const syncDate = (dashboardData && dashboardData.generated)
    ? new Date(dashboardData.generated).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;

  view.innerHTML = `
  <div class="home-header">
    <div class="home-greeting">${capFirst(dateStr)}</div>
    <div class="home-date">${greeting} 👋</div>
  </div>

  ${nextExamHTML}

  <div class="section-label">Matières</div>
  <div class="subject-grid">${progCards.join('')}</div>

  <div class="section-label">Aujourd'hui</div>
  <div class="today-plan-card">
    ${todayTasksHTML}
  </div>

  ${syncDate ? `<div class="sync-footer"><span class="sync-dot"></span>Sync Claude : ${syncDate}</div>` : ''}
  `;
}

// ═══════════════════════════════════════════════════
// VIEW 2+3 — ÉTUDIER (Réviser + Explorer fusionnés)
// ═══════════════════════════════════════════════════

function setStudyTab(tab) {
  studyTab = tab;
  renderStudyView();
}

async function renderStudyView() {
  learnSubView = 'grid';
  const view = document.getElementById('view-learn');

  const segCtrl = `
  <div class="seg-ctrl">
    <button class="seg-btn${studyTab === 'reviser' ? ' active' : ''}" onclick="setStudyTab('reviser')">Réviser</button>
    <button class="seg-btn${studyTab === 'explorer' ? ' active' : ''}" onclick="setStudyTab('explorer')">Explorer</button>
  </div>`;

  if (studyTab === 'reviser') {
    const now = Date.now();

    // ── Matières : FC + QCM dus ──
    let totalFC = 0, totalQCM = 0;
    const subjectData = [];

    for (const id of SUBJECTS_ORDER) {
      const s = subjects[id];
      if (!s) continue;
      const col = SUBJECT_COLORS[id];
      const fcDue = await getDueCards(id);
      const qcmDue = await getDueQCMs(id);
      totalFC += fcDue.length;
      totalQCM += qcmDue.length;
      if (fcDue.length > 0 || qcmDue.length > 0) {
        subjectData.push({ id, name: s.name, col, fcDue: fcDue.length, qcmDue: qcmDue.length });
      }
    }

    // ── Vocabulaire dû ──
    const vocabDue = [];
    for (const [srcId, src] of Object.entries(VOCAB_SOURCES)) {
      await loadVocabSource(srcId);
      const allCards = (vocabCache[srcId] || { flashcards: [] }).flashcards;
      const progress = await getCardProgress(`vocab_${srcId}`);
      const due = allCards.filter(c => { const p = progress[c.id]; return !p || p.nextReview <= now; });
      if (due.length > 0) vocabDue.push({ srcId, src, count: due.length });
    }

    const totalAll = totalFC + totalQCM + vocabDue.reduce((s, v) => s + v.count, 0);

    const counterHTML = totalAll === 0
      ? `<div class="today-counter-card all-done"><div class="tc-left"><div class="tc-all-done">🎉 Tout est à jour !</div><div class="tc-label">Reviens demain pour la suite.</div></div></div>`
      : `<div class="today-counter-card">
           <div class="tc-left">
             <div class="tc-num">${totalAll}</div>
             <div class="tc-label">à réviser aujourd'hui</div>
           </div>
           <button class="tc-btn btn-accent" onclick="startTodaySession()">Tout réviser</button>
         </div>`;

    const subjectRows = subjectData.map(d => {
      const total = d.fcDue + d.qcmDue;
      const details = [
        d.fcDue > 0 ? `${d.fcDue} FC` : '',
        d.qcmDue > 0 ? `${d.qcmDue} QCM` : ''
      ].filter(Boolean).join(' · ');
      return `
      <div class="today-subject-row" style="border-left-color:${d.col.primary}">
        <div class="tsr-emoji">${d.col.emoji}</div>
        <div class="tsr-info">
          <div class="tsr-name">${d.name}</div>
          <div class="tsr-count">${details}</div>
        </div>
        <button class="btn" style="color:${d.col.primary};padding:10px 14px;font-size:13px" onclick="startSubjectRevision('${d.id}')">Réviser</button>
      </div>`;
    }).join('');

    const vocabRows = vocabDue.map(v => `
      <div class="today-subject-row" style="border-left-color:${v.src.color}">
        <div class="tsr-emoji">${v.src.emoji}</div>
        <div class="tsr-info">
          <div class="tsr-name">${v.src.name}</div>
          <div class="tsr-count">${v.count} termes dus</div>
        </div>
        <button class="btn" style="color:${v.src.color};padding:10px 14px;font-size:13px" onclick="startVocab('${v.srcId}',null)">Réviser</button>
      </div>`).join('');

    view.innerHTML = `
    <div class="view-header"><div class="view-title">Étudier</div></div>
    ${segCtrl}
    ${counterHTML}
    ${subjectData.length > 0 ? `
      <div class="section-label">Par matière</div>
      <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${subjectRows}</div>` : ''}
    ${vocabDue.length > 0 ? `
      <div class="section-label">Vocabulaire</div>
      <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${vocabRows}</div>` : ''}
    ${totalAll === 0 ? '' : `<div class="today-note">💡 Boîtes Leitner : B1 → 1j · B2 → 3j · B3 → 7j</div>`}
    `;
  } else {
    // — Onglet Explorer : vocabulaire + matières
    const subjectCards = await Promise.all(SUBJECTS_ORDER.map(async id => {
      const s = subjects[id];
      if (!s) return '';
      const col = SUBJECT_COLORS[id] || { primary: '#5C6BC0', light: '#EEF0FA', emoji: '📖' };
      const stats = await getSubjectStats(id);
      const days = daysUntil(s.exam);
      const b1pct = stats.total ? Math.round(stats.b1 / stats.total * 100) : 0;
      const b2pct = stats.total ? Math.round(stats.b2 / stats.total * 100) : 0;
      const b3pct2 = stats.total ? Math.round(stats.b3 / stats.total * 100) : 0;
      return `
      <div class="subject-learn-card" onclick="openSubjectDetail('${id}')">
        <div class="slc-header">
          <div class="slc-left">
            <div class="slc-emoji">${col.emoji}</div>
            <div>
              <div class="slc-name">${s.name}</div>
              <div class="slc-meta">${s.flashcards.length} cartes · ${s.qcm.length} QCM</div>
            </div>
          </div>
          <div class="slc-days" style="color:${col.primary}">${days}j</div>
        </div>
        <div class="leitner-bars">
          <div class="lb-row"><div class="lb-dot" style="background:#ef4444"></div><div class="lb-track"><div style="width:${b1pct}%;background:#ef4444" class="lb-fill"></div></div><div class="lb-n">${stats.b1}</div></div>
          <div class="lb-row"><div class="lb-dot" style="background:#f97316"></div><div class="lb-track"><div style="width:${b2pct}%;background:#f97316" class="lb-fill"></div></div><div class="lb-n">${stats.b2}</div></div>
          <div class="lb-row"><div class="lb-dot" style="background:#16a34a"></div><div class="lb-track"><div style="width:${b3pct2}%;background:#16a34a" class="lb-fill"></div></div><div class="lb-n">${stats.b3}</div></div>
        </div>
        ${stats.due > 0 ? `<div class="due-badge" style="background:${col.primary}">${stats.due} à revoir</div>` : ''}
      </div>`;
    }));

    await Promise.all(Object.keys(VOCAB_SOURCES).map(id => loadVocabSource(id)));
    const vocabCards = Object.entries(VOCAB_SOURCES).map(([id, src]) => {
      const data = vocabCache[id];
      const count = data ? data.flashcards.length : 0;
      const cats  = data ? [...new Set(data.flashcards.map(c => c.cat))].length : 0;
      return `<div class="vocab-card" onclick="openVocabDetail('${id}')" style="border-left-color:${src.color}">
        <div class="vc-left">
          <div class="vc-icon">${src.emoji}</div>
          <div>
            <div class="vc-name">${src.name}</div>
            <div class="vc-meta">${count} termes · ${cats} thèmes</div>
          </div>
        </div>
        <div class="vc-arrow">›</div>
      </div>`;
    }).join('');

    const antiVocabCards = Object.entries(VOCAB_SOURCES).map(([id, src]) => {
      const data = vocabCache[id];
      const count = data ? data.flashcards.length : 0;
      return `<div class="vocab-card" onclick="openAntiVocabDetail('${id}')" style="border-left-color:${src.color};opacity:.9">
        <div class="vc-left">
          <div class="vc-icon">🔄</div>
          <div>
            <div class="vc-name">${src.name.replace('Vocabulaire', 'Anti-vocab')}</div>
            <div class="vc-meta">${count} définitions → trouver le terme</div>
          </div>
        </div>
        <div class="vc-arrow">›</div>
      </div>`;
    }).join('');

    view.innerHTML = `
    <div class="view-header"><div class="view-title">Étudier</div></div>
    ${segCtrl}
    <div class="mix-row">
      <button class="mix-btn" onclick="startMix('flashcard')">🔀 Mix Flashcards</button>
      <button class="mix-btn" onclick="startMix('qcm')">🎯 Mix QCM</button>
    </div>
    <div class="section-label">Vocabulaire</div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${vocabCards}</div>
    <div class="section-label">Anti-vocabulaire</div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${antiVocabCards}</div>
    <div class="section-label">Fiches de révision</div>
    <div style="padding:0 16px;margin-bottom:14px">
      <div class="vocab-card" onclick="openFichesList()" style="border-left-color:#ca8a04">
        <div class="vc-left">
          <div class="vc-icon">📖</div>
          <div>
            <div class="vc-name">Mes fiches</div>
            <div class="vc-meta">À lire le soir, contrôle à froid le lendemain</div>
          </div>
        </div>
        <div class="vc-arrow">›</div>
      </div>
    </div>
    <div class="section-label">Contrôles</div>
    <div style="padding:0 16px;margin-bottom:14px">
      <div class="vocab-card" onclick="openControleList()" style="border-left-color:#6d28d9">
        <div class="vc-left">
          <div class="vc-icon">📝</div>
          <div>
            <div class="vc-name">Mes contrôles</div>
            <div class="vc-meta">Questions ouvertes · timer caché · export JSON</div>
          </div>
        </div>
        <div class="vc-arrow">›</div>
      </div>
    </div>
    <div class="section-label">Matières</div>
    ${subjectCards.join('')}
    <div style="height:20px"></div>
    `;
  }
}

// Alias pour compatibilité (appelé par openVocabDetail, etc.)
function renderLearnGrid() { renderStudyView(); }

async function startTodaySession() {
  const allDue = [];
  for (const id of SUBJECTS_ORDER) {
    const due = await getDueCards(id);
    due.forEach(c => allDue.push({ ...c, _subject: id }));
  }
  if (allDue.length === 0) { toast('Rien à réviser !'); return; }
  fcSession = { subjectId: 'mix', cards: shuffle(allDue), idx: 0, correct: 0, bof: 0, wrong: 0, mode: 'today' };
  learnSubView = 'flashcard';
  showView('learn');
  renderFlashcard();
}

async function startSubjectTodaySession(subjectId) {
  const due = await getDueCards(subjectId);
  if (due.length === 0) { toast('Rien à réviser pour cette matière !'); return; }
  await startFlashcards(subjectId, 'due');
  showView('learn');
}

async function startSubjectRevision(subjectId) {
  const fcDue = await getDueCards(subjectId);
  const qcmDue = await getDueQCMs(subjectId);
  if (fcDue.length === 0 && qcmDue.length === 0) { toast('Tout est à jour !'); return; }
  if (fcDue.length === 0) { await startQCM(subjectId, 'due'); return; }
  // Lance FC en premier, puis QCM si dispo
  fcSession = {
    subjectId,
    cards: fcDue,
    idx: 0, correct: 0, bof: 0, wrong: 0, mode: 'due',
    _qcmAfter: qcmDue.length > 0 ? subjectId : null
  };
  learnSubView = 'flashcard';
  showView('learn');
  renderFlashcard();
}

// 3b — détail sujet
async function openSubjectDetail(id) {
  learnSubView = 'detail';
  currentSubject = id;
  const s = subjects[id];
  const col = SUBJECT_COLORS[id] || { primary: '#5C6BC0', light: '#EEF0FA', emoji: '📖' };
  const stats = await getSubjectStats(id);
  const dueFC = await getDueCards(id);
  const qcmStats = await getQCMStats(id);
  const qcmDue = await getDueQCMs(id);
  const view = document.getElementById('view-learn');
  const days = daysUntil(s.exam);

  const b3pct = stats.total ? Math.round(stats.b3 / stats.total * 100) : 0;

  view.innerHTML = `
  <div style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="renderLearnGrid()">←</button>
    <div>
      <div style="font-size:22px;font-weight:900;color:var(--text);letter-spacing:-.4px">${col.emoji} ${s.name}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">${s.type || 'Matière'} · dans ${days} jours · ${formatDate(s.exam)}</div>
    </div>
  </div>

  <div class="leitner-stat-row">
    <div class="lstat" style="--c:#ef4444"><div class="lstat-n">${stats.b1}</div><div class="lstat-l">Boîte 1</div></div>
    <div class="lstat" style="--c:#f97316"><div class="lstat-n">${stats.b2}</div><div class="lstat-l">Boîte 2</div></div>
    <div class="lstat" style="--c:#16a34a"><div class="lstat-n">${stats.b3}</div><div class="lstat-l">Boîte 3</div></div>
  </div>

  <div class="section-label">Réviser</div>
  <div class="action-list">
    <div class="action-btn" onclick="startFlashcards('${id}','due')">
      <div class="ab-icon">📖</div>
      <div class="ab-info"><div class="ab-title">Flashcards Leitner</div><div class="ab-sub">${dueFC.length} cartes dues aujourd'hui</div></div>
      <div class="ab-arrow">›</div>
    </div>
    <div class="action-btn" onclick="startQCM('${id}','due')">
      <div class="ab-icon">❓</div>
      <div class="ab-info"><div class="ab-title">QCM Leitner</div><div class="ab-sub">${qcmDue.length} questions dues</div></div>
      <div class="ab-arrow">›</div>
    </div>
    <div class="action-btn" onclick="startFlashcards('${id}','all')">
      <div class="ab-icon">🃏</div>
      <div class="ab-info"><div class="ab-title">Toutes les cartes</div><div class="ab-sub">${s.flashcards.length} au total</div></div>
      <div class="ab-arrow">›</div>
    </div>
    <div class="action-btn" onclick="startQCM('${id}','quick')">
      <div class="ab-icon">⚡</div>
      <div class="ab-info"><div class="ab-title">QCM rapide</div><div class="ab-sub">5 questions aléatoires</div></div>
      <div class="ab-arrow">›</div>
    </div>
    <div class="action-btn" onclick="startQCM('${id}','all')">
      <div class="ab-icon">📝</div>
      <div class="ab-info"><div class="ab-title">Tous les QCM</div><div class="ab-sub">${s.qcm.length} questions</div></div>
      <div class="ab-arrow">›</div>
    </div>
    ${s.qcmImg && s.qcmImg.length ? `
    <div class="action-btn" onclick="startQCMImg('${id}','quick')">
      <div class="ab-icon">🔬</div>
      <div class="ab-info"><div class="ab-title">QCM Microscopie</div><div class="ab-sub">10 images aléatoires (sur ${s.qcmImg.length})</div></div>
      <div class="ab-arrow">›</div>
    </div>
    ` : ''}
  </div>
  <div class="subj-mastery">${b3pct}% maîtrisé · ${stats.b3} cartes en B3 · ${qcmStats.mastered}/${qcmStats.total} QCM</div>
  `;
}

// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// VOCABULAIRE
// ═══════════════════════════════════════════════════
async function openVocabDetail(sourceId = 'bio') {
  await loadVocabSource(sourceId);
  const src   = VOCAB_SOURCES[sourceId];
  const data  = vocabCache[sourceId];
  const cards = data ? data.flashcards : [];
  const cats  = [...new Set(cards.map(c => c.cat))];
  const view  = document.getElementById('view-learn');

  const catRows = cats.map(cat => {
    const n = cards.filter(c => c.cat === cat).length;
    return `<div class="action-btn" onclick="startVocab('${sourceId}','${cat.replace(/'/g,"\\'")}')">
      <div class="ab-icon">📖</div>
      <div class="ab-info"><div class="ab-title">${cat}</div><div class="ab-sub">${n} termes</div></div>
      <div class="ab-arrow">›</div>
    </div>`;
  }).join('');

  view.innerHTML = `
  <div style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="renderLearnGrid()">←</button>
    <div>
      <div style="font-size:20px;font-weight:900;color:var(--text)">${src.emoji} ${src.name}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">${cards.length} termes · ${cats.length} thèmes</div>
    </div>
  </div>
  <div style="padding:0 16px;margin-bottom:14px">
    <div class="action-btn" onclick="startVocab('${sourceId}',null)">
      <div class="ab-icon">🔀</div>
      <div class="ab-info"><div class="ab-title">Tous les termes (mélangés)</div><div class="ab-sub">${cards.length} cartes</div></div>
      <div class="ab-arrow">›</div>
    </div>
  </div>
  <div class="section-label">Par thème</div>
  <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:20px">${catRows}</div>
  `;
}

async function startVocab(sourceId = 'bio', cat = null) {
  await loadVocabSource(sourceId);
  const src = VOCAB_SOURCES[sourceId];
  const all = (vocabCache[sourceId] || { flashcards: [] }).flashcards;
  let cards = cat ? all.filter(c => c.cat === cat) : shuffle([...all]);
  if (!cards.length) return;

  fcSession = {
    subjectId: 'vocab',
    cards: cards.map(c => ({ ...c, _subject: `vocab_${sourceId}` })),
    idx: 0, correct: 0, bof: 0, wrong: 0,
    _backFn: `openVocabDetail('${sourceId}')`,
    _color: src.color
  };
  renderFlashcard();
}

async function openAntiVocabDetail(sourceId = 'bio') {
  await loadVocabSource(sourceId);
  const src   = VOCAB_SOURCES[sourceId];
  const data  = vocabCache[sourceId];
  const cards = data ? data.flashcards : [];
  const cats  = [...new Set(cards.map(c => c.cat))];
  const view  = document.getElementById('view-learn');

  const catRows = cats.map(cat => {
    const n = cards.filter(c => c.cat === cat).length;
    return `<div class="action-btn" onclick="startAntiVocab('${sourceId}','${cat.replace(/'/g,"\\'")}')">
      <div class="ab-icon">🔄</div>
      <div class="ab-info"><div class="ab-title">${cat}</div><div class="ab-sub">${n} définitions</div></div>
      <div class="ab-arrow">›</div>
    </div>`;
  }).join('');

  view.innerHTML = `
  <div style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="renderStudyView()">←</button>
    <div>
      <div style="font-size:20px;font-weight:900;color:var(--text)">🔄 Anti-vocab ${src.name.replace('Vocabulaire ','')}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">Définition → trouver le terme · ${cards.length} cartes</div>
    </div>
  </div>
  <div style="padding:0 16px;margin-bottom:14px">
    <div class="action-btn" onclick="startAntiVocab('${sourceId}',null)">
      <div class="ab-icon">🔀</div>
      <div class="ab-info"><div class="ab-title">Tous les termes (mélangés)</div><div class="ab-sub">${cards.length} cartes</div></div>
      <div class="ab-arrow">›</div>
    </div>
  </div>
  <div class="section-label">Par thème</div>
  <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:20px">${catRows}</div>
  `;
}

async function startAntiVocab(sourceId = 'bio', cat = null) {
  await loadVocabSource(sourceId);
  const src = VOCAB_SOURCES[sourceId];
  const all = (vocabCache[sourceId] || { flashcards: [] }).flashcards;
  let cards = cat ? all.filter(c => c.cat === cat) : shuffle([...all]);
  if (!cards.length) return;

  learnSubView = 'flashcard';
  fcSession = {
    subjectId: 'antivocab',
    cards: cards.map(c => ({ ...c, _subject: `antivocab_${sourceId}` })),
    idx: 0, correct: 0, bof: 0, wrong: 0,
    _backFn: `openAntiVocabDetail('${sourceId}')`,
    _color: src.color
  };
  showView('learn');
  renderFlashcard();
}

// MIX MODE
// ═══════════════════════════════════════════════════
async function startMix(mode) {
  if (mode === 'flashcard') {
    let allCards = [];
    for (const id of SUBJECTS_ORDER) {
      const s = subjects[id];
      if (!s) continue;
      s.flashcards.forEach(c => allCards.push({ ...c, _subject: id }));
    }
    allCards = shuffle(allCards);
    fcSession = { subjectId: 'mix', cards: allCards, idx: 0, correct: 0, bof: 0, wrong: 0, mode: 'mix' };
    learnSubView = 'flashcard';
    renderFlashcard();
  } else {
    let allQCM = [];
    for (const id of SUBJECTS_ORDER) {
      const s = subjects[id];
      if (!s) continue;
      s.qcm.forEach(q => allQCM.push({ ...q, _subject: id }));
    }
    qcmSession = { subjectId: 'mix', questions: shuffle(allQCM).slice(0, 20), idx: 0, correct: 0, mode: 'mix' };
    learnSubView = 'qcm';
    renderQCM();
  }
}

// ═══════════════════════════════════════════════════
// FLASHCARD SESSION
// ═══════════════════════════════════════════════════
async function startFlashcards(subjectId, mode) {
  const s = subjects[subjectId];
  let cards = mode === 'due' ? await getDueCards(subjectId) : [...s.flashcards];
  if (cards.length === 0) { toast('🎉 Toutes les cartes sont à jour !'); return; }
  cards = shuffle(cards);
  fcSession = { subjectId, cards, idx: 0, correct: 0, bof: 0, wrong: 0, mode };
  learnSubView = 'flashcard';
  renderFlashcard();
}

function renderFlashcard() {
  const { subjectId, cards, idx } = fcSession;
  const isMix = subjectId === 'mix';
  const view = document.getElementById('view-learn');

  if (idx >= cards.length) { renderFlashcardEnd(); return; }

  const card = cards[idx];
  const subId = card._subject || subjectId;
  const isVocab = subjectId.startsWith('vocab_') || subjectId === 'vocab';
  const isAntiVocab = subjectId.startsWith('antivocab_') || subjectId === 'antivocab';
  const vocabColor = (isVocab || isAntiVocab) ? (fcSession._color || '#0891b2') : null;
  const col = (isVocab || isAntiVocab) ? { primary: vocabColor } : (SUBJECT_COLORS[subId] || { primary: '#5C6BC0' });
  const pct = Math.round((idx / cards.length) * 100);
  const catLabel = (isVocab || isAntiVocab) ? card.cat : isMix ? `${(subjects[subId] || {}).name || subId} · ${card.cat}` : card.cat;
  const backRef = (isVocab || isAntiVocab) ? (fcSession._backFn || 'renderStudyView()') : isMix ? 'renderStudyView()' : `openSubjectDetail('${subjectId}')`;

  const frontContent = isAntiVocab
    ? `<div class="fc-cat">${catLabel}</div>
       <div class="fc-def fc-def-front">${card.short_def || (card.def || '').split('\n')[0]}</div>
       <div class="fc-hint">Quel est le terme ?</div>`
    : `<div class="fc-cat">${catLabel}</div>
       <div class="fc-term">${card.term}</div>
       <div class="fc-hint">Appuie pour voir la réponse</div>`;

  const backContent = isAntiVocab
    ? `<div class="fc-cat">${catLabel}</div>
       <div class="fc-term" style="color:${col.primary}">${card.term}</div>`
    : `<div class="fc-cat">${catLabel}</div>
       <div class="fc-term-back">${card.term}</div>
       <div class="fc-def">${(card.def || '').replace(/\n/g, '<br>')}</div>
       ${card.ex ? `<div class="fc-ex"><span class="fc-ex-label">En contexte</span>${card.ex}</div>` : ''}`;

  const buttons = isAntiVocab
    ? `<button class="fc-btn fc-non" onclick="answerCard(0)">✗<span>Je cherche</span></button>
       <button class="fc-btn fc-oui" onclick="answerCard(2)">✓<span>Je savais</span></button>`
    : `<button class="fc-btn fc-non" onclick="answerCard(0)">✗<span>Non</span></button>
       <button class="fc-btn fc-bof" onclick="answerCard(1)">〜<span>Bof</span></button>
       <button class="fc-btn fc-oui" onclick="answerCard(2)">✓<span>Oui</span></button>`;

  view.innerHTML = `
  <div class="fc-layout">
    <div class="fc-header">
      <button class="back-btn" onclick="${backRef}">←</button>
      <div class="fc-progress-bar">
        <div class="fc-progress-fill" style="width:${pct}%; background:${col.primary}"></div>
      </div>
      <div class="fc-counter">${idx + 1}/${cards.length}</div>
      <button class="help-btn" onclick="openQuestionModal()">?</button>
    </div>
    <div class="fc-card-area">
      <div class="fc-card" id="fc-card" onclick="flipCard()">
        <div class="fc-face fc-front" id="fc-front">${frontContent}</div>
        <div class="fc-face fc-back" id="fc-back">${backContent}</div>
      </div>
    </div>
    <div class="fc-buttons" id="fc-btns">${buttons}</div>
  </div>
  `;

  // Montrer front, cacher back+boutons
  document.getElementById('fc-back').style.display = 'none';
  document.getElementById('fc-btns').style.visibility = 'hidden';

  getCardProgress(subId).then(progress => {
    const p = progress[card.id];
    const cat = document.querySelector('#fc-front .fc-cat');
    if (cat && p) cat.textContent += ` · B${p.box}`;
  });
}

function flipCard() {
  const front = document.getElementById('fc-front');
  const back  = document.getElementById('fc-back');
  const btns  = document.getElementById('fc-btns');
  if (!front || front.style.display === 'none') return;
  front.style.display = 'none';
  back.style.display  = 'flex';
  btns.style.visibility = 'visible';
}

async function answerCard(score) {
  const { subjectId, cards, idx } = fcSession;
  const card = cards[idx];
  const subId = card._subject || subjectId;
  await updateCard(subId, card.id, score);
  if (score === 2) fcSession.correct++;
  else if (score === 1) fcSession.bof++;
  else fcSession.wrong++;
  fcSession.idx++;
  renderFlashcard();
}

function renderFlashcardEnd() {
  const { subjectId, cards, correct, bof, wrong, mode } = fcSession;
  const isMix = subjectId === 'mix';
  const isVocabEnd = subjectId === 'vocab' || subjectId.startsWith('vocab_');
  const isAntiVocabEnd = subjectId === 'antivocab' || subjectId.startsWith('antivocab_');
  const isVocabAny = isVocabEnd || isAntiVocabEnd;

  const sessionName = isMix ? 'Mix'
    : isAntiVocabEnd ? 'Anti-vocabulaire'
    : isVocabEnd ? 'Vocabulaire'
    : (subjects[subjectId] || {}).name || subjectId;

  const backFn = isMix || isVocabAny
    ? (fcSession._backFn || 'renderStudyView()')
    : `openSubjectDetail('${subjectId}')`;

  const view = document.getElementById('view-learn');
  const total = cards.length;
  const pct = total ? Math.round(((correct + bof * 0.5) / total) * 100) : 0;
  const emoji = pct >= 80 ? '🎉' : pct >= 55 ? '💪' : '📚';
  const msg = pct >= 80 ? 'Excellent travail !' : pct >= 55 ? 'Continue comme ça !' : 'Révise encore ce soir !';

  const scoresHtml = isAntiVocabEnd
    ? `<div class="ses-item" style="color:#ef4444"><div class="ses-n">${wrong}</div><div class="ses-l">Je cherche</div></div>
       <div class="ses-item" style="color:#16a34a"><div class="ses-n">${correct}</div><div class="ses-l">Je savais</div></div>`
    : `<div class="ses-item" style="color:#ef4444"><div class="ses-n">${wrong}</div><div class="ses-l">Non</div></div>
       <div class="ses-item" style="color:#f97316"><div class="ses-n">${bof}</div><div class="ses-l">Bof</div></div>
       <div class="ses-item" style="color:#16a34a"><div class="ses-n">${correct}</div><div class="ses-l">Oui</div></div>`;

  const qcmAfter = fcSession._qcmAfter;
  const actionHtml = isVocabAny
    ? `<button class="btn-primary" onclick="${backFn}">Retour</button>`
    : isMix
    ? `<button class="btn-primary" onclick="startMix('flashcard')">Recommencer</button>
       <button class="btn-secondary" onclick="renderStudyView()">Retour</button>`
    : qcmAfter
    ? `<button class="btn-primary" onclick="startQCM('${qcmAfter}','due')">Continuer → QCM</button>
       <button class="btn-secondary" onclick="renderStudyView()">Retour</button>`
    : `<button class="btn-primary" onclick="startFlashcards('${subjectId}', '${mode}')">Recommencer</button>
       <button class="btn-secondary" onclick="openSubjectDetail('${subjectId}')">Retour</button>`;

  view.innerHTML = `
  <div class="fc-header">
    <button class="back-btn" onclick="${backFn}">←</button>
    <div style="font-size:15px;font-weight:700;flex:1;text-align:center;color:var(--text)">Session terminée</div>
    <div style="width:40px"></div>
  </div>
  <div class="session-end">
    <div class="se-icon">${emoji}</div>
    <div class="se-title">${msg}</div>
    <div class="se-sub">${sessionName} · ${total} carte${total > 1 ? 's' : ''}</div>
    <div class="se-scores">${scoresHtml}</div>
    ${actionHtml}
  </div>
  `;
}

// ═══════════════════════════════════════════════════
// QCM SESSION
// ═══════════════════════════════════════════════════
async function startQCM(subjectId, mode) {
  const s = subjects[subjectId];
  let questions;

  if (mode === 'quick') {
    questions = shuffle([...s.qcm]).slice(0, 5);
  } else if (mode === 'all') {
    questions = shuffle([...s.qcm]);
  } else {
    const due = await getDueQCMs(subjectId);
    questions = due.length > 0 ? shuffle(due) : shuffle([...s.qcm]).slice(0, 10);
    if (due.length === 0) toast('Toutes à jour — session de 10 questions aléatoires');
  }

  qcmSession = { subjectId, questions, idx: 0, correct: 0, mode };
  learnSubView = 'qcm';
  renderQCM();
}

async function startQCMImg(subjectId, mode) {
  const s = subjects[subjectId];
  let questions;

  if (mode === 'quick') {
    questions = shuffle([...s.qcmImg]).slice(0, 10);
  } else {
    questions = shuffle([...s.qcmImg]);
  }

  qcmSession = { subjectId, questions, idx: 0, correct: 0, mode: 'img-' + mode };
  learnSubView = 'qcm';
  renderQCM();
}

function renderQCM() {
  const { subjectId, questions, idx } = qcmSession;
  const isMix = subjectId === 'mix';
  const view = document.getElementById('view-learn');

  if (idx >= questions.length) { renderQCMEnd(); return; }

  const q = questions[idx];
  const subId = q._subject || subjectId;
  const col = SUBJECT_COLORS[subId] || { primary: '#5C6BC0' };
  const pct = Math.round((idx / questions.length) * 100);
  const backFn = isMix ? 'renderLearnGrid()' : `openSubjectDetail('${subjectId}')`;

  // Shuffle options, track new correct index
  const nOpts = q.opts.length;
  const shuffledIdx = shuffle([...Array(nOpts).keys()]);
  const shuffledOpts = shuffledIdx.map(i => q.opts[i]);
  const newAns = shuffledIdx.indexOf(q.ans);
  qcmSession.currentAns = newAns;

  const opts = shuffledOpts.map((opt, i) =>
    `<button class="qcm-opt" onclick="answerQCM(${i})">${opt}</button>`
  ).join('');

  view.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="${backFn}">←</button>
    <div class="fc-progress-bar">
      <div class="fc-progress-fill" style="width:${pct}%; background:${col.primary}"></div>
    </div>
    <div class="fc-counter">${idx + 1}/${questions.length}</div>
    <button class="help-btn" onclick="openQuestionModal()">?</button>
  </div>
  <div class="qcm-body">
    <div class="qcm-question">${q.q}</div>
    ${q.img ? `<img class="qcm-img" src="${q.img}" alt="Image de microscopie">` : ''}
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
  const subId = q._subject || subjectId;
  const opts = document.querySelectorAll('.qcm-opt');
  const correct = chosen === currentAns;

  opts.forEach(o => o.classList.add('disabled'));
  opts[currentAns].classList.add('correct');
  if (!correct) opts[chosen].classList.add('wrong');

  if (correct) qcmSession.correct++;

  updateQCM(subId, q.id, correct);

  if (q.exp) {
    const expHtml = q.exp.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    document.getElementById('qcm-expl').innerHTML =
      `<div class="qcm-explanation">💡 ${expHtml}</div>`;
  }

  const nextBtn = document.getElementById('qcm-next');
  if (nextBtn) nextBtn.classList.add('show');
}

function nextQCM() { qcmSession.idx++; renderQCM(); }

function renderQCMEnd() {
  const { subjectId, questions, correct, mode } = qcmSession;
  const isMix = subjectId === 'mix';
  const s = isMix ? { name: 'Mix' } : subjects[subjectId];
  const view = document.getElementById('view-learn');
  const pct = Math.round((correct / questions.length) * 100);
  const emoji = pct >= 80 ? '🎉' : pct >= 60 ? '💪' : '📖';
  const msg = pct >= 80 ? 'Excellente maîtrise !' : pct >= 60 ? 'Bon travail !' : 'Révise les notions manquées !';
  const backFn = isMix ? 'renderLearnGrid()' : `openSubjectDetail('${subjectId}')`;

  view.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="${backFn}">←</button>
    <div style="font-size:15px;font-weight:700;flex:1;text-align:center;color:var(--text)">QCM terminé</div>
    <div style="width:40px"></div>
  </div>
  <div class="session-end">
    <div class="se-icon">${emoji}</div>
    <div class="se-title">${msg}</div>
    <div class="se-sub">${s.name} · ${questions.length} question${questions.length > 1 ? 's' : ''}</div>
    <div class="se-scores">
      <div class="ses-item" style="color:#ef4444"><div class="ses-n">${questions.length - correct}</div><div class="ses-l">Fausses</div></div>
      <div class="ses-item" style="color:#16a34a"><div class="ses-n">${correct}</div><div class="ses-l">Correctes</div></div>
      <div class="ses-item" style="color:var(--accent)"><div class="ses-n">${pct}%</div><div class="ses-l">Score</div></div>
    </div>
    ${isMix
      ? `<button class="btn-primary" onclick="startMix('qcm')">Recommencer</button>
         <button class="btn-secondary" onclick="renderLearnGrid()">Retour aux matières</button>`
      : `<button class="btn-primary" onclick="startQCM('${subjectId}', '${mode}')">Recommencer</button>
         <button class="btn-secondary" onclick="openSubjectDetail('${subjectId}')">Retour à ${s.name}</button>`
    }
  </div>
  `;
}

// ═══════════════════════════════════════════════════
// SWIPE FOR FLASHCARDS
// ═══════════════════════════════════════════════════
function initSwipeFC(element, onLeft, onRight, onUp) {
  if (!element) return;
  let startX, startY;
  element.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  element.addEventListener('touchend', e => {
    if (startX == null) return;
    const card = document.getElementById('fc-card');
    if (!card || !card.classList.contains('flipped')) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    startX = startY = null;
    if (Math.abs(dx) < 50 && Math.abs(dy) < 50) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx < -50) onLeft && onLeft();
      else if (dx > 50) onRight && onRight();
    } else {
      if (dy < -50) onUp && onUp();
    }
  }, { passive: true });
}

// Swipe for agenda week
function initSwipe(element, onLeft, onRight) {
  if (!element) return;
  let startX, startY;
  element.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  element.addEventListener('touchend', e => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    startX = startY = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < -60) onLeft && onLeft();
    else if (dx > 60) onRight && onRight();
  }, { passive: true });
}

// ═══════════════════════════════════════════════════
// VIEW 4 — AGENDA
// ═══════════════════════════════════════════════════
function buildAgendaWeeks() {
  if (!dashboardData || !dashboardData.planning) return;
  const planning = dashboardData.planning;
  const byDate = {};
  planning.forEach(p => { byDate[p.fullDate] = p; });

  const firstDate = new Date(planning[0].fullDate);
  firstDate.setHours(0, 0, 0, 0);
  const dow = firstDate.getDay() || 7;
  const monday = new Date(firstDate);
  monday.setDate(firstDate.getDate() - dow + 1);

  agendaWeeks = [];
  for (let w = 0; w < 4; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(monday);
      dt.setDate(monday.getDate() + w * 7 + d);
      const fullDate = dt.toISOString().slice(0, 10);
      week.push({ dt, fullDate, plan: byDate[fullDate] || null });
    }
    agendaWeeks.push(week);
  }
}

function renderAgenda() {
  const view = document.getElementById('view-agenda');
  if (!dashboardData || !dashboardData.planning || !dashboardData.planning.length) {
    view.innerHTML = `
    <div class="view-header"><div class="view-title">Agenda</div></div>
    <div class="agenda-no-data"><div style="font-size:48px;margin-bottom:14px">📡</div><p>Aucun planning disponible.</p></div>`;
    return;
  }
  buildAgendaWeeks();

  const todayStr = new Date().toISOString().slice(0, 10);
  agendaWeekIdx = 0; agendaDaySelected = null;
  outer: for (let wi = 0; wi < agendaWeeks.length; wi++) {
    for (const day of agendaWeeks[wi]) {
      if (day.fullDate === todayStr) { agendaWeekIdx = wi; agendaDaySelected = day; break outer; }
    }
  }

  view.innerHTML = `
  <div class="view-header"><div class="view-title">Agenda</div></div>
  <div id="agenda-week-nav"></div>
  <div id="agenda-week-grid"></div>
  <div id="agenda-detail-wrap"></div>`;

  renderWeekNav();
  renderWeekGrid();
  if (agendaDaySelected) renderAgendaDetail();

  initSwipe(view,
    () => { if (agendaWeekIdx < agendaWeeks.length - 1) { agendaWeekIdx++; agendaDaySelected = null; renderWeekNav(); renderWeekGrid(); document.getElementById('agenda-detail-wrap').innerHTML = ''; } },
    () => { if (agendaWeekIdx > 0) { agendaWeekIdx--; agendaDaySelected = null; renderWeekNav(); renderWeekGrid(); document.getElementById('agenda-detail-wrap').innerHTML = ''; } }
  );
}

function renderWeekNav() {
  const week = agendaWeeks[agendaWeekIdx];
  const mon = week[0].dt, sun = week[6].dt;
  const label = `${mon.getDate()} ${FR_MONTHS_A[mon.getMonth()]} – ${sun.getDate()} ${FR_MONTHS_A[sun.getMonth()]}`;
  document.getElementById('agenda-week-nav').innerHTML = `
  <div class="week-nav">
    <button class="week-nav-btn" onclick="changeAgendaWeek(-1)">‹</button>
    <div class="week-label">${label}</div>
    <button class="week-nav-btn" onclick="changeAgendaWeek(1)">›</button>
  </div>`;
}

function changeAgendaWeek(dir) {
  const next = agendaWeekIdx + dir;
  if (next < 0 || next >= agendaWeeks.length) return;
  agendaWeekIdx = next; agendaDaySelected = null;
  renderWeekNav(); renderWeekGrid();
  document.getElementById('agenda-detail-wrap').innerHTML = '';
}

function renderWeekGrid() {
  const week = agendaWeeks[agendaWeekIdx];
  const todayStr = new Date().toISOString().slice(0, 10);
  const cells = week.map((day, i) => {
    const { dt, fullDate, plan } = day;
    const name = WDAY_NAMES[dt.getDay()];
    const num = dt.getDate();
    const isToday = fullDate === todayStr;
    const isActive = agendaDaySelected && agendaDaySelected.fullDate === fullDate;
    const isExam = plan && plan.isExam;
    const hasData = !!plan;
    const borderColor = isExam
      ? (plan.examColor || 'var(--accent)')
      : isToday ? 'var(--accent)' : 'transparent';

    let badge = '';
    if (isExam && plan.examColor) {
      const firstTask = plan.tasks && plan.tasks[0];
      const subName = firstTask ? firstTask.text.replace(/.*—\s*/, '').split(' ')[0] : 'Exam';
      badge = `<span class="wday-exam-tag" style="background:${plan.examColor}">${subName}</span>`;
    } else if (hasData) {
      badge = `<span class="wday-dot" style="background:var(--accent)"></span>`;
    } else {
      badge = `<span class="wday-dot"></span>`;
    }

    return `<button class="wday${isToday ? ' is-today' : ''}${isActive ? ' active' : ''}${!hasData ? ' no-data' : ''}"
      style="border-top-color:${borderColor}"
      onclick="selectWeekDay(${agendaWeekIdx},${i})">
      <span class="wday-name">${name}</span>
      <span class="wday-num">${num}</span>
      ${badge}
    </button>`;
  }).join('');
  document.getElementById('agenda-week-grid').innerHTML = `<div class="week-grid">${cells}</div>`;
}

function selectWeekDay(weekIdx, dayIdx) {
  const day = agendaWeeks[weekIdx][dayIdx];
  if (!day.plan) return;
  if (agendaDaySelected && agendaDaySelected.fullDate === day.fullDate) {
    agendaDaySelected = null;
    document.getElementById('agenda-detail-wrap').innerHTML = '';
  } else {
    agendaDaySelected = day;
    renderAgendaDetail();
  }
  renderWeekGrid();
}

function getAgendaChecked(dateKey) {
  try { return JSON.parse(localStorage.getItem(`agenda-checked-${dateKey}`) || '{}'); } catch { return {}; }
}
function toggleAgendaTask(dateKey, taskIdx) {
  const checked = getAgendaChecked(dateKey);
  checked[taskIdx] = !checked[taskIdx];
  localStorage.setItem(`agenda-checked-${dateKey}`, JSON.stringify(checked));
  renderAgendaDetail();
}

function renderAgendaDetail() {
  const wrap = document.getElementById('agenda-detail-wrap');
  if (!wrap || !agendaDaySelected) return;
  const { dt, plan } = agendaDaySelected;
  const dateKey = plan.fullDate || dt.toISOString().slice(0, 10);
  const checked = getAgendaChecked(dateKey);
  const fullDateStr = dt.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });

  let content = '';
  if (plan.isExam) {
    const color = plan.examColor || 'var(--accent)';
    const examTask = plan.tasks && plan.tasks[0];
    content += `<div class="agenda-exam-band" style="background:${color}">${examTask ? examTask.text : 'Examen'}</div>`;
  }

  const slots = { 'Matin': [], 'Après-midi': [], 'Soir': [] };
  const allTasks = plan.isExam ? (plan.tasks || []).slice(1) : (plan.tasks || []);
  allTasks.forEach((t, globalIdx) => {
    const slot = slots[t.time] !== undefined ? t.time : 'Matin';
    slots[slot].push({ ...t, globalIdx });
  });

  let anySlot = false;
  Object.entries(slots).forEach(([slot, tasks]) => {
    if (!tasks.length) return;
    anySlot = true;
    const totalSlot = tasks.length;
    const doneSlot = tasks.filter(t => checked[t.globalIdx]).length;
    const rows = tasks.map(t => {
      const isDone = !!checked[t.globalIdx];
      return `<div class="at-row${isDone ? ' at-done' : ''}" onclick="toggleAgendaTask('${dateKey}', ${t.globalIdx})">
        <div class="at-check">${isDone ? '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</div>
        <span class="at-text">${t.text}</span>
      </div>`;
    }).join('');
    content += `<div class="agenda-slot">
      <div class="agenda-slot-header">
        <span class="agenda-slot-title">${slot}</span>
        <span class="agenda-slot-count">${doneSlot}/${totalSlot}</span>
      </div>
      ${rows}
    </div>`;
  });

  if (!anySlot && !plan.isExam) content = `<div class="agenda-empty">Rien de prévu</div>`;

  const totalAll = allTasks.length;
  const doneAll = allTasks.filter((_, i) => checked[i]).length;
  const progressPct = totalAll ? Math.round(doneAll / totalAll * 100) : 0;

  const examTagHtml = (plan.isExam && plan.examColor)
    ? `<span class="adh-exam-tag" style="background:${plan.examColor}">${(plan.tasks && plan.tasks[0]) ? plan.tasks[0].text : 'Examen'}</span>`
    : '';

  const progressBar = totalAll ? `
    <div class="agenda-progress-wrap">
      <div class="agenda-progress-track">
        <div class="agenda-progress-fill" style="width:${progressPct}%"></div>
      </div>
      <span class="agenda-progress-label">${doneAll}/${totalAll}</span>
    </div>` : '';

  wrap.innerHTML = `
  <div class="agenda-detail-wrap">
    <div class="agenda-detail">
      <div class="agenda-detail-header">
        <div class="adh-date">${capFirst(fullDateStr)}</div>
        ${examTagHtml}
      </div>
      ${progressBar}
      ${content}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════
// VIEW 5 — STATS
// ═══════════════════════════════════════════════════
async function renderStats() {
  const view = document.getElementById('view-stats');

  let totalSeen = 0, totalB3 = 0, totalQCMMastered = 0, totalVocabB3 = 0;

  // ── Matières régulières ──
  const rows = await Promise.all(SUBJECTS_ORDER.map(async id => {
    const s = subjects[id];
    if (!s) return '';
    const stats = await getSubjectStats(id);
    const qcmStats = await getQCMStats(id);
    const progress = await getCardProgress(id);
    const seen = Object.keys(progress).length;
    const pct = stats.total ? Math.round(stats.b3 / stats.total * 100) : 0;
    const qPct = qcmStats.total ? Math.round(qcmStats.mastered / qcmStats.total * 100) : 0;

    totalSeen += seen;
    totalB3 += stats.b3;
    totalQCMMastered += qcmStats.mastered;

    const col = SUBJECT_COLORS[id] || { primary: '#5C6BC0' };
    const dashSub = (dashboardData && dashboardData.subjects && dashboardData.subjects[id]) || {};
    const checklistPct = dashSub.checklist ? (dashSub.checklist.pct || 0) : 0;

    return `
    <div class="stats-subject" style="border-left-color:${col.primary}">
      <div class="ss-name">${col.emoji || ''} ${s.name}</div>
      ${checklistPct > 0 ? `
      <div class="ss-row-label">Cours (checklist)</div>
      <div class="ss-bar-bg"><div class="ss-bar" style="width:${checklistPct}%; background:${col.primary}"></div></div>
      <div class="ss-detail" style="margin-top:4px"><span style="color:${col.primary}">${checklistPct}% vu</span></div>
      ` : ''}
      <div class="ss-row-label" style="${checklistPct > 0 ? 'margin-top:12px' : ''}">Flashcards</div>
      <div class="ss-bar-bg"><div class="ss-bar" style="width:${pct}%; background:${col.primary}"></div></div>
      <div class="ss-detail" style="margin-top:4px">
        <span style="color:#ef4444">✗ ${stats.b1}</span>
        <span style="color:#f97316">~ ${stats.b2}</span>
        <span style="color:#16a34a">✓ ${stats.b3}</span>
        <span style="color:var(--muted)">${pct}%</span>
      </div>
      <div class="ss-row-label" style="margin-top:12px">QCM</div>
      <div class="ss-bar-bg"><div class="ss-bar" style="width:${qPct}%; background:${col.primary}; opacity:.65"></div></div>
      <div class="ss-detail" style="margin-top:4px">
        <span style="color:#16a34a">✓ ${qcmStats.mastered}</span>
        <span style="color:var(--muted)">${qcmStats.mastered}/${qcmStats.total} maîtrisés</span>
      </div>
    </div>`;
  }));

  // ── Vocabulaire & Anti-vocabulaire ──
  const vocabRows = [];
  for (const [srcId, src] of Object.entries(VOCAB_SOURCES)) {
    await loadVocabSource(srcId);
    const allCards = (vocabCache[srcId] || { flashcards: [] }).flashcards;
    const total = allCards.length;
    if (!total) continue;

    const now = Date.now();
    for (const prefix of ['vocab', 'antivocab']) {
      const key = `${prefix}_${srcId}`;
      const progress = await getCardProgress(key);
      const seen = Object.keys(progress).length;
      if (!seen) continue;

      let b1 = 0, b2 = 0, b3 = 0;
      allCards.forEach(c => {
        const p = progress[c.id];
        if (!p) { b1++; return; }
        if (p.box === 1) b1++;
        else if (p.box === 2) b2++;
        else b3++;
      });
      const pct = total ? Math.round(b3 / total * 100) : 0;
      totalVocabB3 += b3;

      const label = prefix === 'vocab' ? `${src.emoji} ${src.name}` : `🔄 Anti-vocab ${src.name.replace('Vocabulaire ', '')}`;
      vocabRows.push(`
      <div class="stats-subject" style="border-left-color:${src.color}">
        <div class="ss-name">${label}</div>
        <div class="ss-row-label">${seen}/${total} termes vus</div>
        <div class="ss-bar-bg"><div class="ss-bar" style="width:${pct}%; background:${src.color}"></div></div>
        <div class="ss-detail" style="margin-top:4px">
          <span style="color:#ef4444">B1 ${b1}</span>
          <span style="color:#f97316">B2 ${b2}</span>
          <span style="color:#16a34a">B3 ${b3}</span>
          <span style="color:var(--muted)">${pct}% maîtrisés</span>
        </div>
      </div>`);
    }
  }

  view.innerHTML = `
  <div class="view-header"><div class="view-title">Stats</div></div>

  <div class="stats-globals">
    <div class="sg-card"><div class="sg-num">${totalSeen}</div><div class="sg-lbl">cartes vues</div></div>
    <div class="sg-card"><div class="sg-num">${totalB3}</div><div class="sg-lbl">en B3</div></div>
    <div class="sg-card"><div class="sg-num">${totalVocabB3}</div><div class="sg-lbl">vocab B3</div></div>
  </div>

  <div class="section-label">Par matière</div>
  ${rows.join('')}

  ${vocabRows.length ? `<div class="section-label">Vocabulaire</div>${vocabRows.join('')}` : ''}

  <div class="section-label">Actions</div>
  <div class="action-list" style="margin-bottom:8px">
    <div class="action-btn action-sync" onclick="syncWithWiki()">
      <div class="ab-icon">🔄</div>
      <div class="ab-info"><div class="ab-title">Sync Wiki</div><div class="ab-sub">Mise à jour checklists (WiFi maison)</div></div>
    </div>
    <div class="action-btn action-export" onclick="exportProgress()">
      <div class="ab-icon">📤</div>
      <div class="ab-info"><div class="ab-title">Exporter</div><div class="ab-sub">Télécharger ma progression JSON</div></div>
    </div>
    <div class="action-btn action-export" onclick="exportQuestions()">
      <div class="ab-icon">❓</div>
      <div class="ab-info"><div class="ab-title">Exporter mes questions</div><div class="ab-sub">Télécharger les questions enregistrées (JSON)</div></div>
    </div>
    <div class="action-btn" onclick="runMigration()">
      <div class="ab-icon">🔧</div>
      <div class="ab-info"><div class="ab-title">Récupérer vocab perdu</div><div class="ab-sub">Migration ancienne clé → nouvelles clés</div></div>
    </div>
  </div>
  <button class="reset-btn" onclick="resetProgress()">Réinitialiser la progression</button>
  <div class="app-version">StudyOS ${APP_VERSION}</div>
  `;
}

// ═══════════════════════════════════════════════════
// EXPORT / SYNC / RESET
// ═══════════════════════════════════════════════════
async function getAllProgress() {
  const result = {};

  // Matières régulières
  for (const id of SUBJECTS_ORDER) {
    const progress = await getCardProgress(id);
    const s = subjects[id];
    if (!s || !Object.keys(progress).length) continue;
    result[id] = {};
    for (const [cardId, p] of Object.entries(progress)) {
      const card = s.flashcards.find(c => c.id === cardId);
      if (card) result[id][cardId] = { box: p.box, term: card.term, lastAnswered: p.lastAnswered || 0 };
    }
  }

  // Vocabulaire (vocab_bio, vocab_geo, etc.)
  for (const srcId of Object.keys(VOCAB_SOURCES)) {
    await loadVocabSource(srcId);
    const allCards = (vocabCache[srcId] || { flashcards: [] }).flashcards;

    for (const prefix of ['vocab', 'antivocab']) {
      const key = `${prefix}_${srcId}`;
      const progress = await getCardProgress(key);
      if (!Object.keys(progress).length) continue;
      result[key] = {};
      for (const [cardId, p] of Object.entries(progress)) {
        const card = allCards.find(c => c.id === cardId);
        if (card) result[key][cardId] = { box: p.box, term: card.term, cat: card.cat, lastAnswered: p.lastAnswered || 0 };
      }
    }
  }

  return result;
}

// Migration one-time : cards_vocab → cards_vocab_bio / cards_vocab_geo / etc.
// Identifie la source par le préfixe de l'ID de carte (vb=bio, vg=geo, vc=chimie, vp=philo, vf=francais)
const VOCAB_ID_PREFIX = { 'vb': 'bio', 'vg': 'geo', 'vc': 'chimie', 'vp': 'philo', 'vf': 'francais' };

async function migrateOldVocabProgress() {
  const old = await getCardProgress('vocab'); // ancienne clé unique
  if (!old || !Object.keys(old).length) return 0;

  const buckets = {};
  for (const [cardId, p] of Object.entries(old)) {
    const prefix = cardId.slice(0, 2);
    const srcId = VOCAB_ID_PREFIX[prefix];
    if (!srcId) continue;
    if (!buckets[srcId]) buckets[srcId] = {};
    buckets[srcId][cardId] = p;
  }

  let migrated = 0;
  for (const [srcId, data] of Object.entries(buckets)) {
    const existing = await getCardProgress(`vocab_${srcId}`);
    const merged = { ...data, ...existing }; // existing prend la priorité
    await saveCardProgress(`vocab_${srcId}`, merged);
    migrated += Object.keys(data).length;
  }

  // Vider l'ancienne clé pour éviter les doublons
  if (migrated > 0) await saveCardProgress('vocab', {});
  return migrated;
}

async function runMigration() {
  const n = await migrateOldVocabProgress();
  if (n > 0) { toast(`✅ ${n} cartes vocab récupérées !`); renderStats(); }
  else toast('Rien à migrer (déjà à jour)');
}

async function exportProgress() {
  const progress = await getAllProgress();
  const blob = new Blob(['﻿' + JSON.stringify({ progress, exported: new Date().toISOString() }, null, 2)], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `studyapp-progress-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('Progression exportée !');
}

async function syncWithWiki() {
  const btn = document.querySelector('.action-sync');
  if (btn) { btn.querySelector('.ab-title').textContent = 'Sync en cours…'; btn.disabled = true; }
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
  renderLearnGrid();
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
async function init() {
  try {
    db = await openDB();
    await loadAllSubjects();
    await loadDashboard();
    migrateOldVocabProgress().then(n => { if (n > 0) console.log(`Migration vocab: ${n} cartes récupérées`); });
    await renderHome();

    // Service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'SW_UPDATED') {
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
    const homeView = document.getElementById('view-home');
    if (homeView) {
      homeView.innerHTML = `
      <div style="padding:40px 24px; text-align:center">
        <div style="font-size:48px; margin-bottom:16px">⚠️</div>
        <h2 style="color:var(--text)">Erreur de chargement</h2>
        <p style="color:var(--muted); margin-top:8px">Vérifie ta connexion puis recharge la page.</p>
      </div>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════
// CONTRÔLES DIGITAUX
// ═══════════════════════════════════════════════════

let controleSession = null; // session active
let controleTimer = null;   // timer state par question

// ── Indice de Facilité (0-10) ──
// Basé sur : retrieval fluency = force du lien mémoriel (Springer Memory & Cognition)
// Formule : combine ratio réflexion/total + pénalité absolue temps réflexion
function calculateEaseIndex(reflexion_sec, ecriture_sec, nb_chars) {
  const total = reflexion_sec + ecriture_sec;
  if (total < 2) return 10; // réponse quasi instantanée

  const reflexionRatio   = reflexion_sec / Math.max(total, 1);   // 0-1, proportion "bloqué"
  const reflexionPenalty = Math.min(1, reflexion_sec / 60);      // 0-1, pénalité absolue (60s = max)

  const difficulty = reflexionRatio * 0.5 + reflexionPenalty * 0.5;
  return Math.max(0, Math.min(10, Math.round((1 - difficulty) * 10)));
}

function easeLabel(ease) {
  if (ease >= 9) return { label: 'Ancré', color: '#16a34a' };
  if (ease >= 7) return { label: 'Fluide', color: '#65a30d' };
  if (ease >= 5) return { label: 'Fragile', color: '#d97706' };
  if (ease >= 3) return { label: 'Difficile', color: '#ea580c' };
  return { label: 'Lacune', color: '#dc2626' };
}

async function dbGetControle(key) {
  return new Promise(res => {
    const tx = db.transaction('controle_responses', 'readonly');
    tx.objectStore('controle_responses').get(key).onsuccess = e => res(e.target.result);
  });
}
async function dbSetControle(key, value) {
  return new Promise(res => {
    const tx = db.transaction('controle_responses', 'readwrite');
    tx.objectStore('controle_responses').put(value, key);
    tx.oncomplete = () => res();
  });
}
async function dbGetAllControles() {
  return new Promise(res => {
    const results = {};
    const tx = db.transaction('controle_responses', 'readonly');
    const req = tx.objectStore('controle_responses').openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { results[cursor.key] = cursor.value; cursor.continue(); }
      else res(results);
    };
  });
}

// ── FICHES DE RÉVISION ──
const ficheCache = {};
let ficheIndexCache = null;

async function loadFicheIndex() {
  if (ficheIndexCache) return ficheIndexCache;
  try {
    const r = await fetch('/data/fiches/index.json');
    ficheIndexCache = await r.json();
  } catch { ficheIndexCache = []; }
  return ficheIndexCache;
}

async function loadFicheData(id) {
  if (ficheCache[id]) return ficheCache[id];
  try {
    const r = await fetch(`/data/fiches/${id}.md`);
    if (!r.ok) return null;
    ficheCache[id] = await r.text();
    return ficheCache[id];
  } catch { return null; }
}

// Petit moteur Markdown -> HTML (titres, listes, gras/italique, citations, tableaux, hr)
function renderMarkdown(md) {
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  let tableRows = [];

  const inlineMd = s => s.trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const flushTable = () => {
    if (!tableRows.length) return;
    const header = tableRows[0];
    const body = tableRows.slice(2);
    html += '<table><thead><tr>' + header.map(c => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>';
    body.forEach(row => { html += '<tr>' + row.map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>'; });
    html += '</tbody></table>';
    tableRows = [];
  };

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (/^\|.*\|$/.test(trimmed)) {
      tableRows.push(trimmed.slice(1, -1).split('|'));
      continue;
    } else if (tableRows.length) {
      flushTable();
    }

    if (!trimmed) { closeList(); continue; }
    if (/^### /.test(trimmed)) { closeList(); html += `<h3>${inlineMd(trimmed.slice(4))}</h3>`; continue; }
    if (/^## /.test(trimmed))  { closeList(); html += `<h2>${inlineMd(trimmed.slice(3))}</h2>`; continue; }
    if (/^# /.test(trimmed))   { closeList(); html += `<h1>${inlineMd(trimmed.slice(2))}</h1>`; continue; }
    if (/^---+$/.test(trimmed)) { closeList(); html += '<hr>'; continue; }
    if (/^> /.test(trimmed))   { closeList(); html += `<blockquote>${inlineMd(trimmed.slice(2))}</blockquote>`; continue; }
    if (/^[-*] /.test(trimmed)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(trimmed.slice(2))}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineMd(trimmed)}</p>`;
  }
  closeList();
  flushTable();
  return html;
}

// ── Vue liste des fiches ──
async function openFichesList() {
  learnSubView = 'fiches-list';
  const view = document.getElementById('view-learn');
  const fiches = await loadFicheIndex();

  const rows = fiches.map(f => {
    const col = SUBJECT_COLORS[f.matiere] || { primary: '#5C6BC0', emoji: '📖' };
    return `
    <div class="today-subject-row" style="border-left-color:${col.primary};cursor:pointer" onclick="openFicheView('${f.id}')">
      <div class="tsr-emoji">${col.emoji || '📖'}</div>
      <div class="tsr-info">
        <div class="tsr-name">${f.titre}</div>
        <div class="tsr-count">${f.sous_titre || ''}</div>
      </div>
      <div class="vc-arrow">›</div>
    </div>`;
  }).join('');

  view.innerHTML = `
  <div style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="setStudyTab('explorer')">←</button>
    <div style="font-size:20px;font-weight:900;color:var(--text)">📖 Fiches de révision</div>
  </div>
  ${fiches.length > 0 ? `
  <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${rows}</div>` : `
  <div style="padding:40px 24px;text-align:center;color:var(--muted)">
    <div style="font-size:40px;margin-bottom:12px">📖</div>
    <div style="font-weight:700">Aucune fiche disponible</div>
  </div>`}
  <div style="height:100px"></div>
  `;
}

// ── Vue lecture d'une fiche ──
async function openFicheView(id) {
  learnSubView = 'fiche-view';
  const view = document.getElementById('view-learn');
  const md = await loadFicheData(id);
  if (!md) { toast('Fiche introuvable'); openFichesList(); return; }

  const fiches = await loadFicheIndex();
  const meta = fiches.find(f => f.id === id) || {};
  const col = SUBJECT_COLORS[meta.matiere] || { primary: '#5C6BC0' };

  view.innerHTML = `
  <div class="ctrl-layout">
    <div class="ctrl-header">
      <button class="back-btn" onclick="openFichesList()">←</button>
      <div style="flex:1;font-size:15px;font-weight:800;color:${col.primary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${meta.titre || 'Fiche'}</div>
    </div>
    <div class="ctrl-body fiche-content">
      ${renderMarkdown(md)}
      <div style="height:40px"></div>
    </div>
  </div>
  `;
}

// Charger la liste des contrôles disponibles depuis /data/controles/
const controleCache = {};
async function loadControleData(id) {
  if (controleCache[id]) return controleCache[id];
  try {
    const r = await fetch(`/data/controles/${id}.json`);
    controleCache[id] = await r.json();
    return controleCache[id];
  } catch { return null; }
}

// ── Vue liste des contrôles ──
async function openControleList() {
  learnSubView = 'controle-list';
  const view = document.getElementById('view-learn');
  const responses = await dbGetAllControles();
  const savedIds = Object.keys(responses);

  // Lister les fichiers disponibles (on hardcode les IDs pour l'instant, le serveur ne liste pas)
  // On tente de charger une liste index
  let available = [];
  try {
    const r = await fetch('/data/controles/index.json');
    available = await r.json();
  } catch { available = []; }

  const savedRows = savedIds.map(id => {
    const r = responses[id];
    const col = SUBJECT_COLORS[r.matiere] || { primary: '#5C6BC0', emoji: '📝' };
    const date = new Date(r.date).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const mins = Math.round(r.duree_totale_secondes / 60);
    return `
    <div class="today-subject-row" style="border-left-color:${col.primary};cursor:pointer" onclick="openControleResult('${id}')">
      <div class="tsr-emoji">${col.emoji || '📝'}</div>
      <div class="tsr-info">
        <div class="tsr-name">${r.titre}</div>
        <div class="tsr-count">${date} · ${mins} min · ${r.reponses.length} questions</div>
      </div>
      <button class="btn" style="color:${col.primary};padding:7px 12px;font-size:12px" onclick="event.stopPropagation();exportControleResponse('${id}')">↗</button>
    </div>`;
  }).join('');

  const availableRows = available.map(item => {
    const col = SUBJECT_COLORS[item.matiere] || { primary: '#5C6BC0', emoji: '📝' };
    const done = !!responses[item.id + '-' + new Date().toISOString().slice(0,10)];
    return `
    <div class="today-subject-row" style="border-left-color:${col.primary}">
      <div class="tsr-emoji">${col.emoji || '📝'}</div>
      <div class="tsr-info">
        <div class="tsr-name">${item.titre}</div>
        <div class="tsr-count">${item.questions} questions</div>
      </div>
      ${item.fiche_id ? `<button class="btn" style="color:${col.primary};padding:10px 12px;font-size:13px" onclick="openFicheView('${item.fiche_id}')" title="Lire la fiche">📖</button>` : ''}
      <button class="btn" style="color:${col.primary};padding:10px 14px;font-size:13px" onclick="startControle('${item.id}')">Démarrer</button>
    </div>`;
  }).join('');

  view.innerHTML = `
  <div style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="setStudyTab('explorer')">←</button>
    <div style="font-size:20px;font-weight:900;color:var(--text)">📝 Contrôles</div>
  </div>
  ${available.length > 0 ? `
  <div class="section-label">Disponibles</div>
  <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${availableRows}</div>` : ''}
  ${savedIds.length > 0 ? `
  <div class="section-label">Mes réponses sauvegardées</div>
  <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:20px">${savedRows}</div>` : ''}
  ${available.length === 0 && savedIds.length === 0 ? `
  <div style="padding:40px 24px;text-align:center;color:var(--muted)">
    <div style="font-size:40px;margin-bottom:12px">📝</div>
    <div style="font-weight:700">Aucun contrôle disponible</div>
    <div style="font-size:13px;margin-top:6px">Demande à Claude de générer un contrôle pour commencer.</div>
  </div>` : ''}
  <div style="height:100px"></div>
  `;
}

// ── Démarrer un contrôle ──
async function startControle(id) {
  const data = await loadControleData(id);
  if (!data) { toast('Contrôle introuvable'); return; }

  controleSession = {
    controleId: id,
    data,
    idx: 0,
    reponses: [],
    dateDebut: new Date().toISOString()
  };

  learnSubView = 'controle-question';
  renderControleQuestion();
}

// ── Rendu d'une question ──
function renderControleQuestion() {
  const { data, idx, reponses } = controleSession;
  const view = document.getElementById('view-learn');
  const q = data.questions[idx];
  const total = data.questions.length;
  const col = SUBJECT_COLORS[data.matiere] || { primary: '#5C6BC0' };
  const pct = Math.round((idx / total) * 100);

  // Init timer pour cette question
  controleTimer = {
    questionStart: Date.now(),
    writingPeriods: [],
    currentWritingStart: null,
    pauseTimeout: null
  };

  view.innerHTML = `
  <div class="ctrl-layout">
    <div class="ctrl-header">
      <button class="back-btn" onclick="abortControle()">✕</button>
      <div class="fc-progress-bar" style="flex:1;margin:0 12px">
        <div class="fc-progress-fill" style="width:${pct}%;background:${col.primary}"></div>
      </div>
      <div class="fc-counter" style="font-size:13px">${idx + 1}/${total}</div>
    </div>

    <div class="ctrl-body">
      <div class="ctrl-question-num" style="color:${col.primary}">Question ${idx + 1}</div>
      <div class="ctrl-question-text">${q.texte}</div>
      <textarea
        id="ctrl-answer"
        class="ctrl-textarea"
        placeholder="Tape ta réponse ici…"
        oninput="onControleKeystroke()"
        autofocus
      ></textarea>
    </div>

    <div class="ctrl-footer">
      <button class="ctrl-validate-btn" style="background:${col.primary}" onclick="validateControleAnswer()">
        ${idx + 1 < total ? 'Valider →' : 'Terminer ✓'}
      </button>
    </div>
  </div>
  `;

  // Focus textarea
  setTimeout(() => document.getElementById('ctrl-answer')?.focus(), 100);
}

// ── Gestion timer (écriture vs réflexion) ──
function onControleKeystroke() {
  const timer = controleTimer;
  const now = Date.now();

  if (timer.currentWritingStart === null) {
    // Début d'une période d'écriture
    timer.currentWritingStart = now;
  }

  // Réinitialiser le timeout de pause
  clearTimeout(timer.pauseTimeout);
  timer.pauseTimeout = setTimeout(() => {
    // 2s sans frappe = fin de période d'écriture
    if (timer.currentWritingStart !== null) {
      timer.writingPeriods.push({ start: timer.currentWritingStart, end: Date.now() });
      timer.currentWritingStart = null;
    }
  }, 2000);
}

function finalizeControleTimer() {
  const timer = controleTimer;
  const now = Date.now();

  clearTimeout(timer.pauseTimeout);

  // Fermer la période d'écriture en cours si active
  if (timer.currentWritingStart !== null) {
    timer.writingPeriods.push({ start: timer.currentWritingStart, end: now });
    timer.currentWritingStart = null;
  }

  const totalMs = now - timer.questionStart;
  const writingMs = timer.writingPeriods.reduce((s, p) => s + (p.end - p.start), 0);
  const thinkingMs = totalMs - writingMs;

  return {
    duree_totale_secondes: Math.round(totalMs / 1000),
    duree_reflexion_secondes: Math.round(thinkingMs / 1000),
    duree_ecriture_secondes: Math.round(writingMs / 1000)
  };
}

// ── Valider une réponse ──
function validateControleAnswer() {
  const textarea = document.getElementById('ctrl-answer');
  const reponse = (textarea?.value || '').trim();
  const timing = finalizeControleTimer();
  const q = controleSession.data.questions[controleSession.idx];

  const ease = calculateEaseIndex(timing.duree_reflexion_secondes, timing.duree_ecriture_secondes, reponse.length);

  controleSession.reponses.push({
    numero: controleSession.idx + 1,
    question_id: q.id,
    question: q.texte,
    concepts: q.concepts || [],
    reponse,
    nb_caracteres: reponse.length,
    indice_facilite: ease,
    ...timing
  });

  controleSession.idx++;

  if (controleSession.idx < controleSession.data.questions.length) {
    renderControleQuestion();
  } else {
    finishControle();
  }
}

// ── Fin de contrôle ──
async function finishControle() {
  const { controleId, data, reponses, dateDebut } = controleSession;
  const col = SUBJECT_COLORS[data.matiere] || { primary: '#5C6BC0' };
  const view = document.getElementById('view-learn');

  const totalSec = reponses.reduce((s, r) => s + r.duree_totale_secondes, 0);
  // Inclure heure + minutes pour éviter l'écrasement si même contrôle fait 2x le même jour
  const responseId = `${controleId}-${dateDebut.slice(0, 16).replace('T', '-').replace(':', 'h')}`;

  const result = {
    id: responseId,
    controle_id: controleId,
    matiere: data.matiere,
    titre: data.titre,
    date: dateDebut,
    duree_totale_secondes: totalSec,
    reponses
  };

  await dbSetControle(responseId, result);

  const mins = Math.round(totalSec / 60);
  const avgEase = reponses.length ? Math.round(reponses.reduce((s, r) => s + (r.indice_facilite || 0), 0) / reponses.length) : 0;
  const avgEaseInfo = easeLabel(avgEase);

  const reponseRows = reponses.map(r => {
    const ei = easeLabel(r.indice_facilite ?? 5);
    return `
    <div class="ctrl-recap-q">
      <div class="ctrl-recap-num" style="display:flex;justify-content:space-between;align-items:center">
        <span>Q${r.numero} · ${r.duree_totale_secondes}s <span style="color:var(--muted);font-size:9px">(${r.duree_reflexion_secondes}s réflexion · ${r.duree_ecriture_secondes}s écriture)</span></span>
        <span class="ctrl-ease-badge" style="background:${ei.color}">⚡${r.indice_facilite}/10 ${ei.label}</span>
      </div>
      <div class="ctrl-recap-q-text">${r.question}</div>
      <div class="ctrl-recap-answer">${r.reponse || '<em style="color:var(--muted)">Sans réponse</em>'}</div>
    </div>`;
  }).join('');

  view.innerHTML = `
  <div class="ctrl-layout">
    <div class="ctrl-header">
      <div style="font-size:15px;font-weight:700;flex:1;text-align:center;color:var(--text)">Contrôle terminé ✓</div>
    </div>
    <div class="ctrl-body" style="overflow-y:auto">
      <div style="text-align:center;padding:20px 0 16px">
        <div style="font-size:40px">📝</div>
        <div style="font-size:18px;font-weight:900;margin-top:8px">${data.titre}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:4px">${reponses.length} questions · ${mins} min au total</div>
        <div style="margin-top:10px;display:inline-flex;align-items:center;gap:8px;background:var(--bg);box-shadow:var(--raise-sm);border-radius:20px;padding:6px 14px">
          <span style="font-size:13px;font-weight:700;color:var(--muted)">Facilité moyenne</span>
          <span style="font-size:15px;font-weight:900;color:${avgEaseInfo.color}">${avgEase}/10 — ${avgEaseInfo.label}</span>
        </div>
      </div>
      <div class="section-label">Tes réponses</div>
      <div style="padding:0 16px">${reponseRows}</div>
      <div style="height:120px"></div>
    </div>
    <div class="ctrl-footer" style="flex-direction:column;gap:10px">
      <button class="ctrl-validate-btn" style="background:${col.primary}" onclick="exportControleResponse('${responseId}')">
        📤 Exporter pour correction Claude
      </button>
      <button class="btn" style="padding:14px;font-size:14px;font-weight:700;width:100%" onclick="openControleList()">
        Retour aux contrôles
      </button>
    </div>
  </div>
  `;
}

// ── Annuler un contrôle en cours ──
function abortControle() {
  if (!confirm('Abandonner ce contrôle ? Les réponses ne seront pas sauvegardées.')) return;
  controleSession = null;
  openControleList();
}

// ── Exporter les réponses (copie dans presse-papier + téléchargement) ──
async function exportControleResponse(id) {
  const data = await dbGetControle(id);
  if (!data) { toast('Réponses introuvables'); return; }
  const json = JSON.stringify(data, null, 2);

  // Télécharger
  const blob = new Blob(['﻿' + json], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `controle-${data.matiere}-reponses-${data.date.slice(0,16).replace('T','_').replace(':','h')}.json`;
  a.click();

  // Copier dans presse-papier en bonus
  try { await navigator.clipboard.writeText(json); toast('Téléchargé + copié !'); }
  catch { toast('Fichier téléchargé'); }
}

// ── Voir le résultat d'un contrôle sauvegardé ──
async function openControleResult(id) {
  const data = await dbGetControle(id);
  if (!data) { toast('Introuvable'); return; }
  controleSession = { data: { matiere: data.matiere, titre: data.titre, questions: [] }, reponses: data.reponses, idx: data.reponses.length, controleId: data.controle_id, dateDebut: data.date };
  // Réafficher le recap
  const col = SUBJECT_COLORS[data.matiere] || { primary: '#5C6BC0' };
  const view = document.getElementById('view-learn');
  const mins = Math.round(data.duree_totale_secondes / 60);
  const reponseRows = data.reponses.map(r => `
    <div class="ctrl-recap-q">
      <div class="ctrl-recap-num">Q${r.numero} · ${r.duree_totale_secondes}s</div>
      <div class="ctrl-recap-q-text">${r.question}</div>
      <div class="ctrl-recap-answer">${r.reponse || '<em style="color:var(--muted)">Sans réponse</em>'}</div>
    </div>`).join('');
  view.innerHTML = `
  <div class="ctrl-layout">
    <div class="ctrl-header">
      <button class="back-btn" onclick="openControleList()">←</button>
      <div style="font-size:15px;font-weight:700;flex:1;text-align:center">${data.titre}</div>
      <div style="width:40px"></div>
    </div>
    <div class="ctrl-body" style="overflow-y:auto">
      <div style="text-align:center;padding:20px 0 16px">
        <div style="font-size:13px;color:var(--muted)">${new Date(data.date).toLocaleDateString('fr-BE',{day:'numeric',month:'long'})} · ${mins} min</div>
      </div>
      <div class="section-label">Réponses</div>
      <div style="padding:0 16px">${reponseRows}</div>
      <div style="height:120px"></div>
    </div>
    <div class="ctrl-footer">
      <button class="ctrl-validate-btn" style="background:${col.primary}" onclick="exportControleResponse('${id}')">
        📤 Exporter pour Claude
      </button>
    </div>
  </div>
  `;
}
