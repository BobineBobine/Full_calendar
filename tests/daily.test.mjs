// node tests/daily.test.mjs
import assert from 'node:assert/strict';
import * as daily from '../js/daily.js';

const d = new Date(2026, 10, 26, 9, 34); // jeudi 26 novembre 2026
const f = (fmt, loc) => daily.formatDate(d, fmt, loc);
assert.equal(f('YYYY-MM-DD'), '2026-11-26');
assert.equal(f('dddd D MMMM YYYY'), 'jeudi 26 novembre 2026');
assert.equal(f('ddd DD MMM'), 'jeu. 26 nov.');
assert.equal(f('YYYY/MM-MMMM/YYYY-MM-DD'), '2026/11-novembre/2026-11-26');
assert.equal(f('[Journal] YYYY-[S]WW'), 'Journal 2026-S48');
assert.equal(f('gggg-[W]ww'), '2026-W48');
assert.equal(f('dddd, MMMM Do YYYY', 'en'), 'Thursday, November 26th 2026');
assert.equal(daily.formatDate(new Date(2026, 0, 1), 'Do MMMM'), '1er janvier');
// semaines ISO aux limites d'année
assert.equal(daily.formatDate(new Date(2027, 0, 1), 'GGGG-[W]WW'), '2026-W53');
assert.equal(daily.formatDate(new Date(2024, 11, 30), 'GGGG-[W]WW'), '2025-W01');
assert.equal(daily.formatDate(new Date(2021, 0, 3), 'GGGG-[W]WW E'), '2020-W53 7');

assert.equal(daily.dailyPath(d, { folder: '/Journal/', format: 'YYYY-MM-DD' }), 'Journal/2026-11-26');
assert.equal(daily.dailyPath(d, { folder: '', format: 'YYYY/MM/YYYY-MM-DD' }), '2026/11/2026-11-26');

// Config : plugin de base
let c = daily.configFromObsidian({ 'daily-notes.json': '{"folder":"Journal","format":"YYYY-MM-DD dddd","template":"Modèles/Jour"}' });
assert.equal(c.folder, 'Journal'); assert.equal(c.format, 'YYYY-MM-DD dddd'); assert.equal(c.source, 'Notes quotidiennes');
assert.equal(daily.templateFile(c.template), 'Modèles/Jour.md');
// Periodic Notes actif passe devant
c = daily.configFromObsidian({ 'daily-notes.json': '{"folder":"A"}', 'periodic-notes': '{"daily":{"enabled":true,"folder":"Daily/","format":"YYYY/MM/DD","template":"T/day.md"}}' });
assert.deepEqual([c.folder, c.format, c.template, c.source], ['Daily', 'YYYY/MM/DD', 'T/day.md', 'Periodic Notes']);
c = daily.configFromObsidian({ 'periodic-notes': '{"daily":{"enabled":false,"folder":"X"}}' });
assert.equal(c.source, 'défaut'); assert.equal(c.folder, '');
c = daily.configFromObsidian({ 'periodic-notes': '{"activeCalendarSet":"b","calendarSets":[{"id":"a"},{"id":"b","day":{"enabled":true,"folder":"J","format":"DD-MM-YYYY","templatePath":"m.md"}}]}' });
assert.deepEqual([c.folder, c.format, c.template], ['J', 'DD-MM-YYYY', 'm.md']);
// JSON cassé : défauts
assert.equal(daily.configFromObsidian({ 'daily-notes.json': '{oops' }).format, 'YYYY-MM-DD');

// Modèle
const tpl = '# {{title}}\n{{date:dddd D MMMM}} · créé à {{time}}\n← [[{{yesterday}}]] | [[{{date+1d:YYYY-MM-DD}}]] →\n{{ date }}';
assert.equal(daily.applyTemplate(tpl, d, { title: '2026-11-26' }, new Date(2026, 10, 26, 9, 5)),
  '# 2026-11-26\njeudi 26 novembre · créé à 09:05\n← [[2026-11-25]] | [[2026-11-27]] →\n2026-11-26');
assert.equal(daily.usesTemplater('<% tp.date.now() %>'), true);
assert.equal(daily.usesTemplater('{{date}}'), false);

// Frontmatter brut conservé
const note = '---\ntags: [journal]\n---\n# Jour\ntexte\n';
assert.deepEqual(daily.splitRaw(note), { fm: '---\ntags: [journal]\n---\n', body: '# Jour\ntexte\n' });
assert.deepEqual(daily.splitRaw('pas de fm'), { fm: '', body: 'pas de fm' });

console.log('daily : OK');
