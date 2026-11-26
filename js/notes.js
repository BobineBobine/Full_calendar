// Onglet « Notes » : ouvre la note quotidienne d'Obsidian (sur OneDrive) et l'enregistre au fil de la frappe.
// Module piloté par app.js : il partage la connexion, les réglages, les dialogues et l'assistant IA.

import * as auth from './auth.js';
import * as graph from './graph.js';
import * as daily from './daily.js';
import { renderMarkdown, toggleTask } from './markdown.js';
import { createEditor } from './editor.js';

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
};
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const todayStr = () => ymd(new Date());
const SAVE_DELAY = 1200;
const KEEP_CACHE = 21; // notes gardées sur le téléphone pour l'ouverture hors ligne

let ctx = null; // fourni par app.js : settings(), patchSettings(), toast(), banner(), handleError(), openDlg(), closeDlg(), setTitle(), onSelection()
const S = () => ctx.settings();
const cfg = () => ({ ...daily.DEFAULT_DAILY, ...(S().daily || {}) });

// cache : chemin -> { id, eTag, text, at } ; drafts : chemin -> { text, baseText, baseETag, at }
let cache = LS.get('nq.cache', {});
let drafts = LS.get('nq.drafts', {});
const saveCache = () => {
  const keys = Object.keys(cache).sort((a, b) => (cache[b].at || 0) - (cache[a].at || 0));
  for (const k of keys.slice(KEEP_CACHE)) delete cache[k];
  LS.set('nq.cache', cache);
};
const saveDrafts = () => LS.set('nq.drafts', drafts);

// Note affichée
const cur = {
  date: todayStr(), follow: true, // follow : suit « aujourd'hui » (passage à minuit)
  rel: '', full: '', // chemin relatif au coffre sans .md / chemin OneDrive complet avec .md
  exists: null, id: null, eTag: null,
  base: '', // dernier texte connu sur OneDrive (ou modèle si la note n'existe pas encore)
  fm: '', // frontmatter brut, conservé à l'identique
  loaded: false,
};
let active = false, ready = null;
let ed = null; // éditeur avec mise en forme en direct (editor.js)
let saveTimer = null, saving = null;
let mode = LS.get('nq.mode', null) ?? LS.get('nq.settings', {}).mode ?? 'edit';

const isNetErr = e => !navigator.onLine || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));
function fail(e, { quiet = false } = {}) {
  if (isNetErr(e)) { console.warn(e); if (!quiet) ctx.toast('Pas de réseau'); return; }
  if (quiet && !(e instanceof auth.NeedLogin)) { console.warn(e); return; }
  ctx.handleError(e);
}
function setState(kind, text) {
  const s = $('#ntState');
  s.className = kind || '';
  s.textContent = text || '';
}

// ---------- Note quotidienne ----------
const vaultName = () => (S().vaultPath || '').split('/').filter(Boolean).pop() || '';
export const configured = () => !!(S().clientId && S().vaultPath);

function pathsFor(dateStr) {
  const rel = daily.dailyPath(fromYmd(dateStr), cfg());
  return { rel, full: graph.joinPath(S().vaultPath, rel + '.md') };
}

async function readTemplate() {
  const file = daily.templateFile(cfg().template);
  if (!file) return '';
  const k = 'nq.tpl';
  const c = LS.get(k, null);
  if (c && c.file === file && Date.now() - c.at < 864e5) return c.text;
  try {
    const text = await graph.readPath(graph.joinPath(S().vaultPath, file));
    LS.set(k, { file, text, at: Date.now() });
    return text;
  } catch (e) {
    if (c && c.file === file) return c.text; // hors ligne : dernière version connue
    if (e.status === 404) { ctx.toast(`Modèle introuvable : ${file}`, { error: true }); return ''; }
    throw e;
  }
}

async function initialText(dateStr) {
  const tpl = await readTemplate().catch(() => '');
  const title = cur.rel.split('/').pop();
  return daily.applyTemplate(tpl, fromYmd(dateStr), { ...cfg(), title });
}

/** Texte complet tel qu'il doit être enregistré. */
const fullText = () => cur.fm + ed.value;

function showText(text, { keepCursor = false } = {}) {
  const { fm, body } = daily.splitRaw(text);
  cur.fm = fm;
  ed.setValue(body, { keepCursor });
  if (mode === 'read') renderPreview();
}

export function renderHeader() {
  if (!active) return;
  const t = cur.date === todayStr() ? "Aujourd'hui"
    : new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(fromYmd(cur.date));
  ctx.setTitle(t);
  $('#ntDatePick').value = cur.date;
  $('#ntPath').textContent = cur.rel ? cur.rel + '.md' : '';
  $('#ntPath').href = cur.rel ? `obsidian://open?vault=${encodeURIComponent(vaultName())}&file=${encodeURIComponent(cur.rel)}` : '#';
}

/** Ouvre la note d'un jour : affichage immédiat (brouillon ou cache), puis OneDrive. */
export async function openDay(dateStr, { follow = dateStr === todayStr() } = {}) {
  if (cur.loaded && dateStr !== cur.date) await flush();
  Object.assign(cur, { date: dateStr, follow, ...pathsFor(dateStr), exists: null, id: null, eTag: null, base: '', fm: '', loaded: false });
  renderHeader();
  const dr = drafts[cur.full], c = cache[cur.full];
  if (c) Object.assign(cur, { exists: true, id: c.id, eTag: c.eTag, base: c.text });
  showText(dr ? dr.text : (c ? c.text : ''));
  if (dr) setState('dirty', 'Pas encore envoyé'); else setState('', c ? '' : '…');
  cur.loaded = true;
  await refresh();
}

/** Relit la note sur OneDrive (sauf si tu as des modifications pas encore enregistrées). */
export async function refresh({ quiet = false } = {}) {
  if (!cur.loaded) return;
  if (!configured() || !auth.isLoggedIn()) {
    if (!drafts[cur.full] && !cache[cur.full]) { showText(''); setState('', ''); }
    return;
  }
  const path = cur.full, date = cur.date;
  try {
    const item = await graph.getItem(path);
    if (path !== cur.full) return; // on a changé de jour entre-temps
    if (!item) {
      const tpl = await initialText(date);
      if (path !== cur.full) return;
      Object.assign(cur, { exists: false, id: null, eTag: null, base: tpl });
      delete cache[path]; saveCache();
      if (!drafts[path]) { showText(tpl); setState('', 'Nouvelle note'); }
      else scheduleSave(0);
      return;
    }
    const c = cache[path];
    const text = c && c.eTag === item.eTag ? c.text : await graph.readItem(item);
    if (path !== cur.full) return;
    Object.assign(cur, { exists: true, id: item.id, eTag: item.eTag, base: text });
    cache[path] = { id: item.id, eTag: item.eTag, text, at: Date.now() }; saveCache();
    if (drafts[path]) { scheduleSave(0); return; } // le brouillon part, avec contrôle de conflit
    showText(text, { keepCursor: true });
    setState('', 'Enregistré');
  } catch (e) {
    if (isNetErr(e)) setState('offline', drafts[path] ? 'Hors ligne · gardé sur le téléphone' : 'Hors ligne');
    fail(e, { quiet: quiet || isNetErr(e) });
  }
}

// ---------- Enregistrement ----------
function onInput() {
  const text = fullText();
  if (text === cur.base && !drafts[cur.full]) { setState('', 'Enregistré'); return; }
  drafts[cur.full] = { text, baseText: drafts[cur.full]?.baseText ?? cur.base, baseETag: drafts[cur.full]?.baseETag ?? cur.eTag, at: Date.now() };
  if (text === cur.base) delete drafts[cur.full];
  saveDrafts();
  setState('dirty', 'Modifié');
  scheduleSave();
}
function scheduleSave(ms = SAVE_DELAY) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveNow(); }, ms); }
export async function flush() { clearTimeout(saveTimer); if (drafts[cur.full]) await saveNow(); else if (saving) await saving; }

function saveNow() {
  if (saving) { return saving.then(() => (drafts[cur.full] ? saveNow() : null)); }
  saving = doSave().finally(() => { saving = null; });
  return saving;
}

async function doSave() {
  const path = cur.full;
  const dr = drafts[path];
  if (!dr || !configured() || !auth.isLoggedIn()) return;
  if (cur.exists === null) { if (navigator.onLine) refresh({ quiet: true }); return; } // état OneDrive inconnu : on relit d'abord
  const text = dr.text;
  setState('saving', 'Enregistrement…');
  try {
    let item;
    if (!cur.exists) {
      const slash = path.lastIndexOf('/');
      try {
        item = await graph.createFile(path.slice(0, slash), path.slice(slash + 1), text, 'fail');
      } catch (e) {
        if (e.status !== 409) throw e;
        item = await mergeCreated(path, text); // créée entre-temps (Obsidian l'a ouverte ailleurs)
        if (!item) return;
      }
    } else {
      try {
        item = await graph.writeFile(cur.id, text, cur.eTag);
      } catch (e) {
        if (e.status !== 412) throw e;
        item = await resolveConflict(path, text, dr);
        if (!item) return;
      }
    }
    const saved = item.__text ?? text;
    if (path === cur.full) Object.assign(cur, { exists: true, id: item.id, eTag: item.eTag, base: saved });
    cache[path] = { id: item.id, eTag: item.eTag, text: saved, at: Date.now() }; saveCache();
    if (drafts[path] && drafts[path].text === text) delete drafts[path];
    else if (drafts[path]) Object.assign(drafts[path], { baseText: saved, baseETag: item.eTag });
    saveDrafts();
    if (path === cur.full) {
      if (item.__text !== undefined) showText(saved, { keepCursor: true });
      setState(drafts[path] ? 'dirty' : '', drafts[path] ? 'Modifié' : 'Enregistré');
    }
  } catch (e) {
    if (isNetErr(e)) { setState('offline', 'Hors ligne · gardé sur le téléphone'); return; }
    setState('error', 'Non enregistré');
    fail(e);
  }
}

/** Brouillons d'autres jours restés sur le téléphone (écrits hors ligne) : envoyés s'il n'y a aucun conflit. */
async function flushOtherDrafts() {
  if (!configured() || !auth.isLoggedIn()) return;
  for (const [path, dr] of Object.entries(drafts)) {
    if (path === cur.full) continue;
    try {
      const item = await graph.getItem(path);
      let out;
      if (!item) {
        const i = path.lastIndexOf('/');
        out = await graph.createFile(path.slice(0, i), path.slice(i + 1), dr.text, 'fail');
      } else if (item.eTag === dr.baseETag) {
        out = await graph.writeFile(item.id, dr.text, item.eTag);
      } else continue; // modifiée ailleurs : on laisse le brouillon, il sera proposé à l'ouverture du jour
      cache[path] = { id: out.id, eTag: out.eTag, text: dr.text, at: Date.now() };
      delete drafts[path];
    } catch (e) { if (isNetErr(e)) return; console.warn(path, e); }
  }
  saveCache(); saveDrafts();
}

/** La note a été créée ailleurs juste avant nous : on ajoute ce que tu as écrit à la fin. */
async function mergeCreated(path, mine) {
  const item = await graph.getItem(path);
  const theirs = await graph.readItem(item);
  const tpl = cur.base;
  let merged;
  if (!theirs.trim() || theirs.trim() === tpl.trim()) merged = mine;
  else {
    const typed = mine.startsWith(tpl) ? mine.slice(tpl.length) : mine;
    merged = typed.trim() ? theirs.replace(/\s*$/, '') + '\n\n' + typed.trim() + '\n' : theirs;
    ctx.toast('La note existait déjà : ton texte a été ajouté à la fin.');
  }
  const out = await graph.writeFile(item.id, merged, item.eTag);
  out.__text = merged;
  return out;
}

/** La note a changé sur OneDrive depuis ta dernière lecture. */
async function resolveConflict(path, mine, dr) {
  const item = await graph.getItem(path);
  if (!item) { cur.exists = false; return graph.createFile(path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1), mine, 'fail'); }
  const theirs = await graph.readItem(item);
  const base = dr.baseText ?? cur.base;
  const write = async t => { const o = await graph.writeFile(item.id, t, item.eTag); o.__text = t; return o; };
  // Contenu identique (seules les métadonnées ont bougé) ou modification déjà présente
  if (theirs === base || theirs === mine) return write(mine);
  // Chacun n'a fait qu'ajouter à la fin : on garde les deux ajouts
  if (theirs.startsWith(base) && mine.startsWith(base)) {
    const a = theirs.slice(base.length), b = mine.slice(base.length);
    ctx.toast('Note complétée ailleurs entre-temps : les deux ajouts sont gardés.');
    return write(base + a.replace(/\s*$/, '') + (b.trim() ? '\n' + b.replace(/^\s+/, '') : ''));
  }
  // Sinon : tu choisis
  const choice = await askConflict();
  if (choice === 'mine') return write(mine);
  try { await navigator.clipboard.writeText(daily.splitRaw(mine).body); ctx.toast('Ta version est copiée dans le presse-papier.'); } catch { /* ignore */ }
  delete drafts[path]; saveDrafts();
  cache[path] = { id: item.id, eTag: item.eTag, text: theirs, at: Date.now() }; saveCache();
  if (path === cur.full) { Object.assign(cur, { id: item.id, eTag: item.eTag, base: theirs }); showText(theirs); setState('', 'Enregistré'); }
  return null;
}

function askConflict() {
  return new Promise(res => {
    const d = $('#dlgConflict');
    let choice = 'mine'; // fermée sans choisir : on garde la tienne (l'autre reste dans l'historique OneDrive)
    $('#ntMine').onclick = () => { choice = 'mine'; ctx.closeDlg(d); };
    $('#ntTheirs').onclick = () => { choice = 'theirs'; ctx.closeDlg(d); };
    d.addEventListener('close', () => res(choice), { once: true });
    ctx.openDlg(d);
  });
}

// ---------- Lecture / écriture ----------
function renderPreview() {
  const body = ed.value;
  const off = cur.fm ? cur.fm.split('\n').length - 1 : 0;
  $('#preview').innerHTML = body.trim() ? renderMarkdown(body, off, { embeds: true }) : '<p class="hint">Note vide.</p>';
  for (const el of $('#preview').querySelectorAll('.embed')) {
    const t = el.dataset.embed, w = parseInt(el.dataset.w, 10);
    el.innerHTML = `<img alt=""${w ? ` style="width:${w}px"` : ''}>`;
    Promise.resolve(ctx.loadImage(t, cur.rel)).then(u => { if (u) el.querySelector('img').src = u; else el.textContent = `⚠ ${t}`; }).catch(() => { el.textContent = `⚠ ${t}`; });
  }
}
function setMode(m, { focus = true } = {}) {
  mode = m; LS.set('nq.mode', m);
  const read = m === 'read';
  ed.hidden = read;
  $('#preview').hidden = !read;
  const b = $('#btnMode');
  b.setAttribute('aria-pressed', String(read));
  b.setAttribute('aria-label', read ? 'Modifier' : 'Lecture');
  b.innerHTML = `<svg><use href="#${read ? 'i-edit' : 'i-eye'}"/></svg>`;
  if (read) renderPreview(); else if (focus && active) focusEnd();
  ctx.onSelection();
}
export const toggleMode = () => setMode(mode === 'read' ? 'edit' : 'read');

/** Curseur à la fin de la note, prêt à écrire. */
function focusEnd() {
  ed.focusEnd();
}

/** Texte sélectionné dans la note (pour « Envoyer à l'IA »). */
export function selection() {
  if (!active) return '';
  if (mode === 'read') {
    const s = getSelection();
    return s && $('#preview').contains(s.anchorNode) ? String(s).trim() : '';
  }
  return ed.hasFocus ? ed.selectionText().trim() : '';
}

/** Note affichée : chemin relatif au coffre (sans .md), pour un lien [[…]]. */
export const current = () => ({ rel: cur.rel, date: cur.date, label: cur.rel.split('/').pop() });

// ---------- Config Obsidian ----------
export async function readObsidianConfig(vaultPath = S().vaultPath) {
  const tryRead = async p => { try { return await graph.readPath(graph.joinPath(vaultPath, p)); } catch (e) { if (e.status === 404) return null; throw e; } };
  for (const dir of ['.obsidian', '.obsidian-mobile']) {
    const files = {
      'daily-notes.json': await tryRead(`${dir}/daily-notes.json`),
      'periodic-notes': await tryRead(`${dir}/plugins/periodic-notes/data.json`),
      'templates.json': await tryRead(`${dir}/templates.json`),
    };
    if (files['daily-notes.json'] || files['periodic-notes']) return daily.configFromObsidian(files);
  }
  return daily.configFromObsidian({});
}
export const previewPath = c => daily.dailyPath(new Date(), { ...daily.DEFAULT_DAILY, ...c }) + '.md';

/** Première ouverture : reprend les réglages de note quotidienne d'Obsidian. */
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      if (!S().dailyImported && configured() && auth.isLoggedIn()) {
        try {
          const c = await readObsidianConfig();
          ctx.patchSettings({ daily: { ...c, locale: cfg().locale || 'fr' }, dailyImported: true });
        } catch (e) { fail(e, { quiet: true }); }
      }
    })();
  }
  return ready;
}

// ---------- Navigation ----------
function shiftDay(n) {
  const d = fromYmd(cur.date);
  d.setDate(d.getDate() + n);
  openDay(ymd(d));
}
export const nav = {
  prev: () => shiftDay(-1),
  next: () => shiftDay(1),
  today: () => openDay(todayStr()),
  pick: () => {
    const i = $('#ntDatePick');
    i.value = cur.date;
    try { i.showPicker(); } catch { i.focus(); i.click(); }
  },
};

/** Affiche l'onglet. */
export async function show() {
  active = true;
  document.body.classList.add('view-notes');
  $('#notesView').hidden = false;
  $('#ntSetup').hidden = configured();
  $('#ntMain').hidden = !configured();
  $('.nt-sub').hidden = !configured();
  if (!configured()) { ctx.setTitle('Notes'); return; }
  renderHeader();
  Promise.resolve(ctx.ensureIndex()).then(() => ed.refresh()); // liens existants / absents
  await ensureReady();
  if (!active) return;
  const want = cur.follow ? todayStr() : cur.date;
  if (!cur.loaded || want !== cur.date || pathsFor(want).full !== cur.full) await openDay(want, { follow: cur.follow });
  else { renderHeader(); if (!drafts[cur.full]) refresh({ quiet: true }); }
  if (active && mode !== 'read' && document.activeElement?.tagName !== 'INPUT') focusEnd();
  flushOtherDrafts();
}

/** Quitte l'onglet : la note part tout de suite. */
export function hide() {
  if (!active) return;
  active = false;
  document.body.classList.remove('view-notes');
  $('#notesView').hidden = true;
  ed.view.contentDOM.blur();
  if (drafts[cur.full]) saveNow();
  ctx.onSelection();
}

/** Après un changement de réglages (dossier, format, coffre…). */
export async function reload() {
  await flush();
  cur.loaded = false;
  ready = null;
  if (active) await show();
}

export function init(c) {
  ctx = c;
  ed = createEditor($('#editor'), {
    onChange: () => onInput(),
    suggest: q => ctx.suggest(q),
    linkExists: t => ctx.linkExists(t),
    onLink: t => ctx.openLink(t),
    loadImage: t => ctx.loadImage(t, cur.rel),
    onFiles: files => ctx.attachFiles(files, cur.rel + '.md'),
  });
  ed.view.contentDOM.addEventListener('blur', () => { if (drafts[cur.full]) scheduleSave(0); });
  $('#ntImage').onclick = () => $('#ntFile').click();
  $('#ntFile').onchange = async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length || !configured()) return;
    if (mode === 'read') setMode('edit', { focus: false });
    const md = await ctx.attachFiles(files, cur.rel + '.md');
    if (md) { ed.focusEnd(); ed.insert(md); }
  };
  $('#preview').addEventListener('click', e => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    ctx.openLink(a.dataset.link);
  });
  $('#preview').addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox][data-line]');
    if (!cb) return;
    showText(toggleTask(fullText(), +cb.dataset.line));
    onInput();
  });
  $('#ntDatePick').addEventListener('change', e => { if (e.target.value) openDay(e.target.value); });
  setMode(mode === 'read' ? 'read' : 'edit', { focus: false });

  window.addEventListener('online', () => { if (active) refresh({ quiet: true }); flushOtherDrafts(); });
  window.addEventListener('offline', () => { if (active) setState('offline', drafts[cur.full] ? 'Hors ligne · gardé sur le téléphone' : 'Hors ligne'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (drafts[cur.full]) saveNow(); return; }
    if (!active || !cur.loaded) return;
    // Passage à minuit : on suit la nouvelle journée si tu étais sur « aujourd'hui »
    if (cur.follow && cur.date !== todayStr() && !drafts[cur.full]) { openDay(todayStr()); return; }
    renderHeader();
    if (!drafts[cur.full]) refresh({ quiet: true });
  });
  window.addEventListener('pagehide', () => { if (drafts[cur.full]) saveNow(); });
}
