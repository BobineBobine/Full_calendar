// Saisie rapide en français : « Dîner Alex demain 20h », « Réunion lundi 14h-15h30 »,
// « Anniv le 12 mars », « Ciné 28/11 à 21h », « Sport dans 3 jours 18h ».

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const MONTHS_RE = '(janv(?:ier)?|fevr?(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|aout|sept?(?:embre)?|oct(?:obre)?|nov(?:embre)?|dec(?:embre)?)\\.?';

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = s => new Date(s + 'T00:00:00Z');
function addDays(s, n) { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function monthIndex(word) { return MONTHS.findIndex(m => m.startsWith(word.replace(/\.$/, '').slice(0, 3))); }

/** Version sans accents, en minuscules, de même longueur que l'original (pour garder les positions). */
function fold(text) {
  return [...text].map(c => {
    const f = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return f.length === c.length ? f : c.toLowerCase();
  }).join('');
}

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * @param {string} text  saisie de l'utilisateur
 * @param {string} today date du jour 'YYYY-MM-DD'
 * @returns {{title:string, date?:string, startTime?:string, endTime?:string, matched:boolean}}
 */
export function parseQuick(text, today) {
  const low = fold(text);
  const cut = [];
  const take = m => { cut.push([m.index, m.index + m[0].length]); };
  const free = m => !cut.some(([a, b]) => m.index < b && m.index + m[0].length > a);
  const res = {};

  // --- Heures ---
  const range = /(?:\bde\s+)?\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*(?:-|–|\ba\b|\bjusqu'a\b)\s*(\d{1,2})\s*(?:h|:)?\s*(\d{2})?(?![\d/])/g;
  for (const m of low.matchAll(range)) {
    const [h1, m1, h2, m2] = [+m[1], +(m[2] || 0), +m[3], +(m[4] || 0)];
    if (h1 < 24 && h2 < 24 && m1 < 60 && m2 < 60) {
      res.startTime = `${pad(h1)}:${pad(m1)}`;
      res.endTime = `${pad(h2)}:${pad(m2)}`;
      take(m);
      break;
    }
  }
  if (!res.startTime) {
    const single = /(?:\b(?:a|vers|des)\s+)?\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?(?![\d/])/g;
    for (const m of low.matchAll(single)) {
      const h = +m[1], mi = +(m[2] || 0);
      if (h < 24 && mi < 60) { res.startTime = `${pad(h)}:${pad(mi)}`; take(m); break; }
    }
  }

  // --- Dates ---
  const tryDate = (re, fn) => {
    if (res.date) return;
    for (const m of low.matchAll(re)) {
      if (!free(m)) continue;
      const d = fn(m);
      if (d) { res.date = d; take(m); return; }
    }
  };
  const year = +today.slice(0, 4), month = +today.slice(5, 7), dayNum = +today.slice(8, 10);

  tryDate(/\b(?:aujourd'hui|aujourdhui|ce soir|ce midi|ce matin)\b/g, m => {
    if (!res.startTime) {
      if (m[0] === 'ce soir') res.startTime = '20:00';
      if (m[0] === 'ce midi') res.startTime = '12:30';
    }
    return today;
  });
  tryDate(/\b(apres[- ]demain|demain)(?:\s+(soir|midi|matin))?\b/g, m => {
    if (!res.startTime && m[2]) res.startTime = { soir: '20:00', midi: '12:30', matin: '09:00' }[m[2]];
    return addDays(today, m[1] === 'demain' ? 1 : 2);
  });
  tryDate(/\bdans\s+(\d{1,3})\s+(jours?|semaines?)\b/g, m => addDays(today, +m[1] * (m[2].startsWith('semaine') ? 7 : 1)));
  tryDate(new RegExp(`\\b(?:le\\s+)?(\\d{1,2})(?:er)?\\s+${MONTHS_RE}(?:\\s+(\\d{4}))?(?![a-z\\d])`, 'g'), m => {
    const d = +m[1], mo = monthIndex(m[2]) + 1;
    let y = m[3] ? +m[3] : year;
    if (!validDate(y, mo, d)) return null;
    let s = `${y}-${pad(mo)}-${pad(d)}`;
    if (!m[3] && s < today) s = `${y + 1}-${pad(mo)}-${pad(d)}`;
    return s;
  });
  tryDate(/\b(?:le\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, m => {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : year;
    if (y < 100) y += 2000;
    if (!validDate(y, mo, d)) return null;
    let s = `${y}-${pad(mo)}-${pad(d)}`;
    if (!m[3] && s < today) s = `${y + 1}-${pad(mo)}-${pad(d)}`;
    return s;
  });
  tryDate(/\b(?:ce\s+|le\s+)?(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(\s+prochain)?(?:\s+(soir|midi|matin))?\b/g, m => {
    const target = DAYS.indexOf(m[1]);
    const cur = utc(today).getUTCDay();
    let ahead = (target - cur + 7) % 7;
    if (ahead === 0) ahead = 7;
    if (!res.startTime && m[3]) res.startTime = { soir: '20:00', midi: '12:30', matin: '09:00' }[m[3]];
    return addDays(today, ahead);
  });
  tryDate(/\ble\s+(\d{1,2})(?:er)?\b(?!\s*[h:/\d])/g, m => {
    const d = +m[1];
    let y = year, mo = month;
    if (d < dayNum) { mo++; if (mo > 12) { mo = 1; y++; } }
    return validDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  });

  // --- Titre nettoyé ---
  let title = text;
  for (const [a, b] of cut.sort((x, y) => y[0] - x[0])) title = title.slice(0, a) + ' ' + title.slice(b);
  title = title.replace(/\s{2,}/g, ' ')
    .replace(/(?:^|\s)(?:à|a|le|de|du|ce|vers|dès|des|,|-|–)(?=\s*$)/gi, '')
    .replace(/^\s*(?:,|-|–)\s*/, '')
    .replace(/\s+(?:à|a|le|de|ce|vers)\s+(?=(?:à|a|le|de|ce|vers)?\s*$)/gi, ' ')
    .trim();
  return { title, ...res, matched: !!(res.date || res.startTime) };
}
