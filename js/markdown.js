// Rendu Markdown minimal et sûr (tout est échappé) pour le corps des notes.
// Les cases à cocher portent l'index de ligne dans le fichier complet (data-line)
// pour pouvoir être cochées depuis la fiche.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let embeds = false; // ![[image.png]] : affiché seulement là où on sait le charger (onglet Coffre)

export function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t, w) => (embeds ? `<span class="embed" data-embed="${t}"${w ? ` data-w="${w}"` : ''}></span>` : ''))
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="wikilink" data-link="$1">$2</a>')
    .replace(/\[\[([^\]]+)\]\]/g, (_, t) => `<a class="wikilink" data-link="${t}">${t.replace(/#\^?/, ' › ')}</a>`)
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, a, u) => (embeds ? `<img src="${u}" alt="${a}" loading="lazy">` : ''))
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
export function renderMarkdown(body, lineOffset = 0, opts = {}) {
  embeds = !!opts.embeds;
  try { return render(body, lineOffset); } finally { embeds = false; }
}

const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

function render(body, lineOffset) {
  const lines = body.split('\n');
  const out = [];
  let list = null, para = [], fence = null, table = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const openList = t => { flushPara(); if (list !== t) { closeList(); out.push(`<${t}>`); list = t; } };

  const closeTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(`<div class="tbl"><table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
      rows.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    table = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    // Blocs de code ``` … ```
    if (fence) {
      if (/^\s*(```|~~~)\s*$/.test(line)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; }
      else fence.push(line);
      return;
    }
    if (/^\s*(```|~~~)/.test(line)) { flushPara(); closeList(); closeTable(); fence = []; return; }
    // Tableaux | a | b |
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (table) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(line); return; }
      const nxt = (lines[i + 1] || '').replace(/\r$/, '');
      if (/^\s*\|[\s:|-]+\|\s*$/.test(nxt) && nxt.includes('-')) { flushPara(); closeList(); table = [line]; return; }
    }
    closeTable();
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
  if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  flushPara(); closeList(); closeTable();
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
