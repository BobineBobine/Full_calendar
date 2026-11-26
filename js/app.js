import * as auth from './auth.js';
import * as graph from './graph.js';
import * as md from './md.js';
import { renderMarkdown, toggleTask } from './markdown.js';
import { parseQuick } from './nlp.js';
import { PALETTES, applyPalette, paletteFromObsidianCss, SNIPPET_BRIDGE } from './themes.js';
import * as assist from './assist.js';

// ---------- Stockage local ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
};

const VIEWS = ['agenda', 'timeGridDay', 'timeGrid3Day', 'timeGridWeek', 'dayGridMonth'];
const normView = v => (v === 'listWeek' || /^list/.test(v || '')) ? 'agenda' : (VIEWS.includes(v) ? v : null);
const DEFAULT_SETTINGS = { clientId: '', vaultPath: '', sources: [], firstDay: 1, initialView: 'agenda', defaultCalId: null,
  theme: 'auto', textSize: 'm', weekends: true, weekNumbers: false, slotMin: 0, slotMax: 24,
  monthLines: 2, defaultDuration: 60, dragMode: 'confirm', agendaWeeks: true, palette: 'rose', useSnippets: false, agendaEmpty: true, tabs: ['agenda', 'dayGridMonth'], assistFolder: '_IA/consignes' };

let settings = { ...DEFAULT_SETTINGS, ...LS.get('fc.settings', {}) };
let cache = LS.get('fc.cache', { files: {} }); // id -> { id, name, calId, eTag, text }
let hidden = new Set(LS.get('fc.hidden', []));
const parsedMemo = new Map();
let calendar = null;
let syncing = false;
let lastSync = LS.get('fc.lastSync', 0);
let currentView = null;
let obsPalettes = LS.get('fc.obsPalettes', {});

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
function ago(iso) {
  if (!iso) return '';
  const t = new Date(iso), diff = (Date.now() - t) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.round(diff / 3600)} h`;
  if (diff < 86400 * 7) return `il y a ${Math.round(diff / 86400)} j`;
  return `le ${t.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}`;
}
const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const toMin = t => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
/** Durée en minutes entre deux heures (passage de minuit compris), 0 si inconnue. */
const timeDiff = (a, b) => (a && b ? ((toMin(b) - toMin(a)) + 1440) % 1440 : 0);
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
        editable: ev.type === 'single' && settings.dragMode !== 'off',
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
        if (c && c.eTag === it.eTag && c.calId === src.id) {
          c.name = it.name; c.created = it.createdDateTime; c.modified = it.lastModifiedDateTime;
          continue;
        }
        toFetch.push({ it, src });
      }
    }
    for (const id of Object.keys(cache.files)) if (!seen.has(id)) delete cache.files[id];
    let done = 0;
    if (toFetch.length) setBusy(true, `Synchro 0/${toFetch.length}`);
    await pool(toFetch, 8, async ({ it, src }) => {
      const text = await graph.readItem(it);
      cache.files[it.id] = { id: it.id, name: it.name, calId: src.id, eTag: it.eTag, text, created: it.createdDateTime, modified: it.lastModifiedDateTime };
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
  const prev = cache.files[item.id];
  cache.files[item.id] = {
    id: item.id, name: item.name, calId, eTag: item.eTag, text,
    created: item.createdDateTime || prev?.created, modified: item.lastModifiedDateTime || new Date().toISOString(),
  };
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
  const ok = settings.dragMode === 'direct' || await askConfirm(info.oldEvent && +info.oldEvent.start !== +info.event.start ? 'Déplacer l’événement ?' : 'Modifier la durée ?',
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

function weekStart(d) {
  const wd = toDate(d).getDay();
  return md.addDays(d, -((wd - settings.firstDay + 7) % 7));
}

/** Mini-calendrier : mois en haut, semaines du mois en lignes, la semaine courante en surbrillance. */
function miniCal(ws) {
  // On rattache la semaine au mois de son jeudi (ou de son 4e jour), comme la norme ISO.
  const ref = toDate(md.addDays(ws, 3));
  const y = ref.getFullYear(), m = ref.getMonth();
  const first = new Date(y, m, 1, 12), dim = new Date(y, m + 1, 0).getDate();
  const offset = (first.getDay() - settings.firstDay + 7) % 7;
  const rows = Math.ceil((dim + offset) / 7);
  const row = Math.floor((ref.getDate() - 1 + offset) / 7);
  const mon = F.mon.format(ref).replace('.', '').toUpperCase().slice(0, 4);
  let grid = '';
  for (let r = 0; r < rows; r++) grid += `<i${r === row ? ' class="on"' : ''}></i>`;
  return { html: `<span class="mini-cal" aria-hidden="true"><span class="mc-mon">${esc(mon)}</span><span class="mc-grid">${grid}</span></span>`, n: row + 1, monthName: IF({ month: 'long' }).format(ref) };
}

function weekDivider(ws) {
  const we = md.addDays(ws, 6);
  const mc = miniCal(ws);
  const range = ws.slice(0, 7) === we.slice(0, 7)
    ? `${+ws.slice(8)} – ${fd(we, F.dm)}`
    : `${fd(ws, F.dm)} – ${fd(we, F.dm)}`;
  const nth = mc.n === 1 ? '1re' : `${mc.n}e`;
  return `<div class="ag-week">${mc.html}<span><b>${nth} semaine de ${esc(mc.monthName)}</b> · ${esc(range)}</span></div>`;
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
  if (settings.agendaEmpty !== false) {
    // Tous les jours, même vides (on borne à la période réellement couverte par l'agenda)
    const from = agenda.start > agenda.bounds.min ? agenda.start : agenda.bounds.min;
    for (let d = from < agenda.start ? agenda.start : from; d < agenda.end; d = md.addDays(d, 1)) {
      if (agenda.bounds.max !== null && d > agenda.bounds.max && d > today) break;
      if (!byDay.has(d)) byDay.set(d, []);
    }
  }
  if (today >= agenda.start && today < agenda.end && !byDay.has(today)) byDay.set(today, []);
  const days = [...byDay.keys()].sort();
  const atStart = agenda.start <= agenda.bounds.min;
  const atEnd = agenda.bounds.max !== null && agenda.end > agenda.bounds.max;
  let html = `<div class="ag-sentinel" id="agTop">${atStart ? '' : '<span class="ag-more">…</span>'}</div>`;
  let curMonth = '', curWeek = '';
  for (const d of days) {
    const m = d.slice(0, 7);
    if (m !== curMonth) { curMonth = m; html += `<h3 class="ag-month" data-date="${m}-01">${esc(cap(F.monthY.format(toDate(d))))}</h3>`; }
    if (settings.agendaWeeks !== false) {
      const ws = weekStart(d);
      if (ws !== curWeek) { curWeek = ws; html += weekDivider(ws); }
    }
    const list = byDay.get(d).sort((a, b) =>
      (b.ev.allDay - a.ev.allDay) || (a.ev.startTime || '').localeCompare(b.ev.startTime || '') || a.ev.title.localeCompare(b.ev.title));
    const rel = d === today ? 'Aujourd’hui' : d === md.addDays(today, 1) ? 'Demain' : d === md.addDays(today, -1) ? 'Hier' : '';
    const wd = toDate(d).getDay();
    html += `<section class="ag-day${d === today ? ' today' : ''}${d < today ? ' past' : ''}${list.length ? '' : ' empty'}${wd === 0 || wd === 6 ? ' we' : ''}" data-date="${d}">
      <div class="ag-date"><b>${+d.slice(8)}</b><span class="ag-wd"><small>${esc(fd(d, F.wd).replace('.', ''))}</small><button type="button" class="ag-add" aria-label="Ajouter un événement le ${esc(fd(d, F.short))}">+</button></span></div>
      <div class="ag-events">${rel ? `<div class="ag-rel">${rel}</div>` : ''}${list.length ? list.map(agItem).join('') : '<div class="ag-empty"></div>'}</div>
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
  // Les en-têtes (mois, semaine) juste au-dessus du jour visé restent visibles
  let el = target;
  while (el.previousElementSibling && /ag-(month|week)/.test(el.previousElementSibling.className)) el = el.previousElementSibling;
  const top = Math.max(0, el.offsetTop - 4);
  box.scrollTo({ top, behavior: smooth && Math.abs(top - box.scrollTop) < 2500 ? 'smooth' : 'auto' });
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
  today: () => {
    if (currentView === 'agenda') scrollToDate(todayStr(), true); else calendar.today();
    flashToday();
  },
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
  const info = [];
  if (file.created) info.push(`Ajouté ${ago(file.created)}`);
  if (file.modified && (!file.created || Math.abs(new Date(file.modified) - new Date(file.created)) > 60e3)) info.push(`modifié ${ago(file.modified)}`);
  $('#dtInfo').textContent = info.join(' · ');
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

// ---------- Historique des versions ----------
async function openHistory() {
  const fileId = detail.fileId;
  const file = cache.files[fileId];
  const box = $('#histList');
  box.innerHTML = '<div class="s-empty">Chargement de l’historique…</div>';
  swapDlg($('#dlgDetail'), $('#dlgHistory'));
  try {
    const versions = await graph.listVersions(fileId);
    if (versions.length <= 1) { box.innerHTML = '<div class="s-empty">Aucune version précédente pour cette note.</div>'; return; }
    box.innerHTML = '';
    const sig = ev => ev ? `${ev.title}|${ev.type === 'recurring' ? ev.daysOfWeek.join() : ev.date}|${ev.endDate || ''}|${ev.allDay}|${ev.startTime || ''}|${ev.endTime || ''}` : '';
    const curSig = sig(getEvent(file));
    for (const [i, v] of versions.entries()) {
      const row = document.createElement('div');
      row.className = 'hist-row';
      const when = new Date(v.lastModifiedDateTime);
      row.innerHTML = `<div class="hist-main"><b>${i === 0 ? 'Version actuelle' : esc(cap(when.toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })))}</b>
        <span class="hist-desc">…</span></div>`;
      box.appendChild(row);
      graph.readVersion(fileId, v.id).then(text => {
        const ev = md.parseEvent(text, file.name);
        const desc = ev ? `${ev.title} · ${ev.type === 'recurring' ? recurText(ev).split('\n')[0] : whenText(ev).replace('\n', ' · ')}` : 'Note sans événement';
        row.querySelector('.hist-desc').textContent = desc;
        if (i > 0 && sig(ev) !== curSig) {
          row.classList.add('diff');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'primary';
          btn.textContent = 'Restaurer';
          btn.onclick = async () => {
            if (!await askConfirm('Restaurer cette version ?', desc, 'Restaurer')) return;
            setBusy(true);
            try {
              const saved = await restoreText(fileId, text);
              detail.fileId = saved.id;
              toast('Version restaurée');
              closeDlg($('#dlgHistory'));
            } catch (err) { handleError(err); } finally { setBusy(false); }
          };
          row.appendChild(btn);
        }
      }).catch(() => { row.querySelector('.hist-desc').textContent = 'Contenu illisible'; });
    }
  } catch (err) {
    box.innerHTML = `<div class="s-empty">Historique indisponible : ${esc(err.message)}</div>`;
  }
}

/** Réécrit une note avec un ancien contenu, et renomme le fichier selon la date de cette version. */
async function restoreText(fileId, text) {
  const file = cache.files[fileId];
  const ev = md.parseEvent(text, file.name);
  let eTag = file.eTag;
  if (ev) {
    const name = md.fileNameFor(ev);
    if (name !== file.name) eTag = (await graph.moveRename(fileId, { name })).eTag;
  }
  const item = await graph.writeFile(fileId, text, eTag);
  return storeItem(item, file.calId, text);
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
  $('#evEnd').value = ev ? (ev.endTime || '') : addMinutes(start, +settings.defaultDuration || 60);
  $('#evStartRecur').value = ev?.startRecur || date;
  $('#evEndRecur').value = ev?.endRecur || '';
  const days = new Set(ev?.daysOfWeek?.length ? ev.daysOfWeek : [md.DAY_LETTERS[toDate(date).getDay()]]);
  for (const cb of $('#evDays').querySelectorAll('input')) cb.checked = days.has(cb.value);
  const bodyShown = srcFile ? (ev?.note?.body ?? '').replace(/^\s*\n/, '') : '';
  editing.bodyShown = file ? bodyShown : null; // copie : le corps est toujours écrit
  $('#evBody').value = bodyShown;
  $('#evWarn').hidden = !ev?.unsupported;
  editing.duration = timeDiff($('#evStart').value, $('#evEnd').value) || (+settings.defaultDuration || 60);
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
    $('#evEnd').value = q.endTime || addMinutes(q.startTime, +settings.defaultDuration || 60);
    editing.duration = timeDiff($('#evStart').value, $('#evEnd').value) || editing.duration;
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

let searchSort = 'date';
function runSearch() {
  if (searchSort !== 'date') return runRecentSearch();
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

function runRecentSearch() {
  const field = searchSort; // 'created' | 'modified'
  const toks = fold($('#searchInput').value).split(/\s+/).filter(Boolean);
  const today = todayStr();
  let items = getIndex().filter(it => it.f[field]);
  if (toks.length) items = items.filter(it => toks.every(t => it.hay.includes(t)));
  else items = items.filter(it => !hidden.has(it.f.calId));
  items.sort((a, b) => (b.f[field] || '').localeCompare(a.f[field] || ''));
  const box = $('#searchResults');
  if (!items.length) {
    box.innerHTML = `<div class="s-empty">${getIndex().some(it => it.f[field]) ? 'Aucun résultat' : 'Information disponible après la prochaine synchronisation'}</div>`;
    return;
  }
  const groups = [['Aujourd’hui', 1], ['7 derniers jours', 7], ['30 derniers jours', 30], ['Plus ancien', Infinity]];
  const curYear = today.slice(0, 4);
  let html = '', gi = -1;
  for (const it of items.slice(0, 120)) {
    const age = (Date.now() - new Date(it.f[field])) / 864e5;
    const g = groups.findIndex(([, max]) => age < max);
    if (g !== gi) { gi = g; html += `<div class="s-group">${groups[g][0]}</div>`; }
    const occ = nextOccurrence(it.ev, today);
    const mon = fd(occ.date, F.mon).replace('.', '') + (occ.date.slice(0, 4) !== curYear ? ` ${occ.date.slice(2, 4)}` : '');
    const sub = `${field === 'created' ? 'Ajouté' : 'Modifié'} ${ago(it.f[field])} · ${it.src.name}`;
    html += `<button class="result${occ.past ? ' past' : ''}" data-id="${esc(it.f.id)}" data-date="${occ.date}" style="--c:${esc(colorOf(it.src))}">
      <span class="r-date"><b>${+occ.date.slice(8, 10)}</b><small>${esc(mon)}</small></span>
      <span class="r-main"><span class="r-title">${highlight(it.ev.title, toks)}</span><span class="r-sub">${esc(sub)}</span></span></button>`;
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

// ---------- Assistant IA (consignes) ----------
// Une note par consigne dans <coffre>/<assistFolder>. L'appli ne fait que créer
// des notes ; la tâche planifiée du soir les traite et y écrit sa réponse.
let asCache = LS.get('fc.assist', { files: {} }); // id -> { id, name, eTag, text, created }
let asCtx = { lien: null, lienLabel: '', suite: null, suiteLabel: '' };
let asLoading = false;
const asDir = () => graph.joinPath(settings.vaultPath, settings.assistFolder || '_IA/consignes');
const asRel = name => graph.joinPath(settings.assistFolder || '_IA/consignes', name.replace(/\.md$/i, ''));

function asItems() {
  return Object.values(asCache.files)
    .map(f => ({ f, c: assist.parseConsigne(f.text, f.created) }))
    .filter(x => x.c)
    .sort((a, b) => String(a.c.cree).localeCompare(String(b.c.cree)));
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const day = fmtDate(d) === todayStr() ? "aujourd'hui" : IF({ weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${day} ${fmtTime(d)}`;
}

function renderAssist({ scroll = false } = {}) {
  const box = $('#asList');
  const items = asItems();
  const pending = items.filter(x => x.c.statut === 'a-traiter').length;
  const waiting = items.filter(x => x.c.statut === 'attente').length;
  $('#asState').textContent = [
    pending ? `${pending} en file` : '',
    waiting ? `${waiting} question${waiting > 1 ? 's' : ''} pour toi` : '',
  ].filter(Boolean).join(' · ') || 'Rien en attente';
  if (!items.length) {
    box.innerHTML = '<p class="as-empty">Écris une consigne ci-dessous : Claude la lira ce soir et répondra ici.</p>';
  } else {
    box.innerHTML = items.map(({ f, c }) => `
      <article class="as-item st-${esc(c.statut)}" data-id="${esc(f.id)}">
        <div class="as-me">
          ${c.suite ? `<div class="as-ref">↪ Réponse à « ${esc(c.suite.split('/').pop())} »</div>` : ''}
          ${c.lien ? `<div class="as-ref">📎 ${esc(c.lien.split('/').pop())}</div>` : ''}
          <div class="as-text">${renderMarkdown(c.ask)}</div>
          <div class="as-meta"><span class="as-badge">${esc(c.label)}</span><span>${esc(fmtWhen(c.cree))}</span>${c.source && c.source !== 'calendrier' ? `<span>· via ${esc(c.source === 'notes' ? 'Notes du jour' : c.source)}</span>` : ''}
            ${c.statut === 'attente' ? '<button type="button" class="as-act" data-act="reply">Répondre</button>' : ''}
            ${c.statut === 'a-traiter' ? '<button type="button" class="as-act" data-act="cancel">Retirer</button>' : ''}
          </div>
        </div>
        ${c.answer ? `<div class="as-ai"><div class="as-who">Claude${c.traite ? ' · ' + esc(c.traite) : ''}</div><div class="md">${renderMarkdown(c.answer)}</div></div>` : ''}
      </article>`).join('');
  }
  renderAssistCtx();
  if (scroll) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

function renderAssistCtx() {
  const parts = [];
  if (asCtx.suite) parts.push(`<span class="as-chip">↪ Réponse à « ${esc(asCtx.suiteLabel)} » <button type="button" data-clear="suite" aria-label="Retirer">×</button></span>`);
  if (asCtx.lien) parts.push(`<span class="as-chip">📎 ${esc(asCtx.lienLabel)} <button type="button" data-clear="lien" aria-label="Retirer">×</button></span>`);
  $('#asCtx').innerHTML = parts.join('');
  $('#asCtx').hidden = !parts.length;
}

function updateAsDot() {
  $('#asDot').hidden = !asItems().some(x => x.c.statut === 'attente');
}

async function loadAssist({ quiet = false } = {}) {
  if (asLoading || !settings.vaultPath || !auth.isLoggedIn()) return;
  asLoading = true;
  $('#asRefresh').classList.add('spin');
  try {
    let items = [];
    try { items = await graph.listChildren(asDir()); } catch (e) { if (e.status !== 404) throw e; }
    const md = items.filter(it => it.file && /\.md$/i.test(it.name));
    const next = {};
    await pool(md, 6, async it => {
      const old = asCache.files[it.id];
      const text = old && old.eTag === it.eTag ? old.text : await graph.readItem(it);
      next[it.id] = { id: it.id, name: it.name, eTag: it.eTag, text, created: it.createdDateTime };
    });
    asCache = { files: next };
    LS.set('fc.assist', asCache);
    if ($('#dlgAssist').open) renderAssist();
    updateAsDot();
  } catch (e) { if (!quiet) handleError(e); } finally {
    asLoading = false;
    $('#asRefresh').classList.remove('spin');
  }
}

function openAssist(ctx = {}) {
  if (!settings.vaultPath) { toastError("Indique d'abord ton coffre dans les réglages."); return; }
  if (ctx.lien) { asCtx.lien = ctx.lien; asCtx.lienLabel = ctx.lienLabel || ctx.lien.split('/').pop(); }
  const d = $('#dlgAssist');
  if (ctx.from) swapDlg(ctx.from, d); else if (!d.open) openDlg(d);
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
  const text = $('#asInput').value.trim();
  if (!text) return;
  const btn = $('#asSend');
  btn.disabled = true;
  try {
    const now = new Date();
    const note = assist.buildConsigne(text, {
      lien: asCtx.lien ? `[[${asCtx.lien}]]` : null,
      suite: asCtx.suite ? `[[${asCtx.suite}]]` : null,
      date: now,
    });
    const item = await graph.createFile(asDir(), assist.fileNameFor(text, now), note);
    asCache.files[item.id] = { id: item.id, name: item.name, eTag: item.eTag, text: note, created: item.createdDateTime || now.toISOString() };
    LS.set('fc.assist', asCache);
    $('#asInput').value = '';
    growInput();
    asCtx = { lien: null, lienLabel: '', suite: null, suiteLabel: '' };
    renderAssist({ scroll: true });
    toast('Consigne envoyée. Claude la traitera ce soir.');
  } catch (err) { handleError(err); } finally { btn.disabled = false; }
}

async function onAssistClick(e) {
  const clr = e.target.closest('[data-clear]');
  if (clr) { asCtx[clr.dataset.clear] = null; renderAssistCtx(); return; }
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
    if (!await askConfirm('Retirer cette consigne ?', 'La note ira dans la corbeille OneDrive.', 'Retirer', true)) return;
    try {
      await graph.deleteItem(f.id);
      delete asCache.files[f.id];
      LS.set('fc.assist', asCache);
      renderAssist();
    } catch (err) { handleError(err); }
  }
}

// ---------- Menu calendriers ----------
function updateMenuDot() { $('#menuDot').hidden = !settings.sources.some(s => hidden.has(s.id)); }

function renderMenu() {
  for (const b of document.querySelectorAll('#menuMode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === settings.theme));
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
  $('#setAssistFolder').value = settings.assistFolder || '_IA/consignes';
  $('#setView').value = normView(settings.initialView) || 'agenda';
  $('#setFirstDay').value = String(settings.firstDay);
  $('#setTheme').value = settings.theme;
  $('#setSnippets').checked = !!settings.useSnippets;
  renderPalettes();
  $('#setTextSize').value = settings.textSize;
  $('#setWeekends').checked = settings.weekends !== false;
  $('#setWeekNumbers').checked = !!settings.weekNumbers;
  $('#setSlotMin').value = String(settings.slotMin ?? 0);
  $('#setSlotMax').value = String(settings.slotMax ?? 24);
  $('#setMonthLines').value = String(settings.monthLines ?? 2);
  $('#setDuration').value = String(settings.defaultDuration ?? 60);
  $('#setDrag').value = settings.dragMode || 'confirm';
  $('#setAgendaWeeks').checked = settings.agendaWeeks !== false;
  $('#setAgendaEmpty').checked = settings.agendaEmpty !== false;
  const tabs = Array.isArray(settings.tabs) && settings.tabs.length ? settings.tabs : ['agenda', 'dayGridMonth'];
  for (const cb of document.querySelectorAll('#setTabs input')) cb.checked = tabs.includes(cb.value);
  settings.sources = settings.sources.map(s => ({ ...s }));
  fillDefaultCal();
  renderSources();
  renderAuthState();
  const d = $('#dlgSettings');
  if (from) swapDlg(from, d); else if (!d.open) openDlg(d);
}

function fillDefaultCal() {
  const sel = $('#setDefaultCal');
  sel.innerHTML = '<option value="">Premier de la liste</option>';
  for (const s of settings.sources) {
    if (!s.directory) continue;
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name || s.directory;
    sel.appendChild(o);
  }
  sel.value = settings.defaultCalId && sourceById(settings.defaultCalId) ? settings.defaultCalId : '';
}

function isDark() {
  return settings.theme === 'dark' || (settings.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function paletteById(id) {
  if (id && id.startsWith('obs:') && obsPalettes[id.slice(4)]) return obsPalettes[id.slice(4)];
  return PALETTES[id] || PALETTES.rose;
}

function renderPalettes() {
  const box = $('#setPalettes');
  if (!box) return;
  box.innerHTML = '';
  const v = isDark() ? 'dark' : 'light';
  const entries = [
    ...Object.entries(PALETTES).map(([id, p]) => ({ id, name: p.name, p })),
    ...Object.entries(obsPalettes).map(([n, p]) => ({ id: `obs:${n}`, name: n, p, obs: true })),
  ];
  for (const { id, name, p, obs } of entries) {
    const c = p[v];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pal' + (settings.palette === id ? ' on' : '');
    b.setAttribute('aria-pressed', String(settings.palette === id));
    b.innerHTML = `<span class="pal-prev" style="background:${esc(c.bg)};border-color:${esc(c.border)}">
        <i style="background:${esc(c.surface)}"></i><i style="background:${esc(c.accent)}"></i><i style="background:${esc(c.fg)}"></i></span>
      <span class="pal-name">${esc(name)}${obs ? '<small>Obsidian</small>' : ''}</span>`;
    b.onclick = () => { settings.palette = id; applyPrefs(); renderPalettes(); };
    box.appendChild(b);
  }
}

/** Importe les couleurs des thèmes installés dans le coffre Obsidian. */
async function importObsidianThemes() {
  if (!settings.vaultPath) throw new Error("Indique d'abord le chemin du coffre");
  const found = {};
  for (const dir of ['.obsidian/themes', '.obsidian-mobile/themes']) {
    const base = graph.joinPath(settings.vaultPath, dir);
    let folders = [];
    try { folders = (await graph.listChildren(base)).filter(i => i.folder); } catch (e) { if (e.status !== 404) throw e; }
    for (const f of folders) {
      if (found[f.name]) continue;
      setBusy(true, `Thème ${f.name}…`);
      try { found[f.name] = paletteFromObsidianCss(await graph.readPath(graph.joinPath(base, f.name, 'theme.css'))); }
      catch (e) { if (e.status !== 404) console.warn(f.name, e); }
    }
  }
  if (!Object.keys(found).length) throw new Error('Aucun thème trouvé dans .obsidian/themes');
  obsPalettes = found;
  LS.set('fc.obsPalettes', obsPalettes);
  let active = null;
  try {
    const app = JSON.parse(await graph.readPath(graph.joinPath(settings.vaultPath, '.obsidian/appearance.json')));
    if (app.cssTheme && found[app.cssTheme]) { active = app.cssTheme; settings.palette = `obs:${active}`; }
    if (app.theme === 'moonstone') settings.theme = 'light';
    else if (app.theme === 'obsidian') settings.theme = 'dark';
    else if (app.theme === 'system') settings.theme = 'auto';
    document.querySelector('#setTheme').value = settings.theme;
  } catch { /* pas d'appearance.json */ }
  applyPrefs();
  renderPalettes();
  return { n: Object.keys(found).length, active };
}

/** Récupère les extraits CSS (snippets) activés dans Obsidian. */
async function importSnippets() {
  const app = JSON.parse(await graph.readPath(graph.joinPath(settings.vaultPath, '.obsidian/appearance.json')));
  const names = app.enabledCssSnippets || [];
  let css = '';
  for (const n of names) {
    try { css += `\n/* ${n} */\n` + await graph.readPath(graph.joinPath(settings.vaultPath, '.obsidian/snippets', `${n}.css`)); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  LS.set('fc.snippetsCss', css);
  return names;
}

/** Applique les préférences d'affichage. */
function applyPrefs() {
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  const isDarkMode = isDark();
  const pal = paletteById(settings.palette);
  applyPalette(pal[isDarkMode ? 'dark' : 'light'], isDarkMode);
  colorMemo.clear();
  document.body.classList.toggle('theme-dark', isDarkMode);
  document.body.classList.toggle('theme-light', !isDarkMode);
  let snip = document.getElementById('obsSnippets');
  const css = settings.useSnippets ? LS.get('fc.snippetsCss', '') : '';
  if (css) {
    if (!snip) { snip = document.createElement('style'); snip.id = 'obsSnippets'; document.head.appendChild(snip); }
    snip.textContent = SNIPPET_BRIDGE + '\n' + css;
  } else if (snip) snip.remove();
  root.style.setProperty('--fs', { s: '14px', m: '15px', l: '17px' }[settings.textSize] || '15px');
  document.body.dataset.monthLines = String(settings.monthLines ?? 2);
  applyTabs();
  if (!calendar) return;
  const pad2 = n => `${String(n).padStart(2, '0')}:00:00`;
  calendar.batchRendering(() => {
    calendar.setOption('firstDay', settings.firstDay);
    calendar.setOption('weekends', settings.weekends !== false);
    calendar.setOption('weekNumbers', !!settings.weekNumbers);
    calendar.setOption('slotMinTime', pad2(settings.slotMin ?? 0));
    calendar.setOption('slotMaxTime', pad2(settings.slotMax ?? 24));
    calendar.setOption('editable', settings.dragMode !== 'off');
  });
}

function readSettingsForm() {
  settings.clientId = $('#setClientId').value.trim();
  settings.vaultPath = $('#setVault').value.trim().replace(/^\/+|\/+$/g, '');
  settings.assistFolder = $('#setAssistFolder').value.trim().replace(/^\/+|\/+$/g, '') || '_IA/consignes';
  settings.initialView = $('#setView').value;
  settings.firstDay = +$('#setFirstDay').value;
  settings.theme = $('#setTheme').value;
  settings.useSnippets = $('#setSnippets').checked;
  settings.textSize = $('#setTextSize').value;
  settings.weekends = $('#setWeekends').checked;
  settings.weekNumbers = $('#setWeekNumbers').checked;
  settings.slotMin = +$('#setSlotMin').value;
  settings.slotMax = Math.max(+$('#setSlotMax').value, settings.slotMin + 1);
  settings.monthLines = +$('#setMonthLines').value;
  settings.defaultDuration = +$('#setDuration').value;
  settings.dragMode = $('#setDrag').value;
  settings.agendaWeeks = $('#setAgendaWeeks').checked;
  settings.agendaEmpty = $('#setAgendaEmpty').checked;
  settings.tabs = [...document.querySelectorAll('#setTabs input:checked')].map(cb => cb.value);
  if (!settings.tabs.length) settings.tabs = ['agenda'];
  settings.defaultCalId = $('#setDefaultCal').value || null;
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
  for (let h = 0; h <= 23; h++) $('#setSlotMin').add(new Option(`${h} h`, String(h)));
  for (let h = 1; h <= 24; h++) $('#setSlotMax').add(new Option(`${h} h`, String(h)));
  $('#setSources').addEventListener('input', () => fillDefaultCal());
  $('#setTheme').onchange = () => { settings.theme = $('#setTheme').value; applyPrefs(); renderPalettes(); };
  $('#setImportThemes').onclick = withBusy(async () => {
    readSettingsForm();
    const r = await importObsidianThemes();
    toast(`${r.n} thème(s) importé(s)${r.active ? ` — « ${r.active} » (ton thème Obsidian) sélectionné` : ''}`);
  });
  $('#setSnippets').onchange = withBusy(async () => {
    settings.useSnippets = $('#setSnippets').checked;
    if (settings.useSnippets) {
      const names = await importSnippets();
      toast(names.length ? `Snippets appliqués : ${names.join(', ')}` : 'Aucun snippet activé dans Obsidian');
    }
    applyPrefs();
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
    applyPrefs();
    parsedMemo.clear();
    refresh();
    updateMenuDot();
    sync();
  };
  $('#setCancel').onclick = () => {
    settings = { ...DEFAULT_SETTINGS, ...LS.get('fc.settings', {}) };
    applyPrefs();
    closeDlg($('#dlgSettings'));
  };
}

// ---------- Calendrier ----------
/** Petite animation qui montre où est aujourd'hui. */
function flashToday() {
  const btn = $('#btnToday');
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
  setTimeout(() => {
    const sel = currentView === 'agenda' ? '#agenda .ag-day.today'
      : '.fc-daygrid-day.fc-day-today, .fc-timegrid-col.fc-day-today, .fc-col-header-cell.fc-day-today';
    for (const el of document.querySelectorAll(sel)) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1400);
    }
  }, currentView === 'agenda' ? 350 : 60);
}

/** Affiche seulement les onglets choisis dans les réglages. */
function applyTabs() {
  const tabs = Array.isArray(settings.tabs) && settings.tabs.length ? settings.tabs : ['agenda', 'dayGridMonth'];
  for (const b of document.querySelectorAll('#viewNav button')) b.hidden = !tabs.includes(b.dataset.view);
  $('#viewNav').hidden = tabs.length < 2;
}

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
      dayGridMonth: { dayMaxEvents: true, displayEventTime: false, moreLinkText: n => `+${n}` },
    },
    height: '100%',
    nowIndicator: true,
    eventDisplay: 'block',
    editable: settings.dragMode !== 'off',
    weekends: settings.weekends !== false,
    weekNumbers: !!settings.weekNumbers,
    weekText: 'S',
    slotMinTime: `${String(settings.slotMin ?? 0).padStart(2, '0')}:00:00`,
    slotMaxTime: `${String(settings.slotMax ?? 24).padStart(2, '0')}:00:00`,
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
  {
    const tabs = Array.isArray(settings.tabs) && settings.tabs.length ? settings.tabs : ['agenda', 'dayGridMonth'];
    let v = normView(LS.get('fc.view', null)) || normView(settings.initialView);
    if (!tabs.includes(v)) v = tabs.includes(normView(settings.initialView)) ? normView(settings.initialView) : tabs[0];
    setView(v);
  }

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
  $('#btnAssist').onclick = () => openAssist();
  $('#btnSync').onclick = () => sync();
  $('#btnMenu').onclick = () => { renderMenu(); openDlg($('#dlgMenu')); };
  $('#menuSettings').onclick = () => openSettings({ from: $('#dlgMenu') });
  for (const b of document.querySelectorAll('#menuMode button')) {
    b.onclick = () => { settings.theme = b.dataset.mode; saveSettings(); applyPrefs(); renderMenu(); };
  }
  $('#menuRecent').onclick = () => {
    searchSort = 'modified';
    for (const x of document.querySelectorAll('#searchSort button')) x.setAttribute('aria-pressed', String(x.dataset.sort === 'modified'));
    $('#searchInput').value = '';
    searchIndex = null;
    swapDlg($('#dlgMenu'), $('#dlgSearch'));
    runSearch();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'auto') applyPrefs(); });
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
  $('#dtHistory').onclick = openHistory;
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
  // L'heure de fin suit l'heure de début en gardant la même durée (1 h par défaut)
  $('#evStart').addEventListener('input', () => {
    const start = $('#evStart').value;
    if (start) $('#evEnd').value = addMinutes(start, editing.duration || (+settings.defaultDuration || 60));
  });
  $('#evEnd').addEventListener('change', () => {
    const d = timeDiff($('#evStart').value, $('#evEnd').value);
    if (d) editing.duration = d;
  });
  for (const id of ['#evDate', '#evStart', '#evEnd', '#evAllDay', '#evRecurring']) {
    $(id).addEventListener('input', () => { editing.touchedWhen = true; });
  }

  // Assistant IA
  $('#asForm').onsubmit = sendAssist;
  $('#asInput').addEventListener('input', growInput);
  $('#asInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendAssist(e); });
  $('#asRefresh').onclick = () => loadAssist().then(() => renderAssist({ scroll: true }));
  $('#dlgAssist').addEventListener('click', onAssistClick);
  $('#dtAsk').onclick = () => {
    const file = cache.files[detail.fileId];
    const src = sourceById(file?.calId);
    if (!file) return;
    const ev = getEvent(file);
    openAssist({ lien: graph.joinPath(src?.directory || '', file.name.replace(/\.md$/i, '')), lienLabel: ev?.title || file.name, from: $('#dlgDetail') });
  };

  // Recherche
  let st;
  $('#searchInput').addEventListener('input', () => { clearTimeout(st); st = setTimeout(runSearch, 120); });
  for (const b of document.querySelectorAll('#searchSort button')) {
    b.onclick = () => {
      searchSort = b.dataset.sort;
      for (const x of document.querySelectorAll('#searchSort button')) x.setAttribute('aria-pressed', String(x === b));
      runSearch();
    };
  }
  $('#searchResults').addEventListener('click', e => {
    const r = e.target.closest('.result');
    if (r) openDetail(r.dataset.id, r.dataset.date, { from: $('#dlgSearch') });
  });

  // Agenda
  $('#agenda').addEventListener('click', e => {
    const b = e.target.closest('.ag-ev');
    if (b) { openDetail(b.dataset.id, b.dataset.date); return; }
    const day = e.target.closest('.ag-day');
    if (day && e.target.closest('.ag-add, .ag-date b, .ag-empty')) openEditor(null, { date: day.dataset.date });
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
    if (Date.now() - lastSync > 60e3) { sync({ quiet: true }); loadAssist({ quiet: true }); }
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
  applyPrefs();
  wireUI();
  initCalendar();
  updateMenuDot();
  updateAsDot();

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
  loadAssist({ quiet: true });
}

start();
