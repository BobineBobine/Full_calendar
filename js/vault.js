// Onglet « Coffre » : parcourir, lire, modifier et chercher dans tout le coffre Obsidian (sur OneDrive).
// - La liste des fichiers vient de l'API « delta » de OneDrive : la première fois tout le coffre, ensuite seulement ce qui a changé.
// - Le texte des notes est gardé dans le navigateur (IndexedDB) pour la recherche et les rétroliens, même hors ligne.
// - Liens [[…]] cliquables (créent la note si elle n'existe pas), images ![[…]], rétroliens.

import * as auth from './auth.js';
import * as graph from './graph.js';
import { renderMarkdown, toggleTask } from './markdown.js';
import { splitRaw } from './daily.js';

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
const saveOpen = () => LS.set('vt.open', [...open]);

function treeHtml(parent, depth) {
  return (children[parent] || []).filter(visible).map(id => {
    const it = meta.items[id];
    const pad = `style="padding-left:${8 + depth * 14}px"`;
    if (it.folder) {
      const o = open.has(id);
      return `<div class="vt-row vt-dir${o ? ' open' : ''}" data-id="${id}" ${pad}><svg><use href="#i-right"/></svg><span>${esc(it.name)}</span></div>`
        + (o ? treeHtml(id, depth + 1) : '');
    }
    const md = isMd(it.name);
    return `<div class="vt-row vt-file${md ? '' : ' other'}${id === cur.id ? ' on' : ''}" data-id="${id}" ${pad}><span>${esc(md ? base(it.name) : it.name)}</span></div>`;
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
function renderBacklinks() {
  const box = $('#vtBacklinks');
  if (!cur.id) { box.innerHTML = ''; return; }
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
  const list = backlinkMemo[cur.id] || [];
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
  const it = meta.items[id];
  const name = $('#vtTitle').value.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
  if (!name || name === base(it.name)) { $('#vtTitle').value = base(it.name); return; }
  try {
    await flush();
    const out = await graph.moveRename(id, { name: name + '.md' });
    const oldBase = base(it.name);
    it.name = out.name; it.eTag = out.eTag;
    rebuild(); persist();
    $('#vtTitle').value = base(out.name);
    headerTitle(); renderTree();
    renderBacklinks();
    const refs = new Set((backlinkMemo[id] || []).map(b => b.from)).size;
    ctx.toast(refs ? `Renommée. ${refs} note(s) ont encore un lien vers « ${oldBase} » : Obsidian peut les mettre à jour.` : 'Note renommée');
  } catch (e) { $('#vtTitle').value = base(it.name); ctx.handleError(e); }
}

async function removeNote() {
  const id = cur.id;
  if (!id) return;
  const it = meta.items[id];
  if (!await ctx.askConfirm('Supprimer cette note ?', `« ${base(it.name)} »\nElle ira dans la corbeille OneDrive.`, 'Supprimer', true)) return;
  try {
    clearTimeout(saveTimer); delete drafts[id]; saveDrafts();
    await graph.deleteItem(id);
    delete meta.items[id]; delete texts[id];
    rebuild(); persist();
    hist = hist.filter(h => h !== id); histPos = hist.length - 1;
    closeNote();
    ctx.toast('Note supprimée (corbeille OneDrive)');
  } catch (e) { ctx.handleError(e); }
}

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
  $('#vtNew').onclick = newNote;
  $('#vtWelcomeNew').onclick = newNote;
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
