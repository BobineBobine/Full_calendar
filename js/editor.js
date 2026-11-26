// Éditeur Markdown avec mise en forme en direct (comme l'aperçu en direct d'Obsidian), basé sur CodeMirror 6.
// Le texte reste du Markdown brut ; seules les lignes où n'est pas le curseur cachent les symboles
// (**, #, [[ ]]…), affichent les cases à cocher, les puces et les images.

import {
  EditorState, EditorSelection, Prec, EditorView, keymap, Decoration, WidgetType, ViewPlugin,
  placeholder as placeholderExt, drawSelection, dropCursor, defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxTree, markdown, markdownLanguage, autocompletion, completionKeymap, acceptCompletion, StateEffect,
} from '../vendor/codemirror.min.js';

const refreshEffect = StateEffect.define();

// ---------- Petits éléments affichés à la place du texte ----------
class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM() {
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.className = 'cm-task';
    i.checked = this.checked;
    i.dataset.pos = this.pos;
    return i;
  }
  ignoreEvent() { return false; }
}
class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = '•'; return s; }
}
class ImageWidget extends WidgetType {
  constructor(target, width, load) { super(); this.target = target; this.width = width; this.load = load; }
  eq(o) { return o.target === this.target && o.width === this.width; }
  toDOM() {
    const w = document.createElement('span');
    w.className = 'cm-embed';
    const img = document.createElement('img');
    img.alt = this.target;
    if (this.width) img.style.width = this.width + 'px';
    w.appendChild(img);
    Promise.resolve(this.load(this.target)).then(url => {
      if (url) img.src = url;
      else { w.textContent = `⚠ ${this.target}`; w.classList.add('missing'); }
    }).catch(() => { w.textContent = `⚠ ${this.target}`; w.classList.add('missing'); });
    return w;
  }
  ignoreEvent() { return false; }
}
const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// ---------- Décorations ----------
function buildDecorations(view, o) {
  const { state } = view;
  const doc = state.doc;
  const deco = [];
  const hide = (from, to) => { if (to > from) deco.push(Decoration.replace({}).range(from, to)); };
  const mark = (from, to, cls, attrs) => { if (to > from) deco.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to)); };
  const lineCls = (pos, cls) => deco.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));

  // Lignes « actives » (curseur ou sélection) : le Markdown y reste visible
  const active = new Set();
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
    }
  }
  const isActive = pos => active.has(doc.lineAt(pos).number);
  const isActiveRange = (from, to) => { for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) if (active.has(l)) return true; return false; };

  // Propriétés (frontmatter) en tête de note : affichées à part, jamais interprétées
  let fmEnd = 0;
  if (doc.lines > 1 && /^---\s*$/.test(doc.line(1).text)) {
    for (let l = 2; l <= Math.min(doc.lines, 200); l++) {
      if (/^---\s*$/.test(doc.line(l).text)) { fmEnd = doc.line(l).to; break; }
    }
    if (fmEnd) for (let l = 1; doc.line(l).from <= fmEnd; l++) { lineCls(doc.line(l).from, 'cm-fm'); if (l === doc.lines) break; }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: node => {
        if (node.from < fmEnd) return node.name === 'Document' ? undefined : false;
        const n = node.name;
        let m;
        if ((m = n.match(/^ATXHeading(\d)$/))) {
          lineCls(node.from, `cm-h cm-h${m[1]}`);
          if (!isActive(node.from)) {
            const hm = node.node.getChild('HeaderMark');
            if (hm) hide(hm.from, Math.min(hm.to + 1, doc.lineAt(node.from).to));
          }
          return;
        }
        switch (n) {
          case 'StrongEmphasis': mark(node.from, node.to, 'cm-strong'); break;
          case 'Emphasis': mark(node.from, node.to, 'cm-em'); break;
          case 'Strikethrough': mark(node.from, node.to, 'cm-strike'); break;
          case 'EmphasisMark': case 'StrikethroughMark':
            if (!isActiveRange(node.from, node.to)) hide(node.from, node.to);
            break;
          case 'InlineCode': {
            mark(node.from, node.to, 'cm-inline-code');
            if (!isActiveRange(node.from, node.to)) for (const c of node.node.getChildren('CodeMark')) hide(c.from, c.to);
            return false;
          }
          case 'FencedCode': case 'CodeBlock': {
            const first = doc.lineAt(node.from).number, last = doc.lineAt(node.to).number;
            for (let l = first; l <= last; l++) {
              lineCls(doc.line(l).from, 'cm-codeblock' + (n === 'FencedCode' && (l === first || l === last) ? ' cm-codefence' : ''));
            }
            return false;
          }
          case 'Blockquote': {
            const first = doc.lineAt(node.from).number, last = doc.lineAt(node.to).number;
            for (let l = first; l <= last; l++) lineCls(doc.line(l).from, 'cm-quote');
            break;
          }
          case 'QuoteMark':
            if (!isActive(node.from)) hide(node.from, Math.min(node.to + (doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0), doc.lineAt(node.from).to));
            break;
          case 'HorizontalRule':
            if (!isActive(node.from)) { lineCls(node.from, 'cm-hr'); hide(node.from, node.to); }
            break;
          case 'ListItem': {
            const lm = node.node.getChild('ListMark');
            const task = node.node.getChild('Task');
            const tm = task && task.getChild('TaskMarker');
            if (!lm || isActive(lm.from)) break;
            if (tm) {
              const checked = /x/i.test(doc.sliceString(tm.from, tm.to));
              deco.push(Decoration.replace({ widget: new CheckboxWidget(checked, tm.from) }).range(lm.from, tm.to));
              if (checked) mark(tm.to, doc.lineAt(tm.to).to, 'cm-task-done');
            } else if (node.node.parent?.name === 'BulletList') {
              deco.push(Decoration.replace({ widget: new BulletWidget() }).range(lm.from, lm.to));
            }
            break;
          }
          case 'Link': {
            const url = node.node.getChild('URL');
            const marks = node.node.getChildren('LinkMark');
            if (!url || marks.length < 2) break;
            if (isActiveRange(node.from, node.to)) { mark(node.from, node.to, 'cm-link-src'); break; }
            mark(marks[0].to, marks[1].from, 'cm-link', { 'data-href': doc.sliceString(url.from, url.to) });
            hide(node.from, marks[0].to);
            hide(marks[1].from, node.to);
            return false;
          }
          case 'Image': {
            const url = node.node.getChild('URL');
            if (!url || isActiveRange(node.from, node.to)) break;
            deco.push(Decoration.replace({ widget: new ImageWidget(doc.sliceString(url.from, url.to), 0, t => t) }).range(node.from, node.to));
            return false;
          }
          default:
        }
      },
    });

    // Ce que l'analyseur Markdown ne connaît pas : [[liens]], ![[images]], ==surligné==, #tags
    const tree = syntaxTree(state);
    const inCode = pos => { for (let nd = tree.resolveInner(pos, 1); nd; nd = nd.parent) if (/Code/.test(nd.name)) return true; return false; };
    let pos = Math.max(from, fmEnd);
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const t = line.text, act = active.has(line.number);
      for (const m of t.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]|==([^=\n]+)==|(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
        const s = line.from + m.index, e = s + m[0].length;
        if (inCode(s)) continue;
        if (m[2] !== undefined) {
          const [target, alias] = m[2].split('|');
          if (m[1]) { // ![[image]] / ![[note]]
            if (!act && IMG.test(target.trim())) {
              const w = parseInt(alias, 10);
              deco.push(Decoration.replace({ widget: new ImageWidget(target.trim(), w || 0, o.loadImage) }).range(s, e));
            } else mark(s, e, 'cm-embed-src');
            continue;
          }
          if (act) { mark(s, e, 'cm-wikilink-src'); continue; }
          const missing = o.linkExists && !o.linkExists(target.trim());
          const textFrom = alias !== undefined ? s + 2 + target.length + 1 : s + 2;
          hide(s, textFrom);
          mark(textFrom, textFrom + (alias !== undefined ? alias.length : target.length), 'cm-wikilink' + (missing ? ' missing' : ''), { 'data-link': target.trim() });
          hide(e - 2, e);
        } else if (m[3] !== undefined) {
          mark(s, e, 'cm-highlight');
          if (!act) { hide(s, s + 2); hide(e - 2, e); }
        } else if (m[5] !== undefined) {
          const ts = s + m[4].length;
          mark(ts, e, 'cm-tag');
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(deco, true);
}

const livePreview = o => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDecorations(view, o); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged
      || u.transactions.some(tr => tr.effects.some(e => e.is(refreshEffect)))) {
      this.decorations = buildDecorations(u.view, o);
    }
  }
}, { decorations: v => v.decorations });

// ---------- Raccourcis de mise en forme ----------
function wrap(mk) {
  return view => {
    const { state } = view;
    view.dispatch(state.changeByRange(r => {
      const txt = state.sliceDoc(r.from, r.to);
      const before = state.sliceDoc(r.from - mk.length, r.from), after = state.sliceDoc(r.to, r.to + mk.length);
      if (before === mk && after === mk) { // déjà en forme : on retire
        return { changes: [{ from: r.from - mk.length, to: r.from }, { from: r.to, to: r.to + mk.length }], range: EditorSelection.range(r.from - mk.length, r.to - mk.length) };
      }
      return { changes: { from: r.from, to: r.to, insert: mk + txt + mk }, range: EditorSelection.range(r.from + mk.length, r.to + mk.length) };
    }));
    return true;
  };
}

/**
 * @param {HTMLElement} parent
 * @param {object} o
 *   onChange(text), suggest(q) → [{label, insert, hint}], linkExists(target), onLink(target),
 *   loadImage(target) → Promise<url>, onFiles(files) → Promise<string|null> (Markdown à insérer), placeholder
 */
export function createEditor(parent, o = {}) {
  let silent = false;
  const linkSource = cx => {
    const m = cx.matchBefore(/\[\[[^[\]\n|#]*/);
    if (!m || !o.suggest) return null;
    const after = cx.state.sliceDoc(cx.pos, cx.pos + 2);
    const options = o.suggest(m.text.slice(2)).map(s => ({ label: s.label, detail: s.hint || '', apply: s.insert + (after === ']]' ? '' : ']]'), type: 'text' }));
    return options.length ? { from: m.from + 2, options, filter: false } : null;
  };
  const insertFiles = async (files, at) => {
    if (!o.onFiles) return;
    let md = await o.onFiles(files);
    if (!md) return;
    const pos = Math.min(at ?? view.state.selection.main.head, view.state.doc.length);
    // Une image par ligne, comme Obsidian
    if (pos > 0 && view.state.sliceDoc(pos - 1, pos) !== '\n') md = '\n' + md;
    if (pos < view.state.doc.length && view.state.sliceDoc(pos, pos + 1) !== '\n') md += '\n';
    view.dispatch({ changes: { from: pos, insert: md }, selection: { anchor: pos + md.length } });
    view.focus();
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, addKeymap: true }),
        autocompletion({ override: [linkSource], icons: false, activateOnTyping: true }),
        Prec.high(keymap.of([
          { key: 'Mod-b', run: wrap('**') },
          { key: 'Mod-i', run: wrap('*') },
          { key: 'Mod-Shift-h', run: wrap('==') },
          { key: 'Tab', run: acceptCompletion }, // Tab valide aussi la suggestion [[…]]
          ...completionKeymap,
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        placeholderExt(o.placeholder || 'Écris ici…'),
        livePreview(o),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences', autocorrect: 'on' }),
        EditorView.updateListener.of(u => { if (u.docChanged && !silent && o.onChange) o.onChange(u.state.doc.toString()); }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            const cb = e.target.closest?.('input.cm-task');
            if (cb) {
              e.preventDefault();
              const p = +cb.dataset.pos;
              const cur = v.state.sliceDoc(p + 1, p + 2);
              v.dispatch({ changes: { from: p + 1, to: p + 2, insert: /x/i.test(cur) ? ' ' : 'x' } });
              return true;
            }
            const a = e.target.closest?.('.cm-wikilink[data-link], .cm-link[data-href]');
            if (a && e.button === 0) {
              e.preventDefault();
              if (a.dataset.link) o.onLink?.(a.dataset.link);
              else window.open(a.dataset.href, '_blank', 'noopener');
              return true;
            }
            return false;
          },
          paste(e) {
            const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
            if (!files.length || !o.onFiles) return false;
            e.preventDefault();
            insertFiles(files);
            return true;
          },
          drop(e, v) {
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.length || !o.onFiles) return false;
            e.preventDefault();
            insertFiles(files, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined);
            return true;
          },
        }),
      ],
    }),
  });

  return {
    view,
    get value() { return view.state.doc.toString(); },
    /** Remplace le texte (venu d'ailleurs : OneDrive, autre jour…) sans déclencher onChange. */
    setValue(text, { keepCursor = false } = {}) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      const sel = view.state.selection.main;
      silent = true;
      try {
        view.dispatch({
          changes: { from: 0, to: cur.length, insert: text },
          selection: keepCursor ? { anchor: Math.min(sel.anchor, text.length), head: Math.min(sel.head, text.length) } : { anchor: 0 },
        });
      } finally { silent = false; }
      if (!keepCursor) view.scrollDOM.scrollTop = 0;
    },
    focus() { view.focus(); },
    focusEnd() {
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
      view.focus();
    },
    get hasFocus() { return view.hasFocus; },
    selectionText() { const r = view.state.selection.main; return view.state.sliceDoc(r.from, r.to); },
    /** Insère du texte au curseur (image choisie depuis le téléphone…). */
    insert(text) {
      const r = view.state.selection.main;
      if (r.from > 0 && view.state.sliceDoc(r.from - 1, r.from) !== '\n' && text.startsWith('![[')) text = '\n' + text;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
      view.focus();
    },
    insertFiles,
    /** Recalcule la mise en forme (ex. liens existants une fois le coffre chargé). */
    refresh() { view.dispatch({ effects: refreshEffect.of(null) }); },
    set hidden(v) { parent.hidden = v; },
  };
}
