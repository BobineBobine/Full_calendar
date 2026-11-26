// Source du fichier vendor/codemirror.min.js (CodeMirror 6, licence MIT).
// Pour le reconstruire : voir README (section Développement).
export { EditorState, EditorSelection, StateField, StateEffect, RangeSetBuilder, Prec } from '@codemirror/state';
export { EditorView, keymap, Decoration, WidgetType, ViewPlugin, placeholder, drawSelection, dropCursor } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
export { syntaxTree, syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language';
export { markdown, markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
export { autocompletion, startCompletion, completionKeymap, closeBrackets, acceptCompletion } from '@codemirror/autocomplete';
export { tags } from '@lezer/highlight';
export { Strikethrough, TaskList, Table } from '@lezer/markdown';
