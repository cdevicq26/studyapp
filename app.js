'use strict';

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════
// Garder en phase avec CACHE dans sw.js à chaque déploiement
const APP_VERSION = 'v93';

const CHEVRON_ICON = `<svg class="chevron-icon" viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg>`;

const ACCENT_PRESETS = [
  { name: 'Orange',  primary: '#E8491F', light: '#FDE6DB' },
  { name: 'Rouge',   primary: '#DC2626', light: '#FBE2E1' },
  { name: 'Vert',    primary: '#16A34A', light: '#DCFCE7' },
  { name: 'Bleu',    primary: '#2563EB', light: '#DBEAFE' },
  { name: 'Violet',  primary: '#7C3AED', light: '#EDE3FB' },
  { name: 'Rose',    primary: '#DB2777', light: '#FCE4F1' },
];

let guestName = '';

function getDisplayName() {
  if (GUEST_MODE) return guestName || 'invité';
  return localStorage.getItem('studyos-name') || 'Charles';
}

const DARK_ACTIVE_BG = '#2A2D34';

function applyStoredAccent() {
  const idx = parseInt(localStorage.getItem('studyos-accent') || '0', 10);
  const preset = ACCENT_PRESETS[idx] || ACCENT_PRESETS[0];
  document.documentElement.style.setProperty('--accent', preset.primary);
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.style.setProperty('--accent-l', dark ? DARK_ACTIVE_BG : preset.light);
}

// ═══════════════════════════════════════════════════
// LEVÉ / COUCHÉ DU SOLEIL (pour le mode "Auto")
// ═══════════════════════════════════════════════════
const DEFAULT_COORDS = { lat: 50.8503, lon: 4.3517 }; // Bruxelles, par défaut

function getStoredCoords() {
  try { return JSON.parse(localStorage.getItem('studyos-geo') || 'null'); }
  catch { return null; }
}

function requestGeoOnce() {
  if (getStoredCoords() || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      localStorage.setItem('studyos-geo', JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude }));
      applyStoredTheme();
    },
    () => {},
    { timeout: 10000 }
  );
}

// Algorithme NOAA — heure UTC (en heures décimales) du lever/coucher du soleil
function sunTimeUTC(lat, lon, date, isSunrise) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const dayOfYear = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 86400000) + 1;
  const zenith = 90.83;
  const lngHour = lon / 15;
  const t = isSunrise ? dayOfYear + ((6 - lngHour) / 24) : dayOfYear + ((18 - lngHour) / 24);
  const M = (0.9856 * t) - 3.289;
  let L = M + (1.916 * Math.sin(D2R * M)) + (0.020 * Math.sin(2 * D2R * M)) + 282.634;
  L = (L + 360) % 360;
  let RA = R2D * Math.atan(0.91764 * Math.tan(D2R * L));
  RA = (RA + 360) % 360;
  const Lq = Math.floor(L / 90) * 90, RAq = Math.floor(RA / 90) * 90;
  RA = (RA + (Lq - RAq)) / 15;
  const sinDec = 0.39782 * Math.sin(D2R * L);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(D2R * zenith) - (sinDec * Math.sin(D2R * lat))) / (cosDec * Math.cos(D2R * lat));
  if (cosH > 1 || cosH < -1) return null; // jour/nuit polaire
  let H = isSunrise ? 360 - R2D * Math.acos(cosH) : R2D * Math.acos(cosH);
  H = H / 15;
  const T = H + RA - (0.06571 * t) - 6.622;
  let UT = (T - lngHour) % 24;
  if (UT < 0) UT += 24;
  return UT;
}

function isNightTime() {
  const { lat, lon } = getStoredCoords() || DEFAULT_COORDS;
  const now = new Date();
  const sunriseUTC = sunTimeUTC(lat, lon, now, true);
  const sunsetUTC = sunTimeUTC(lat, lon, now, false);
  if (sunriseUTC == null || sunsetUTC == null) return now.getHours() < 7 || now.getHours() >= 21;
  const nowUTC = now.getUTCHours() + now.getUTCMinutes() / 60;
  return nowUTC < sunriseUTC || nowUTC > sunsetUTC;
}

// ═══════════════════════════════════════════════════
// THÈME (clair / sombre / auto)
// ═══════════════════════════════════════════════════
function applyStoredTheme() {
  const mode = localStorage.getItem('studyos-theme') || 'auto';
  const dark = mode === 'dark' || (mode === 'auto' && isNightTime());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#15171C' : '#FFFFFF');
  applyStoredAccent();
}

function setTheme(mode) {
  localStorage.setItem('studyos-theme', mode);
  applyStoredTheme();
  if (mode === 'auto') requestGeoOnce();
  renderSettings();
}

// En mode "Auto", revérifie périodiquement si le lever/coucher du soleil est franchi
setInterval(() => {
  if ((localStorage.getItem('studyos-theme') || 'auto') === 'auto') applyStoredTheme();
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════
// TAILLE DE TEXTE
// ═══════════════════════════════════════════════════
const TEXT_SIZES = { petit: 0.9, normal: 1, grand: 1.15 };

function applyStoredTextSize() {
  const size = localStorage.getItem('studyos-textsize') || 'normal';
  document.documentElement.style.zoom = TEXT_SIZES[size] || 1;
}

function setTextSize(size) {
  localStorage.setItem('studyos-textsize', size);
  applyStoredTextSize();
  renderSettings();
}

// ═══════════════════════════════════════════════════
// DATES D'EXAMEN PERSONNALISÉES
// ═══════════════════════════════════════════════════
const guestExamDates = {};

function getExamDateOverrides() {
  if (GUEST_MODE) return guestExamDates;
  try { return JSON.parse(localStorage.getItem('studyos-examdates') || '{}'); }
  catch { return {}; }
}

function getExamDate(subjectId) {
  const overrides = getExamDateOverrides();
  return overrides[subjectId] || (subjects[subjectId] && subjects[subjectId].exam);
}

function setExamDate(subjectId, dateStr) {
  const overrides = getExamDateOverrides();
  if (dateStr) overrides[subjectId] = dateStr;
  else delete overrides[subjectId];
  if (!GUEST_MODE) localStorage.setItem('studyos-examdates', JSON.stringify(overrides));
  toast(GUEST_MODE ? 'Date modifiée pour cette session uniquement' : 'Date d\'examen mise à jour');
}

// ═══════════════════════════════════════════════════
// RAPPELS DE RÉVISION
// ═══════════════════════════════════════════════════
async function setReminders(on) {
  if (on && 'Notification' in window) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications refusées par le navigateur'); on = false; }
  }
  localStorage.setItem('studyos-reminders', on ? 'on' : 'off');
  renderSettings();
}

async function checkReminders() {
  if (localStorage.getItem('studyos-reminders') !== 'on') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = localDateStr();
  if (localStorage.getItem('studyos-reminder-last') === today) return;

  let due = 0;
  for (const id of SUBJECTS_ORDER) {
    if (!subjects[id]) continue;
    const stats = await getSubjectStats(id);
    const dueQCM = await getDueQCMs(id);
    due += (stats.due || 0) + dueQCM.length;
  }

  if (due > 0) {
    new Notification('StudyOS — Révisions du jour', {
      body: `Tu as ${due} exercice${due > 1 ? 's' : ''} à réviser aujourd'hui.`,
      icon: '/icons/icon-192.png',
    });
  }
  localStorage.setItem('studyos-reminder-last', today);
}

const SUBJECTS_ORDER = ['geo', 'philo', 'bio', 'maths', 'francais', 'chimie'];

const SUBJECT_COLORS = {
  geo:      { primary: '#2F8FE0' },
  philo:    { primary: '#8B5CF6' },
  bio:      { primary: '#14B8A6' },
  francais: { primary: '#EC4899' },
  maths:    { primary: '#EAB308' },
  chimie:   { primary: '#22C55E' },
};

const SUBJECT_SHORT = {
  geo:      'Géo',
  philo:    'Philo',
  bio:      'Bio',
  francais: 'Français',
  maths:    'Math',
  chimie:   'Chimie',
};

const SUBJECT_ICONS = {
  geo:      '🌍',
  philo:    '🧠',
  bio:      '🧬',
  francais: '📖',
  maths:    '📐',
  chimie:   '🧪',
};

const LEITNER_DAYS = [1, 3, 7]; // par boîte 1, 2, 3

// Code d'accès Charles (6 chiffres) — à changer ici si besoin
const CHARLES_CODE = '124816';

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
let db;
let GUEST_MODE = false;
let subjects = {};
let currentSubject = null;
let fcSession = null;
let qcmSession = null;
let qcmColorSession = null;
let metDbSession = null;
let dashboardData = null;
let currentView = 'home';
let learnSubView = 'subject'; // 'subject' | 'flashcard' | 'qcm' | 'qcm-color' | 'met-db' | 'fiche-view' | 'controle-question'

// Agenda
let agendaDays = [];


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
// MODE INVITÉ — base en mémoire (rien n'est persisté)
// Implémente la même interface que IndexedDB (transaction/objectStore)
// ═══════════════════════════════════════════════════
function createMemDB() {
  const KEY_PATH = { questions: 'id' };
  const stores = {
    progress: new Map(),
    qcm_progress: new Map(),
    controle_responses: new Map(),
    questions: new Map(),
  };

  function makeRequest(compute) {
    const req = {};
    req.result = compute();
    Promise.resolve().then(() => { if (req.onsuccess) req.onsuccess({ target: req }); });
    return req;
  }

  return {
    transaction(storeNames) {
      const tx = {};
      Promise.resolve().then(() => { if (tx.oncomplete) tx.oncomplete(); });
      tx.objectStore = name => {
        const map = stores[name];
        return {
          get: key => makeRequest(() => map.get(key)),
          getAll: () => makeRequest(() => Array.from(map.values())),
          put: (value, key) => makeRequest(() => {
            map.set(KEY_PATH[name] ? value[KEY_PATH[name]] : key, value);
          }),
          clear: () => makeRequest(() => map.clear()),
          openCursor: () => {
            const entries = Array.from(map.entries());
            let i = 0;
            const req = {};
            const emit = () => Promise.resolve().then(() => {
              req.result = i < entries.length
                ? { key: entries[i][0], value: entries[i++][1], continue: emit }
                : null;
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            emit();
            return req;
          },
        };
      };
      return tx;
    },
  };
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
  if (learnSubView === 'qcm-color' && qcmColorSession) {
    const q = qcmColorSession.questions[qcmColorSession.idx];
    const subId = qcmColorSession.subjectId;
    return {
      type: 'qcm-color',
      subject: (subjects[subId] || {}).name || subId,
      id: q.id,
      label: `QCM Microscopie : organites rose/bleu`,
      img: q.img,
      rose: q.rose,
      bleu: q.bleu,
      opts: q.opts
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
  bio:      { file: '/data/vocabulaire-bio.json',      name: 'Vocabulaire Biologie',   color: '#14B8A6' },
  geo:      { file: '/data/vocabulaire-geo.json',      name: 'Vocabulaire Géographie', color: '#2F8FE0' },
  chimie:   { file: '/data/vocabulaire-chimie.json',   name: 'Vocabulaire Chimie',     color: '#22C55E' },
  philo:    { file: '/data/vocabulaire-philo.json',    name: 'Vocabulaire Philo',      color: '#8B5CF6' },
  francais: { file: '/data/vocabulaire-francais.json', name: 'Vocabulaire Français',   color: '#EC4899' },
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

// Date locale (YYYY-MM-DD) — éviter le décalage de toISOString() (UTC)
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════
function setNavbarVisible(visible) {
  document.querySelector('.navbar')?.classList.toggle('navbar-hidden', !visible);
  document.querySelector('.bottom-fade')?.classList.toggle('hidden', !visible);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const viewEl = document.getElementById(`view-${name}`);
  if (!viewEl) return;
  viewEl.classList.add('active');
  const btn = document.querySelector(`[data-nav="${name}"]`);
  if (btn) btn.classList.add('active');
  currentView = name;
  if (name !== 'learn') setNavbarVisible(true);
  if (name === 'home') renderHome();
  else if (name === 'agenda') renderAgenda();
  else if (name === 'stats') renderStats();
  else if (name === 'settings') renderSettings();
}

// Navigate to subject from home card
function goToSubject(id) {
  showView('learn');
  renderSubjectPage(id);
}

// ═══════════════════════════════════════════════════
// SCORE COMBINÉ
// ═══════════════════════════════════════════════════
function combinedScore({ flashPct, qcmTotal, qcmMastered, checklistPct }) {
  const parts = [flashPct];
  if (qcmTotal > 0) parts.push(Math.round(qcmMastered / qcmTotal * 100));
  if (checklistPct != null) parts.push(checklistPct);
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

// Rond de progression SVG
function progressRing(pct, color, size = 64, label = null) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return `
  <div class="ring" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 36 36">
      <circle class="ring-bg" cx="18" cy="18" r="${r}"/>
      <circle class="ring-fill" cx="18" cy="18" r="${r}"
        stroke-dasharray="${(pct / 100 * c).toFixed(2)} ${c.toFixed(2)}"
        style="stroke:${color}"/>
    </svg>
    <div class="ring-label">${label ?? pct + '%'}</div>
  </div>`;
}

// ═══════════════════════════════════════════════════
// VIEW 1 — HOME
// ═══════════════════════════════════════════════════
async function renderHome() {
  const view = document.getElementById('view-home');

  // Greeting
  const h = new Date().getHours();
  const greeting = h >= 18 ? 'Bonsoir' : (h >= 12 ? 'Bon après-midi' : 'Bonjour');
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

  // Subject grid — score combiné par matière
  const subjectScores = await Promise.all(SUBJECTS_ORDER.map(async id => {
    const s = subjects[id];
    if (!s) return null;
    const stats = await getSubjectStats(id);
    const qcmStats = await getQCMStats(id);
    const dueQCM = await getDueQCMs(id);
    const flashPct = stats.total ? Math.round((stats.b1 * 0.25 + stats.b2 * 0.6 + stats.b3 * 1.0) / stats.total * 100) : 0;
    const checklistPct = dashboardData?.subjects?.[id]?.checklist?.pct ?? null;
    const score = combinedScore({ flashPct, qcmTotal: qcmStats.total, qcmMastered: qcmStats.mastered, checklistPct });
    const due = (stats.due || 0) + dueQCM.length;
    return { id, s, score, due };
  }));

  const globalScore = (() => {
    const valid = subjectScores.filter(Boolean);
    if (!valid.length) return 0;
    return Math.round(valid.reduce((sum, v) => sum + v.score, 0) / valid.length);
  })();

  const progCards = subjectScores.map(entry => {
    if (!entry) return '';
    const { id, s, score, due } = entry;
    const col = SUBJECT_COLORS[id] || { primary: '#5C6BC0' };
    const days = daysUntil(getExamDate(id));
    const ctaText = due > 0 ? `${due} exercice${due > 1 ? 's' : ''}` : 'Tout est fait ✓';

    return `
    <div class="subject-cell" onclick="goToSubject('${id}')">
      <div class="sc-top">
        ${progressRing(score, col.primary, 44, SUBJECT_ICONS[id] || '📘')}
        <div class="sc-name">${SUBJECT_SHORT[id] || s.name}</div>
      </div>
      <div class="sc-info">
        <div class="sc-days" style="color:${col.primary}">Examen dans ${days}j</div>
      </div>
      <div class="sc-cta" style="background:${col.primary}1A;color:${col.primary}">
        <span>${ctaText}</span>
        ${CHEVRON_ICON}
      </div>
    </div>`;
  });

  const syncDate = (dashboardData && dashboardData.generated)
    ? new Date(dashboardData.generated).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;

  view.innerHTML = `
  <div class="home-header">
    <div class="home-greeting">${greeting}, ${getDisplayName()}</div>
    <div class="home-date">${capFirst(dateStr)}</div>
  </div>

  <div class="global-score-card">
    ${progressRing(globalScore, 'var(--accent)', 76)}
    <div class="gsc-info">
      <div class="gsc-label">Avancement global</div>
      <div class="gsc-sub">Moyenne de tes ${subjectScores.filter(Boolean).length} matières</div>
    </div>
  </div>

  ${nextExamHTML}

  <div class="section-label">Matières</div>
  <div class="subject-grid">${progCards.join('')}</div>

  ${syncDate ? `<div class="sync-footer"><span class="sync-dot"></span>Sync Claude : ${syncDate}</div>` : ''}
  `;
}

// ═══════════════════════════════════════════════════
// VIEW 2 — PAGE MATIÈRE UNIFIÉE
// ═══════════════════════════════════════════════════
async function renderSubjectPage(id) {
  learnSubView = 'subject';
  setNavbarVisible(true);
  currentSubject = id;
  const s = subjects[id];
  const col = SUBJECT_COLORS[id] || { primary: '#5C6BC0' };
  const stats = await getSubjectStats(id);
  const dueFC = await getDueCards(id);
  const qcmStats = await getQCMStats(id);
  const qcmDue = await getDueQCMs(id);
  const view = document.getElementById('view-learn');
  const days = daysUntil(getExamDate(id));

  const flashPct = stats.total ? Math.round((stats.b1 * 0.25 + stats.b2 * 0.6 + stats.b3 * 1.0) / stats.total * 100) : 0;
  const checklistPct = dashboardData?.subjects?.[id]?.checklist?.pct ?? null;
  const score = combinedScore({ flashPct, qcmTotal: qcmStats.total, qcmMastered: qcmStats.mastered, checklistPct });

  // ── Vocabulaire / anti-vocabulaire ──
  const vocabSrc = VOCAB_SOURCES[id];
  let vocabHTML = '';
  if (vocabSrc) {
    await loadVocabSource(id);
    const data = vocabCache[id];
    const count = data ? data.flashcards.length : 0;
    const cats = data ? [...new Set(data.flashcards.map(c => c.cat))].length : 0;
    vocabHTML = `
    <div class="section-label">Vocabulaire</div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
      <div class="vocab-card" onclick="openVocabDetail('${id}')">
        <div class="vc-left">
          <div><div class="vc-name">${vocabSrc.name}</div><div class="vc-meta">${count} termes · ${cats} thèmes</div></div>
        </div>
        <div class="vc-arrow">${CHEVRON_ICON}</div>
      </div>
      <div class="vocab-card" onclick="openAntiVocabDetail('${id}')" style="opacity:.9">
        <div class="vc-left">
          <div><div class="vc-name">${vocabSrc.name.replace('Vocabulaire', 'Anti-vocab')}</div><div class="vc-meta">${count} définitions → trouver le terme</div></div>
        </div>
        <div class="vc-arrow">${CHEVRON_ICON}</div>
      </div>
    </div>`;
  }

  // ── Fiches de révision de cette matière ──
  const allFiches = await loadFicheIndex();
  const fiches = allFiches.filter(f => f.matiere === id);
  const fichesHTML = fiches.length ? `
    <div class="section-label">Fiches de révision</div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
      ${fiches.map(f => `
      <div class="today-subject-row" style="cursor:pointer" onclick="openFicheView('${f.id}')">
        <div class="tsr-info"><div class="tsr-name">${f.titre}</div><div class="tsr-count">${f.sous_titre || ''}</div></div>
        <div class="vc-arrow">${CHEVRON_ICON}</div>
      </div>`).join('')}
    </div>` : '';

  // ── Contrôles disponibles + réponses sauvegardées pour cette matière ──
  let available = [];
  try {
    const r = await fetch('/data/controles/index.json');
    available = await r.json();
  } catch { available = []; }
  const controles = available.filter(c => c.matiere === id);
  const responses = await dbGetAllControles();
  const savedIds = Object.keys(responses).filter(rid => responses[rid].matiere === id);

  const controlesHTML = (controles.length || savedIds.length) ? `
    <div class="section-label">Contrôles</div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
      ${controles.map(item => `
      <div class="today-subject-row">
        <div class="tsr-info"><div class="tsr-name">${item.titre}</div><div class="tsr-count">${item.questions} questions</div></div>
        ${item.fiche_id ? `<button class="btn" style="color:${col.primary};padding:10px 12px;font-size:13px" onclick="openFicheView('${item.fiche_id}')" title="Lire la fiche">Fiche</button>` : ''}
        <button class="btn" style="color:${col.primary};padding:10px 14px;font-size:13px" onclick="startControle('${item.id}')">Démarrer</button>
      </div>`).join('')}
      ${savedIds.map(rid => {
        const r = responses[rid];
        const date = new Date(r.date).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const mins = Math.round(r.duree_totale_secondes / 60);
        return `
        <div class="today-subject-row" style="cursor:pointer" onclick="openControleResult('${rid}')">
          <div class="tsr-info"><div class="tsr-name">${r.titre}</div><div class="tsr-count">${date} · ${mins} min</div></div>
          <button class="btn" style="color:${col.primary};padding:7px 12px;font-size:12px" onclick="event.stopPropagation();exportControleResponse('${rid}')">↗</button>
        </div>`;
      }).join('')}
    </div>` : '';

  view.innerHTML = `
  <div class="subj-header" style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="showView('home')">←</button>
    <div style="flex:1">
      <div style="font-size:22px;font-weight:900;color:var(--text);letter-spacing:-.4px">${s.name}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">${s.type || 'Matière'} · dans ${days} jours · ${formatDate(getExamDate(id))}</div>
    </div>
    ${progressRing(score, col.primary, 52, String(score))}
  </div>

  <div class="leitner-stat-row">
    <div class="lstat" style="--c:#ef4444"><div class="lstat-n">${stats.b1}</div><div class="lstat-l">Boîte 1</div></div>
    <div class="lstat" style="--c:#f97316"><div class="lstat-n">${stats.b2}</div><div class="lstat-l">Boîte 2</div></div>
    <div class="lstat" style="--c:#16a34a"><div class="lstat-n">${stats.b3}</div><div class="lstat-l">Boîte 3</div></div>
  </div>

  <div class="section-label">Flashcards</div>
  <div class="action-list">
    <div class="action-btn" onclick="startFlashcards('${id}','due')">
      <div class="ab-info"><div class="ab-title">À réviser aujourd'hui</div><div class="ab-sub">${dueFC.length} carte${dueFC.length === 1 ? '' : 's'} due${dueFC.length === 1 ? '' : 's'}</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>
    <div class="action-btn" onclick="startFlashcards('${id}','all')">
      <div class="ab-info"><div class="ab-title">Toutes les flashcards</div><div class="ab-sub">${s.flashcards.length} carte${s.flashcards.length === 1 ? '' : 's'} au total</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>
  </div>

  <div class="section-label">QCM</div>
  <div class="action-list">
    <div class="action-btn" onclick="startQCM('${id}','due')">
      <div class="ab-info"><div class="ab-title">À réviser aujourd'hui</div><div class="ab-sub">${qcmDue.length} question${qcmDue.length === 1 ? '' : 's'} due${qcmDue.length === 1 ? '' : 's'}</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>
    <div class="action-btn" onclick="startQCM('${id}','quick')">
      <div class="ab-info"><div class="ab-title">Session rapide</div><div class="ab-sub">5 questions aléatoires</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>
    <div class="action-btn" onclick="startQCM('${id}','all')">
      <div class="ab-info"><div class="ab-title">Tous les QCM</div><div class="ab-sub">${s.qcm.length} questions</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>
    ${s.qcmImg && s.qcmImg.length ? `
    <div class="action-btn" onclick="startMETDatabase('${id}')">
      <div class="ab-info"><div class="ab-title">MET Database</div><div class="ab-sub">${s.qcmImg.length} images de microscopie électronique à parcourir</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>
    ` : ''}
    ${s.qcmColor && s.qcmColor.length ? `
    <div class="action-btn" onclick="startQCMColor('${id}')">
      <div class="ab-info"><div class="ab-title">QCM Microscopie</div><div class="ab-sub">${s.qcmColor.length} images — identifie les organites rose/bleu</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>
    ` : ''}
  </div>

  ${vocabHTML}
  ${fichesHTML}
  ${controlesHTML}
  <div style="height:20px"></div>
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
      <div class="ab-info"><div class="ab-title">${cat}</div><div class="ab-sub">${n} termes</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>`;
  }).join('');

  view.innerHTML = `
  <div style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="renderSubjectPage('${sourceId}')">←</button>
    <div>
      <div style="font-size:20px;font-weight:900;color:var(--text)">${src.name}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">${cards.length} termes · ${cats.length} thèmes</div>
    </div>
  </div>
  <div style="padding:0 16px;margin-bottom:14px">
    <div class="action-btn" onclick="startVocab('${sourceId}',null)">
      <div class="ab-info"><div class="ab-title">Tous les termes (mélangés)</div><div class="ab-sub">${cards.length} cartes</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
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
      <div class="ab-info"><div class="ab-title">${cat}</div><div class="ab-sub">${n} définitions</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
    </div>`;
  }).join('');

  view.innerHTML = `
  <div style="padding:max(env(safe-area-inset-top,0),52px) 20px 16px;display:flex;align-items:center;gap:14px">
    <button class="back-btn" onclick="renderSubjectPage('${sourceId}')">←</button>
    <div>
      <div style="font-size:20px;font-weight:900;color:var(--text)">Anti-vocab ${src.name.replace('Vocabulaire ','')}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">Définition → trouver le terme · ${cards.length} cartes</div>
    </div>
  </div>
  <div style="padding:0 16px;margin-bottom:14px">
    <div class="action-btn" onclick="startAntiVocab('${sourceId}',null)">
      <div class="ab-info"><div class="ab-title">Tous les termes (mélangés)</div><div class="ab-sub">${cards.length} cartes</div></div>
      <div class="ab-arrow">${CHEVRON_ICON}</div>
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

// ═══════════════════════════════════════════════════
// FLASHCARD SESSION
// ═══════════════════════════════════════════════════
async function startFlashcards(subjectId, mode) {
  const s = subjects[subjectId];
  let cards = mode === 'due' ? await getDueCards(subjectId) : [...s.flashcards];
  if (cards.length === 0) { toast('Toutes les cartes sont à jour !'); return; }
  cards = shuffle(cards);
  fcSession = { subjectId, cards, idx: 0, correct: 0, bof: 0, wrong: 0, mode };
  learnSubView = 'flashcard';
  renderFlashcard();
}

function renderFlashcard() {
  const { subjectId, cards, idx } = fcSession;
  const view = document.getElementById('view-learn');
  learnSubView = 'flashcard';
  setNavbarVisible(false);

  if (idx >= cards.length) { renderFlashcardEnd(); return; }

  const card = cards[idx];
  const subId = card._subject || subjectId;
  const isVocab = subjectId.startsWith('vocab_') || subjectId === 'vocab';
  const isAntiVocab = subjectId.startsWith('antivocab_') || subjectId === 'antivocab';
  const vocabColor = (isVocab || isAntiVocab) ? (fcSession._color || '#0891b2') : null;
  const col = (isVocab || isAntiVocab) ? { primary: vocabColor } : (SUBJECT_COLORS[subId] || { primary: '#5C6BC0' });
  const pct = Math.round((idx / cards.length) * 100);
  const catLabel = card.cat;
  const backRef = (isVocab || isAntiVocab) ? (fcSession._backFn || `renderSubjectPage('${subjectId}')`) : `renderSubjectPage('${subjectId}')`;

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
  setNavbarVisible(true);
  const { subjectId, cards, correct, bof, wrong, mode } = fcSession;
  const isVocabEnd = subjectId === 'vocab' || subjectId.startsWith('vocab_');
  const isAntiVocabEnd = subjectId === 'antivocab' || subjectId.startsWith('antivocab_');
  const isVocabAny = isVocabEnd || isAntiVocabEnd;

  const sessionName = isAntiVocabEnd ? 'Anti-vocabulaire'
    : isVocabEnd ? 'Vocabulaire'
    : (subjects[subjectId] || {}).name || subjectId;

  const backFn = isVocabAny
    ? (fcSession._backFn || `renderSubjectPage('${subjectId}')`)
    : `renderSubjectPage('${subjectId}')`;

  const view = document.getElementById('view-learn');
  const total = cards.length;
  const pct = total ? Math.round(((correct + bof * 0.5) / total) * 100) : 0;
  const msg = pct >= 80 ? 'Excellent travail !' : pct >= 55 ? 'Continue comme ça !' : 'Révise encore ce soir !';

  const scoresHtml = isAntiVocabEnd
    ? `<div class="ses-item" style="color:#ef4444"><div class="ses-n">${wrong}</div><div class="ses-l">Je cherche</div></div>
       <div class="ses-item" style="color:#16a34a"><div class="ses-n">${correct}</div><div class="ses-l">Je savais</div></div>`
    : `<div class="ses-item" style="color:#ef4444"><div class="ses-n">${wrong}</div><div class="ses-l">Non</div></div>
       <div class="ses-item" style="color:#f97316"><div class="ses-n">${bof}</div><div class="ses-l">Bof</div></div>
       <div class="ses-item" style="color:#16a34a"><div class="ses-n">${correct}</div><div class="ses-l">Oui</div></div>`;

  const actionHtml = isVocabAny
    ? `<button class="btn-primary" onclick="${backFn}">Retour</button>`
    : `<button class="btn-primary" onclick="startFlashcards('${subjectId}', '${mode}')">Recommencer</button>
       <button class="btn-secondary" onclick="renderSubjectPage('${subjectId}')">Retour</button>`;

  view.innerHTML = `
  <div class="fc-header">
    <button class="back-btn" onclick="${backFn}">←</button>
    <div style="font-size:15px;font-weight:700;flex:1;text-align:center;color:var(--text)">Session terminée</div>
    <div style="width:40px"></div>
  </div>
  <div class="session-end">
    <div class="se-pct">${pct}%</div>
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

function renderQCM() {
  const { subjectId, questions, idx } = qcmSession;
  const view = document.getElementById('view-learn');
  learnSubView = 'qcm';
  setNavbarVisible(false);

  if (idx >= questions.length) { renderQCMEnd(); return; }

  const q = questions[idx];
  const subId = q._subject || subjectId;
  const col = SUBJECT_COLORS[subId] || { primary: '#5C6BC0' };
  const pct = Math.round((idx / questions.length) * 100);
  const backFn = `renderSubjectPage('${subjectId}')`;

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
      `<div class="qcm-explanation">${expHtml}</div>`;
  }

  const nextBtn = document.getElementById('qcm-next');
  if (nextBtn) nextBtn.classList.add('show');
}

function nextQCM() { qcmSession.idx++; renderQCM(); }

function renderQCMEnd() {
  setNavbarVisible(true);
  const { subjectId, questions, correct, mode } = qcmSession;
  const s = subjects[subjectId];
  const view = document.getElementById('view-learn');
  const pct = Math.round((correct / questions.length) * 100);
  const msg = pct >= 80 ? 'Excellente maîtrise !' : pct >= 60 ? 'Bon travail !' : 'Révise les notions manquées !';
  const backFn = `renderSubjectPage('${subjectId}')`;

  view.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="${backFn}">←</button>
    <div style="font-size:15px;font-weight:700;flex:1;text-align:center;color:var(--text)">QCM terminé</div>
    <div style="width:40px"></div>
  </div>
  <div class="session-end">
    <div class="se-pct">${pct}%</div>
    <div class="se-title">${msg}</div>
    <div class="se-sub">${s.name} · ${questions.length} question${questions.length > 1 ? 's' : ''}</div>
    <div class="se-scores">
      <div class="ses-item" style="color:#ef4444"><div class="ses-n">${questions.length - correct}</div><div class="ses-l">Fausses</div></div>
      <div class="ses-item" style="color:#16a34a"><div class="ses-n">${correct}</div><div class="ses-l">Correctes</div></div>
      <div class="ses-item" style="color:var(--accent)"><div class="ses-n">${pct}%</div><div class="ses-l">Score</div></div>
    </div>
    <button class="btn-primary" onclick="startQCM('${subjectId}', '${mode}')">Recommencer</button>
    <button class="btn-secondary" onclick="renderSubjectPage('${subjectId}')">Retour à ${s.name}</button>
  </div>
  `;
}

// ═══════════════════════════════════════════════════
// QCM COLORATION (image avec organites colorés rose/bleu)
// ═══════════════════════════════════════════════════
async function startQCMColor(subjectId) {
  const s = subjects[subjectId];
  qcmColorSession = { subjectId, questions: shuffle([...s.qcmColor]), idx: 0, correct: 0, parts: 0 };
  learnSubView = 'qcm-color';
  renderQCMColor();
}

function renderQCMColor() {
  const { subjectId, questions, idx } = qcmColorSession;
  const view = document.getElementById('view-learn');
  learnSubView = 'qcm-color';
  setNavbarVisible(false);

  if (idx >= questions.length) { renderQCMColorEnd(); return; }

  const q = questions[idx];
  const col = SUBJECT_COLORS[subjectId] || { primary: '#5C6BC0' };
  const pct = Math.round((idx / questions.length) * 100);

  const optsHtml = q.opts.map(o => `<option value="${o}">${o}</option>`).join('');

  view.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="renderSubjectPage('${subjectId}')">←</button>
    <div class="fc-progress-bar">
      <div class="fc-progress-fill" style="width:${pct}%; background:${col.primary}"></div>
    </div>
    <div class="fc-counter">${idx + 1}/${questions.length}</div>
    <button class="help-btn" onclick="openQuestionModal()">?</button>
  </div>
  <div class="qcm-body">
    <div class="qcm-question">Identifie les organites colorés sur cette image</div>
    <img class="qcm-img" src="${q.img}" alt="Image de microscopie colorée">
    <div class="qcmc-group">
      <label class="qcmc-label qcmc-rose">Organite en rose</label>
      <select class="qcmc-select" id="qcmc-rose">
        <option value="">— Choisis une réponse —</option>
        ${optsHtml}
      </select>
    </div>
    <div class="qcmc-group">
      <label class="qcmc-label qcmc-bleu">Organite en bleu</label>
      <select class="qcmc-select" id="qcmc-bleu">
        <option value="">— Choisis une réponse —</option>
        ${optsHtml}
      </select>
    </div>
    <button class="btn-primary" id="qcmc-validate" onclick="validateQCMColor()">Valider</button>
    <div id="qcmc-feedback"></div>
  </div>
  <button class="qcm-next-btn" id="qcm-next" onclick="nextQCMColor()">
    ${idx + 1 < questions.length ? 'Question suivante →' : 'Voir les résultats'}
  </button>
  `;
}

function organelleExplanation(subjectId, name) {
  const s = subjects[subjectId];
  if (!s || !s.qcmImg) return null;
  const entry = s.qcmImg.find(q => q.opts[q.ans] === name);
  return entry ? entry.exp : null;
}

function validateQCMColor() {
  const { subjectId, questions, idx } = qcmColorSession;
  const q = questions[idx];
  const roseSel = document.getElementById('qcmc-rose');
  const bleuSel = document.getElementById('qcmc-bleu');

  if (!roseSel.value || !bleuSel.value) { toast('Choisis une réponse pour chaque couleur'); return; }

  const roseOk = roseSel.value === q.rose;
  const bleuOk = bleuSel.value === q.bleu;

  roseSel.classList.add(roseOk ? 'correct' : 'wrong');
  bleuSel.classList.add(bleuOk ? 'correct' : 'wrong');
  roseSel.disabled = true;
  bleuSel.disabled = true;
  document.getElementById('qcmc-validate').disabled = true;

  if (roseOk) qcmColorSession.parts++;
  if (bleuOk) qcmColorSession.parts++;
  if (roseOk && bleuOk) qcmColorSession.correct++;

  const fmt = t => (t || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const roseExp = organelleExplanation(subjectId, q.rose);
  const bleuExp = organelleExplanation(subjectId, q.bleu);

  const feedback = `
    <div class="qcm-explanation"><strong class="qcmc-rose-text">${roseOk ? '✓' : '✗'} Rose — ${q.rose}</strong>${roseExp ? `<br>${fmt(roseExp)}` : ''}</div>
    <div class="qcm-explanation"><strong class="qcmc-bleu-text">${bleuOk ? '✓' : '✗'} Bleu — ${q.bleu}</strong>${bleuExp ? `<br>${fmt(bleuExp)}` : ''}</div>
  `;
  document.getElementById('qcmc-feedback').innerHTML = feedback;

  const nextBtn = document.getElementById('qcm-next');
  if (nextBtn) nextBtn.classList.add('show');
}

function nextQCMColor() { qcmColorSession.idx++; renderQCMColor(); }

function renderQCMColorEnd() {
  setNavbarVisible(true);
  const { subjectId, questions, correct, parts } = qcmColorSession;
  const s = subjects[subjectId];
  const view = document.getElementById('view-learn');
  const totalParts = questions.length * 2;
  const pct = Math.round((parts / totalParts) * 100);
  const msg = pct >= 80 ? 'Excellente reconnaissance !' : pct >= 60 ? 'Bon travail !' : 'Révise les organites manqués !';

  view.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="renderSubjectPage('${subjectId}')">←</button>
    <div style="font-size:15px;font-weight:700;flex:1;text-align:center;color:var(--text)">QCM Microscopie terminé</div>
    <div style="width:40px"></div>
  </div>
  <div class="session-end">
    <div class="se-pct">${pct}%</div>
    <div class="se-title">${msg}</div>
    <div class="se-sub">${s.name} · ${questions.length} image${questions.length > 1 ? 's' : ''} · ${correct}/${questions.length} entièrement correctes</div>
    <div class="se-scores">
      <div class="ses-item" style="color:#ef4444"><div class="ses-n">${totalParts - parts}</div><div class="ses-l">Organites ratés</div></div>
      <div class="ses-item" style="color:#16a34a"><div class="ses-n">${parts}</div><div class="ses-l">Organites OK</div></div>
      <div class="ses-item" style="color:var(--accent)"><div class="ses-n">${pct}%</div><div class="ses-l">Score</div></div>
    </div>
    <button class="btn-primary" onclick="startQCMColor('${subjectId}')">Recommencer</button>
    <button class="btn-secondary" onclick="renderSubjectPage('${subjectId}')">Retour à ${s.name}</button>
  </div>
  `;
}

// ═══════════════════════════════════════════════════
// MET DATABASE (banque d'images de microscopie électronique)
// ═══════════════════════════════════════════════════
function startMETDatabase(subjectId) {
  const s = subjects[subjectId];
  metDbSession = { subjectId, order: shuffle([...Array(s.qcmImg.length).keys()]), pos: 0 };
  learnSubView = 'met-db';
  renderMETDatabase();
}

function renderMETDatabase() {
  const { subjectId, order, pos } = metDbSession;
  const s = subjects[subjectId];
  const q = s.qcmImg[order[pos]];
  const view = document.getElementById('view-learn');
  learnSubView = 'met-db';
  setNavbarVisible(false);

  const name = q.opts[q.ans];
  const exp = (q.exp || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  view.innerHTML = `
  <div class="qcm-header">
    <button class="back-btn" onclick="renderSubjectPage('${subjectId}')">←</button>
    <div style="font-size:15px;font-weight:700;flex:1;text-align:center;color:var(--text)">MET Database</div>
    <div class="fc-counter">${pos + 1}/${order.length}</div>
  </div>
  <div class="qcm-body">
    <img class="qcm-img" src="${q.img}" alt="Image de microscopie électronique">
    <div class="qcm-question" style="text-align:center">${name}</div>
    ${exp ? `<div class="qcm-explanation">${exp}</div>` : ''}
  </div>
  <button class="qcm-next-btn show" onclick="nextMETDatabase()">Suivant →</button>
  `;
}

function nextMETDatabase() {
  metDbSession.pos++;
  if (metDbSession.pos >= metDbSession.order.length) {
    const s = subjects[metDbSession.subjectId];
    const last = metDbSession.order[metDbSession.order.length - 1];
    let newOrder = shuffle([...Array(s.qcmImg.length).keys()]);
    if (newOrder.length > 1 && newOrder[0] === last) {
      [newOrder[0], newOrder[1]] = [newOrder[1], newOrder[0]];
    }
    metDbSession.order = newOrder;
    metDbSession.pos = 0;
  }
  renderMETDatabase();
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

// ═══════════════════════════════════════════════════
// VIEW 4 — AGENDA
// ═══════════════════════════════════════════════════
function slotsHTML(day) {
  const plan = day;
  const dateKey = plan.fullDate;
  const checked = getAgendaChecked(dateKey);

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

  if (!anySlot && !plan.isExam) content = `<div class="agenda-empty">Rien de prévu ce jour</div>`;

  const totalAll = allTasks.length;
  const doneAll = allTasks.filter((_, i) => checked[i]).length;
  const progressPct = totalAll ? Math.round(doneAll / totalAll * 100) : 0;

  const progressBar = totalAll ? `
    <div class="agenda-progress-wrap">
      <div class="agenda-progress-track">
        <div class="agenda-progress-fill" style="width:${progressPct}%"></div>
      </div>
      <span class="agenda-progress-label">${doneAll}/${totalAll}</span>
    </div>` : '';

  return `${progressBar}${content}`;
}

function dayBadgeHTML(day) {
  if (day.isExam) {
    const examTask = day.tasks && day.tasks[0];
    const subName = examTask ? examTask.text.replace(/.*—\s*/, '') : 'Examen';
    return `<span class="agenda-row-tag" style="background:${day.examColor || 'var(--accent)'}">${subName}</span>`;
  }
  const tasks = day.tasks || [];
  if (!tasks.length) return `<span class="agenda-row-count">—</span>`;
  const checked = getAgendaChecked(day.fullDate);
  const done = tasks.filter((_, i) => checked[i]).length;
  return `<span class="agenda-row-count">${done}/${tasks.length}</span>`;
}

function renderAgenda() {
  const view = document.getElementById('view-agenda');
  if (!dashboardData || !dashboardData.planning || !dashboardData.planning.length) {
    view.innerHTML = `
    <div class="view-header"><div class="view-title">Agenda</div></div>
    <div class="agenda-no-data"><p>Aucun planning disponible.</p></div>`;
    return;
  }

  agendaDays = dashboardData.planning;
  const todayStr = localDateStr();
  const todayDay = agendaDays.find(d => d.fullDate === todayStr);

  let todayCardHTML;
  if (todayDay) {
    const dt = new Date(todayDay.fullDate);
    const fullDateStr = dt.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
    const examTagHtml = (todayDay.isExam && todayDay.examColor)
      ? `<span class="adh-exam-tag" style="background:${todayDay.examColor}">${(todayDay.tasks && todayDay.tasks[0]) ? todayDay.tasks[0].text : 'Examen'}</span>`
      : '';
    todayCardHTML = `
    <div class="agenda-today-card">
      <div class="agenda-detail-header">
        <div class="adh-date">Aujourd'hui — ${capFirst(fullDateStr)}</div>
        ${examTagHtml}
      </div>
      <div id="agenda-today-slots">${slotsHTML(todayDay)}</div>
    </div>`;
  } else {
    todayCardHTML = `
    <div class="agenda-today-card">
      <div class="agenda-detail-header"><div class="adh-date">Aujourd'hui</div></div>
      <div class="agenda-empty">Rien de prévu aujourd'hui</div>
    </div>`;
  }

  const dayRow = day => {
    const dt = new Date(day.fullDate);
    const isToday = day.fullDate === todayStr;
    const dayName = dt.toLocaleDateString('fr-BE', { weekday: 'short' });
    return `
    <div class="agenda-day-row${isToday ? ' is-today' : ''}" onclick="toggleAgendaDay('${day.fullDate}')">
      <div class="adr-date">${capFirst(dayName)} ${day.date}</div>
      <div id="agenda-row-badge-${day.fullDate}">${dayBadgeHTML(day)}</div>
      <div class="adr-chevron" id="adr-chevron-${day.fullDate}">${CHEVRON_ICON}</div>
    </div>
    <div class="agenda-day-detail" id="agenda-day-detail-${day.fullDate}" style="display:none"></div>`;
  };

  const pastRows = agendaDays.filter(d => d.fullDate < todayStr).map(dayRow).join('');
  const upcomingRows = agendaDays.filter(d => d.fullDate > todayStr).map(dayRow).join('');

  view.innerHTML = `
  <div class="view-header"><div class="view-title">Agenda</div></div>
  ${todayCardHTML}
  ${pastRows ? `
  <div class="agenda-past-toggle" onclick="togglePastDays()">
    <span>Jours passés</span>
    <span class="adr-chevron" id="past-toggle-chevron">${CHEVRON_ICON}</span>
  </div>
  <div class="agenda-day-list" id="agenda-past-list" style="display:none">${pastRows}</div>` : ''}
  <div class="agenda-day-list">${upcomingRows}</div>`;
}

function togglePastDays() {
  const list = document.getElementById('agenda-past-list');
  const chevron = document.getElementById('past-toggle-chevron');
  if (!list) return;
  const isOpen = list.style.display !== 'none';
  list.style.display = isOpen ? 'none' : 'block';
  chevron.classList.toggle('open', !isOpen);
}

function toggleAgendaDay(fullDate) {
  const detail = document.getElementById(`agenda-day-detail-${fullDate}`);
  const chevron = document.getElementById(`adr-chevron-${fullDate}`);
  if (!detail) return;
  const isOpen = detail.style.display !== 'none';
  if (isOpen) {
    detail.style.display = 'none';
    chevron.classList.remove('open');
  } else {
    const day = agendaDays.find(d => d.fullDate === fullDate);
    detail.innerHTML = slotsHTML(day);
    detail.style.display = 'block';
    chevron.classList.add('open');
  }
}

const guestAgendaChecked = {};
function getAgendaChecked(dateKey) {
  if (GUEST_MODE) return guestAgendaChecked[dateKey] || {};
  try { return JSON.parse(localStorage.getItem(`agenda-checked-${dateKey}`) || '{}'); } catch { return {}; }
}
function toggleAgendaTask(dateKey, taskIdx) {
  const checked = getAgendaChecked(dateKey);
  checked[taskIdx] = !checked[taskIdx];
  if (GUEST_MODE) guestAgendaChecked[dateKey] = checked;
  else localStorage.setItem(`agenda-checked-${dateKey}`, JSON.stringify(checked));

  const day = agendaDays.find(d => d.fullDate === dateKey);
  if (!day) return;

  const todaySlots = document.getElementById('agenda-today-slots');
  if (todaySlots && dateKey === localDateStr()) todaySlots.innerHTML = slotsHTML(day);

  const detail = document.getElementById(`agenda-day-detail-${dateKey}`);
  if (detail && detail.style.display !== 'none') detail.innerHTML = slotsHTML(day);

  const badge = document.getElementById(`agenda-row-badge-${dateKey}`);
  if (badge) badge.innerHTML = dayBadgeHTML(day);
}

// ═══════════════════════════════════════════════════
// VIEW 5 — STATS
// ═══════════════════════════════════════════════════
async function renderStats() {
  const view = document.getElementById('view-stats');
  view.innerHTML = `<div class="view-header"><div class="view-title">Stats</div></div><div class="loading-state">Chargement…</div>`;

  let totalSeen = 0, totalB3 = 0, totalVocabB3 = 0;

  // ── Matières régulières ──
  const subjectData = await Promise.all(SUBJECTS_ORDER.map(async id => {
    const s = subjects[id];
    if (!s) return null;
    const stats = await getSubjectStats(id);
    const qcmStats = await getQCMStats(id);
    const progress = await getCardProgress(id);
    const seen = Object.keys(progress).length;
    const flashPct = stats.total ? Math.round((stats.b1 * 0.25 + stats.b2 * 0.6 + stats.b3 * 1.0) / stats.total * 100) : 0;
    const checklistPct = dashboardData?.subjects?.[id]?.checklist?.pct ?? null;
    const score = combinedScore({ flashPct, qcmTotal: qcmStats.total, qcmMastered: qcmStats.mastered, checklistPct });

    totalSeen += seen;
    totalB3 += stats.b3;

    return { id, s, stats, qcmStats, checklistPct, score };
  }));

  const validSubjects = subjectData.filter(Boolean);
  const globalScore = validSubjects.length
    ? Math.round(validSubjects.reduce((sum, v) => sum + v.score, 0) / validSubjects.length)
    : 0;

  const subjectRows = validSubjects.map(({ id, s, stats, qcmStats, checklistPct, score }) => {
    const col = SUBJECT_COLORS[id] || { primary: '#5C6BC0' };
    const flashPct = stats.total ? Math.round(stats.b3 / stats.total * 100) : 0;
    const qPct = qcmStats.total ? Math.round(qcmStats.mastered / qcmStats.total * 100) : 0;

    return `
    <div class="stats-subject-row">
      <div class="ssr-top">
        <div class="ssr-name">${s.name}</div>
        <div class="ssr-score" style="color:${col.primary}">${score}%</div>
      </div>
      <div class="ssr-bar-bg"><div class="ssr-bar" style="width:${score}%; background:${col.primary}"></div></div>
      <details class="ssr-details">
        <summary>Détail Leitner</summary>
        ${checklistPct != null ? `<div class="ssr-detail-row"><span>Cours (checklist)</span><span>${checklistPct}% vu</span></div>` : ''}
        <div class="ssr-detail-row">
          <span>Flashcards</span>
          <span style="color:#ef4444">✗ ${stats.b1}</span>
          <span style="color:#f97316">~ ${stats.b2}</span>
          <span style="color:#16a34a">✓ ${stats.b3}</span>
          <span>${flashPct}%</span>
        </div>
        ${qcmStats.total ? `<div class="ssr-detail-row"><span>QCM</span><span>${qcmStats.mastered}/${qcmStats.total} maîtrisés</span><span>${qPct}%</span></div>` : ''}
      </details>
    </div>`;
  }).join('');

  // ── Vocabulaire & Anti-vocabulaire ──
  const vocabRows = [];
  for (const [srcId, src] of Object.entries(VOCAB_SOURCES)) {
    await loadVocabSource(srcId);
    const allCards = (vocabCache[srcId] || { flashcards: [] }).flashcards;
    const total = allCards.length;
    if (!total) continue;

    for (const prefix of ['vocab', 'antivocab']) {
      const key = `${prefix}_${srcId}`;
      const progress = await getCardProgress(key);
      const seen = Object.keys(progress).length;
      if (!seen) continue;

      let b3 = 0;
      allCards.forEach(c => {
        const p = progress[c.id];
        if (p && p.box === 3) b3++;
      });
      const pct = total ? Math.round(b3 / total * 100) : 0;
      totalVocabB3 += b3;

      const label = prefix === 'vocab' ? src.name : `Anti-vocab ${src.name.replace('Vocabulaire ', '')}`;
      vocabRows.push(`
      <div class="stats-vocab-row">
        <span class="svr-name">${label}</span>
        <span class="svr-meta">${seen}/${total} vus</span>
        <span class="svr-pct" style="color:${src.color}">${pct}%</span>
      </div>`);
    }
  }

  view.innerHTML = `
  <div class="view-header"><div class="view-title">Stats</div></div>

  <div class="global-score-card">
    ${progressRing(globalScore, 'var(--accent)', 64)}
    <div class="gsc-info">
      <div class="gsc-label">Avancement global</div>
      <div class="gsc-sub">${totalSeen} cartes vues · ${totalB3} en B3 · ${totalVocabB3} vocab B3</div>
    </div>
  </div>

  <div class="section-label">Par matière</div>
  ${subjectRows}

  ${vocabRows.length ? `<div class="section-label">Vocabulaire</div>${vocabRows.join('')}` : ''}
  `;
}

// ═══════════════════════════════════════════════════
// RÉGLAGES
// ═══════════════════════════════════════════════════
function renderSettings() {
  const view = document.getElementById('view-settings');
  const currentAccent = parseInt(localStorage.getItem('studyos-accent') || '0', 10);
  const currentTheme = localStorage.getItem('studyos-theme') || 'auto';
  const currentTextSize = localStorage.getItem('studyos-textsize') || 'normal';
  const remindersOn = localStorage.getItem('studyos-reminders') === 'on';

  const examRows = SUBJECTS_ORDER.filter(id => subjects[id]).map(id => {
    const s = subjects[id];
    return `
    <div class="examdate-row">
      <div class="examdate-name">${SUBJECT_ICONS[id] || '📘'} ${SUBJECT_SHORT[id] || s.name}</div>
      <input type="date" class="examdate-input" value="${getExamDate(id) || ''}" onchange="setExamDate('${id}', this.value); renderHome();">
    </div>`;
  }).join('');

  view.innerHTML = `
  <div class="view-header"><div class="view-title">Réglages</div></div>
  <div class="section-label">Profil</div>
  <div class="card card-sm">
    <label class="settings-label" for="settings-name-input">Nom affiché</label>
    <input id="settings-name-input" class="settings-input" type="text" value="${getDisplayName()}" maxlength="20" placeholder="Charles">
  </div>

  <div class="section-label">Couleur d'accentuation</div>
  <div class="settings-swatches">
    ${ACCENT_PRESETS.map((p, i) => `
    <button class="settings-swatch${i === currentAccent ? ' active' : ''}" style="background:${p.primary}" onclick="setAccentColor(${i})" aria-label="${p.name}"></button>`).join('')}
  </div>

  <div class="section-label">Apparence</div>
  <div class="settings-label" style="padding:0 16px 8px">Thème</div>
  <div class="seg-group">
    <button class="seg-btn${currentTheme === 'light' ? ' active' : ''}" onclick="setTheme('light')">Clair</button>
    <button class="seg-btn${currentTheme === 'dark' ? ' active' : ''}" onclick="setTheme('dark')">Sombre</button>
    <button class="seg-btn${currentTheme === 'auto' ? ' active' : ''}" onclick="setTheme('auto')">Auto</button>
  </div>
  <div class="settings-label" style="padding:8px 16px 8px">Taille du texte</div>
  <div class="seg-group">
    <button class="seg-btn${currentTextSize === 'petit' ? ' active' : ''}" onclick="setTextSize('petit')">Petit</button>
    <button class="seg-btn${currentTextSize === 'normal' ? ' active' : ''}" onclick="setTextSize('normal')">Normal</button>
    <button class="seg-btn${currentTextSize === 'grand' ? ' active' : ''}" onclick="setTextSize('grand')">Grand</button>
  </div>

  <div class="section-label">Dates d'examen</div>
  <div class="card card-sm" style="padding:0">
    ${examRows}
  </div>

  <div class="section-label">Rappels</div>
  <div class="card card-sm toggle-row" onclick="setReminders(${!remindersOn})">
    <div>
      <div class="toggle-title">Rappels de révision</div>
      <div class="toggle-sub">Notification au lancement si des révisions sont dues</div>
    </div>
    <div class="toggle-switch${remindersOn ? ' on' : ''}"><div class="toggle-knob"></div></div>
  </div>

  ${GUEST_MODE ? '' : `
  <div class="section-label">Données</div>
  <div class="action-list" style="margin-bottom:8px">
    <div class="action-btn action-sync" onclick="syncWithWiki()">
      <div class="ab-info"><div class="ab-title">Sync Wiki</div><div class="ab-sub">Mise à jour checklists (WiFi maison)</div></div>
    </div>
    <div class="action-btn action-export" onclick="exportProgress()">
      <div class="ab-info"><div class="ab-title">Exporter</div><div class="ab-sub">Télécharger ma progression JSON</div></div>
    </div>
    <div class="action-btn action-export" onclick="exportQuestions()">
      <div class="ab-info"><div class="ab-title">Exporter mes questions</div><div class="ab-sub">Télécharger les questions enregistrées (JSON)</div></div>
    </div>
    <div class="action-btn" onclick="runMigration()">
      <div class="ab-info"><div class="ab-title">Récupérer vocab perdu</div><div class="ab-sub">Migration ancienne clé → nouvelles clés</div></div>
    </div>
  </div>

  <div class="danger-zone">
    <div class="danger-label">Zone danger</div>
    <button class="reset-btn" onclick="resetProgress()">Réinitialiser la progression</button>
  </div>`}
  <div class="app-version">StudyOS ${APP_VERSION}</div>`;

  const input = document.getElementById('settings-name-input');
  input.addEventListener('change', () => {
    const val = input.value.trim() || 'Charles';
    localStorage.setItem('studyos-name', val);
    input.value = val;
  });
}

function setAccentColor(idx) {
  localStorage.setItem('studyos-accent', String(idx));
  applyStoredAccent();
  renderSettings();
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
  if (n > 0) { toast(`${n} cartes vocab récupérées !`); renderStats(); }
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
  renderStats();
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
async function init() {
  try {
    db = GUEST_MODE ? createMemDB() : await openDB();

    if (GUEST_MODE) {
      const banner = document.createElement('div');
      banner.className = 'guest-banner';
      banner.textContent = 'Mode invité — rien n\'est sauvegardé';
      document.body.prepend(banner);

      const statsNav = document.querySelector('.nav-btn[data-nav="stats"]');
      if (statsNav) statsNav.remove();
    }

    await loadAllSubjects();
    await loadDashboard();
    migrateOldVocabProgress().then(n => { if (n > 0) console.log(`Migration vocab: ${n} cartes récupérées`); });
    await renderHome();
    checkReminders();

    // Service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'SW_UPDATED') {
          const b = document.createElement('div');
          b.className = 'update-banner';
          b.innerHTML = `<div class="update-banner-box">Nouvelle version disponible (${APP_VERSION})<button onclick="location.reload()">Recharger</button></div>`;
          document.body.appendChild(b);
        }
      });
    }
  } catch (err) {
    console.error('Init error:', err);
    const homeView = document.getElementById('view-home');
    if (homeView) {
      homeView.innerHTML = `
      <div style="padding:40px 24px; text-align:center">
        <h2 style="color:var(--text)">Erreur de chargement</h2>
        <p style="color:var(--muted); margin-top:8px">Vérifie ta connexion puis recharge la page.</p>
      </div>`;
    }
  }
}

// ═══════════════════════════════════════════════════
// LOCK SCREEN
// ═══════════════════════════════════════════════════
function setupLockScreen() {
  const screen = document.getElementById('lock-screen');
  const input = document.getElementById('lock-pin');
  const error = document.getElementById('lock-error');

  function tryUnlock() {
    if (input.value === CHARLES_CODE) {
      localStorage.setItem('studyos-auth', 'charles');
      screen.remove();
      init();
    } else {
      error.textContent = 'Code incorrect';
      input.value = '';
      input.focus();
    }
  }

  document.getElementById('lock-submit').addEventListener('click', tryUnlock);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  input.addEventListener('input', () => {
    error.textContent = '';
    if (input.value.length === 6) tryUnlock();
  });

  document.getElementById('lock-guest').addEventListener('click', () => {
    document.getElementById('lock-guest').style.display = 'none';
    document.querySelector('.lock-divider').style.display = 'none';
    document.querySelector('.lock-guest-note').style.display = 'none';
    const form = document.getElementById('lock-guest-form');
    form.style.display = 'block';
    const nameInput = document.getElementById('lock-guest-name');
    nameInput.focus();

    const start = () => {
      GUEST_MODE = true;
      guestName = nameInput.value.trim();
      screen.remove();
      init();
    };
    document.getElementById('lock-guest-start').addEventListener('click', start);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  applyStoredTheme();
  applyStoredTextSize();
  if ((localStorage.getItem('studyos-theme') || 'auto') === 'auto') requestGeoOnce();
  if (localStorage.getItem('studyos-auth') === 'charles') {
    document.getElementById('lock-screen').remove();
    init();
  } else {
    setupLockScreen();
  }
});

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

// ── Vue lecture d'une fiche ──
async function openFicheView(id) {
  learnSubView = 'fiche-view';
  const view = document.getElementById('view-learn');
  const md = await loadFicheData(id);
  if (!md) { toast('Fiche introuvable'); renderSubjectPage(currentSubject); return; }

  const fiches = await loadFicheIndex();
  const meta = fiches.find(f => f.id === id) || {};
  const col = SUBJECT_COLORS[meta.matiere] || { primary: '#5C6BC0' };

  view.innerHTML = `
  <div class="ctrl-layout">
    <div class="ctrl-header">
      <button class="back-btn" onclick="renderSubjectPage(currentSubject)">←</button>
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
  setNavbarVisible(false);
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
  if (!reponse) {
    toast('Écris au moins quelques mots avant de valider');
    return;
  }
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
  setNavbarVisible(true);
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
        <span class="ctrl-ease-badge" style="background:${ei.color}">${r.indice_facilite}/10 ${ei.label}</span>
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
        <div style="font-size:18px;font-weight:900;margin-top:8px">${data.titre}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:4px">${reponses.length} questions · ${mins} min au total</div>
        <div style="margin-top:10px;display:inline-flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:6px 14px">
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
        Exporter pour correction Claude
      </button>
      <button class="btn" style="padding:14px;font-size:14px;font-weight:700;width:100%" onclick="renderSubjectPage(currentSubject)">
        Retour
      </button>
    </div>
  </div>
  `;
}

// ── Annuler un contrôle en cours ──
function abortControle() {
  if (!confirm('Abandonner ce contrôle ? Les réponses ne seront pas sauvegardées.')) return;
  controleSession = null;
  renderSubjectPage(currentSubject);
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
      <button class="back-btn" onclick="renderSubjectPage('${data.matiere}')">←</button>
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
        Exporter pour Claude
      </button>
    </div>
  </div>
  `;
}
