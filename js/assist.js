// Consignes pour l'assistant IA : une note par consigne dans le coffre.
//
// L'appli ne fait que CRÉER des notes (jamais de modification) : aucun conflit
// possible avec la tâche du soir qui les traite. La tâche met à jour le statut
// dans le frontmatter et ajoute sa réponse sous un titre « ## Claude ».
//
//   ---
//   type: consigne
//   statut: a-traiter | attente | fait | repondu | annulee
//   cree: 2026-11-25T19:12:00+01:00
//   source: calendrier
//   lien: "[[Calendrier/2026-11-26 Dîner]]"   (facultatif)
//   suite: "[[_IA/consignes/2026-11-25 19h12 …]]" (facultatif : réponse à une question)
//   traite: 2026-11-25                          (ajouté par Claude)
//   ---
//   Texte de la consigne
//
//   ## Claude (2026-11-25)
//   Réponse…

import { splitNote } from './md.js';

export const STATUS = {
  'a-traiter': 'En file',
  'attente': 'Question pour toi',
  'fait': 'Fait',
  'repondu': 'Répondu',
  'annulee': 'Annulée',
};

const pad = n => String(n).padStart(2, '0');

/** Horodatage local ISO avec fuseau, ex. 2026-11-25T19:12:00+01:00. */
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Nom de fichier : « 2026-11-25 19h12 Début de la consigne.md ». */
export function fileNameFor(text, d = new Date()) {
  const words = String(text).replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 8).join(' ');
  const title = words.length > 50 ? words.slice(0, 50).trim() : words;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`
    + `${title ? ' ' + title : ''}.md`;
}

const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export function buildConsigne(text, { lien, suite, date = new Date() } = {}) {
  const fm = ['---', 'type: consigne', 'statut: a-traiter', `cree: ${isoLocal(date)}`, 'source: calendrier'];
  if (lien) fm.push(`lien: ${q(lien)}`);
  if (suite) fm.push(`suite: ${q(suite)}`);
  fm.push('---');
  return fm.join('\n') + '\n' + String(text).trim() + '\n';
}

/** Lit une note de consigne. Renvoie null si ce n'en est pas une. */
export function parseConsigne(text, fallbackDate = '') {
  const { fm, body } = splitNote(text);
  if (!fm || String(fm.data.type || '').toLowerCase() !== 'consigne') return null;
  const d = fm.data;
  const m = body.match(/^#{1,3}\s*Claude\b.*$/m);
  const ask = (m ? body.slice(0, m.index) : body).trim();
  const answer = m ? body.slice(m.index).replace(/^#{1,3}\s*Claude\b[^\n]*\n?/, '').trim() : '';
  const statut = String(d.statut || 'a-traiter').toLowerCase();
  const cree = String(d.cree || fallbackDate || '');
  const unlink = v => String(v || '').replace(/^\[\[|\]\]$/g, '');
  return {
    statut,
    label: STATUS[statut] || statut,
    cree,
    traite: d.traite ? String(d.traite) : '',
    lien: unlink(d.lien),
    suite: unlink(d.suite),
    ask,
    answer,
  };
}
