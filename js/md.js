// Lecture / écriture des notes d'événements au format du plugin Obsidian Full Calendar.
//
// Ponctuel :   title, allDay, startTime, endTime, date, endDate?, completed
// Récurrent :  title, allDay, startTime, endTime, type: recurring, daysOfWeek: [W],
//              startRecur, endRecur?, skipDates?
// Les clés inconnues et le corps de la note sont conservés tels quels.

export const DAY_LETTERS = ['U', 'M', 'T', 'W', 'R', 'F', 'S']; // index = Date.getDay() (dimanche = 0)

const KEY_ORDER = [
  'title', 'allDay', 'startTime', 'endTime', 'date', 'endDate', 'completed',
  'type', 'daysOfWeek', 'startRecur', 'endRecur', 'skipDates',
];

// ---------- Frontmatter ----------

export function splitNote(text) {
  text = (text || '').replace(/^﻿/, '');
  const m = text.match(/^---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: null, body: text };
  return { fm: parseYaml(m[1]), body: text.slice(m[0].length) };
}

function parseYaml(src) {
  const data = {}, raw = {}, order = [];
  let cur = null;
  for (const line of src.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (cur && /^[\s-]/.test(line)) {
      raw[cur].push(line);
      const it = line.match(/^\s*-\s*(.*)$/);
      if (it) {
        if (!Array.isArray(data[cur])) data[cur] = [];
        data[cur].push(scalar(it[1]));
      }
      continue;
    }
    const kv = line.match(/^([^:#\s][^:]*?)\s*:(?:\s+(.*)|\s*)$/);
    if (!kv) { cur = null; continue; }
    cur = kv[1];
    if (!(cur in raw)) order.push(cur);
    raw[cur] = [line];
    data[cur] = parseValue(kv[2] ?? '');
  }
  return { data, raw, order };
}

function parseValue(v) {
  v = v.trim();
  if (v === '') return null;
  if (/^\[.*\]$/.test(v)) {
    return v.slice(1, -1).split(',').map(s => scalar(s)).filter(s => s !== '' && s !== null);
  }
  return scalar(v);
}

function scalar(s) {
  s = String(s).trim();
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function fmtScalar(s) {
  if (s === null || s === undefined) return 'null';
  if (typeof s === 'boolean') return String(s);
  s = String(s);
  if (s === '') return '""';
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) || /: |\s#|[,\[\]{}]/.test(s) ||
      /^(true|false|null|~|yes|no|on|off)$/i.test(s) || /^[+-]?\d+(\.\d+)?$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function fmtValue(v) {
  if (Array.isArray(v)) return '[' + v.map(fmtScalar).join(', ') + ']';
  return fmtScalar(v);
}

/**
 * Reconstruit la note. `fields` contient les clés connues (undefined = clé supprimée).
 * Les clés inconnues de la note d'origine sont recopiées à l'identique.
 */
export function buildNote(note, fields, body) {
  const fm = note?.fm || { data: {}, raw: {}, order: [] };
  const lines = [];
  for (const k of KEY_ORDER) {
    if (fields[k] === undefined) continue;
    lines.push(`${k}: ${fmtValue(fields[k])}`);
  }
  for (const k of fm.order) {
    if (KEY_ORDER.includes(k)) continue;
    lines.push(...fm.raw[k]);
  }
  const b = body !== undefined ? body : (note?.body ?? '');
  return `---\n${lines.join('\n')}\n---\n${b}`;
}

// ---------- Événements ----------

export function normDate(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

export function normTime(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = +m[1];
  if (/pm/i.test(s) && h < 12) h += 12;
  if (/am/i.test(s) && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function toArr(v) {
  if (v === null || v === undefined) return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);
}

/** Analyse une note. Renvoie null si ce n'est pas un événement exploitable. */
export function parseEvent(text, fileName = '') {
  const note = splitNote(text);
  if (!note.fm) return null;
  const d = note.fm.data;
  let type = d.type ? String(d.type) : (d.daysOfWeek ? 'recurring' : (d.rrule ? 'rrule' : 'single'));
  const ev = {
    title: d.title !== null && d.title !== undefined && String(d.title).trim()
      ? String(d.title).trim()
      : fileName.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '').replace(/^\(Every [^)]*\)\s*/, ''),
    allDay: d.allDay === true || d.allDay === 'true',
    type,
    date: normDate(d.date),
    endDate: normDate(d.endDate),
    startTime: normTime(d.startTime),
    endTime: normTime(d.endTime),
    daysOfWeek: toArr(d.daysOfWeek).map(x => x.toUpperCase()),
    startRecur: normDate(d.startRecur),
    endRecur: normDate(d.endRecur),
    skipDates: toArr(d.skipDates).map(normDate).filter(Boolean),
    note,
  };
  if (!ev.startTime) ev.allDay = true;
  if (type === 'rrule') {
    // Non géré finement : on affiche seulement la première occurrence.
    ev.date = normDate(d.startDate) || ev.date;
    ev.type = type = 'single';
    ev.unsupported = true;
  }
  if (type === 'recurring') {
    if (!ev.daysOfWeek.length) return null;
  } else {
    ev.type = 'single';
    if (!ev.date) return null;
  }
  return ev;
}

export function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(s) { return new Date(s + 'T00:00:00Z').getUTCDay(); }

function occurrence(ev, date, endDate) {
  if (ev.allDay) {
    const o = { start: date, allDay: true, date };
    if (endDate && endDate > date) o.end = addDays(endDate, 1);
    return o;
  }
  const start = `${date}T${ev.startTime}`;
  const endDay = endDate && endDate >= date ? endDate : date;
  let end = ev.endTime ? `${endDay}T${ev.endTime}` : null;
  if (end && end <= start) end = `${addDays(endDay, 1)}T${ev.endTime}`;
  const o = { start, allDay: false, date };
  if (end) o.end = end;
  return o;
}

/** Occurrences d'un événement dans [rs, re[ (dates 'YYYY-MM-DD'). */
export function occurrences(ev, rs, re) {
  if (ev.type !== 'recurring') return [occurrence(ev, ev.date, ev.endDate)];
  const days = new Set(ev.daysOfWeek.map(l => DAY_LETTERS.indexOf(l)).filter(i => i >= 0));
  const skip = new Set(ev.skipDates);
  const out = [];
  let d = addDays(rs, -1);
  if (ev.startRecur && ev.startRecur > d) d = ev.startRecur;
  for (let guard = 0; d < re && guard < 800; d = addDays(d, 1), guard++) {
    if (ev.endRecur && d > ev.endRecur) break;
    if (days.has(weekday(d)) && !skip.has(d)) out.push(occurrence(ev, d));
  }
  return out;
}

export function cleanTitle(t) {
  return String(t || '').replace(/[\\/:*?"<>|#^\[\]]/g, '').trim() || 'Sans titre';
}

/** Nom de fichier utilisé par Full Calendar. */
export function fileNameFor(ev) {
  if (ev.type === 'recurring') return `(Every ${ev.daysOfWeek.join(',')}) ${cleanTitle(ev.title)}.md`;
  return `${ev.date} ${cleanTitle(ev.title)}.md`;
}
