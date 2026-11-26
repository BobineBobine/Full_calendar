// Complétion des liens Obsidian : en tapant « [[ » dans une zone de texte, une liste de notes s'affiche.
// ↑ ↓ pour choisir, Entrée ou Tab pour insérer, Échap pour fermer. « [[Note#… » et « [[Note|… » ne sont pas complétés.

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let box = null; // une seule liste pour toute l'appli
function getBox() {
  if (!box) {
    box = document.createElement('div');
    box.className = 'lc-box';
    box.setAttribute('role', 'listbox');
    box.hidden = true;
    document.body.appendChild(box);
  }
  return box;
}

/** Position (dans la fenêtre) du curseur d'une zone de texte, via un double invisible. */
function caretRect(ta) {
  const st = getComputedStyle(ta);
  const m = document.createElement('div');
  for (const p of ['font', 'letterSpacing', 'lineHeight', 'padding', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'overflowWrap', 'tabSize', 'textIndent', 'wordBreak']) m.style[p] = st[p];
  const r = ta.getBoundingClientRect();
  Object.assign(m.style, { position: 'fixed', visibility: 'hidden', top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  m.textContent = ta.value.slice(0, ta.selectionStart);
  const span = document.createElement('span');
  span.textContent = '​';
  m.appendChild(span);
  document.body.appendChild(m);
  const s = span.getBoundingClientRect();
  m.remove();
  const lh = parseFloat(st.lineHeight) || 20;
  return { left: s.left, top: s.top - ta.scrollTop, bottom: s.top - ta.scrollTop + lh };
}

/**
 * @param {HTMLTextAreaElement} ta
 * @param {(q: string) => Array<{ label: string, insert: string, hint?: string }>} source
 */
export function attach(ta, source) {
  let items = [], sel = 0, start = -1;
  const close = () => { if (box && box.dataset.for === ta.id) { box.hidden = true; } start = -1; items = []; };
  const query = () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/\[\[([^[\]\n|#]*)$/);
    return m ? { q: m[1], at: before.length - m[1].length } : null;
  };
  const render = () => {
    const b = getBox();
    b.dataset.for = ta.id;
    b.innerHTML = items.map((it, i) => `<div class="lc-item${i === sel ? ' on' : ''}" data-i="${i}" role="option"><b>${esc(it.label)}</b>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</div>`).join('');
    b.hidden = false;
    const c = caretRect(ta);
    const w = Math.min(340, innerWidth - 16);
    b.style.width = w + 'px';
    b.style.left = Math.max(8, Math.min(c.left, innerWidth - w - 8)) + 'px';
    const h = b.offsetHeight;
    b.style.top = (c.bottom + h + 8 < innerHeight ? c.bottom + 4 : Math.max(8, c.top - h - 4)) + 'px';
    b.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const update = () => {
    const q = query();
    if (!q || document.activeElement !== ta) { close(); return; }
    items = source(q.q).slice(0, 12);
    start = q.at;
    sel = 0;
    if (!items.length) { close(); return; }
    render();
  };
  const choose = i => {
    const it = items[i];
    if (!it) return;
    const end = ta.selectionStart;
    const after = ta.value.slice(end);
    const closeBr = after.startsWith(']]') ? '' : ']]';
    ta.setSelectionRange(start, end);
    document.execCommand('insertText', false, it.insert + closeBr); // garde l'annulation (Ctrl+Z) et déclenche « input »
    if (!closeBr) ta.setSelectionRange(ta.selectionStart + 2, ta.selectionStart + 2);
    close();
  };
  ta.addEventListener('input', update);
  ta.addEventListener('click', update);
  ta.addEventListener('blur', () => setTimeout(close, 150));
  ta.addEventListener('scroll', () => { if (items.length) render(); });
  ta.addEventListener('keydown', e => {
    if (!items.length || getBox().hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); choose(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  getBox().addEventListener('pointerdown', e => {
    if (getBox().dataset.for !== ta.id) return;
    const el = e.target.closest('.lc-item');
    if (!el) return;
    e.preventDefault(); // garde le focus dans la zone de texte
    choose(+el.dataset.i);
  });
}
