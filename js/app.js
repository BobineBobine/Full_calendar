import * as auth from './auth.js';
import * as graph from './graph.js';
import * as md from './md.js';
import { renderMarkdown, toggleTask } from './markdown.js';
import { parseQuick } from './nlp.js';

// ---------- Stockage local ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
};

const VIEWS = ['agenda', 'timeGridDay', 'timeGrid3Day', 'timeGridWeek', 'dayGridMonth'];
const normView = v => (v === 'listWeek' || /^list/.test(v || '')) ? 'agenda' : (VIEWS.includes(v) ? v : null);
const DEFAULT_SETTINGS = { clientId: '', vaultPath: '', sources: [], firstDay: 1, initialView: 'agenda', defaultCalId: null };

let settings = { ...DEFAULT_SETTINGS, ...LS.get('fc.settings', {}) };
let cache = LS.get('fc.cache', { files: {} }); // id -> { id, name, calId, eTag, text }
let hidden = new Set(LS.get('fc.hidden', []));
const parsedMemo = new Map();
let calendar = null;
let syncing = false;
let lastSync = LS.get('fc.lastSync', 0);
let currentView = null;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const saveSettings = () => LS.set('fc.settings', settings);
const saveCache = () => LS.set('fc.cache', cache);
const sourceById = id => settings.sources.find(s => s.id === id);
const dirPath = src => graph.joinPath(settings.vaultPath, src.directory);
const configured = () => settings.clientId && settings.vaultPath && settings.sources.length;

graph.init(force => auth.getToken(settings.clientId, force));

// ---------- Dates ----------
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayStr = () => fmtDate(new Date());
const toDate = s => new Date(s + 'T12:00:00');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const IF = o => new Intl.DateTimeFormat('fr-FR', o);
const F = {
  long: IF({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  short: IF({ weekday: 'short', day: 'numeric', month: 'short' }),
  shortY: IF({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  dmy: IF({ day: 'numeric', month: 'long', year: 'numeric' }),
  wd: IF({ weekday: 'short' }),
  mon: IF({ month: 'short' }),
  monthY: IF({ month: 'long', year: 'numeric' }),
  dm: IF({ day: 'numeric', month: 'short' }),
};
const fd = (s, f) => f.format(toDate(s));
const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const addMinutes = (t, n) => { const [h, m] = t.split(':').map(Number); const x = Math.min(h * 60 + m + n, 23 * 60 + 59); return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };

// ---------- Dialogues (gestion du bouton retour Android) ----------
const dlgStack = [];
function openDlg(d) {
  d.showModal();
  dlgStack.push(d);
  history.pushState({ dlg: dlgStack.length }, '');
}
function closeDlg(d) {
  if (!d.open) return;
  d.close();
  const i = dlgStack.lastIndexOf(d);
  if (i >= 0) dlgStack.splice(i, 1);
  if (history.state?.dlg) history.back();
}
/** Remplace un dialogue par un autre sans toucher à l'historique. */
function swapDlg(from, to) {
  if (from.open) from.close();
  const i = dlgStack.lastIndexOf(from);
  if (i >= 0) dlgStack.splice(i, 1, to); else dlgStack.push(to);
  to.showModal();
}
window.addEventListener('popstate', () => {
  const depth = history.state?.dlg || 0;
  while (dlgStack.length > depth) { const d = dlgStack.pop(); if (d.open) d.close(); }
});
function wireDialog(d) {
  d.addEventListener('cancel', e => { e.preventDefault(); closeDlg(d); });
  d.addEventListener('click', e => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeDlg(d);
    }
  });
  d.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => closeDlg(d); });
}

// ---------- UI : toast, statut, bannière ----------
let toastTimer;
function toast(msg, opts = {}) {
  const t = $('#toast');
  t.querySelector('span').textContent = msg;
  const btn = t.querySelector('button');
  if (opts.action) {
    btn.hidden = false;
    btn.textContent = opts.action.label;
    btn.onclick = () => { t.className = ''; opts.action.fn(); };
  } else btn.hidden = true;
  t.className = 'show' + (opts.error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, opts.action ? 7000 : opts.error ? 6000 : 2500);
}
const toastError = msg => toast(msg, { error: true });

function setBusy(on, label = '') {
  document.body.classList.toggle('busy', on);
  const s = $('#status');
  s.textContent = label;
  s.hidden = !label;
}

function banner(msg, btnLabel, action) {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  b.querySelector('span').textContent = msg;
  const btn = b.querySelector('button');
  btn.hidden = !btnLabel;
  btn.textContent = btnLabel || '';
  btn.onclick = action || null;
  b.hidden = false;
}

const colorMemo = new Map();
function rgbOf(css) {
  if (colorMemo.has(css)) return colorMemo.get(css);
  const el = document.createElement('span');
  el.style.color = css || '#3b82f6';
  document.body.appendChild(el);
  const rgb = (getComputedStyle(el).color.match(/\d+(\.\d+)?/g) || [59, 130, 246]).slice(0, 3).map(Number);
  el.remove();
  colorMemo.set(css, rgb);
  return rgb;
}
function textColorFor(css) {
  const [r, g, b] = rgbOf(css);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#1f2328' : '#ffffff';
}
const toHex = css => '#' + rgbOf(css).map(x => pad(Math.round(x).toString(16))).join('');
const colorOf = src => src?.color || '#3b82f6';

// ---------- Événements ----------
function getEvent(file) {
  const m = parsedMemo.get(file.id);
  if (m && m.eTag === file.eTag && m.name === file.name && m.text === file.text) return m.ev;
  let ev = null;
  try { ev = md.parseEvent(file.text, file.name); } catch (e) { console.warn(file.name, e); }
  parsedMemo.set(file.id, { eTag: file.eTag, name: file.name, text: file.text, ev });
  return ev;
}

function eventsFn(info, success) {
  const rs = fmtDate(info.start), re = fmtDate(info.end);
  const out = [];
  for (const f of Object.values(cache.files)) {
    if (hidden.has(f.calId)) continue;
    const src = sourceById(f.calId);
    if (!src) continue;
    const ev = getEvent(f);
    if (!ev) continue;
    const color = colorOf(src);
    for (const o of md.occurrences(ev, rs, re)) {
      out.push({
        id: ev.type === 'recurring' ? `${f.id}|${o.date}` : f.id,
        title: ev.title,
        start: o.start, end: o.end, allDay: o.allDay,
        backgroundColor: color, borderColor: color, textColor: textColorFor(color),
        editable: ev.type === 'single',
        classNames: ev.type === 'recurring' ? ['fc-recurring'] : [],
        extendedProps: { fileId: f.id, occDate: o.date },
      });
    }
  }
  success(out);
}

function refresh() {
  if (calendar) calendar.refetchEvents();
  if (currentView === 'agenda') renderAgenda({ keepScroll: true });
}

function whenText(ev, occDate) {
  const times = ev.allDay ? 'Toute la journée' : (ev.endTime ? `${ev.startTime} – ${ev.endTime}` : ev.startTime);
  const date = occDate || ev.date;
  if (!date) return times;
  const end = ev.type === 'single' && ev.endDate && ev.endDate > ev.date ? ev.endDate : null;
  if (end) {
    return ev.allDay
      ? `Du ${fd(date, F.short)} au ${fd(end, F.shortY)}`
      : `Du ${fd(date, F.short)}, ${ev.startTime}\nau ${fd(end, F.shortY)}${ev.endTime ? ', ' + ev.endTime : ''}`;
  }
  return `${cap(fd(date, F.long))}\n${times}`;
}

function recurText(ev) {
  const letters = [...ev.daysOfWeek].sort((a, b) => (md.DAY_LETTERS.indexOf(a) + 6) % 7 - (md.DAY_LETTERS.indexOf(b) + 6) % 7);
  const names = letters.map(l => DAY_NAMES[md.DAY_LETTERS.indexOf(l)]).filter(Boolean);
  let s = 'Chaque ' + (names.length === 7 ? 'jour' : names.length > 1 ? names.slice(0, -1).join(', ') + ' et ' + names.at(-1) : names[0]);
  if (!ev.allDay) s += ` · ${ev.startTime}${ev.endTime ? ' – ' + ev.endTime : ''}`;
  const parts = [];
  if (ev.startRecur) parts.push(`du ${fd(ev.startRecur, F.dmy)}`);
  if (ev.endRecur) parts.push(`au ${fd(ev.endRecur, F.dmy)}`);
  return parts.length ? `${s}\n${cap(parts.join(' '))}` : s;
}

/** Prochaine occurrence à partir de `from` (ou la dernière si tout est passé). */
function nextOccurrence(ev, from) {
  if (ev.type !== 'recurring') return { date: ev.date, past: (ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date) < from };
  const next = md.occurrences(ev, from, md.addDays(from, 400)).find(o => o.date >= from);
  if (next) return { date: next.date, past: false };
  const endRef = ev.endRecur && ev.endRecur < from ? ev.endRecur : from;
  const last = md.occurrences(ev, md.addDays(endRef, -14), md.addDays(endRef, 1)).filter(o => o.date <= endRef).at(-1);
  return { date: last?.date || ev.startRecur || from, past: true };
}

// ---------- Synchronisation OneDrive ----------
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

async function sync({ quiet = false } = {}) {
  if (syncing || !configured() || !auth.isLoggedIn()) return;
  if (!navigator.onLine) { if (!quiet) toast('Hors ligne : affichage des données en cache'); return; }
  syncing = true;
  setBusy(true);
  try {
    const seen = new Set(), toFetch = [];
    for (const src of settings.sources) {
      let items;
      try { items = await graph.listChildren(dirPath(src)); }
      catch (e) {
        if (e.status === 404) throw new Error(`Dossier introuvable : ${dirPath(src)}`);
        throw e;
      }
      for (const it of items) {
        if (!it.file || !/\.md$/i.test(it.name)) continue;
        seen.add(it.id);
        const c = cache.files[it.id];
        if (c && c.eTag === it.eTag && c.calId === src.id) { c.name = it.name; continue; }
        toFetch.push({ it, src });
      }
    }
    for (const id of Object.keys(cache.files)) if (!seen.has(id)) delete cache.files[id];
    let done = 0;
    if (toFetch.length) setBusy(true, `Synchro 0/${toFetch.length}`);
    await pool(toFetch, 8, async ({ it, src }) => {
      const text = await graph.readItem(it);
      cache.files[it.id] = { id: it.id, name: it.name, calId: src.id, eTag: it.eTag, text };
      done++;
      if (done % 5 === 0 || done === toFetch.length) setBusy(true, `Synchro ${done}/${toFetch.length}`);
    });
    saveCache();
    lastSync = Date.now();
    LS.set('fc.lastSync', lastSync);
    refresh();
    if (!quiet) toast(toFetch.length ? `${toFetch.length} note(s) mise(s) à jour` : 'Tout est à jour');
    banner(null);
  } catch (e) {
    handleError(e);
  } finally {
    syncing = false;
    setBusy(false);
  }
}

function handleError(e) {
  console.error(e);
  if (e instanceof auth.NeedLogin) {
    if (navigator.onLine && !sessionStorage.getItem('fc.silentTried')) {
      sessionStorage.setItem('fc.silentTried', '1');
      auth.login(settings.clientId, { silent: true });
      return;
    }
    banner('Session OneDrive expirée.', 'Se reconnecter', () => auth.login(settings.clientId));
    return;
  }
  if (e.status === 412) {
    toastError('Ce fichier a été modifié ailleurs entre-temps. Synchronisation…');
    sync({ quiet: true });
    return;
  }
  if (e instanceof TypeError && !navigator.onLine) { toastError('Hors ligne : impossible d’enregistrer'); return; }
  toastError(e.message || String(e));
}

// ---------- Écriture ----------
function fieldsFromForm(f, note, oldEv) {
  const d = note?.fm?.data || {};
  const fields = {
    title: f.title,
    allDay: f.allDay,
    startTime: f.allDay ? undefined : f.startTime,
    endTime: f.allDay || !f.endTime ? undefined : f.endTime,
  };
  if (f.recurring) {
    Object.assign(fields, {
      type: 'recurring',
      daysOfWeek: f.days,
      startRecur: f.startRecur || undefined,
      endRecur: f.endRecur || undefined,
      skipDates: oldEv?.type === 'recurring' && d.skipDates !== undefined ? d.skipDates : undefined,
      completed: d.completed !== undefined ? d.completed : undefined,
    });
  } else {
    Object.assign(fields, {
      date: f.date,
      endDate: f.endDate && f.endDate > f.date ? f.endDate : undefined,
      completed: d.completed !== undefined ? d.completed : null,
      type: d.type !== undefined ? 'single' : undefined,
    });
  }
  return fields;
}

function storeItem(item, calId, text) {
  cache.files[item.id] = { id: item.id, name: item.name, calId, eTag: item.eTag, text };
  saveCache();
  refresh();
  return cache.files[item.id];
}

async function saveEvent(fileId, f) {
  const src = sourceById(f.calId);
  if (!src) throw new Error('Calendrier inconnu');
  const file = fileId ? cache.files[fileId] : null;
  const note = file ? md.splitNote(file.text) : null;
  const oldEv = file ? getEvent(file) : null;
  const fields = fieldsFromForm(f, note, oldEv);
  const text = md.buildNote(note, fields, f.body);
  const newEv = { type: f.recurring ? 'recurring' : 'single', title: f.title, date: f.date, daysOfWeek: f.days };
  const name = md.fileNameFor(newEv);

  let item;
  if (!file) {
    item = await graph.createFile(dirPath(src), name, text);
  } else {
    let eTag = file.eTag;
    const needMove = src.id !== file.calId;
    const needRename = !oldEv || md.fileNameFor(oldEv) !== name;
    if (needMove || needRename) {
      const moved = await graph.moveRename(file.id, { name: needRename ? name : undefined, folder: needMove ? dirPath(src) : undefined });
      eTag = moved.eTag;
    }
    item = await graph.writeFile(file.id, text, eTag);
  }
  return storeItem(item, src.id, text);
}

async function deleteEvent(fileId) {
  const f = { ...cache.files[fileId] };
  const src = sourceById(f.calId);
  await graph.deleteItem(fileId);
  delete cache.files[fileId];
  saveCache();
  refresh();
  toast('Événement supprimé', {
    action: {
      label: 'Annuler',
      fn: async () => {
        try {
          setBusy(true);
          const item = await graph.createFile(dirPath(src), f.name, f.text);
          storeItem(item, f.calId, f.text);
          toast('Événement restauré');
        } catch (e) { handleError(e); } finally { setBusy(false); }
      },
    },
  });
}

async function onMove(info) {
  const fileId = info.event.extendedProps.fileId;
  const file = cache.files[fileId];
  const ev = file && getEvent(file);
  if (!ev) { info.revert(); return; }
  const s = info.event.start, e = info.event.end;
  const f = {
    title: ev.title, calId: file.calId, allDay: info.event.allDay, recurring: false,
    date: fmtDate(s), endDate: null, startTime: null, endTime: null,
  };
  if (f.allDay) {
    if (e) { const last = new Date(e); last.setDate(last.getDate() - 1); f.endDate = fmtDate(last); }
  } else {
    const end = e || new Date(s.getTime() + 3600e3);
    f.startTime = fmtTime(s);
    f.endTime = fmtTime(end);
    const endDay = fmtDate(end);
    const overnight = endDay === md.addDays(f.date, 1) && f.endTime <= f.startTime;
    if (endDay !== f.date && !overnight) f.endDate = endDay;
  }
  const old = {
    title: ev.title, calId: file.calId, allDay: ev.allDay, recurring: false, date: ev.date,
    endDate: ev.endDate, startTime: ev.allDay ? null : ev.startTime, endTime: ev.allDay ? null : ev.endTime,
  };
  const label = x => `${cap(fd(x.date, F.short))}${x.allDay ? ' · journée' : ' · ' + x.startTime + (x.endTime ? '–' + x.endTime : '')}`
    + (x.endDate && x.endDate > x.date ? ` → ${fd(x.endDate, F.short)}` : '');
  const ok = await askConfirm(info.oldEvent && +info.oldEvent.start !== +info.event.start ? 'Déplacer l’événement ?' : 'Modifier la durée ?',
    `« ${ev.title} »\n${label(old)}\n↓\n${label(f)}`, 'Confirmer');
  if (!ok) { info.revert(); return; }
  try {
    setBusy(true);
    const saved = await saveEvent(fileId, f);
    toast(`Déplacé : ${label(f)}`, {
      action: {
        label: 'Annuler',
        fn: async () => {
          try { setBusy(true); await saveEvent(saved.id, old); toast('Déplacement annulé'); }
          catch (err) { handleError(err); } finally { setBusy(false); }
        },
      },
    });
  } catch (err) {
    info.revert();
    handleError(err);
  } finally { setBusy(false); }
}

// ---------- Confirmation ----------
function askConfirm(title, msg, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const d = $('#dlgConfirm');
    $('#cfTitle').textContent = title;
    $('#cfMsg').textContent = msg;
    const yes = $('#cfYes');
    yes.textContent = okLabel;
    yes.className = danger ? 'primary danger-fill' : 'primary';
    let done = false;
    const onClose = () => finish(false);
    const finish = v => {
      if (done) return;
      done = true;
      d.removeEventListener('close', onClose);
      closeDlg(d);
      resolve(v);
    };
    yes.onclick = () => finish(true);
    $('#cfNo').onclick = () => finish(false);
    d.addEventListener('close', onClose);
    openDlg(d);
  });
}

// ---------- Agenda (liste à défilement infini) ----------
const agenda = { start: null, end: null, busy: false, bounds: null };
const AG_CHUNK = 60;
let agObserver = null;

function agendaBounds() {
  let min = '9999-12-31', max = '0000-01-01', endless = false;
  for (const f of Object.values(cache.files)) {
    if (hidden.has(f.calId) || !sourceById(f.calId)) continue;
    const ev = getEvent(f);
    if (!ev) continue;
    if (ev.type === 'recurring') {
      const a = ev.startRecur || '0000-01-01';
      if (a < min) min = a;
      if (ev.endRecur) { if (ev.endRecur > max) max = ev.endRecur; } else endless = true;
    } else {
      if (ev.date < min) min = ev.date;
      const b = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
      if (b > max) max = b;
    }
  }
  return { min, max: endless ? null : max };
}

function collectOccurrences(rs, re) {
  const out = [];
  for (const f of Object.values(cache.files)) {
    if (hidden.has(f.calId)) continue;
    const src = sourceById(f.calId);
    if (!src) continue;
    const ev = getEvent(f);
    if (!ev) continue;
    for (const o of md.occurrences(ev, rs, re)) {
      const lastDay = o.allDay && o.end ? md.addDays(o.end, -1) : o.date;
      for (let d = o.date < rs ? rs : o.date; d <= lastDay && d < re; d = md.addDays(d, 1)) {
        out.push({ fileId: f.id, ev, src, date: d, occDate: o.date, lastDay, multi: lastDay !== o.date });
      }
    }
  }
  return out;
}

function agItem(it) {
  const { ev } = it;
  const color = colorOf(it.src);
  let time = ev.allDay ? 'Toute la journée' : (ev.endTime ? `${ev.startTime} – ${ev.endTime}` : ev.startTime);
  if (it.multi && it.date !== it.occDate) {
    const n = Math.round((toDate(it.lastDay) - toDate(it.occDate)) / 864e5) + 1;
    const k = Math.round((toDate(it.date) - toDate(it.occDate)) / 864e5) + 1;
    return `<button class="ag-ev cont" data-id="${esc(it.fileId)}" data-date="${it.occDate}" style="--c:${esc(color)};--t:${textColorFor(color)}">
      <span class="ag-title">${esc(ev.title)}</span><span class="ag-time">jour ${k}/${n}</span></button>`;
  }
  if (it.multi) time += ` · jusqu’au ${fd(it.lastDay, F.dm)}`;
  return `<button class="ag-ev" data-id="${esc(it.fileId)}" data-date="${it.occDate}" style="--c:${esc(color)};--t:${textColorFor(color)}">
    <span class="ag-title">${ev.type === 'recurring' ? '<span class="rec">↻</span>' : ''}${esc(ev.title)}</span>
    <span class="ag-time">${esc(time)}</span></button>`;
}

function renderAgenda({ keepScroll = false } = {}) {
  const box = $('#agenda');
  if (!agenda.start) return;
  // Point d'ancrage : le jour affiché en haut, pour ne pas « sauter » quand du contenu change au-dessus.
  let anchor = null;
  if (keepScroll) {
    const top = [...box.querySelectorAll('.ag-day')].find(el => el.offsetTop + el.offsetHeight > box.scrollTop + 4);
    if (top) anchor = { date: top.dataset.date, delta: top.offsetTop - box.scrollTop };
  }
  agenda.bounds = agendaBounds();
  const today = todayStr();
  const byDay = new Map();
  for (const it of collectOccurrences(agenda.start, agenda.end)) {
    if (!byDay.has(it.date)) byDay.set(it.date, []);
    byDay.get(it.date).push(it);
  }
  if (today >= agenda.start && today < agenda.end && !byDay.has(today)) byDay.set(today, []);
  const days = [...byDay.keys()].sort();
  const atStart = agenda.start <= agenda.bounds.min;
  const atEnd = agenda.bounds.max !== null && agenda.end > agenda.bounds.max;
  let html = `<div class="ag-sentinel" id="agTop">${atStart ? '' : '<span class="ag-more">…</span>'}</div>`;
  let curMonth = '';
  for (const d of days) {
    const m = d.slice(0, 7);
    if (m !== curMonth) { curMonth = m; html += `<h3 class="ag-month" data-date="${m}-01">${esc(cap(F.monthY.format(toDate(d))))}</h3>`; }
    const list = byDay.get(d).sort((a, b) =>
      (b.ev.allDay - a.ev.allDay) || (a.ev.startTime || '').localeCompare(b.ev.startTime || '') || a.ev.title.localeCompare(b.ev.title));
    const rel = d === today ? 'Aujourd’hui' : d === md.addDays(today, 1) ? 'Demain' : d === md.addDays(today, -1) ? 'Hier' : '';
    html += `<section class="ag-day${d === today ? ' today' : ''}${d < today ? ' past' : ''}" data-date="${d}">
      <div class="ag-date"><b>${+d.slice(8)}</b><small>${esc(fd(d, F.wd).replace('.', ''))}</small></div>
      <div class="ag-events">${rel ? `<div class="ag-rel">${rel}</div>` : ''}${list.length ? list.map(agItem).join('') : '<div class="ag-empty">Rien de prévu</div>'}</div>
    </section>`;
  }
  html += `<div class="ag-sentinel" id="agBottom">${atEnd ? '<div class="ag-end">Fin de l’agenda</div>' : '<span class="ag-more">…</span>'}</div>`;
  box.innerHTML = html;
  if (anchor) {
    const el = [...box.querySelectorAll('.ag-day')].find(x => x.dataset.date >= anchor.date);
    if (el) box.scrollTop = el.offsetTop - anchor.delta;
  }
  agObserver?.disconnect();
  agObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      if (en.target.id === 'agBottom' && !atEnd) extendAgenda('down');
      if (en.target.id === 'agTop' && !atStart) extendAgenda('up');
    }
  }, { root: box, rootMargin: '700px 0px' });
  agObserver.observe($('#agTop'));
  agObserver.observe($('#agBottom'));
  updateAgendaTitle();
}

function extendAgenda(dir) {
  if (agenda.busy) return;
  agenda.busy = true;
  requestAnimationFrame(() => {
    const box = $('#agenda');
    if (dir === 'down') {
      agenda.end = md.addDays(agenda.end, AG_CHUNK);
      renderAgenda({ keepScroll: true });
    } else {
      const oldH = box.scrollHeight, oldTop = box.scrollTop;
      agenda.start = md.addDays(agenda.start, -AG_CHUNK);
      renderAgenda();
      box.scrollTop = oldTop + (box.scrollHeight - oldH);
    }
    agenda.busy = false;
  });
}

function agendaTopDate() {
  const box = $('#agenda');
  for (const el of box.querySelectorAll('.ag-day')) {
    if (el.offsetTop + el.offsetHeight > box.scrollTop + 4) return el.dataset.date;
  }
  return todayStr();
}

function updateAgendaTitle() {
  if (currentView !== 'agenda') return;
  $('#hdrTitleText').textContent = F.monthY.format(toDate(agendaTopDate()));
}

function scrollToDate(date, smooth = false) {
  const box = $('#agenda');
  if (!agenda.start || date < agenda.start || date >= agenda.end) {
    agenda.start = md.addDays(date, -30);
    agenda.end = md.addDays(date, 90);
    renderAgenda();
  }
  const target = [...box.querySelectorAll('.ag-day, .ag-month')].find(el => el.dataset.date >= date && el.classList.contains('ag-day'))
    || box.querySelector('#agBottom');
  // Un en-tête de mois juste au-dessus du jour visé reste visible
  const prev = target.previousElementSibling;
  const el = prev && prev.classList.contains('ag-month') ? prev : target;
  box.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: smooth ? 'smooth' : 'auto' });
  updateAgendaTitle();
}

function agendaJump(delta) {
  const d = toDate(agendaTopDate());
  const t = new Date(d.getFullYear(), d.getMonth() + delta, 1, 12);
  scrollToDate(fmtDate(t), true);
}

// ---------- Changement de vue ----------
function setView(v) {
  v = normView(v) || 'agenda';
  currentView = v;
  LS.set('fc.view', v);
  setActiveView(v);
  const isAg = v === 'agenda';
  $('#agenda').hidden = !isAg;
  $('#cal').hidden = isAg;
  if (isAg) {
    if (!agenda.start) scrollToDate(todayStr());
    else renderAgenda({ keepScroll: true });
  } else {
    if (calendar.view.type !== v) calendar.changeView(v);
    calendar.updateSize();
    $('#hdrTitleText').textContent = calendar.view.title;
  }
}

function gotoDay(date) {
  setView('timeGridDay');
  calendar.gotoDate(date);
}

const nav = {
  prev: () => (currentView === 'agenda' ? agendaJump(-1) : calendar.prev()),
  next: () => (currentView === 'agenda' ? agendaJump(1) : calendar.next()),
  today: () => (currentView === 'agenda' ? scrollToDate(todayStr(), true) : calendar.today()),
};

// ---------- Fiche événement ----------
let detail = null; // { fileId, occDate }

function bodyLineOffset(text, body) {
  return text.slice(0, text.length - body.length).split('\n').length - 1;
}

function renderDetail() {
  const file = cache.files[detail.fileId];
  if (!file) { closeDlg($('#dlgDetail')); return; }
  const ev = getEvent(file);
  const src = sourceById(file.calId);
  const dlg = $('#dlgDetail');
  dlg.style.setProperty('--ev-color', colorOf(src));
  $('#dtCal').textContent = src?.name || '';
  $('#dtTitle').textContent = ev?.title || file.name;
  $('#dtWhen').textContent = ev ? whenText(ev, detail.occDate) : '';
  const rec = ev?.type === 'recurring';
  $('#dtRecurRow').hidden = !rec;
  if (rec) $('#dtRecur').textContent = recurText(ev);
  const body = ev?.note?.body || '';
  $('#dtBody').innerHTML = body.trim() ? renderMarkdown(body, bodyLineOffset(file.text, body)) : '';
  const vault = settings.vaultPath.split('/').filter(Boolean).pop() || '';
  const path = graph.joinPath(src?.directory || '', file.name.replace(/\.md$/i, ''));
  $('#dtObsidian').href = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
  $('#dtGoto').hidden = !(detail.occDate || ev?.date);
}

function openDetail(fileId, occDate, { from } = {}) {
  if (!cache.files[fileId]) return;
  detail = { fileId, occDate };
  renderDetail();
  const d = $('#dlgDetail');
  if (from) swapDlg(from, d); else openDlg(d);
}

async function onTaskToggle(e) {
  const cb = e.target.closest('input[type=checkbox][data-line]');
  if (!cb) return;
  const file = cache.files[detail.fileId];
  const text = toggleTask(file.text, +cb.dataset.line);
  cb.disabled = true;
  try {
    const item = await graph.writeFile(file.id, text, file.eTag);
    storeItem(item, file.calId, text);
    renderDetail();
  } catch (err) {
    cb.checked = !cb.checked;
    handleError(err);
  } finally { cb.disabled = false; }
}

// ---------- Éditeur ----------
const DAY_UI = [['M', 'L'], ['T', 'M'], ['W', 'M'], ['R', 'J'], ['F', 'V'], ['S', 'S'], ['U', 'D']];
let editing = null; // { fileId, bodyShown, touchedWhen, quick }

function buildDayChips() {
  const box = $('#evDays');
  box.innerHTML = '';
  for (const [letter, label] of DAY_UI) {
    const l = document.createElement('label');
    l.className = 'chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = letter;
    l.append(cb, document.createTextNode(label));
    box.appendChild(l);
  }
}

function fillCalendarSelect(sel, value) {
  sel.innerHTML = '';
  for (const s of settings.sources) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  const def = settings.defaultCalId && sourceById(settings.defaultCalId) ? settings.defaultCalId : settings.sources[0]?.id;
  sel.value = value && sourceById(value) ? value : def;
  updateCalColor();
}
function updateCalColor() {
  $('#evCal').closest('.cal-field').style.setProperty('--cal-color', colorOf(sourceById($('#evCal').value)));
}

function updateEditorVisibility() {
  const allDay = $('#evAllDay').checked, rec = $('#evRecurring').checked;
  $('#rowTimes').hidden = allDay;
  $('#rowSingle').hidden = rec;
  $('#rowRecur').hidden = !rec;
}

/**
 * @param {string|null} fileId  note à modifier (null = création)
 * @param {object} preset       { date, time, allDay, copyFrom }
 */
function openEditor(fileId, preset = {}, { from } = {}) {
  if (!configured()) { openSettings(); return; }
  $('#evForm').reset();
  const file = fileId ? cache.files[fileId] : null;
  const srcFile = file || (preset.copyFrom ? cache.files[preset.copyFrom] : null);
  const ev = srcFile ? getEvent(srcFile) : null;
  editing = { fileId: file ? fileId : null, touchedWhen: !!srcFile, quick: null };

  $('#evTitleHead').textContent = file ? 'Modifier' : preset.copyFrom ? 'Dupliquer' : 'Nouvel événement';
  fillCalendarSelect($('#evCal'), srcFile?.calId);
  $('#evTitle').value = ev?.title || '';
  $('#evAllDay').checked = ev ? ev.allDay : !!preset.allDay;
  $('#evRecurring').checked = ev?.type === 'recurring';
  const date = (preset.copyFrom ? null : ev?.date) || preset.date || ev?.date || todayStr();
  $('#evDate').value = date;
  $('#evEndDate').value = ev?.endDate && ev.endDate > (ev.date || date) && !preset.copyFrom ? ev.endDate : '';
  const start = ev?.startTime || preset.time || '09:00';
  $('#evStart').value = start;
  $('#evEnd').value = ev ? (ev.endTime || '') : addMinutes(start, 60);
  $('#evStartRecur').value = ev?.startRecur || date;
  $('#evEndRecur').value = ev?.endRecur || '';
  const days = new Set(ev?.daysOfWeek?.length ? ev.daysOfWeek : [md.DAY_LETTERS[toDate(date).getDay()]]);
  for (const cb of $('#evDays').querySelectorAll('input')) cb.checked = days.has(cb.value);
  const bodyShown = srcFile ? (ev?.note?.body ?? '').replace(/^\s*\n/, '') : '';
  editing.bodyShown = file ? bodyShown : null; // copie : le corps est toujours écrit
  $('#evBody').value = bodyShown;
  $('#evWarn').hidden = !ev?.unsupported;
  $('#quickHint').hidden = true;

  updateEditorVisibility();
  const d = $('#dlgEvent');
  if (from) swapDlg(from, d); else openDlg(d);
  if (!file) setTimeout(() => $('#evTitle').focus(), 80);
}

function onTitleInput() {
  if (editing.fileId) return;
  const q = parseQuick($('#evTitle').value, todayStr());
  editing.quick = q.matched && q.title ? q : null;
  const hint = $('#quickHint');
  if (!editing.quick) { hint.hidden = true; return; }
  const parts = [];
  if (q.date) parts.push(cap(fd(q.date, F.short)));
  if (q.startTime) parts.push(q.endTime ? `${q.startTime} – ${q.endTime}` : q.startTime);
  hint.querySelector('span').textContent = `« ${q.title} » · ${parts.join(' · ')}`;
  hint.hidden = false;
}

function applyQuick() {
  const q = editing.quick;
  if (!q) return;
  $('#evTitle').value = q.title;
  if (q.date) { $('#evDate').value = q.date; $('#evStartRecur').value = q.date; }
  if (q.startTime) {
    $('#evAllDay').checked = false;
    $('#evStart').value = q.startTime;
    $('#evEnd').value = q.endTime || addMinutes(q.startTime, 60);
  } else if (q.date) {
    $('#evAllDay').checked = true;
  }
  $('#evRecurring').checked = false;
  editing.quick = null;
  editing.touchedWhen = true;
  $('#quickHint').hidden = true;
  updateEditorVisibility();
}

function readEditor() {
  if (editing.quick && !editing.touchedWhen) applyQuick();
  const f = {
    title: $('#evTitle').value.trim(),
    calId: $('#evCal').value,
    allDay: $('#evAllDay').checked,
    recurring: $('#evRecurring').checked,
    date: $('#evDate').value,
    endDate: $('#evEndDate').value || null,
    startTime: $('#evStart').value || null,
    endTime: $('#evEnd').value || null,
    startRecur: $('#evStartRecur').value || null,
    endRecur: $('#evEndRecur').value || null,
    days: [...$('#evDays').querySelectorAll('input:checked')].map(cb => cb.value),
  };
  const bodyVal = $('#evBody').value;
  if (editing.bodyShown === null || bodyVal !== editing.bodyShown) {
    f.body = bodyVal.trim() ? '\n' + bodyVal.replace(/\s+$/, '') + '\n' : '';
  }
  if (!f.title) throw new Error('Le titre est obligatoire');
  if (f.recurring) {
    if (!f.days.length) throw new Error('Choisis au moins un jour');
    if (!f.startRecur) f.startRecur = todayStr();
    f.days.sort((a, b) => md.DAY_LETTERS.indexOf(a) - md.DAY_LETTERS.indexOf(b));
  } else if (!f.date) throw new Error('La date est obligatoire');
  if (!f.allDay && !f.startTime) throw new Error("L'heure de début est obligatoire");
  return f;
}

async function onSaveEditor(e) {
  e.preventDefault();
  let f;
  try { f = readEditor(); } catch (err) { toastError(err.message); return; }
  const btn = $('#evSave');
  btn.disabled = true;
  setBusy(true);
  try {
    const wasNew = !editing.fileId;
    const saved = await saveEvent(editing.fileId, f);
    closeDlg($('#dlgEvent'));
    toast(wasNew ? `Créé : ${f.recurring ? 'récurrent' : fd(f.date, F.short)}` : 'Enregistré');
    if (wasNew && !f.recurring) { if (currentView === 'agenda') scrollToDate(f.date, true); else calendar.gotoDate(f.date); }
    if (!wasNew && detail?.fileId === editing.fileId && saved) detail.fileId = saved.id;
  } catch (err) { handleError(err); }
  finally { btn.disabled = false; setBusy(false); }
}

// ---------- Recherche ----------
const fold = s => [...String(s || '')].map(c => {
  const f = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return f.length === c.length ? f : c.toLowerCase();
}).join('');

function highlight(text, toks) {
  if (!toks.length) return esc(text);
  const f = fold(text);
  const marks = new Array(text.length).fill(false);
  for (const t of toks) {
    let i = f.indexOf(t);
    while (i >= 0) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = f.indexOf(t, i + t.length); }
  }
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(text[i]);
  }
  return out + (open ? '</mark>' : '');
}

const cleanBody = b => (b || '')
  .replace(/^\s*[-*+]\s+\[[xX]\]\s*/gm, '☑ ').replace(/^\s*[-*+]\s+\[ \]\s*/gm, '☐ ')
  .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/[#*_`>]|==|~~/g, '')
  .replace(/\s+/g, ' ').trim();

let searchIndex = null;
function getIndex() {
  if (searchIndex) return searchIndex;
  searchIndex = Object.values(cache.files).map(f => {
    const src = sourceById(f.calId);
    const ev = src && getEvent(f);
    if (!ev) return null;
    const body = cleanBody(ev.note?.body);
    return { f, src, ev, body, hayTitle: fold(ev.title), hay: fold(`${ev.title}\n${body}\n${src.name}`) };
  }).filter(Boolean);
  return searchIndex;
}

function runSearch() {
  const q = $('#searchInput').value;
  const toks = fold(q).split(/\s+/).filter(Boolean);
  const today = todayStr();
  let items = getIndex();
  if (toks.length) items = items.filter(it => toks.every(t => it.hay.includes(t)));
  else items = items.filter(it => !hidden.has(it.f.calId));
  const withOcc = items.map(it => ({ ...it, occ: nextOccurrence(it.ev, today) }));
  const key = it => `${it.occ.date}T${it.ev.allDay ? '00:00' : it.ev.startTime}`;
  let upcoming = withOcc.filter(it => !it.occ.past).sort((a, b) => key(a).localeCompare(key(b)) || (b.hayTitle.includes(toks[0] || '') - a.hayTitle.includes(toks[0] || '')));
  let past = toks.length ? withOcc.filter(it => it.occ.past).sort((a, b) => key(b).localeCompare(key(a))) : [];
  if (!toks.length) upcoming = upcoming.slice(0, 40);

  const box = $('#searchResults');
  if (!upcoming.length && !past.length) {
    box.innerHTML = `<div class="s-empty">${toks.length ? 'Aucun résultat' : 'Aucun événement à venir'}</div>`;
    return;
  }
  const curYear = today.slice(0, 4);
  const item = it => {
    const { ev, src, occ } = it;
    const day = +occ.date.slice(8, 10);
    const mon = fd(occ.date, F.mon).replace('.', '') + (occ.date.slice(0, 4) !== curYear ? ` ${occ.date.slice(2, 4)}` : '');
    const sub = [cap(fd(occ.date, F.wd).replace('.', '')), ev.allDay ? 'Journée' : ev.startTime, src.name, ev.type === 'recurring' ? '↻' : ''].filter(Boolean).join(' · ');
    let snip = '';
    if (it.body) {
      const fb = fold(it.body);
      const hit = toks.map(t => fb.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0];
      if (hit !== undefined || !toks.length) {
        const a = Math.max(0, (hit ?? 0) - 30);
        snip = (a > 0 ? '…' : '') + it.body.slice(a, a + 140);
      }
    }
    return `<button class="result${occ.past ? ' past' : ''}" data-id="${esc(it.f.id)}" data-date="${occ.date}" style="--c:${esc(colorOf(src))}">
      <span class="r-date"><b>${day}</b><small>${esc(mon)}</small></span>
      <span class="r-main"><span class="r-title">${highlight(ev.title, toks)}</span>
      <span class="r-sub">${esc(sub)}</span>${snip ? `<span class="r-snip">${highlight(snip, toks)}</span>` : ''}</span>
    </button>`;
  };
  const LIMIT = 80;
  let html = '';
  if (upcoming.length) {
    html += `<div class="s-group">${toks.length ? 'À venir' : 'Prochains événements'} · ${upcoming.length}</div>` + upcoming.slice(0, LIMIT).map(item).join('');
    if (upcoming.length > LIMIT) html += `<div class="s-more">… et ${upcoming.length - LIMIT} autres</div>`;
  }
  if (past.length) {
    html += `<div class="s-group">Passés · ${past.length}</div>` + past.slice(0, LIMIT).map(item).join('');
    if (past.length > LIMIT) html += `<div class="s-more">… et ${past.length - LIMIT} autres</div>`;
  }
  box.innerHTML = html;
}

function openSearch() {
  searchIndex = null;
  const d = $('#dlgSearch');
  openDlg(d);
  runSearch();
  setTimeout(() => $('#searchInput').focus(), 60);
}

// ---------- Menu calendriers ----------
function updateMenuDot() { $('#menuDot').hidden = !settings.sources.some(s => hidden.has(s.id)); }

function renderMenu() {
  const counts = {};
  for (const f of Object.values(cache.files)) counts[f.calId] = (counts[f.calId] || 0) + 1;
  const box = $('#menuCals');
  box.innerHTML = '';
  for (const s of settings.sources) {
    const row = document.createElement('label');
    row.className = 'cal-row';
    row.style.setProperty('--c', colorOf(s));
    row.innerHTML = `<span class="swatch"></span><span class="name"></span><span class="count">${counts[s.id] || 0}</span>
      <span class="switch"><input type="checkbox" role="switch"><span class="track"></span></span>`;
    row.querySelector('.name').textContent = s.name;
    const cb = row.querySelector('input');
    cb.checked = !hidden.has(s.id);
    cb.onchange = () => {
      cb.checked ? hidden.delete(s.id) : hidden.add(s.id);
      LS.set('fc.hidden', [...hidden]);
      updateMenuDot();
      refresh();
    };
    box.appendChild(row);
  }
  const ago = lastSync ? Math.round((Date.now() - lastSync) / 60000) : null;
  $('#menuSync').textContent = `${Object.keys(cache.files).length} notes en cache · ` +
    (ago === null ? 'jamais synchronisé' : ago < 1 ? "synchronisé à l'instant" : `synchronisé il y a ${ago < 60 ? ago + ' min' : Math.round(ago / 60) + ' h'}`) +
    (navigator.onLine ? '' : ' · hors ligne');
}

// ---------- Réglages ----------
function renderSources() {
  const box = $('#setSources');
  box.innerHTML = '';
  settings.sources.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'src-row';
    row.innerHTML = `
      <input type="color" class="src-color" aria-label="Couleur">
      <div class="src-fields">
        <input class="src-name" placeholder="Nom" aria-label="Nom">
        <input class="src-dir" placeholder="Dossier dans le coffre (ex. Calendrier/General)" aria-label="Dossier">
      </div>
      <button type="button" class="ib src-del" aria-label="Retirer"><svg><use href="#i-trash"/></svg></button>`;
    const color = row.querySelector('.src-color');
    color.value = toHex(s.color);
    color.oninput = () => { s.color = color.value; };
    const name = row.querySelector('.src-name');
    name.value = s.name;
    name.oninput = () => { s.name = name.value; };
    const dir = row.querySelector('.src-dir');
    dir.value = s.directory;
    dir.oninput = () => { s.directory = dir.value; };
    row.querySelector('.src-del').onclick = () => { settings.sources.splice(i, 1); renderSources(); };
    box.appendChild(row);
  });
}

function renderAuthState() {
  const logged = auth.isLoggedIn();
  $('#setAuthState').textContent = logged ? '✓ Connecté à OneDrive' : 'Non connecté';
  $('#setLogin').hidden = logged;
  $('#setLogout').hidden = !logged;
  $('#setVaultBox').classList.toggle('disabled', !logged);
}

function openSettings({ from } = {}) {
  $('#setClientId').value = settings.clientId;
  $('#setRedirect').textContent = auth.redirectUri();
  $('#setVault').value = settings.vaultPath;
  $('#setView').value = normView(settings.initialView) || 'agenda';
  $('#setFirstDay').value = String(settings.firstDay);
  settings.sources = settings.sources.map(s => ({ ...s }));
  renderSources();
  renderAuthState();
  const d = $('#dlgSettings');
  if (from) swapDlg(from, d); else if (!d.open) openDlg(d);
}

function readSettingsForm() {
  settings.clientId = $('#setClientId').value.trim();
  settings.vaultPath = $('#setVault').value.trim().replace(/^\/+|\/+$/g, '');
  settings.initialView = $('#setView').value;
  settings.firstDay = +$('#setFirstDay').value;
  settings.sources = settings.sources.filter(s => s.directory && s.directory.trim())
    .map((s, i) => ({ ...s, id: s.id || `cal_${Date.now()}_${i}`, name: s.name || s.directory.split('/').pop(), directory: s.directory.trim().replace(/^\/+|\/+$/g, '') }));
}

async function importPluginConfig() {
  readSettingsForm();
  if (!settings.vaultPath) throw new Error("Indique d'abord le chemin du coffre");
  const candidates = ['.obsidian/plugins/full-calendar-remastered', '.obsidian/plugins/obsidian-full-calendar',
    '.obsidian-mobile/plugins/full-calendar-remastered', '.obsidian-mobile/plugins/obsidian-full-calendar'];
  for (const dir of candidates) {
    let d;
    try { d = JSON.parse(await graph.readPath(graph.joinPath(settings.vaultPath, dir, 'data.json'))); }
    catch (e) { if (e.status === 404 || e instanceof SyntaxError) continue; throw e; }
    const srcs = (d.calendarSources || []).filter(s => s.type === 'local' && s.directory)
      .map((s, i) => ({ id: s.id || `local_${i + 1}`, name: s.name || s.directory.split('/').pop(), directory: s.directory, color: s.color || '#3b82f6' }));
    if (!srcs.length) continue;
    // On garde les calendriers ajoutés à la main qui ne sont pas dans le plugin.
    const extra = settings.sources.filter(s => s.directory && !srcs.some(x => x.directory === s.directory));
    settings.sources = [...srcs, ...extra];
    if (typeof d.firstDay === 'number') settings.firstDay = d.firstDay;
    const v = d.initialView?.mobile;
    if (normView(v)) settings.initialView = normView(v);
    settings.defaultCalId = d.defaultCalendarId || null;
    $('#setView').value = settings.initialView;
    $('#setFirstDay').value = String(settings.firstDay);
    renderSources();
    return srcs.length;
  }
  throw new Error('Aucune configuration Full Calendar trouvée dans ce coffre');
}

async function detectVaults() {
  const list = await graph.findVaults();
  const dl = $('#vaultList');
  dl.innerHTML = '';
  for (const p of list) { const o = document.createElement('option'); o.value = p; dl.appendChild(o); }
  if (list.length === 1 && !$('#setVault').value) $('#setVault').value = list[0];
  return list;
}

function wireSettings() {
  const withBusy = fn => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { handleError(e); } finally { setBusy(false); }
  };
  $('#setLogin').onclick = () => {
    readSettingsForm();
    if (!settings.clientId) { toastError("Renseigne d'abord l'ID d'application"); return; }
    saveSettings();
    auth.login(settings.clientId);
  };
  $('#setLogout').onclick = () => { auth.logout(); renderAuthState(); };
  $('#setDetect').onclick = withBusy(async () => {
    const l = await detectVaults();
    toast(l.length ? `${l.length} coffre(s) trouvé(s) — choisis dans la liste` : 'Aucun coffre trouvé, saisis le chemin à la main');
  });
  $('#setImport').onclick = withBusy(async () => {
    const n = await importPluginConfig();
    toast(`${n} calendrier(s) importé(s)`);
  });
  $('#setAddSrc').onclick = () => {
    readSettingsForm();
    settings.sources.push({ id: `cal_${Date.now()}`, name: '', directory: '', color: '#3b82f6' });
    renderSources();
  };
  $('#setClearCache').onclick = () => {
    cache = { files: {} };
    saveCache();
    parsedMemo.clear();
    refresh();
    toast('Cache vidé — appuie sur ⟳ pour tout recharger');
  };
  $('#setForm').onsubmit = e => {
    e.preventDefault();
    readSettingsForm();
    saveSettings();
    for (const [id, f] of Object.entries(cache.files)) if (!sourceById(f.calId)) delete cache.files[id];
    saveCache();
    closeDlg($('#dlgSettings'));
    if (calendar) calendar.setOption('firstDay', settings.firstDay);
    parsedMemo.clear();
    refresh();
    updateMenuDot();
    sync();
  };
  $('#setCancel').onclick = () => {
    settings = { ...DEFAULT_SETTINGS, ...LS.get('fc.settings', {}) };
    closeDlg($('#dlgSettings'));
  };
}

// ---------- Calendrier ----------
function setActiveView(type) {
  for (const b of document.querySelectorAll('#viewNav button')) b.setAttribute('aria-pressed', String(b.dataset.view === type));
}

function initCalendar() {
  const saved = LS.get('fc.view', null);
  calendar = new FullCalendar.Calendar($('#cal'), {
    locale: 'fr',
    firstDay: settings.firstDay,
    initialView: normView(saved) && normView(saved) !== 'agenda' ? normView(saved) : 'timeGridWeek',
    headerToolbar: false,
    footerToolbar: false,
    views: {
      timeGrid3Day: { type: 'timeGrid', duration: { days: 3 }, titleFormat: { day: 'numeric', month: 'short', year: 'numeric' } },
      timeGrid: { dayHeaderFormat: { weekday: 'short', day: 'numeric' }, allDayContent: '' },
      timeGridDay: { dayHeaderFormat: { weekday: 'long', day: 'numeric', month: 'long' }, titleFormat: { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' } },
      dayGridMonth: { dayMaxEvents: 4, displayEventTime: false, moreLinkText: n => `+${n}` },
    },
    height: '100%',
    nowIndicator: true,
    eventDisplay: 'block',
    editable: true,
    longPressDelay: 400,
    eventLongPressDelay: 650,
    dragScroll: true,
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    scrollTime: '07:30',
    allDayText: 'Journée',
    noEventsText: 'Rien de prévu cette semaine',
    events: eventsFn,
    eventClick: info => {
      info.jsEvent.preventDefault();
      openDetail(info.event.extendedProps.fileId, info.event.extendedProps.occDate);
    },
    dateClick: info => openEditor(null, {
      date: fmtDate(info.date),
      allDay: info.view.type === 'dayGridMonth' ? false : info.allDay,
      time: info.allDay ? null : fmtTime(info.date),
    }),
    eventDrop: onMove,
    eventResize: onMove,
    datesSet: info => {
      if (currentView === 'agenda') return;
      $('#hdrTitleText').textContent = info.view.title;
    },
  });
  calendar.render();
  setView(LS.get('fc.view', null) || settings.initialView);

  // Balayage gauche/droite pour changer de période
  const el = $('#cal');
  let x0 = null, y0 = null, t0 = 0;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 === null || document.querySelector('.fc-event-dragging, .fc-event-resizing')) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Date.now() - t0 < 600 && Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) * 0.6) {
      dx < 0 ? calendar.next() : calendar.prev();
    }
  }, { passive: true });
}

// ---------- Démarrage ----------
function wireUI() {
  for (const d of document.querySelectorAll('dialog')) wireDialog(d);
  buildDayChips();
  wireSettings();

  $('#todayNum').textContent = new Date().getDate();
  $('#hdrPrev').onclick = nav.prev;
  $('#hdrNext').onclick = nav.next;
  $('#hdrTitle').onclick = nav.today;
  $('#btnToday').onclick = nav.today;
  $('#btnSearch').onclick = openSearch;
  $('#btnSync').onclick = () => sync();
  $('#btnMenu').onclick = () => { renderMenu(); openDlg($('#dlgMenu')); };
  $('#menuSettings').onclick = () => openSettings({ from: $('#dlgMenu') });
  $('#menuSyncBtn').onclick = async () => { await sync(); renderMenu(); };
  for (const b of document.querySelectorAll('#viewNav button')) b.onclick = () => setView(b.dataset.view);

  $('#fab').onclick = () => {
    const today = todayStr();
    if (currentView === 'agenda') { openEditor(null, { date: today }); return; }
    const view = calendar?.view;
    const inView = view && today >= fmtDate(view.currentStart) && today < fmtDate(view.currentEnd);
    openEditor(null, { date: inView || !view ? today : fmtDate(view.currentStart) });
  };

  // Fiche
  $('#dtBody').addEventListener('change', onTaskToggle);
  $('#dtEdit').onclick = () => openEditor(detail.fileId, {}, { from: $('#dlgDetail') });
  $('#dtDup').onclick = () => openEditor(null, { copyFrom: detail.fileId }, { from: $('#dlgDetail') });
  $('#dtGoto').onclick = () => {
    const ev = getEvent(cache.files[detail.fileId]);
    const date = detail.occDate || ev?.date;
    closeDlg($('#dlgDetail'));
    if (date) gotoDay(date);
  };
  $('#dtDelete').onclick = async () => {
    const ev = getEvent(cache.files[detail.fileId]);
    const what = ev?.type === 'recurring' ? 'toute la série récurrente' : 'cet événement';
    if (!await askConfirm(`Supprimer ${what} ?`, `« ${ev?.title || ''} »\nLa note ira dans la corbeille OneDrive.`, 'Supprimer', true)) return;
    setBusy(true);
    try {
      await deleteEvent(detail.fileId);
      closeDlg($('#dlgDetail'));
    } catch (err) { handleError(err); } finally { setBusy(false); }
  };

  // Éditeur
  $('#evForm').onsubmit = onSaveEditor;
  $('#evCancel').onclick = () => closeDlg($('#dlgEvent'));
  $('#evAllDay').onchange = updateEditorVisibility;
  $('#evRecurring').onchange = updateEditorVisibility;
  $('#evCal').onchange = updateCalColor;
  $('#evTitle').addEventListener('input', onTitleInput);
  $('#quickApply').onclick = applyQuick;
  for (const id of ['#evDate', '#evStart', '#evEnd', '#evAllDay', '#evRecurring']) {
    $(id).addEventListener('input', () => { editing.touchedWhen = true; });
  }

  // Recherche
  let st;
  $('#searchInput').addEventListener('input', () => { clearTimeout(st); st = setTimeout(runSearch, 120); });
  $('#searchResults').addEventListener('click', e => {
    const r = e.target.closest('.result');
    if (r) openDetail(r.dataset.id, r.dataset.date, { from: $('#dlgSearch') });
  });

  // Agenda
  $('#agenda').addEventListener('click', e => {
    const b = e.target.closest('.ag-ev');
    if (b) { openDetail(b.dataset.id, b.dataset.date); return; }
    const day = e.target.closest('.ag-day');
    if (day && e.target.closest('.ag-date, .ag-empty')) openEditor(null, { date: day.dataset.date });
  });
  let agRaf = 0;
  $('#agenda').addEventListener('scroll', () => {
    if (agRaf) return;
    agRaf = requestAnimationFrame(() => { agRaf = 0; updateAgendaTitle(); });
  }, { passive: true });

  window.addEventListener('online', () => sync({ quiet: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    $('#todayNum').textContent = new Date().getDate();
    if (Date.now() - lastSync > 60e3) sync({ quiet: true });
  });
}

async function start() {
  if ('serviceWorker' in navigator) {
    // Quand une nouvelle version de l'appli s'installe, on recharge une fois pour l'utiliser.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !sessionStorage.getItem('fc.swReloaded')) {
        sessionStorage.setItem('fc.swReloaded', '1');
        location.reload();
      }
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  wireUI();
  initCalendar();
  updateMenuDot();

  let redirect = null;
  try { redirect = await auth.handleRedirect(settings.clientId); }
  catch (e) { toastError('Connexion impossible : ' + e.message); }

  if (redirect?.ok) sessionStorage.removeItem('fc.silentTried');
  if (redirect?.error) {
    if (redirect.silent) banner('Session OneDrive expirée.', 'Se reconnecter', () => auth.login(settings.clientId));
    else toastError(`Connexion refusée : ${redirect.description || redirect.error}`);
  }

  if (!configured()) {
    openSettings();
    if (redirect?.ok) {
      toast('Connecté ! Indique maintenant ton coffre Obsidian.');
      detectVaults().catch(() => {});
    }
    return;
  }
  if (!auth.isLoggedIn()) {
    banner('Pas connecté à OneDrive (affichage du cache).', 'Se connecter', () => auth.login(settings.clientId));
    return;
  }
  sync({ quiet: true });
}

start();
