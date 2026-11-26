// Note quotidienne d'Obsidian : réglages (Notes quotidiennes ou Periodic Notes),
// nom de fichier au format moment.js et modèle ({{date}}, {{time}}, {{title}}…).

const pad = (n, w = 2) => String(n).padStart(w, '0');

const LOCALES = {
  fr: {
    months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    monthsShort: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    daysShort: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
    daysMin: ['di', 'lu', 'ma', 'me', 'je', 've', 'sa'],
    ordinal: n => (n === 1 ? '1er' : String(n)),
    dow: 1, doy: 4,
  },
  en: {
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    daysMin: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
    ordinal: n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'),
    dow: 0, doy: 6,
  },
};

const DAY = 864e5;
const utc = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

/** Semaine et année de semaine (dow = premier jour, doy = règle de la 1re semaine, comme moment). */
function weekOf(d, dow, doy) {
  const fwd = 7 + dow - doy; // le 1er janvier + fwd - 1 est toujours en semaine 1
  const firstWeekOffset = y => {
    const fwdlw = (7 + new Date(Date.UTC(y, 0, fwd)).getUTCDay() - dow) % 7;
    return -fwdlw + fwd - 1;
  };
  const y = d.getFullYear();
  const dayOfYear = Math.round((utc(d) - Date.UTC(y, 0, 1)) / DAY) + 1;
  const week = Math.floor((dayOfYear - firstWeekOffset(y) - 1) / 7) + 1;
  const weeksIn = yy => {
    const len = (new Date(yy, 1, 29).getMonth() === 1) ? 366 : 365;
    return (len - firstWeekOffset(yy) + firstWeekOffset(yy + 1)) / 7;
  };
  if (week < 1) return { week: weeksIn(y - 1), year: y - 1 };
  if (week > weeksIn(y)) return { week: week - weeksIn(y), year: y + 1 };
  return { week, year: y };
}

const TOKENS = /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|DDDD|DDD|Do|DD|D|dddd|ddd|dd|d|E|e|WW|W|ww|w|GGGG|gggg|HH|H|hh|h|mm|m|ss|s|A|a|X|x/g;

/** Formate une date comme moment.js (sous-ensemble utile aux noms de fichiers). */
export function formatDate(d, fmt = 'YYYY-MM-DD', locale = 'fr') {
  const L = LOCALES[locale] || LOCALES.fr;
  const Y = d.getFullYear(), M = d.getMonth(), D = d.getDate(), wd = d.getDay();
  const H = d.getHours(), mi = d.getMinutes(), s = d.getSeconds();
  const doy = Math.round((utc(d) - Date.UTC(Y, 0, 1)) / DAY) + 1;
  let iso, loc;
  const isoW = () => (iso ||= weekOf(d, 1, 4));
  const locW = () => (loc ||= weekOf(d, L.dow, L.doy));
  return String(fmt).replace(TOKENS, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case 'YYYY': return String(Y);
      case 'YY': return pad(Y % 100);
      case 'Q': return String(Math.floor(M / 3) + 1);
      case 'MMMM': return L.months[M];
      case 'MMM': return L.monthsShort[M];
      case 'MM': return pad(M + 1);
      case 'M': return String(M + 1);
      case 'DDDD': return pad(doy, 3);
      case 'DDD': return String(doy);
      case 'Do': return L.ordinal(D);
      case 'DD': return pad(D);
      case 'D': return String(D);
      case 'dddd': return L.days[wd];
      case 'ddd': return L.daysShort[wd];
      case 'dd': return L.daysMin[wd];
      case 'd': return String(wd);
      case 'E': return String(wd || 7);
      case 'e': return String((wd - L.dow + 7) % 7);
      case 'WW': return pad(isoW().week);
      case 'W': return String(isoW().week);
      case 'ww': return pad(locW().week);
      case 'w': return String(locW().week);
      case 'GGGG': return String(isoW().year);
      case 'gggg': return String(locW().year);
      case 'HH': return pad(H);
      case 'H': return String(H);
      case 'hh': return pad(H % 12 || 12);
      case 'h': return String(H % 12 || 12);
      case 'mm': return pad(mi);
      case 'm': return String(mi);
      case 'ss': return pad(s);
      case 's': return String(s);
      case 'A': return H < 12 ? 'AM' : 'PM';
      case 'a': return H < 12 ? 'am' : 'pm';
      case 'X': return String(Math.floor(d.getTime() / 1000));
      case 'x': return String(d.getTime());
      default: return t;
    }
  });
}

export const DEFAULT_DAILY = { folder: '', format: 'YYYY-MM-DD', template: '', locale: 'fr' };

const clean = p => String(p || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** Chemin de la note (relatif au coffre, sans .md), ex. « Journal/2026-11-26 ». */
export function dailyPath(date, cfg = DEFAULT_DAILY) {
  const name = formatDate(date, cfg.format || 'YYYY-MM-DD', cfg.locale);
  return [clean(cfg.folder), clean(name)].filter(Boolean).join('/');
}

/**
 * Lit les réglages Obsidian. `files` : { 'daily-notes.json': texte|null, 'periodic-notes': texte|null, 'templates.json': texte|null }.
 * Periodic Notes (s'il est actif pour les notes quotidiennes) passe avant le plugin de base, comme dans Obsidian.
 */
export function configFromObsidian(files) {
  const j = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const out = { ...DEFAULT_DAILY, source: 'défaut' };
  const core = j(files['daily-notes.json']);
  if (core) Object.assign(out, { folder: core.folder || '', format: core.format || 'YYYY-MM-DD', template: core.template || '', source: 'Notes quotidiennes' });
  const per = j(files['periodic-notes']);
  if (per) {
    let d = per.daily;
    if (!d && Array.isArray(per.calendarSets)) {
      const set = per.calendarSets.find(s => s.id === per.activeCalendarSet) || per.calendarSets[0];
      d = set?.day || set?.daily;
    }
    if (d && d.enabled) {
      Object.assign(out, { folder: d.folder || '', format: d.format || 'YYYY-MM-DD', template: d.template || d.templatePath || '', source: 'Periodic Notes' });
    }
  }
  const tpl = j(files['templates.json']);
  out.dateFormat = tpl?.dateFormat || 'YYYY-MM-DD';
  out.timeFormat = tpl?.timeFormat || 'HH:mm';
  out.folder = clean(out.folder);
  out.template = clean(out.template);
  return out;
}

export function templateFile(path) {
  const p = clean(path);
  return !p ? '' : (/\.md$/i.test(p) ? p : p + '.md');
}

/** Remplit un modèle comme le font les notes quotidiennes d'Obsidian. */
export function applyTemplate(tpl, date, cfg = {}, now = new Date()) {
  const loc = cfg.locale || 'fr';
  const title = String(cfg.title ?? '');
  const shift = (d, n, unit) => {
    const x = new Date(d);
    if (unit === 'd') x.setDate(x.getDate() + n);
    else if (unit === 'w') x.setDate(x.getDate() + 7 * n);
    else if (unit === 'M' || unit === 'm') x.setMonth(x.getMonth() + n);
    else if (unit === 'y') x.setFullYear(x.getFullYear() + n);
    return x;
  };
  return String(tpl || '')
    .replace(/{{\s*title\s*}}/gi, title)
    .replace(/{{\s*yesterday\s*}}/gi, () => formatDate(shift(date, -1, 'd'), cfg.dateFormat || 'YYYY-MM-DD', loc))
    .replace(/{{\s*tomorrow\s*}}/gi, () => formatDate(shift(date, 1, 'd'), cfg.dateFormat || 'YYYY-MM-DD', loc))
    .replace(/{{\s*date\s*(?:([+-])\s*(\d+)\s*([dwMmy]))?\s*(?::\s*([^}]*?))?\s*}}/gi, (_, sign, n, unit, fmt) => {
      const d = sign ? shift(date, (sign === '-' ? -1 : 1) * +n, unit) : date;
      return formatDate(d, fmt || cfg.dateFormat || 'YYYY-MM-DD', loc);
    })
    .replace(/{{\s*time\s*(?::\s*([^}]*?))?\s*}}/gi, (_, fmt) => formatDate(now, fmt || cfg.timeFormat || 'HH:mm', loc));
}

export const usesTemplater = tpl => /<%[\s\S]*?%>/.test(String(tpl || ''));

/** Sépare le frontmatter brut (conservé à l'identique) du corps. */
export function splitRaw(text) {
  const t = String(text || '');
  const m = t.match(/^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/);
  return m ? { fm: m[0], body: t.slice(m[0].length) } : { fm: '', body: t };
}
