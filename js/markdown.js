// Rendu Markdown minimal et sûr (tout est échappé) pour le corps des notes.
// Les cases à cocher portent l'index de ligne dans le fichier complet (data-line)
// pour pouvoir être cochées depuis la fiche.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/!\[\[([^\]]+)\]\]/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="wikilink">$2</span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

/**
 * @param {string} body corps de la note
 * @param {number} lineOffset nombre de lignes du fichier avant le corps
 */
export function renderMarkdown(body, lineOffset = 0) {
  const lines = body.split('\n');
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const openList = t => { flushPara(); if (list !== t) { closeList(); out.push(`<${t}>`); list = t; } };

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const indent = (line.match(/^\s*/)[0].replace(/\t/g, '    ').length / 2) | 0;
    const ind = indent ? ` style="margin-left:${Math.min(indent, 6) * 1.1}em"` : '';
    let m;
    if (!line.trim()) { flushPara(); closeList(); return; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      const lvl = Math.min(m[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/))) {
      openList('ul');
      const done = m[1] !== ' ';
      out.push(`<li class="task${done ? ' done' : ''}"${ind}><label><input type="checkbox" data-line="${lineOffset + i}"${done ? ' checked' : ''}><span>${inline(m[2])}</span></label></li>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      openList('ul');
      out.push(`<li${ind}>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      openList('ol');
      out.push(`<li${ind}>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr>');
    } else {
      closeList();
      para.push(inline(line.trim()));
    }
  });
  flushPara(); closeList();
  return out.join('');
}

/** Coche / décoche la case de la ligne `lineIndex` du texte complet. */
export function toggleTask(text, lineIndex) {
  const lines = text.split('\n');
  const l = lines[lineIndex];
  if (l === undefined) return text;
  lines[lineIndex] = l.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/, (_, a, c, b) => a + (c === ' ' ? 'x' : ' ') + b);
  return lines.join('\n');
}
