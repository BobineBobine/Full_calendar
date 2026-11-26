// Notes du jour : ouvre la note quotidienne d'Obsidian (sur OneDrive) et l'enregistre au fil de la frappe.
// Partage avec le Calendrier (même site) : la connexion, le coffre, le style et les consignes de l'assistant IA.

import * as auth from './auth.js';
import * as graph from './graph.js';
import * as daily from './daily.js';
import * as assist from './assist.js';
import { renderMarkdown, toggleTask } from './markdown.js';
import { PALETTES, applyPalette } from './themes.js';

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const todayStr = () => ymd(new Date());
const SAVE_DELAY = 1200;
const KEEP_CACHE = 21; // notes gardées sur le téléphone pour l'ouverture hors ligne

// Réglages partagés avec le Calendrier (clientId, vaultPath, assistFolder, theme, palette…)
const fcSettings = () => LS.get('fc.settings', {});
let shared = fcSettings();
let opts = { daily: { ...daily.DEFAULT_DAILY }, dailyImported: false, mode: 'edit', textSize: 'm', ...LS.get('nq.settings', {}) };
const saveOpts = () => LS.set('nq.settings', opts);
function saveShared(patch) {
  shared = { ...fcSettings(), ...patch }; // relu juste avant pour ne rien écraser du Calendrier
  LS.set('fc.settings', shared);
}

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
let saveTimer = null, saving = null, online = navigator.onLine;

// ---------- Petits outils d'interface ----------
let toastTimer;
function toast(msg, { error = false, action = null, ms = 3200 } = {}) {
  const t = $('#toast'), b = t.querySelector('button');
  t.querySelector('span').textContent = msg;
  t.classList.toggle('error', error);
  b.hidden = !action;
  if (action) { b.textContent = action.label; b.onclick = () => { t.classList.remove('show'); action.fn(); }; }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : ms);
}
function banner(msg, label, fn) {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  b.querySelector('span').textContent = msg;
  b.querySelector('button').textContent = label;
  b.querySelector('button').onclick = fn;
  b.hidden = false;
}
function setState(kind, text) {
  const s = $('#ntState');
  s.className = kind || '';
  s.textContent = text || '';
}
const dlgStack = [];
function openDlg(d) { if (!d.open) { d.showModal(); dlgStack.push(d); history.pushState({ dlg: d.id }, ''); } }
function closeDlg(d) { if (d.open) { d.close(); } }
function wireDialog(d) {
  d.addEventListener('close', () => {
    const i = dlgStack.indexOf(d);
    if (i >= 0) { dlgStack.splice(i, 1); if (history.state?.dlg === d.id) history.back(); }
  });
  d.addEventListener('click', e => {
    if (e.target === d && d.classList.contains('sheet')) closeDlg(d);
    if (e.target.closest('[data-close]')) closeDlg(d);
  });
}
// Bouton retour d'Android : ferme la fenêtre ouverte
window.addEventListener('popstate', () => { const d = dlgStack[dlgStack.length - 1]; if (d) { dlgStack.pop(); d.close(); } });

// ---------- Apparence (reprise du Calendrier) ----------
function applyPrefs() {
  shared = fcSettings();
  const root = document.documentElement;
  if (shared.theme === 'light' || shared.theme === 'dark') root.dataset.theme = shared.theme; else delete root.dataset.theme;
  const dark = shared.theme === 'dark' || (shared.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const obs = LS.get('fc.obsPalettes', {});
  const id = shared.palette;
  const pal = (id && id.startsWith('obs:') && obs[id.slice(4)]) || PALETTES[id] || PALETTES.rose;
  applyPalette(pal[dark ? 'dark' : 'light'], dark);
  document.body.classList.toggle('theme-dark', dark);
  document.body.classList.toggle('theme-light', !dark);
  root.style.setProperty('--fs', { s: '14px', m: '15px', l: '17px' }[shared.textSize] || '15px');
  root.style.setProperty('--note-fs', { s: '.95rem', m: '1.05rem', l: '1.2rem' }[opts.textSize] || '1.05rem');
}

// ---------- Erreurs et connexion ----------
// Coupure réseau seulement (pas un bug du code, qui serait aussi une TypeError)
const isNetErr = e => !navigator.onLine || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));
function login() { auth.login(shared.clientId, { returnTo: location.href.split('#')[0] }); }
function handleError(e, { quiet = false } = {}) {
  console.warn(e);
  if (e instanceof auth.NeedLogin) { banner('Session OneDrive expirée.', 'Se reconnecter', login); return; }
  if (isNetErr(e)) { if (!quiet) toast('Pas de réseau'); return; }
  if (!quiet) toast(e.message || String(e), { error: true });
}

// ---------- Note quotidienne ----------
const vaultName = () => (shared.vaultPath || '').split('/').filter(Boolean).pop() || '';
const configured = () => shared.clientId && shared.vaultPath;

function pathsFor(dateStr) {
  const rel = daily.dailyPath(fromYmd(dateStr), opts.daily);
  return { rel, full: graph.joinPath(shared.vaultPath, rel + '.md') };
}

async function readTemplate() {
  const file = daily.templateFile(opts.daily.template);
  if (!file) return '';
  const k = 'nq.tpl';
  const c = LS.get(k, null);
  if (c && c.file === file && Date.now() - c.at < 864e5) return c.text;
  try {
    const text = await graph.readPath(graph.joinPath(shared.vaultPath, file));
    LS.set(k, { file, text, at: Date.now() });
    return text;
  } catch (e) {
    if (c && c.file === file) return c.text; // hors ligne : dernière version connue
    if (e.status === 404) { toast(`Modèle introuvable : ${file}`, { error: true }); return ''; }
    throw e;
  }
}

async function initialText(dateStr) {
  const tpl = await readTemplate().catch(() => '');
  const title = cur.rel.split('/').pop();
  return daily.applyTemplate(tpl, fromYmd(dateStr), { ...opts.daily, title });
}

/** Texte complet tel qu'il doit être enregistré. */
const fullText = () => cur.fm + $('#editor').value;

function showText(text, { keepCursor = false } = {}) {
  const { fm, body } = daily.splitRaw(text);
  cur.fm = fm;
  const ed = $('#editor');
  const pos = keepCursor ? [ed.selectionStart, ed.selectionEnd] : null;
  if (ed.value !== body) ed.value = body;
  if (pos) ed.setSelectionRange(Math.min(pos[0], body.length), Math.min(pos[1], body.length));
  if (opts.mode === 'read') renderPreview();
}

function renderHeader() {
  const d = fromYmd(cur.date);
  const t = cur.date === todayStr() ? "Aujourd'hui" : new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  $('#hdrTitle').textContent = t;
  $('#datePick').value = cur.date;
  $('#btnToday').hidden = cur.date === todayStr();
  $('#todayNum').textContent = new Date().getDate();
  $('#ntPath').textContent = cur.rel + '.md';
  document.title = `${t} · Notes du jour`;
  const href = `obsidian://open?vault=${encodeURIComponent(vaultName())}&file=${encodeURIComponent(cur.rel)}`;
  $('#setObsidian').href = href;
}

/** Ouvre la note d'un jour : affichage immédiat (brouillon ou cache), puis OneDrive. */
async function openDay(dateStr, { follow = dateStr === todayStr() } = {}) {
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
async function refresh({ quiet = false } = {}) {
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
    online = true;
  } catch (e) {
    if (isNetErr(e)) { online = false; setState('offline', drafts[path] ? 'Hors ligne · gardé sur le téléphone' : 'Hors ligne'); }
    handleError(e, { quiet: quiet || isNetErr(e) });
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
async function flush() { clearTimeout(saveTimer); if (drafts[cur.full]) await saveNow(); else if (saving) await saving; }

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
    online = true;
    if (path === cur.full) {
      if (item.__text !== undefined) showText(saved, { keepCursor: true });
      setState(drafts[path] ? 'dirty' : '', drafts[path] ? 'Modifié' : 'Enregistré');
    }
    banner(null);
  } catch (e) {
    if (isNetErr(e)) { online = false; setState('offline', 'Hors ligne · gardé sur le téléphone'); return; }
    setState('error', 'Non enregistré');
    handleError(e);
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
    toast('La note existait déjà : ton texte a été ajouté à la fin.');
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
    toast('Note complétée ailleurs entre-temps : les deux ajouts sont gardés.');
    return write(base + a.replace(/\s*$/, '') + (b.trim() ? '\n' + b.replace(/^\s+/, '') : ''));
  }
  // Sinon : tu choisis
  const choice = await askConflict();
  if (choice === 'mine') return write(mine);
  try { await navigator.clipboard.writeText(daily.splitRaw(mine).body); toast('Ta version est copiée dans le presse-papier.'); } catch { /* ignore */ }
  delete drafts[path]; saveDrafts();
  cache[path] = { id: item.id, eTag: item.eTag, text: theirs, at: Date.now() }; saveCache();
  if (path === cur.full) { Object.assign(cur, { id: item.id, eTag: item.eTag, base: theirs }); showText(theirs); setState('', 'Enregistré'); }
  return null;
}

function askConflict() {
  return new Promise(res => {
    const d = $('#dlgConflict');
    const done = v => { d.onclose = null; closeDlg(d); res(v); };
    $('#cfMine').onclick = () => done('mine');
    $('#cfTheirs').onclick = () => done('theirs');
    d.onclose = () => res('mine');
    openDlg(d);
  });
}

// ---------- Lecture (aperçu) ----------
function renderPreview() {
  const body = $('#editor').value;
  const off = cur.fm ? cur.fm.split('\n').length - 1 : 0;
  $('#preview').innerHTML = body.trim() ? renderMarkdown(body, off) : '<p class="hint">Note vide.</p>';
}
function setMode(m, { focus = true } = {}) {
  opts.mode = m; saveOpts();
  const read = m === 'read';
  $('#editor').hidden = read;
  $('#preview').hidden = !read;
  $('#btnMode').setAttribute('aria-pressed', String(read));
  $('#btnMode').setAttribute('aria-label', read ? 'Modifier' : 'Lecture');
  $('#btnMode').innerHTML = `<svg><use href="#${read ? 'i-edit' : 'i-eye'}"/></svg>`;
  if (read) renderPreview(); else if (focus) focusEnd();
  updateSelAsk();
}
/** Curseur à la fin de la note, prêt à écrire. */
function focusEnd() {
  const ed = $('#editor');
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
  ed.scrollTop = ed.scrollHeight;
}

// ---------- Assistant IA ----------
let asCache = LS.get('fc.assist', { files: {} }); // partagé avec le Calendrier
let asCtx = { attach: false, quote: '', suite: null, suiteLabel: '' };
let asLoading = false;
const asFolder = () => shared.assistFolder || '_IA/consignes';
const asDir = () => graph.joinPath(shared.vaultPath, asFolder());
const asRel = name => graph.joinPath(asFolder(), name.replace(/\.md$/i, ''));
const SRC = { calendrier: 'Calendrier', notes: 'Notes du jour' };

function asItems() {
  return Object.values(asCache.files)
    .map(f => ({ f, c: assist.parseConsigne(f.text, f.created) }))
    .filter(x => x.c)
    .sort((a, b) => String(a.c.cree).localeCompare(String(b.c.cree)));
}
function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const day = ymd(d) === todayStr() ? "aujourd'hui" : new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function renderAssist({ scroll = false } = {}) {
  const box = $('#asList');
  const items = asItems();
  const pending = items.filter(x => x.c.statut === 'a-traiter').length;
  const waiting = items.filter(x => x.c.statut === 'attente').length;
  $('#asState').textContent = [pending ? `${pending} en file` : '', waiting ? `${waiting} question${waiting > 1 ? 's' : ''} pour toi` : '']
    .filter(Boolean).join(' · ') || 'Rien en attente';
  box.innerHTML = !items.length
    ? '<p class="as-empty">Écris une consigne ci-dessous : Claude la lira ce soir et répondra ici.</p>'
    : items.map(({ f, c }) => `
      <article class="as-item st-${esc(c.statut)}" data-id="${esc(f.id)}">
        <div class="as-me">
          ${c.suite ? `<div class="as-ref">↪ Réponse à « ${esc(c.suite.split('/').pop())} »</div>` : ''}
          ${c.lien ? `<div class="as-ref">📎 ${esc(c.lien.split('/').pop())}</div>` : ''}
          <div class="as-text">${renderMarkdown(c.ask)}</div>
          <div class="as-meta"><span class="as-badge">${esc(c.label)}</span><span>${esc(fmtWhen(c.cree))}</span>
            ${c.source ? `<span>· ${esc(SRC[c.source] || c.source)}</span>` : ''}
            ${c.statut === 'attente' ? '<button type="button" class="as-act" data-act="reply">Répondre</button>' : ''}
            ${c.statut === 'a-traiter' ? '<button type="button" class="as-act" data-act="cancel">Retirer</button>' : ''}
          </div>
        </div>
        ${c.answer ? `<div class="as-ai"><div class="as-who">Claude${c.traite ? ' · ' + esc(c.traite) : ''}</div><div class="md">${renderMarkdown(c.answer)}</div></div>` : ''}
      </article>`).join('');
  renderAssistCtx();
  if (scroll) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}
function renderAssistCtx() {
  const parts = [];
  if (asCtx.suite) parts.push(`<span class="as-chip">↪ Réponse à « ${esc(asCtx.suiteLabel)} » <button type="button" data-clear="suite" aria-label="Retirer">×</button></span>`);
  if (asCtx.quote) parts.push(`<span class="as-chip as-quote">« ${esc(asCtx.quote.length > 140 ? asCtx.quote.slice(0, 140) + '…' : asCtx.quote)} » <button type="button" data-clear="quote" aria-label="Retirer">×</button></span>`);
  if (asCtx.attach) parts.push(`<span class="as-chip">📎 ${esc(cur.rel.split('/').pop())} <button type="button" data-clear="attach" aria-label="Retirer">×</button></span>`);
  $('#asCtx').innerHTML = parts.join('');
  $('#asCtx').hidden = !parts.length;
  $('#asAttach').setAttribute('aria-pressed', String(asCtx.attach));
}
const updateAsDot = () => { $('#asDot').hidden = !asItems().some(x => x.c.statut === 'attente'); };

async function loadAssist({ quiet = false } = {}) {
  if (asLoading || !shared.vaultPath || !auth.isLoggedIn()) return;
  asLoading = true;
  $('#asRefresh').classList.add('spin');
  try {
    let items = [];
    try { items = await graph.listChildren(asDir()); } catch (e) { if (e.status !== 404) throw e; }
    const next = {};
    const md = items.filter(it => it.file && /\.md$/i.test(it.name));
    for (let i = 0; i < md.length; i += 6) {
      await Promise.all(md.slice(i, i + 6).map(async it => {
        const old = asCache.files[it.id];
        const text = old && old.eTag === it.eTag ? old.text : await graph.readItem(it);
        next[it.id] = { id: it.id, name: it.name, eTag: it.eTag, text, created: it.createdDateTime };
      }));
    }
    asCache = { files: next };
    LS.set('fc.assist', asCache);
    if ($('#dlgAssist').open) renderAssist();
    updateAsDot();
  } catch (e) { handleError(e, { quiet }); } finally {
    asLoading = false;
    $('#asRefresh').classList.remove('spin');
  }
}

function openAssist(ctx = {}) {
  if (!shared.vaultPath) { toast("Indique d'abord ton coffre dans les réglages.", { error: true }); return; }
  if (ctx.quote) asCtx.quote = ctx.quote;
  if (ctx.attach) asCtx.attach = true;
  openDlg($('#dlgAssist'));
  renderAssist({ scroll: true });
  loadAssist().then(() => renderAssist({ scroll: true }));
  setTimeout(() => $('#asInput').focus(), 80);
}
function growInput() {
  const t = $('#asInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 180) + 'px';
}
async function sendAssist(e) {
  e?.preventDefault();
  let text = $('#asInput').value.trim();
  if (!text && !asCtx.quote) return;
  if (asCtx.quote) {
    const q = asCtx.quote.trim().split('\n').map(l => '> ' + l).join('\n');
    text = `${text || 'Voir ce passage.'}\n\nPassage de ma note du jour :\n${q}`;
  }
  const btn = $('#asSend');
  btn.disabled = true;
  try {
    await flush(); // la note jointe doit être à jour pour Claude
    const now = new Date();
    const note = assist.buildConsigne(text, {
      lien: asCtx.attach || asCtx.quote ? `[[${cur.rel}]]` : null,
      suite: asCtx.suite ? `[[${asCtx.suite}]]` : null,
      date: now,
      source: 'notes',
    });
    const item = await graph.createFile(asDir(), assist.fileNameFor($('#asInput').value.trim() || text, now), note);
    asCache.files[item.id] = { id: item.id, name: item.name, eTag: item.eTag, text: note, created: item.createdDateTime || now.toISOString() };
    LS.set('fc.assist', asCache);
    $('#asInput').value = '';
    growInput();
    asCtx = { attach: false, quote: '', suite: null, suiteLabel: '' };
    renderAssist({ scroll: true });
    toast('Consigne envoyée. Claude la traitera ce soir.');
  } catch (err) {
    handleError(err);
    if (isNetErr(err)) toast("Pas de réseau : la consigne n'est pas partie, réessaie plus tard.", { error: true });
  } finally { btn.disabled = false; }
}
async function onAssistClick(e) {
  const clr = e.target.closest('[data-clear]');
  if (clr) { const k = clr.dataset.clear; asCtx[k] = k === 'attach' ? false : (k === 'quote' ? '' : null); renderAssistCtx(); return; }
  const act = e.target.closest('.as-act');
  if (!act) return;
  const f = asCache.files[act.closest('.as-item').dataset.id];
  if (!f) return;
  if (act.dataset.act === 'reply') {
    asCtx.suite = asRel(f.name);
    asCtx.suiteLabel = f.name.replace(/\.md$/i, '');
    renderAssistCtx();
    $('#asInput').focus();
  } else if (act.dataset.act === 'cancel') {
    if (!confirm('Retirer cette consigne ? La note ira dans la corbeille OneDrive.')) return;
    try {
      await graph.deleteItem(f.id);
      delete asCache.files[f.id];
      LS.set('fc.assist', asCache);
      renderAssist();
    } catch (err) { handleError(err); }
  }
}

// Sélection dans la note → « Envoyer à l'IA »
function currentSelection() {
  if (opts.mode === 'read') {
    const s = getSelection();
    return s && $('#preview').contains(s.anchorNode) ? String(s).trim() : '';
  }
  const ed = $('#editor');
  if (document.activeElement !== ed) return '';
  return ed.value.slice(ed.selectionStart, ed.selectionEnd).trim();
}
function updateSelAsk() { $('#selAsk').hidden = !currentSelection() || $('#dlgAssist').open; }

// ---------- Réglages ----------
async function readObsidianConfig() {
  const base = shared.vaultPath;
  const tryRead = async p => { try { return await graph.readPath(graph.joinPath(base, p)); } catch (e) { if (e.status === 404) return null; throw e; } };
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

function fillSettings() {
  shared = fcSettings();
  $('#setShared').textContent = shared.clientId && shared.vaultPath
    ? 'Connexion et coffre repris du Calendrier.' : "Mêmes réglages que dans le Calendrier (s'il est déjà configuré sur ce téléphone, rien à faire).";
  $('#setClientId').value = shared.clientId || '';
  $('#setVault').value = shared.vaultPath || '';
  $('#setAssistFolder').value = shared.assistFolder || '';
  $('#setTheme').value = shared.theme || 'auto';
  $('#setTextSize').value = opts.textSize || 'm';
  $('#setDailyFolder').value = opts.daily.folder || '';
  $('#setDailyFormat').value = opts.daily.format || '';
  $('#setDailyTemplate').value = opts.daily.template || '';
  $('#setDailyLocale').value = opts.daily.locale || 'fr';
  $('#setDailySource').textContent = opts.daily.source ? `Réglages repris de : ${opts.daily.source}` : '';
  $('#setAuthState').textContent = auth.isLoggedIn() ? '✓ Connecté' : 'Non connecté';
  $('#setLogout').hidden = !auth.isLoggedIn();
  updateDailyPreview();
}
function readDailyForm() {
  return {
    ...opts.daily,
    folder: $('#setDailyFolder').value.trim().replace(/^\/+|\/+$/g, ''),
    format: $('#setDailyFormat').value.trim() || 'YYYY-MM-DD',
    template: $('#setDailyTemplate').value.trim(),
    locale: $('#setDailyLocale').value,
  };
}
function updateDailyPreview() { $('#setDailyPreview').textContent = daily.dailyPath(new Date(), readDailyForm()) + '.md'; }

async function importDaily({ quiet = false } = {}) {
  const cfg = await readObsidianConfig();
  opts.daily = { ...cfg, locale: opts.daily.locale || 'fr' };
  opts.dailyImported = true;
  saveOpts();
  if ($('#dlgSettings').open) fillSettings();
  if (!quiet) toast(`Note quotidienne : ${cfg.source === 'défaut' ? 'réglages par défaut d\'Obsidian' : cfg.source}`);
  return cfg;
}

function wireSettings() {
  const busy = fn => async () => { try { await fn(); } catch (e) { handleError(e); } };
  $('#btnMenu').onclick = () => { fillSettings(); openDlg($('#dlgSettings')); };
  $('#setCancel').onclick = () => { applyPrefs(); closeDlg($('#dlgSettings')); };
  for (const id of ['#setDailyFolder', '#setDailyFormat', '#setDailyLocale']) $(id).addEventListener('input', updateDailyPreview);
  $('#setTheme').onchange = () => { saveShared({ theme: $('#setTheme').value }); applyPrefs(); };
  $('#setLogin').onclick = () => {
    const clientId = $('#setClientId').value.trim();
    if (!clientId) { toast("Renseigne d'abord l'ID d'application", { error: true }); return; }
    saveShared({ clientId, vaultPath: $('#setVault').value.trim().replace(/^\/+|\/+$/g, '') });
    login();
  };
  $('#setLogout').onclick = () => { auth.logout(); fillSettings(); };
  $('#setDetect').onclick = busy(async () => {
    const list = await graph.findVaults();
    const dl = $('#vaultList');
    dl.innerHTML = '';
    for (const p of list) { const o = document.createElement('option'); o.value = p; dl.appendChild(o); }
    if (list.length === 1 && !$('#setVault').value) $('#setVault').value = list[0];
    toast(list.length ? `${list.length} coffre(s) trouvé(s) — choisis dans la liste` : 'Aucun coffre trouvé, saisis le chemin à la main');
  });
  $('#setImportDaily').onclick = busy(async () => {
    saveShared({ vaultPath: $('#setVault').value.trim().replace(/^\/+|\/+$/g, '') });
    await importDaily();
  });
  $('#setForm').onsubmit = async e => {
    e.preventDefault();
    await flush();
    saveShared({
      clientId: $('#setClientId').value.trim(),
      vaultPath: $('#setVault').value.trim().replace(/^\/+|\/+$/g, ''),
      assistFolder: $('#setAssistFolder').value.trim().replace(/^\/+|\/+$/g, '') || '_IA/consignes',
      theme: $('#setTheme').value,
    });
    opts.daily = readDailyForm();
    opts.textSize = $('#setTextSize').value;
    saveOpts();
    applyPrefs();
    closeDlg($('#dlgSettings'));
    openDay(cur.date, { follow: cur.follow });
  };
}

// ---------- Démarrage ----------
function shiftDay(n) {
  const d = fromYmd(cur.date);
  d.setDate(d.getDate() + n);
  openDay(ymd(d));
}

function wireUI() {
  for (const d of document.querySelectorAll('dialog')) wireDialog(d);
  wireSettings();
  const ed = $('#editor');
  ed.addEventListener('input', onInput);
  ed.addEventListener('blur', () => { if (drafts[cur.full]) scheduleSave(0); });
  // Tabulation et retour à la ligne dans les listes, comme dans Obsidian
  ed.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '\t'); }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const start = ed.value.lastIndexOf('\n', ed.selectionStart - 1) + 1;
      const line = ed.value.slice(start, ed.selectionStart);
      const m = line.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)[.)] )/);
      if (!m || ed.selectionStart !== ed.selectionEnd) return;
      e.preventDefault();
      if (line.trim() === m[2].trim()) { // puce vide : on sort de la liste
        ed.setSelectionRange(start, ed.selectionStart);
        document.execCommand('delete');
        return;
      }
      const next = m[3] ? m[2].replace(/\d+/, n => +n + 1) : m[2].replace(/\[[xX]\]/, '[ ]');
      document.execCommand('insertText', false, '\n' + m[1] + next);
    }
  });
  $('#preview').addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox][data-line]');
    if (!cb) return;
    const full = toggleTask(fullText(), +cb.dataset.line);
    showText(full);
    onInput();
  });
  $('#hdrPrev').onclick = () => shiftDay(-1);
  $('#hdrNext').onclick = () => shiftDay(1);
  $('#btnToday').onclick = () => openDay(todayStr());
  $('#datePick').onchange = e => { if (e.target.value) openDay(e.target.value); };
  $('#btnMode').onclick = () => setMode(opts.mode === 'read' ? 'edit' : 'read');

  // Assistant
  $('#btnAssist').onclick = () => openAssist();
  $('#asForm').onsubmit = sendAssist;
  $('#asInput').addEventListener('input', growInput);
  $('#asInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendAssist(e); });
  $('#asRefresh').onclick = () => loadAssist().then(() => renderAssist({ scroll: true }));
  $('#asAttach').onclick = () => { asCtx.attach = !asCtx.attach; renderAssistCtx(); };
  $('#dlgAssist').addEventListener('click', onAssistClick);
  $('#dlgAssist').addEventListener('close', updateSelAsk);
  document.addEventListener('selectionchange', updateSelAsk);
  // pointerdown sans perte du focus : la sélection reste lisible au moment du clic
  $('#selAsk').addEventListener('pointerdown', e => e.preventDefault());
  $('#selAsk').onclick = () => {
    const q = currentSelection();
    if (q) openAssist({ quote: q, attach: true });
  };

  window.addEventListener('online', () => { online = true; refresh({ quiet: true }); flushOtherDrafts(); loadAssist({ quiet: true }); });
  window.addEventListener('offline', () => { online = false; setState('offline', drafts[cur.full] ? 'Hors ligne · gardé sur le téléphone' : 'Hors ligne'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (drafts[cur.full]) saveNow(); return; }
    applyPrefs();
    // Passage à minuit : on suit la nouvelle journée si tu étais sur « aujourd'hui »
    if (cur.follow && cur.date !== todayStr() && !drafts[cur.full]) { openDay(todayStr()); return; }
    renderHeader();
    if (!drafts[cur.full]) refresh({ quiet: true });
    loadAssist({ quiet: true });
  });
  window.addEventListener('pagehide', () => { if (drafts[cur.full]) saveNow(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);
}

async function start() {
  graph.init(force => auth.getToken(fcSettings().clientId, force));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('../sw.js', { scope: '../', updateViaCache: 'none' }).catch(() => {});
  }
  applyPrefs();
  wireUI();
  setMode(opts.mode === 'read' ? 'read' : 'edit', { focus: false });
  updateAsDot();

  const authErr = location.hash.match(/auth-error=([^&]*)/);
  if (authErr) { history.replaceState(null, '', location.pathname); toast('Connexion refusée : ' + decodeURIComponent(authErr[1]), { error: true }); }

  if (!configured()) {
    renderHeader();
    fillSettings();
    openDlg($('#dlgSettings'));
    return;
  }
  if (!auth.isLoggedIn()) banner('Pas connecté à OneDrive (affichage du cache).', 'Se connecter', login);
  else if (!opts.dailyImported) {
    try { await importDaily({ quiet: true }); } catch (e) { handleError(e, { quiet: true }); }
  }
  await openDay(todayStr());
  if (opts.mode !== 'read') focusEnd();
  flushOtherDrafts();
  loadAssist({ quiet: true });
}

start();
