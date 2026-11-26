// Onglet « Coffre » : parcourir, lire, modifier et chercher dans tout le coffre Obsidian (sur OneDrive).
// - La liste des fichiers vient de l'API « delta » de OneDrive : la première fois tout le coffre, ensuite seulement ce qui a changé.
// - Le texte des notes est gardé dans le navigateur (IndexedDB) pour la recherche et les rétroliens, même hors ligne.
// - Liens [[…]] cliquables (créent la note si elle n'existe pas), images ![[…]], rétroliens.

import * as auth from './auth.js';
import * as graph from './graph.js';
import { renderMarkdown, toggleTask } from './markdown.js';
import { splitRaw } from './daily.js';
import * as linkcomplete from './linkcomplete.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
};
const isMd = n => /\.md$/i.test(n);
const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const base = n => n.replace(/\.md$/i, '');
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isNetErr = e => !navigator.onLine || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));
const SAVE_DELAY = 1200;

let ctx = null; // fourni par app.js
const S = () => ctx.settings();
const vaultPath = () => S().vaultPath || '';
const vaultName = () => vaultPath().split('/').filter(Boolean).pop() || '';

// ---------- Stockage local (IndexedDB) ----------
let dbP = null;
const db = () => (dbP ||= new Promise((res, rej) => {
  const r = indexedDB.open('coffre', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
async function idbGet(k) {
  try {
    const d = await db();
    return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  } catch (e) { console.warn(e); return undefined; }
}
async function idbSet(k, v) {
  try {
    const d = await db();
    await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
  } catch (e) { console.warn(e); }
}

// ---------- État ----------
// meta.items : id -> { id, name, parent, folder, eTag, mtime, size }
let meta = { vault: '', rootId: null, deltaLink: null, items: {} };
let texts = {}; // id -> { eTag, text }
let loadedFor = null, loading = null, syncing = false, active = false;
let saveMetaTimer = null;
const persist = () => {
  clearTimeout(saveMetaTimer);
  saveMetaTimer = setTimeout(() => { idbSet('meta:' + meta.vault, meta); idbSet('texts:' + meta.vault, texts); }, 800);
};

// Index des chemins et des liens (recalculé après chaque synchro)
let paths = {}; // id -> chemin relatif au coffre (avec extension)
let byPath = {}; // chemin en minuscules -> id
let byBase = {}; // nom sans .md en minuscules -> [id]
let children = {}; // id dossier -> [id]
function rebuild() {
  paths = {}; byPath = {}; byBase = {}; children = {};
  const pathOf = id => {
    if (id === meta.rootId) return '';
    if (paths[id] !== undefined) return paths[id];
    const it = meta.items[id];
    if (!it) return null;
    const pp = it.parent === meta.rootId ? '' : pathOf(it.parent);
    if (pp === null) return (paths[id] = null);
    return (paths[id] = pp ? `${pp}/${it.name}` : it.name);
  };
  for (const id of Object.keys(meta.items)) {
    const p = pathOf(id);
    if (p === null || p.split('/').some(seg => seg.startsWith('.'))) continue; // .obsidian, .trash…
    const it = meta.items[id];
    (children[it.parent] ||= []).push(id);
    if (it.folder) continue;
    byPath[p.toLowerCase()] = id;
    const k = (isMd(it.name) ? base(it.name) : it.name).toLowerCase();
    (byBase[k] ||= []).push(id);
  }
  const coll = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  for (const k of Object.keys(children)) {
    children[k].sort((a, b) => {
      const A = meta.items[a], B = meta.items[b];
      return (B.folder - A.folder) || coll.compare(A.name, B.name);
    });
  }
  backlinkMemo = null;
}
const visible = id => paths[id] != null && (byPath[paths[id].toLowerCase()] === id || meta.items[id]?.folder);

/** Résout un lien [[cible]] comme Obsidian : chemin exact, sinon le nom le plus court qui correspond. */
function resolve(target, fromId = null) {
  let t = String(target || '').split('|')[0].split('#')[0].trim();
  if (!t) return fromId;
  t = t.replace(/^\/+/, '');
  const withMd = /\.[a-z0-9]{1,5}$/i.test(t) && !isMd(t) ? t : (isMd(t) ? t : t + '.md');
  const exact = byPath[withMd.toLowerCase()];
  if (exact) return exact;
  // relatif au dossier de la note courante
  if (fromId && paths[fromId]) {
    const dir = paths[fromId].split('/').slice(0, -1).join('/');
    const rel = byPath[(dir ? dir + '/' : '') + withMd.toLowerCase()];
    if (rel) return rel;
  }
  const name = withMd.split('/').pop();
  const k = (isMd(name) ? base(name) : name).toLowerCase();
  const cands = (byBase[k] || []).filter(id => paths[id].toLowerCase().endsWith(withMd.toLowerCase()));
  cands.sort((a, b) => paths[a].length - paths[b].length);
  return cands[0] || null;
}

// ---------- Chargement et synchronisation ----------
async function load() {
  const v = vaultPath();
  if (loadedFor === v) return;
  if (loading) return loading;
  loading = (async () => {
    meta = (await idbGet('meta:' + v)) || { vault: v, rootId: null, deltaLink: null, items: {} };
    texts = (await idbGet('texts:' + v)) || {};
    loadedFor = v;
    rebuild();
  })();
  try { await loading; } finally { loading = null; }
}

function status(msg) { const s = $('#vtStatus'); s.textContent = msg || ''; s.hidden = !msg; }

export async function sync({ quiet = true } = {}) {
  if (syncing || !vaultPath() || !auth.isLoggedIn()) return;
  await load();
  syncing = true;
  document.body.classList.add('vt-syncing');
  try {
    if (!meta.rootId) {
      const root = await graph.getItem(vaultPath());
      if (!root) throw new Error(`Coffre introuvable : ${vaultPath()}`);
      meta.rootId = root.id;
    }
    if (!meta.deltaLink) status('Lecture du coffre…');
    let res;
    try { res = await graph.delta(vaultPath(), meta.deltaLink); }
    catch (e) {
      if (e.status !== 410) throw e;
      meta.deltaLink = null; meta.items = {};
      res = await graph.delta(vaultPath());
    }
    const full = !meta.deltaLink;
    const fresh = {};
    for (const it of res.items) {
      if (it.id === meta.rootId) continue;
      if (it.deleted) { delete meta.items[it.id]; delete texts[it.id]; continue; }
      const rec = { id: it.id, name: it.name, parent: it.parentReference?.id, folder: !!it.folder, eTag: it.eTag, mtime: it.lastModifiedDateTime, size: it.size };
      if (full) fresh[it.id] = rec; else meta.items[it.id] = rec;
      if (it['@microsoft.graph.downloadUrl']) rec.dl = it['@microsoft.graph.downloadUrl'];
    }
    if (full) {
      meta.items = fresh;
      for (const id of Object.keys(texts)) if (!fresh[id]) delete texts[id];
    }
    meta.deltaLink = res.deltaLink;
    rebuild();
    if (active) renderTree();
    // Texte des notes modifiées (pour la recherche et les rétroliens)
    const todo = Object.values(meta.items).filter(it => !it.folder && isMd(it.name) && visible(it.id) && texts[it.id]?.eTag !== it.eTag);
    let done = 0;
    const pool = [...todo];
    const worker = async () => {
      while (pool.length) {
        const it = pool.shift();
        try {
          const text = await graph.readItem({ id: it.id, '@microsoft.graph.downloadUrl': it.dl });
          texts[it.id] = { eTag: it.eTag, text };
          if (cur.id === it.id && !dirty() && cur.eTag !== it.eTag) reloadCurrent(text, it.eTag);
        } catch (e) { if (isNetErr(e)) throw e; console.warn(it.name, e); }
        done++;
        if (todo.length > 3 && (done % 10 === 0 || done === todo.length)) status(`Indexation ${done}/${todo.length}`);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    for (const it of Object.values(meta.items)) delete it.dl;
    backlinkMemo = null;
    persist();
    if (active) { if (searchQ()) renderSearch(); if (cur.id) renderBacklinks(); }
    if (!quiet) ctx.toast(todo.length ? `${todo.length} note(s) mise(s) à jour` : 'Coffre à jour');
  } catch (e) {
    if (isNetErr(e)) { if (!quiet) ctx.toast('Hors ligne : affichage du coffre en cache'); }
    else ctx.handleError(e);
  } finally {
    syncing = false;
    document.body.classList.remove('vt-syncing');
    status('');
  }
}

// ---------- Arborescence ----------
let open = new Set(LS.get('vt.open', []));
// Glisser-déposer seulement à la souris : sur téléphone, l'appui long ouvre le menu.
const DRAG = matchMedia('(pointer: fine)').matches ? 'draggable="true"' : '';
const saveOpen = () => LS.set('vt.open', [...open]);

function treeHtml(parent, depth) {
  return (children[parent] || []).filter(visible).map(id => {
    const it = meta.items[id];
    const pad = `style="padding-left:${8 + depth * 14}px"`;
    if (it.folder) {
      const o = open.has(id);
      return `<div class="vt-row vt-dir${o ? ' open' : ''}" data-id="${id}" ${DRAG} ${pad}><svg><use href="#i-right"/></svg><span>${esc(it.name)}</span></div>`
        + (o ? treeHtml(id, depth + 1) : '');
    }
    const md = isMd(it.name);
    return `<div class="vt-row vt-file${md ? '' : ' other'}${id === cur.id ? ' on' : ''}" data-id="${id}" ${DRAG} ${pad}><span>${esc(md ? base(it.name) : it.name)}</span></div>`;
  }).join('');
}
function renderTree() {
  if (searchQ()) return renderSearch();
  const box = $('#vtTree');
  if (!meta.rootId || !Object.keys(meta.items).length) {
    box.innerHTML = `<p class="hint vt-empty">${syncing ? 'Lecture du coffre…' : auth.isLoggedIn() ? 'Coffre vide ou pas encore lu.' : 'Connecte-toi à OneDrive pour voir ton coffre.'}</p>`;
    return;
  }
  box.innerHTML = treeHtml(meta.rootId, 0);
}
/** Déplie les dossiers jusqu'à la note ouverte. */
function reveal(id) {
  let p = meta.items[id]?.parent;
  while (p && p !== meta.rootId) { open.add(p); p = meta.items[p]?.parent; }
  saveOpen();
}

// ---------- Recherche ----------
const searchQ = () => $('#vtSearch').value.trim();
function renderSearch() {
  const q = searchQ();
  if (!q) return renderTree();
  const toks = fold(q).split(/\s+/).filter(Boolean);
  const res = [];
  for (const id of Object.values(byPath)) {
    const it = meta.items[id], p = paths[id];
    const name = fold(isMd(it.name) ? base(it.name) : it.name);
    const body = isMd(it.name) ? (texts[id]?.text || '') : '';
    const fb = fold(body);
    if (!toks.every(t => name.includes(t) || fold(p).includes(t) || fb.includes(t))) continue;
    let score = toks.filter(t => name.includes(t)).length * 10;
    let snip = '';
    const t0 = toks.find(t => fb.includes(t));
    if (t0) {
      const i = fb.indexOf(t0);
      snip = body.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ');
      score += 1;
    }
    res.push({ id, p, score, snip, mtime: it.mtime || '' });
  }
  res.sort((a, b) => b.score - a.score || String(b.mtime).localeCompare(String(a.mtime)));
  // Surligne le premier mot cherché, sans tenir compte des accents (positions prises dans le texte replié)
  const hl = str => {
    const f = fold(str), t = toks.find(x => f.includes(x));
    if (!t) return esc(str);
    let out = '', last = 0, k;
    while ((k = f.indexOf(t, last)) >= 0) { out += esc(str.slice(last, k)) + `<mark>${esc(str.slice(k, k + t.length))}</mark>`; last = k + t.length; }
    return out + esc(str.slice(last));
  };
  $('#vtTree').innerHTML = res.length
    ? `<p class="hint vt-count">${res.length > 100 ? '100 premiers sur ' : ''}${res.length} résultat${res.length > 1 ? 's' : ''}</p>` + res.slice(0, 100).map(r => {
      const it = meta.items[r.id];
      const dir = r.p.split('/').slice(0, -1).join('/');
      return `<div class="vt-row vt-file vt-res${r.id === cur.id ? ' on' : ''}" data-id="${r.id}"><b>${hl(isMd(it.name) ? base(it.name) : it.name)}</b>${dir ? `<small>${esc(dir)}</small>` : ''}${r.snip ? `<small class="snip">${hl(r.snip)}</small>` : ''}</div>`;
    }).join('')
    : '<p class="hint vt-empty">Aucun résultat.</p>';
}

// ---------- Note ouverte ----------
const cur = { id: null, eTag: null, base: '', loaded: false };
let mode = LS.get('vt.mode', 'read');
let saveTimer = null, saving = null;
let hist = [], histPos = -1;
let drafts = LS.get('vt.drafts', {}); // id -> { text, baseETag }
const saveDrafts = () => LS.set('vt.drafts', drafts);
const dirty = () => !!(cur.id && drafts[cur.id]);

function setSaveState(kind, text) { const s = $('#vtState'); s.className = kind || ''; s.textContent = text || ''; }

function headerTitle() {
  if (!active) return;
  ctx.setTitle(cur.id && meta.items[cur.id] ? base(meta.items[cur.id].name) : 'Coffre');
}

export async function openNote(id, { push = true } = {}) {
  if (!id || !meta.items[id]) return;
  await flush();
  const it = meta.items[id];
  if (!isMd(it.name)) return openFile(id);
  if (push) { hist = hist.slice(0, histPos + 1); if (hist[histPos] !== id) { hist.push(id); histPos = hist.length - 1; } }
  LS.set('vt.last', id);
  Object.assign(cur, { id, eTag: texts[id]?.eTag ?? null, base: texts[id]?.text ?? '', loaded: false });
  reveal(id);
  document.body.classList.add('vt-note-open');
  $('#vtPane').hidden = false;
  $('#vtWelcome').hidden = true;
  $('#vtTitle').value = base(it.name);
  const dir = paths[id].split('/').slice(0, -1);
  $('#vtCrumbs').textContent = dir.join(' / ');
  $('#vtObsidian').href = `obsidian://open?vault=${encodeURIComponent(vaultName())}&file=${encodeURIComponent(base(paths[id]))}`;
  showText(drafts[id] ? drafts[id].text : cur.base);
  setSaveState(drafts[id] ? 'dirty' : '', drafts[id] ? 'Pas encore enregistré' : '');
  cur.loaded = texts[id] != null;
  headerTitle();
  renderTree();
  renderBacklinks();
  $('#vtPane').scrollTop = 0;
  // Version la plus récente sur OneDrive
  if (auth.isLoggedIn()) {
    try {
      const fresh = await graph.getItem(graph.joinPath(vaultPath(), paths[id]));
      if (cur.id !== id) return;
      if (!fresh) { ctx.toast('Cette note a été supprimée ou déplacée.', { error: true }); sync(); return; }
      if (fresh.eTag !== cur.eTag || !cur.loaded) {
        const text = await graph.readItem(fresh);
        if (cur.id !== id) return;
        texts[id] = { eTag: fresh.eTag, text };
        meta.items[id].eTag = fresh.eTag;
        persist();
        if (drafts[id]) { cur.eTag = drafts[id].baseETag; scheduleSave(0); } // contrôle de conflit à l'envoi
        else reloadCurrent(text, fresh.eTag);
      }
      cur.loaded = true;
    } catch (e) { if (!isNetErr(e)) ctx.handleError(e); }
  }
}

function reloadCurrent(text, eTag) {
  Object.assign(cur, { eTag, base: text, loaded: true });
  showText(text, { keepCursor: true });
  renderBacklinks();
}

function showText(text, { keepCursor = false } = {}) {
  const ed = $('#vtEditor');
  const pos = keepCursor ? [ed.selectionStart, ed.selectionEnd] : null;
  if (ed.value !== text) ed.value = text;
  if (pos) ed.setSelectionRange(Math.min(pos[0], text.length), Math.min(pos[1], text.length));
  if (mode === 'read') renderPreview();
}

function renderPreview() {
  const text = $('#vtEditor').value;
  const { fm, body } = splitRaw(text);
  const off = fm ? fm.split('\n').length - 1 : 0;
  let props = '';
  if (fm) {
    const rows = fm.split('\n').slice(1, -2).filter(l => l.trim()).map(l => {
      const m = l.match(/^([^:\s][^:]*):\s*(.*)$/);
      return m ? `<tr><th>${esc(m[1])}</th><td>${esc(m[2])}</td></tr>` : `<tr><th></th><td>${esc(l.trim())}</td></tr>`;
    }).join('');
    if (rows) props = `<details class="vt-props"><summary>Propriétés</summary><table>${rows}</table></details>`;
  }
  $('#vtPreview').innerHTML = props + (body.trim() ? renderMarkdown(body, off, { embeds: true }) : '<p class="hint">Note vide. Appuie sur Modifier (Ctrl+E) pour écrire.</p>');
  // Liens : existants ou non (comme Obsidian, en plus pâle)
  for (const a of $('#vtPreview').querySelectorAll('a.wikilink')) {
    if (!resolve(a.dataset.link, cur.id) && !a.dataset.link.startsWith('#')) a.classList.add('missing');
  }
  for (const el of $('#vtPreview').querySelectorAll('.embed')) loadEmbed(el);
}

const blobs = new Map(); // id -> objectURL
async function loadEmbed(el) {
  const id = resolve(el.dataset.embed, cur.id);
  if (!id) { el.innerHTML = `<span class="hint">⚠ ${esc(el.dataset.embed)} introuvable</span>`; return; }
  const it = meta.items[id];
  if (IMG.test(it.name)) {
    const w = parseInt(el.dataset.w, 10);
    el.innerHTML = `<img alt="${esc(it.name)}"${w ? ` style="width:${w}px"` : ''}>`;
    try {
      if (!blobs.has(id)) blobs.set(id, URL.createObjectURL(await graph.readBlob(id)));
      el.querySelector('img').src = blobs.get(id);
    } catch (e) { el.innerHTML = `<span class="hint">⚠ Image non chargée (${esc(it.name)})</span>`; }
  } else if (isMd(it.name)) {
    const t = texts[id]?.text;
    el.innerHTML = `<div class="vt-transclude"><a class="wikilink" data-link="${esc(base(paths[id]))}">${esc(base(it.name))}</a>${t != null ? renderMarkdown(splitRaw(t).body) : ''}</div>`;
  } else {
    el.innerHTML = `<a class="wikilink" data-link="${esc(paths[id])}">📎 ${esc(it.name)}</a>`;
  }
}

/** Fichier qui n'est pas une note : image affichée, sinon ouverture dans OneDrive. */
async function openFile(id) {
  const it = meta.items[id];
  if (IMG.test(it.name)) {
    try {
      if (!blobs.has(id)) blobs.set(id, URL.createObjectURL(await graph.readBlob(id)));
      window.open(blobs.get(id), '_blank');
    } catch (e) { ctx.handleError(e); }
    return;
  }
  try {
    const full = await graph.getItem(graph.joinPath(vaultPath(), paths[id]));
    if (full?.webUrl) window.open(full.webUrl, '_blank', 'noopener');
  } catch (e) { ctx.handleError(e); }
}

// ---------- Rétroliens ----------
let backlinkMemo = null;
function linksOf(id) {
  const t = texts[id]?.text || '';
  const out = [];
  for (const m of t.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.push({ target: m[1], index: m.index });
  for (const m of t.matchAll(/\]\(([^)\s]+\.md)\)/g)) out.push({ target: decodeURIComponent(m[1]), index: m.index });
  return out;
}
/** id -> [{ from, index }] : qui pointe vers qui. */
function backlinks() {
  if (!backlinkMemo) {
    backlinkMemo = {};
    for (const id of Object.values(byPath)) {
      if (!isMd(meta.items[id].name)) continue;
      for (const l of linksOf(id)) {
        const to = resolve(l.target, id);
        if (to && to !== id) (backlinkMemo[to] ||= []).push({ from: id, index: l.index });
      }
    }
  }
  return backlinkMemo;
}
function renderBacklinks() {
  const box = $('#vtBacklinks');
  if (!cur.id) { box.innerHTML = ''; return; }
  const list = backlinks()[cur.id] || [];
  const seen = new Map();
  for (const b of list) { if (!seen.has(b.from)) seen.set(b.from, []); seen.get(b.from).push(b.index); }
  // Mentions sans lien (le nom apparaît dans le texte)
  box.innerHTML = `<h4>Rétroliens <small>${seen.size}</small></h4>` + (seen.size ? [...seen].map(([from, idx]) => {
    const t = texts[from]?.text || '';
    const lines = idx.slice(0, 3).map(i => {
      const s = t.lastIndexOf('\n', i) + 1, e = t.indexOf('\n', i);
      return `<div class="vt-bl-line md">${renderMarkdown(t.slice(s, e < 0 ? undefined : e).trim().slice(0, 300))}</div>`;
    }).join('');
    return `<div class="vt-bl" data-id="${from}"><b>${esc(base(meta.items[from].name))}</b>${lines}</div>`;
  }).join('') : '<p class="hint">Aucune note ne pointe ici.</p>');
}

// ---------- Mode lecture / édition ----------
function setMode(m, { focus = true } = {}) {
  mode = m; LS.set('vt.mode', m);
  const read = m === 'read';
  $('#vtEditor').hidden = read;
  $('#vtPreview').hidden = !read;
  const b = $('#vtMode');
  b.setAttribute('aria-pressed', String(!read));
  b.innerHTML = `<svg><use href="#${read ? 'i-edit' : 'i-eye'}"/></svg>${read ? 'Modifier' : 'Lecture'}`;
  if (read) renderPreview();
  else if (focus) $('#vtEditor').focus();
  ctx.onSelection();
}
export const toggleMode = () => { if (cur.id) setMode(mode === 'read' ? 'edit' : 'read'); };

// ---------- Enregistrement ----------
function onInput() {
  const text = $('#vtEditor').value;
  if (text === cur.base) { delete drafts[cur.id]; saveDrafts(); setSaveState('', 'Enregistré'); return; }
  drafts[cur.id] = { text, baseETag: drafts[cur.id]?.baseETag ?? cur.eTag };
  saveDrafts();
  setSaveState('dirty', 'Modifié');
  scheduleSave();
}
function scheduleSave(ms = SAVE_DELAY) { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow(), ms); }
export async function flush() { clearTimeout(saveTimer); if (dirty()) await saveNow(); else if (saving) await saving; }
function saveNow() {
  if (saving) return saving.then(() => (dirty() ? saveNow() : null));
  saving = doSave(cur.id).finally(() => { saving = null; });
  return saving;
}
async function doSave(id) {
  const dr = drafts[id];
  if (!dr || !auth.isLoggedIn()) return;
  setSaveState('saving', 'Enregistrement…');
  try {
    let out;
    try { out = await graph.writeFile(id, dr.text, dr.baseETag || cur.eTag); }
    catch (e) {
      if (e.status !== 412) throw e;
      // Modifiée ailleurs (Obsidian sur un autre appareil ?)
      const fresh = await graph.getItem(graph.joinPath(vaultPath(), paths[id]));
      const theirs = fresh ? await graph.readItem(fresh) : '';
      if (theirs !== cur.base && theirs !== dr.text) {
        const keepMine = await ctx.askConfirm('Note modifiée ailleurs',
          `« ${base(meta.items[id].name)} » a changé sur un autre appareil pendant que tu écrivais. Garder ta version ? (L'autre reste dans l'historique des versions de OneDrive.)`,
          'Garder la mienne');
        if (!keepMine) {
          delete drafts[id]; saveDrafts();
          texts[id] = { eTag: fresh.eTag, text: theirs }; persist();
          if (cur.id === id) { reloadCurrent(theirs, fresh.eTag); setSaveState('', 'Version distante reprise'); }
          return;
        }
      }
      out = await graph.writeFile(id, dr.text, fresh?.eTag);
    }
    texts[id] = { eTag: out.eTag, text: dr.text };
    if (meta.items[id]) Object.assign(meta.items[id], { eTag: out.eTag, mtime: out.lastModifiedDateTime });
    persist();
    backlinkMemo = null;
    const still = drafts[id] && drafts[id].text !== dr.text;
    if (still) drafts[id].baseETag = out.eTag; else delete drafts[id];
    saveDrafts();
    if (cur.id === id) { Object.assign(cur, { eTag: out.eTag, base: dr.text }); setSaveState(still ? 'dirty' : '', still ? 'Modifié' : 'Enregistré'); }
  } catch (e) {
    if (isNetErr(e)) { setSaveState('offline', 'Hors ligne · gardé dans le navigateur'); return; }
    setSaveState('error', 'Non enregistré');
    ctx.handleError(e);
  }
}

// ---------- Créer, renommer, supprimer ----------
const curFolderId = () => (cur.id && meta.items[cur.id] ? meta.items[cur.id].parent : meta.rootId);
const folderPath = fid => (fid === meta.rootId ? '' : paths[fid] || '');

async function createNote(name = 'Sans titre', folderId = curFolderId(), text = '') {
  if (!auth.isLoggedIn()) { ctx.toast('Connecte-toi à OneDrive pour créer une note.', { error: true }); return null; }
  try {
    const item = await graph.createFile(graph.joinPath(vaultPath(), folderPath(folderId)), `${name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || 'Sans titre'}.md`, text, 'rename');
    meta.items[item.id] = { id: item.id, name: item.name, parent: folderId, folder: false, eTag: item.eTag, mtime: item.lastModifiedDateTime, size: item.size };
    texts[item.id] = { eTag: item.eTag, text };
    rebuild(); persist();
    return item.id;
  } catch (e) { ctx.handleError(e); return null; }
}

async function newNote() {
  const id = await createNote();
  if (!id) return;
  await openNote(id);
  setMode('edit', { focus: false });
  const t = $('#vtTitle'); t.focus(); t.select();
}

async function rename() {
  const id = cur.id;
  if (!id) return;
  const name = $('#vtTitle').value;
  if (!await renameItem(id, name)) $('#vtTitle').value = base(meta.items[id]?.name || '');
}

const removeNote = () => cur.id && removeItem(cur.id);

function closeNote() {
  Object.assign(cur, { id: null, eTag: null, base: '', loaded: false });
  $('#vtPane').hidden = true;
  $('#vtWelcome').hidden = false;
  document.body.classList.remove('vt-note-open');
  headerTitle(); renderTree();
}

/** Clic sur un lien [[…]] : ouvre la note, ou la crée si elle n'existe pas (comme Obsidian). */
async function followLink(target) {
  if (target.startsWith('#')) return; // titre de la note courante
  const id = resolve(target, cur.id);
  if (id) { openNote(id); return; }
  const name = target.split('|')[0].split('#')[0].trim();
  if (!await ctx.askConfirm('Créer la note ?', `« ${name} » n'existe pas encore.`, 'Créer')) return;
  const parts = name.split('/');
  let folder = meta.rootId;
  if (parts.length > 1) {
    const fid = byPath[parts.slice(0, -1).join('/').toLowerCase()] || Object.keys(meta.items).find(k => meta.items[k].folder && paths[k]?.toLowerCase() === parts.slice(0, -1).join('/').toLowerCase());
    if (fid) folder = fid;
  }
  const nid = await createNote(parts.pop(), folder);
  if (nid) { await openNote(nid); setMode('edit'); }
}

// ---------- Opérations sur les fichiers et dossiers (menu clic droit) ----------
const cleanName = n => String(n || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const label = id => (meta.items[id].folder || !isMd(meta.items[id].name) ? meta.items[id].name : base(meta.items[id].name));
const descendants = fid => (children[fid] || []).flatMap(c => [c, ...(meta.items[c].folder ? descendants(c) : [])]);
const allFolders = () => [meta.rootId, ...Object.keys(meta.items).filter(k => meta.items[k].folder && visible(k))];
const folderLabel = fid => (fid === meta.rootId ? '/' : paths[fid]);

async function newNoteIn(folderId) {
  const id = await createNote('Sans titre', folderId);
  if (!id) return;
  open.add(folderId); saveOpen();
  await openNote(id);
  setMode('edit', { focus: false });
  const t = $('#vtTitle'); t.focus(); t.select();
}

async function newFolderIn(parentId) {
  const name = cleanName(await ctx.askText('Nouveau dossier', 'Sans titre', { ok: 'Créer' }));
  if (!name) return;
  try {
    const f = await graph.createFolder(graph.joinPath(vaultPath(), folderPath(parentId)), name);
    meta.items[f.id] = { id: f.id, name: f.name, parent: parentId, folder: true, eTag: f.eTag };
    open.add(parentId); open.add(f.id); saveOpen();
    rebuild(); persist(); renderTree();
  } catch (e) { ctx.handleError(e); }
}

/**
 * Renomme une note, un fichier ou un dossier. Pour une note, propose de mettre à jour
 * les liens [[…]] des autres notes (comme Obsidian). Renvoie true si c'est fait.
 */
async function renameItem(id, newName = null) {
  const it = meta.items[id];
  if (!it) return false;
  const md = !it.folder && isMd(it.name);
  if (newName === null) newName = await ctx.askText(it.folder ? 'Renommer le dossier' : 'Renommer', label(id), { ok: 'Renommer' });
  let name = cleanName(newName);
  if (!name || name === label(id)) return false;
  if (md) name += '.md';
  try {
    if (id === cur.id) await flush();
    const oldBase = base(it.name), oldPath = base(paths[id]);
    const sources = md ? [...new Set((backlinks()[id] || []).map(b => b.from))] : [];
    const out = await graph.moveRename(id, { name });
    it.name = out.name; it.eTag = out.eTag;
    rebuild(); persist();
    if (id === cur.id) { $('#vtTitle').value = base(out.name); headerTitle(); }
    renderTree();
    if (sources.length && await ctx.askConfirm('Mettre à jour les liens ?',
      `${sources.length} note(s) pointent vers « ${oldBase} ». Les modifier pour pointer vers « ${base(out.name)} » ?`, 'Mettre à jour')) {
      await rewriteLinks(sources, id, oldBase, oldPath);
    }
    if (cur.id) renderBacklinks();
    if (cur.id && mode === 'read') renderPreview();
    return true;
  } catch (e) { ctx.handleError(e); return false; }
}

/** Remplace [[ancien nom…]] par [[nouveau nom…]] dans les notes données. */
async function rewriteLinks(sources, id, oldBase, oldPath) {
  const newBase = base(meta.items[id].name), newPath = base(paths[id]);
  const re = new RegExp(`(!?\\[\\[)(${escRe(oldPath)}|${escRe(oldBase)})(\\.md)?((?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\])`, 'gi');
  let n = 0;
  for (const src of sources) {
    if (src === cur.id && dirty()) await flush();
    const t = texts[src]?.text;
    if (t == null) continue;
    const next = t.replace(re, (m, open, target, ext, rest) => open + (target.includes('/') ? newPath : newBase) + (ext || '') + rest);
    if (next === t) continue;
    try {
      const o = await graph.writeFile(src, next, texts[src].eTag);
      texts[src] = { eTag: o.eTag, text: next };
      meta.items[src].eTag = o.eTag;
      if (src === cur.id) reloadCurrent(next, o.eTag);
      n++;
    } catch (e) { console.warn(e); ctx.toast(`Lien non mis à jour dans « ${label(src)} » (modifiée ailleurs ?)`, { error: true }); }
  }
  backlinkMemo = null; persist();
  if (n) ctx.toast(`Liens mis à jour dans ${n} note(s)`);
}

async function moveItem(id, folderId) {
  const it = meta.items[id];
  if (!it || !folderId || it.parent === folderId || id === folderId) return;
  if (it.folder && descendants(id).includes(folderId)) { ctx.toast('Impossible de déplacer un dossier dans lui-même.', { error: true }); return; }
  try {
    if (id === cur.id) await flush();
    const out = await graph.moveRename(id, { parentId: folderId });
    it.parent = folderId; it.name = out.name; it.eTag = out.eTag;
    open.add(folderId); saveOpen();
    rebuild(); persist(); renderTree();
    if (id === cur.id) $('#vtCrumbs').textContent = paths[id].split('/').slice(0, -1).join(' / ');
    ctx.toast(`Déplacé dans ${folderLabel(folderId)}`);
  } catch (e) { ctx.handleError(e); }
}

async function askMove(id) {
  const opts = allFolders().filter(f => f !== meta.items[id].parent && f !== id && !(meta.items[id].folder && descendants(id).includes(f)));
  const ans = await ctx.askText(`Déplacer « ${label(id)} » vers…`, '', { ok: 'Déplacer', list: opts.map(folderLabel), placeholder: 'Dossier (/ pour la racine)' });
  if (ans == null) return;
  const want = ans.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  const fid = want === '' ? meta.rootId : opts.find(f => (paths[f] || '').toLowerCase() === want);
  if (!fid) { ctx.toast(`Dossier introuvable : ${ans}`, { error: true }); return; }
  moveItem(id, fid);
}

async function removeItem(id) {
  const it = meta.items[id];
  if (!it) return;
  const inside = it.folder ? descendants(id).filter(d => !meta.items[d].folder).length : 0;
  const msg = it.folder ? `Le dossier « ${it.name} »${inside ? ` et ses ${inside} fichier(s)` : ''} iront dans la corbeille OneDrive.` : `« ${label(id)} »\nElle ira dans la corbeille OneDrive.`;
  if (!await ctx.askConfirm(it.folder ? 'Supprimer ce dossier ?' : 'Supprimer cette note ?', msg, 'Supprimer', true)) return;
  try {
    const gone = [id, ...(it.folder ? descendants(id) : [])];
    if (gone.includes(cur.id)) { clearTimeout(saveTimer); closeNote(); }
    for (const g of gone) delete drafts[g];
    saveDrafts();
    await graph.deleteItem(id);
    for (const g of gone) { delete meta.items[g]; delete texts[g]; }
    hist = hist.filter(h => !gone.includes(h)); histPos = hist.length - 1;
    rebuild(); persist(); renderTree();
    ctx.toast('Supprimé (corbeille OneDrive)');
  } catch (e) { ctx.handleError(e); }
}

function linkText(id) {
  const it = meta.items[id];
  const short = isMd(it.name) ? base(it.name) : it.name;
  const unique = (byBase[short.toLowerCase()] || []).length <= 1;
  return unique ? short : (isMd(it.name) ? base(paths[id]) : paths[id]);
}
async function copyLink(id) {
  const l = `[[${linkText(id)}]]`;
  try { await navigator.clipboard.writeText(l); ctx.toast(`Copié : ${l}`); } catch { ctx.toast(l); }
}
const obsidianHref = id => `obsidian://open?vault=${encodeURIComponent(vaultName())}&file=${encodeURIComponent(isMd(paths[id]) ? base(paths[id]) : paths[id])}`;

// Menu contextuel (clic droit, ou appui long sur téléphone)
function showMenu(x, y, id) {
  const m = $('#vtMenu');
  const it = id ? meta.items[id] : null;
  const folderId = !it ? meta.rootId : it.folder ? id : it.parent;
  const entries = [];
  const add = (act, icon, text, cls = '') => entries.push(`<button type="button" data-act="${act}" class="${cls}"><svg><use href="#${icon}"/></svg>${text}</button>`);
  const sep = () => entries.push('<hr>');
  if (it && !it.folder) { add('open', 'i-ext', 'Ouvrir'); sep(); }
  add('newNote', 'i-plus', it && !it.folder ? 'Nouvelle note dans ce dossier' : 'Nouvelle note');
  add('newFolder', 'i-folder', it && !it.folder ? 'Nouveau dossier ici' : 'Nouveau dossier');
  if (it) {
    sep();
    add('rename', 'i-edit', 'Renommer…');
    add('move', 'i-right', 'Déplacer vers…');
    if (!it.folder) add('copyLink', 'i-copy', 'Copier le lien [[…]]');
    if (!it.folder) add('obsidian', 'i-ext', 'Ouvrir dans Obsidian');
    sep();
    add('delete', 'i-trash', 'Supprimer', 'danger');
  }
  m.innerHTML = (it ? `<div class="vt-menu-head">${esc(label(id))}</div>` : '') + entries.join('');
  m.hidden = false;
  m.onclick = e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    hideMenu();
    ({
      open: () => openNote(id),
      newNote: () => newNoteIn(folderId),
      newFolder: () => newFolderIn(folderId),
      rename: () => renameItem(id),
      move: () => askMove(id),
      copyLink: () => copyLink(id),
      obsidian: () => { location.href = obsidianHref(id); },
      delete: () => removeItem(id),
    })[b.dataset.act]();
  };
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  for (const row of document.querySelectorAll('#vtTree .vt-row.ctx')) row.classList.remove('ctx');
  if (id) document.querySelector(`#vtTree .vt-row[data-id="${id}"]`)?.classList.add('ctx');
  m.querySelector('button')?.focus({ preventScroll: true });
}
function hideMenu() {
  $('#vtMenu').hidden = true;
  for (const row of document.querySelectorAll('#vtTree .vt-row.ctx')) row.classList.remove('ctx');
}

// ---------- Liens [[…]] depuis les autres onglets ----------
/** Notes proposées en tapant [[… (le nom le plus proche d'abord, puis les plus récentes). */
export function suggest(q) {
  const fq = fold(q.trim());
  const out = [];
  for (const id of Object.values(byPath)) {
    const it = meta.items[id];
    const name = isMd(it.name) ? base(it.name) : it.name;
    const fn = fold(name), fp = fold(paths[id]);
    let score;
    if (!fq) score = 1;
    else if (fn.startsWith(fq)) score = 4;
    else if (fn.split(/[\s\-_.]+/).some(w => w.startsWith(fq))) score = 3;
    else if (fn.includes(fq)) score = 2;
    else if (fp.includes(fq)) score = 1;
    else continue;
    out.push({ id, score, mtime: it.mtime || '', md: isMd(it.name) });
  }
  out.sort((a, b) => b.score - a.score || (b.md - a.md) || String(b.mtime).localeCompare(String(a.mtime)));
  return out.slice(0, 12).map(({ id }) => {
    const dir = paths[id].split('/').slice(0, -1).join('/');
    return { label: label(id), insert: linkText(id), hint: dir };
  });
}
/** Prépare l'index du coffre (pour la complétion dans l'onglet Notes). */
export async function ensureIndex() {
  if (!configured()) return;
  await load();
  if (!meta.deltaLink && auth.isLoggedIn()) sync();
}
/** Ouvre un lien [[…]] cliqué ailleurs (onglet Notes) : app.js a déjà affiché l'onglet Coffre. */
export async function openLink(target) {
  await load();
  if (!Object.keys(meta.items).length) await sync();
  followLink(target);
}

// ---------- API pour app.js ----------
export const configured = () => !!(S().clientId && S().vaultPath);
export const current = () => (cur.id ? { rel: base(paths[cur.id]), label: base(meta.items[cur.id].name) } : null);
export function selection() {
  if (!active || !cur.id) return '';
  if (mode === 'read') {
    const s = getSelection();
    return s && $('#vtPreview').contains(s.anchorNode) ? String(s).trim() : '';
  }
  const ed = $('#vtEditor');
  if (document.activeElement !== ed) return '';
  return ed.value.slice(ed.selectionStart, ed.selectionEnd).trim();
}
export const nav = {
  back: () => { if (histPos > 0) openNote(hist[--histPos], { push: false }); },
  forward: () => { if (histPos < hist.length - 1) openNote(hist[++histPos], { push: false }); },
  search: () => { const s = $('#vtSearch'); s.focus(); s.select(); document.body.classList.remove('vt-note-open'); },
};

export async function show() {
  active = true;
  document.body.classList.add('view-vault');
  $('#vaultView').hidden = false;
  if (!configured()) { $('#vtSetup').hidden = false; ctx.setTitle('Coffre'); return; }
  $('#vtSetup').hidden = true;
  await load();
  if (!active) return;
  renderTree();
  headerTitle();
  if (!cur.id) {
    const last = LS.get('vt.last', null);
    if (last && meta.items[last] && visible(last)) openNote(last);
  }
  sync();
}
export function hide() {
  if (!active) return;
  active = false;
  document.body.classList.remove('view-vault');
  $('#vaultView').hidden = true;
  if (dirty()) saveNow();
  ctx.onSelection();
}
/** Coffre changé dans les réglages. */
export function reset() {
  loadedFor = null; meta = { vault: '', rootId: null, deltaLink: null, items: {} }; texts = {};
  closeNote(); hist = []; histPos = -1;
  if (active) show();
}

export function init(c) {
  ctx = c;
  linkcomplete.attach($('#vtEditor'), suggest);
  // Menu clic droit (et appui long sur téléphone)
  $('#vtTree').addEventListener('contextmenu', e => {
    e.preventDefault();
    const row = e.target.closest('.vt-row');
    if (row && row.classList.contains('vt-res') && !meta.items[row.dataset.id]) return;
    showMenu(e.clientX, e.clientY, row ? row.dataset.id : null);
  });
  document.addEventListener('pointerdown', e => { if (!$('#vtMenu').hidden && !e.target.closest('#vtMenu')) hideMenu(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#vtMenu').hidden) { e.preventDefault(); hideMenu(); } });
  $('#vtTree').addEventListener('scroll', hideMenu, { passive: true });
  // Glisser-déposer (ordinateur) : déplacer une note ou un dossier
  let dragId = null;
  const tree = $('#vtTree');
  tree.addEventListener('dragstart', e => {
    const row = e.target.closest('.vt-row');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `[[${linkText(dragId)}]]`); // déposé dans l'éditeur : insère le lien
  });
  const dropTarget = e => {
    const row = e.target.closest('.vt-row');
    if (!row) return meta.rootId;
    const it = meta.items[row.dataset.id];
    return it?.folder ? it.id : it?.parent;
  };
  tree.addEventListener('dragover', e => {
    if (!dragId) return;
    e.preventDefault();
    const t = dropTarget(e);
    for (const r of tree.querySelectorAll('.drop')) r.classList.remove('drop');
    tree.classList.toggle('drop-root', t === meta.rootId);
    if (t !== meta.rootId) tree.querySelector(`.vt-row[data-id="${t}"]`)?.classList.add('drop');
  });
  const endDrag = () => { dragId = null; tree.classList.remove('drop-root'); for (const r of tree.querySelectorAll('.drop')) r.classList.remove('drop'); };
  tree.addEventListener('dragleave', e => { if (!tree.contains(e.relatedTarget)) { tree.classList.remove('drop-root'); for (const r of tree.querySelectorAll('.drop')) r.classList.remove('drop'); } });
  tree.addEventListener('drop', e => { if (!dragId) return; e.preventDefault(); const id = dragId, t = dropTarget(e); endDrag(); moveItem(id, t); });
  tree.addEventListener('dragend', endDrag);
  $('#vtNewFolder').onclick = () => newFolderIn(meta.rootId);
  $('#vtTree').addEventListener('click', e => {
    const row = e.target.closest('.vt-row');
    if (!row) return;
    const id = row.dataset.id;
    if (meta.items[id]?.folder) { open.has(id) ? open.delete(id) : open.add(id); saveOpen(); renderTree(); return; }
    openNote(id);
  });
  let st;
  $('#vtSearch').addEventListener('input', () => { clearTimeout(st); st = setTimeout(renderSearch, 120); });
  $('#vtSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const first = $('#vtTree .vt-res'); if (first) openNote(first.dataset.id); }
    if (e.key === 'Escape') { $('#vtSearch').value = ''; renderTree(); }
  });
  $('#vtNew').onclick = () => newNoteIn(curFolderId());
  $('#vtWelcomeNew').onclick = () => newNoteIn(meta.rootId);
  $('#vtCollapse').onclick = () => { open.clear(); saveOpen(); renderTree(); };
  $('#vtBackToList').onclick = () => document.body.classList.remove('vt-note-open');
  $('#vtMode').onclick = toggleMode;
  $('#vtDelete').onclick = removeNote;
  $('#vtSetupBtn').onclick = () => ctx.openSettings();
  $('#vtTitle').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#vtTitle').blur(); if (mode === 'edit') $('#vtEditor').focus(); }
    if (e.key === 'Escape') { $('#vtTitle').value = base(meta.items[cur.id]?.name || ''); $('#vtTitle').blur(); }
  });
  $('#vtTitle').addEventListener('change', rename);
  const ed = $('#vtEditor');
  ed.addEventListener('input', onInput);
  ed.addEventListener('blur', () => { if (dirty()) scheduleSave(0); });
  ed.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '\t'); }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const start = ed.value.lastIndexOf('\n', ed.selectionStart - 1) + 1;
      const line = ed.value.slice(start, ed.selectionStart);
      const m = line.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)[.)] |> )/);
      if (!m || ed.selectionStart !== ed.selectionEnd) return;
      e.preventDefault();
      if (line.trim() === m[2].trim()) { ed.setSelectionRange(start, ed.selectionStart); document.execCommand('delete'); return; }
      const next = m[3] ? m[2].replace(/\d+/, n => +n + 1) : m[2].replace(/\[[xX]\]/, '[ ]');
      document.execCommand('insertText', false, '\n' + m[1] + next);
    }
  });
  const onLink = e => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const id = resolve(a.dataset.link, cur.id); if (id) openNote(id); return; }
    followLink(a.dataset.link);
  };
  $('#vtPreview').addEventListener('click', onLink);
  $('#vtBacklinks').addEventListener('click', e => {
    if (e.target.closest('a.wikilink')) return onLink(e);
    const b = e.target.closest('.vt-bl'); if (b) openNote(b.dataset.id);
  });
  $('#vtPreview').addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox][data-line]');
    if (!cb) return;
    showText(toggleTask($('#vtEditor').value, +cb.dataset.line));
    onInput();
  });
  // Raccourcis clavier façon Obsidian
  document.addEventListener('keydown', e => {
    if (!active || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'e') { e.preventDefault(); toggleMode(); }
    else if (mod && (k === 'o' || k === 'k' || (e.shiftKey && k === 'f'))) { e.preventDefault(); nav.search(); }
    else if (mod && k === 'n') { e.preventDefault(); newNote(); }
    else if (mod && k === 's') { e.preventDefault(); flush(); }
    else if (e.altKey && k === 'arrowleft') { e.preventDefault(); nav.back(); }
    else if (e.altKey && k === 'arrowright') { e.preventDefault(); nav.forward(); }
  });
  setMode(mode === 'edit' ? 'edit' : 'read', { focus: false });
  window.addEventListener('online', () => {
    for (const id of Object.keys(drafts)) if (id === cur.id) scheduleSave(0);
    if (active) sync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (dirty()) saveNow(); return; }
    if (active) sync();
  });
  window.addEventListener('pagehide', () => { if (dirty()) saveNow(); });
}
