import * as auth from './auth.js';
import * as graph from './graph.js';
import * as md from './md.js';

// ---------- Stockage local ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
};

const VIEWS = ['listWeek', 'timeGridDay', 'timeGridWeek', 'dayGridMonth'];
const DEFAULT_SETTINGS = { clientId: '', vaultPath: '', sources: [], firstDay: 1, initialView: 'listWeek', defaultCalId: null };

let settings = { ...DEFAULT_SETTINGS, ...LS.get('fc.settings', {}) };
let cache = LS.get('fc.cache', { files: {} }); // id -> { id, name, calId, eTag, text }
const parsedMemo = new Map();
let calendar = null;
let syncing = false, lastSync = 0;

const $ = sel => document.querySelector(sel);
const saveSettings = () => LS.set('fc.settings', settings);
const saveCache = () => LS.set('fc.cache', cache);
const sourceById = id => settings.sources.find(s => s.id === id);
const dirPath = src => graph.joinPath(settings.vaultPath, src.directory);
const configured = () => settings.clientId && settings.vaultPath && settings.sources.length;

graph.init(force => auth.getToken(settings.clientId, force));

// ---------- Utilitaires date ----------
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayStr = () => fmtDate(new Date());

// ---------- UI : toast, statut, bannière ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 2500);
}

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

const textColorMemo = new Map();
function textColorFor(css) {
  if (textColorMemo.has(css)) return textColorMemo.get(css);
  const el = document.createElement('span');
  el.style.color = css;
  document.body.appendChild(el);
  const [r, g, b] = (getComputedStyle(el).color.match(/\d+(\.\d+)?/g) || [0, 0, 0]).map(Number);
  el.remove();
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const res = lum > 0.62 ? '#1f2328' : '#ffffff';
  textColorMemo.set(css, res);
  return res;
}

// ---------- Événements ----------
function getEvent(file) {
  const m = parsedMemo.get(file.id);
  if (m && m.eTag === file.eTag && m.name === file.name) return m.ev;
  let ev = null;
  try { ev = md.parseEvent(file.text, file.name); } catch (e) { console.warn(file.name, e); }
  parsedMemo.set(file.id, { eTag: file.eTag, name: file.name, ev });
  return ev;
}

function eventsFn(info, success) {
  const rs = fmtDate(info.start), re = fmtDate(info.end);
  const out = [];
  for (const f of Object.values(cache.files)) {
    const src = sourceById(f.calId);
    if (!src) continue;
    const ev = getEvent(f);
    if (!ev) continue;
    const color = src.color || '#3b82f6';
    for (const o of md.occurrences(ev, rs, re)) {
      out.push({
        id: ev.type === 'recurring' ? `${f.id}|${o.date}` : f.id,
        title: ev.title,
        start: o.start, end: o.end, allDay: o.allDay,
        backgroundColor: color, borderColor: color, textColor: textColorFor(color),
        editable: ev.type === 'single',
        classNames: ev.type === 'recurring' ? ['fc-recurring'] : [],
        extendedProps: { fileId: f.id },
      });
    }
  }
  success(out);
}

const refresh = () => calendar && calendar.refetchEvents();

// ---------- Synchronisation OneDrive ----------
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

async function sync({ quiet = false } = {}) {
  if (syncing || !configured() || !auth.isLoggedIn()) return;
  if (!navigator.onLine) { if (!quiet) toast('Hors ligne : affichage du cache'); return; }
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
    if (toFetch.length) setBusy(true, `0/${toFetch.length}`);
    await pool(toFetch, 8, async ({ it, src }) => {
      const text = await graph.readItem(it);
      cache.files[it.id] = { id: it.id, name: it.name, calId: src.id, eTag: it.eTag, text };
      done++;
      if (done % 5 === 0 || done === toFetch.length) setBusy(true, `${done}/${toFetch.length}`);
    });
    saveCache();
    lastSync = Date.now();
    refresh();
    if (!quiet && toFetch.length) toast(`${toFetch.length} note(s) mise(s) à jour`);
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
    // On tente une reconnexion silencieuse (une fois par session).
    if (navigator.onLine && !sessionStorage.getItem('fc.silentTried')) {
      sessionStorage.setItem('fc.silentTried', '1');
      auth.login(settings.clientId, { silent: true });
      return;
    }
    banner('Session OneDrive expirée.', 'Se reconnecter', () => auth.login(settings.clientId));
    return;
  }
  if (e.status === 412) {
    toast('Ce fichier a été modifié ailleurs entre-temps. Synchronisation…', true);
    sync({ quiet: true });
    return;
  }
  toast(e.message || String(e), true);
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
  cache.files[item.id] = { id: item.id, name: item.name, calId: src.id, eTag: item.eTag, text };
  saveCache();
  refresh();
}

async function deleteEvent(fileId) {
  await graph.deleteItem(fileId);
  delete cache.files[fileId];
  saveCache();
  refresh();
}

// Glisser-déposer / redimensionner (événements ponctuels uniquement)
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
  try {
    setBusy(true);
    await saveEvent(fileId, f);
  } catch (err) {
    info.revert();
    handleError(err);
  } finally { setBusy(false); }
}

// ---------- Éditeur d'événement ----------
const DAY_UI = [['M', 'L'], ['T', 'M'], ['W', 'M'], ['R', 'J'], ['F', 'V'], ['S', 'S'], ['U', 'D']];
let editing = null; // { fileId, bodyShown }

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
  sel.value = value && sourceById(value) ? value : (settings.defaultCalId && sourceById(settings.defaultCalId) ? settings.defaultCalId : settings.sources[0]?.id);
}

function updateEditorVisibility() {
  const allDay = $('#evAllDay').checked, rec = $('#evRecurring').checked;
  $('#rowTimes').hidden = allDay;
  $('#rowSingle').hidden = rec;
  $('#rowRecur').hidden = !rec;
}

function openEditor(fileId, preset = {}) {
  if (!configured()) { openSettings(); return; }
  const form = $('#evForm');
  form.reset();
  const file = fileId ? cache.files[fileId] : null;
  const ev = file ? getEvent(file) : null;
  const src = file ? sourceById(file.calId) : null;
  editing = { fileId: file ? fileId : null };

  $('#evTitleHead').textContent = file ? 'Modifier' : 'Nouvel événement';
  fillCalendarSelect($('#evCal'), file?.calId);
  $('#evTitle').value = ev?.title || '';
  $('#evAllDay').checked = ev ? ev.allDay : !!preset.allDay;
  $('#evRecurring').checked = ev?.type === 'recurring';
  const date = ev?.date || preset.date || todayStr();
  $('#evDate').value = date;
  $('#evEndDate').value = ev?.endDate && ev.endDate > date ? ev.endDate : '';
  const start = ev?.startTime || preset.time || '09:00';
  $('#evStart').value = start;
  let end = ev?.endTime;
  if (!ev) { const [h, m] = start.split(':').map(Number); end = `${pad(Math.min(h + 1, 23))}:${pad(m)}`; }
  $('#evEnd').value = end || '';
  $('#evStartRecur').value = ev?.startRecur || (ev?.type === 'recurring' ? '' : date);
  $('#evEndRecur').value = ev?.endRecur || '';
  const days = new Set(ev?.daysOfWeek?.length ? ev.daysOfWeek : [md.DAY_LETTERS[new Date(date + 'T12:00').getDay()]]);
  for (const cb of $('#evDays').querySelectorAll('input')) cb.checked = days.has(cb.value);
  const bodyShown = file ? ev?.note?.body?.replace(/^\s*\n/, '') ?? '' : '';
  editing.bodyShown = bodyShown;
  editing.rawBody = file ? ev?.note?.body : '';
  $('#evBody').value = bodyShown;

  $('#evDelete').hidden = !file;
  const link = $('#evObsidian');
  if (file && src) {
    const vault = settings.vaultPath.split('/').filter(Boolean).pop();
    const path = graph.joinPath(src.directory, file.name.replace(/\.md$/i, ''));
    link.href = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
    link.hidden = false;
  } else link.hidden = true;
  $('#evWarn').hidden = !ev?.unsupported;

  updateEditorVisibility();
  $('#dlgEvent').showModal();
  if (!file) setTimeout(() => $('#evTitle').focus(), 50);
}

function readEditor() {
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
  if (bodyVal !== editing.bodyShown) {
    f.body = bodyVal.trim() ? '\n' + bodyVal.replace(/\s+$/, '') + '\n' : '';
  } else if (!editing.fileId) {
    f.body = '';
  }
  if (!f.title) throw new Error('Le titre est obligatoire');
  if (f.recurring) {
    if (!f.days.length) throw new Error('Choisis au moins un jour');
    if (!f.startRecur) f.startRecur = todayStr();
    // Les jours sont triés dans l'ordre de Full Calendar (dim → sam)
    f.days.sort((a, b) => md.DAY_LETTERS.indexOf(a) - md.DAY_LETTERS.indexOf(b));
  } else if (!f.date) throw new Error('La date est obligatoire');
  if (!f.allDay && !f.startTime) throw new Error("L'heure de début est obligatoire");
  return f;
}

async function onSaveEditor(e) {
  e.preventDefault();
  let f;
  try { f = readEditor(); } catch (err) { toast(err.message, true); return; }
  const btn = $('#evSave');
  btn.disabled = true;
  setBusy(true);
  try {
    await saveEvent(editing.fileId, f);
    $('#dlgEvent').close();
    toast('Enregistré');
  } catch (err) { handleError(err); }
  finally { btn.disabled = false; setBusy(false); }
}

async function onDeleteEditor() {
  if (!editing?.fileId) return;
  if (!confirm('Supprimer cet événement ? (la note sera mise dans la corbeille OneDrive)')) return;
  setBusy(true);
  try {
    await deleteEvent(editing.fileId);
    $('#dlgEvent').close();
    toast('Supprimé');
  } catch (err) { handleError(err); }
  finally { setBusy(false); }
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
        <input class="src-dir" placeholder="Dossier dans le coffre" aria-label="Dossier">
      </div>
      <button type="button" class="icon-btn src-del" aria-label="Retirer">✕</button>`;
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

function toHex(css) {
  const el = document.createElement('span');
  el.style.color = css || '#3b82f6';
  document.body.appendChild(el);
  const [r, g, b] = (getComputedStyle(el).color.match(/\d+(\.\d+)?/g) || [59, 130, 246]).map(Number);
  el.remove();
  return '#' + [r, g, b].map(x => pad(Math.round(x).toString(16))).join('');
}

function renderAuthState() {
  const logged = auth.isLoggedIn();
  $('#setAuthState').textContent = logged ? 'Connecté à OneDrive' : 'Non connecté';
  $('#setLogin').hidden = logged;
  $('#setLogout').hidden = !logged;
  $('#setVaultBox').classList.toggle('disabled', !logged);
}

function openSettings() {
  $('#setClientId').value = settings.clientId;
  $('#setRedirect').textContent = auth.redirectUri();
  $('#setVault').value = settings.vaultPath;
  $('#setView').value = settings.initialView;
  $('#setFirstDay').value = String(settings.firstDay);
  settings.sources = settings.sources.map(s => ({ ...s }));
  renderSources();
  renderAuthState();
  $('#dlgSettings').showModal();
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
    settings.sources = srcs;
    if (typeof d.firstDay === 'number') settings.firstDay = d.firstDay;
    const v = d.initialView?.mobile;
    if (VIEWS.includes(v)) settings.initialView = v;
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
  if (list.length === 1) $('#setVault').value = list[0];
  return list;
}

function applySettingsToCalendar() {
  if (!calendar) return;
  calendar.setOption('firstDay', settings.firstDay);
  parsedMemo.clear();
  refresh();
}

function wireSettings() {
  const withBusy = fn => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { handleError(e); } finally { setBusy(false); }
  };
  $('#setLogin').onclick = () => {
    readSettingsForm();
    if (!settings.clientId) { toast("Renseigne d'abord l'ID d'application", true); return; }
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
    toast('Cache vidé');
  };
  $('#setForm').onsubmit = e => {
    e.preventDefault();
    readSettingsForm();
    saveSettings();
    // Retire du cache les calendriers supprimés
    for (const [id, f] of Object.entries(cache.files)) if (!sourceById(f.calId)) delete cache.files[id];
    saveCache();
    $('#dlgSettings').close();
    applySettingsToCalendar();
    sync();
  };
  $('#setCancel').onclick = () => {
    settings = { ...DEFAULT_SETTINGS, ...LS.get('fc.settings', {}) };
    $('#dlgSettings').close();
  };
}

// ---------- Calendrier ----------
function initCalendar() {
  const saved = LS.get('fc.view', null);
  calendar = new FullCalendar.Calendar($('#cal'), {
    locale: 'fr',
    firstDay: settings.firstDay,
    initialView: VIEWS.includes(saved) ? saved : settings.initialView,
    headerToolbar: { left: 'prev,next', center: 'title', right: 'today syncBtn settingsBtn' },
    footerToolbar: { left: '', center: 'listWeek,timeGridDay,timeGridWeek,dayGridMonth', right: '' },
    buttonText: { today: 'Auj.', listWeek: 'Liste', timeGridDay: 'Jour', timeGridWeek: 'Sem.', dayGridMonth: 'Mois' },
    customButtons: {
      syncBtn: { text: '⟳', hint: 'Synchroniser', click: () => sync() },
      settingsBtn: { text: '⚙', hint: 'Réglages', click: openSettings },
    },
    views: {
      timeGridWeek: { dayHeaderFormat: { weekday: 'short', day: 'numeric' }, allDayText: '' },
      dayGridMonth: { dayMaxEvents: 4, displayEventTime: false, moreLinkText: n => `+${n}` },
    },
    height: '100%',
    nowIndicator: true,
    eventDisplay: 'block',
    editable: true,
    longPressDelay: 350,
    eventLongPressDelay: 350,
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    scrollTime: '08:00',
    allDayText: 'Journée',
    noEventsText: 'Aucun événement',
    events: eventsFn,
    eventClick: info => { info.jsEvent.preventDefault(); openEditor(info.event.extendedProps.fileId); },
    dateClick: info => openEditor(null, {
      date: fmtDate(info.date),
      allDay: info.allDay && info.view.type === 'dayGridMonth' ? false : info.allDay,
      time: info.allDay ? null : fmtTime(info.date),
    }),
    eventDrop: onMove,
    eventResize: onMove,
    datesSet: info => LS.set('fc.view', info.view.type),
  });
  calendar.render();

  // Balayage gauche/droite pour changer de période
  const el = $('#cal');
  let x0 = null, y0 = null, t0 = 0;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 === null || document.querySelector('.fc-event-dragging')) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Date.now() - t0 < 600 && Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) * 0.6) {
      dx < 0 ? calendar.next() : calendar.prev();
    }
  }, { passive: true });
}

// ---------- Démarrage ----------
async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  buildDayChips();
  wireSettings();
  $('#evForm').onsubmit = onSaveEditor;
  $('#evCancel').onclick = () => $('#dlgEvent').close();
  $('#evDelete').onclick = onDeleteEditor;
  $('#evAllDay').onchange = updateEditorVisibility;
  $('#evRecurring').onchange = updateEditorVisibility;
  $('#fab').onclick = () => {
    const d = calendar?.getDate();
    const today = todayStr();
    const view = calendar?.view;
    const inView = view && today >= fmtDate(view.currentStart) && today < fmtDate(view.currentEnd);
    openEditor(null, { date: inView || !d ? today : fmtDate(view.currentStart) });
  };

  initCalendar();

  let redirect = null;
  try { redirect = await auth.handleRedirect(settings.clientId); }
  catch (e) { toast('Connexion impossible : ' + e.message, true); }

  if (redirect?.ok) sessionStorage.removeItem('fc.silentTried');
  if (redirect?.error) {
    if (redirect.silent) banner('Session OneDrive expirée.', 'Se reconnecter', () => auth.login(settings.clientId));
    else toast(`Connexion refusée : ${redirect.description || redirect.error}`, true);
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastSync > 60e3) sync({ quiet: true });
  });
  window.addEventListener('online', () => sync({ quiet: true }));
}

start();
