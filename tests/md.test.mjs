// node tests/md.test.mjs
import assert from 'node:assert/strict';
import * as md from '../js/md.js';

const recurring = `---\ntitle: Cours impro\nallDay: false\nstartTime: 19:00\nendTime: 22:00\ndate: 2025-10-08\ncompleted: null\ntype: recurring\ndaysOfWeek: [W]\nstartRecur: 2025-10-08\nendRecur: 2026-06-24\n---\n\n\n- [x] (@2025-09-05) Rappel\n\n`;
const single = `---\ntitle: Petit déj\nallDay: false\nstartTime: 07:46\nendTime: 08:45\ndate: 2026-11-10\ncompleted: null\n---\n`;
const multi = `---\ntitle: Vacances de Noël\nallDay: true\ndate: 2025-12-20\nendDate: 2026-01-04\n---\n\n**Description :** x\n`;
const badEnd = `---\ntitle: 11 novembre\nallDay: true\ndate: 2030-11-11\nendDate: 2030-11-10\n---\n`;

let e = md.parseEvent(recurring);
assert.equal(e.type, 'recurring');
assert.deepEqual(e.daysOfWeek, ['W']);
let occ = md.occurrences(e, '2026-06-15', '2026-07-06');
assert.deepEqual(occ.map(o => o.start), ['2026-06-17T19:00', '2026-06-24T19:00']); // endRecur inclusif
assert.equal(occ[0].end, '2026-06-17T22:00');

e = md.parseEvent(single);
assert.deepEqual(md.occurrences(e, '2026-11-09', '2026-11-16'), [{ start: '2026-11-10T07:46', end: '2026-11-10T08:45', allDay: false, date: '2026-11-10' }]);
assert.equal(md.fileNameFor(e), '2026-11-10 Petit déj.md');

e = md.parseEvent(multi);
assert.equal(md.occurrences(e, 'a', 'z')[0].end, '2026-01-05');
e = md.parseEvent(badEnd);
assert.equal(md.occurrences(e, 'a', 'z')[0].end, undefined);

// Minuit franchi
e = md.parseEvent(`---\ntitle: Nuit\nallDay: false\nstartTime: 22:00\nendTime: 02:00\ndate: 2026-11-19\n---\n`);
assert.equal(md.occurrences(e, 'a', 'z')[0].end, '2026-11-20T02:00');

// Round-trip : corps et clés inconnues conservés
const withExtra = `---\ntitle: A\nallDay: false\nstartTime: 10:00\nendTime: 11:00\ndate: 2026-01-01\ncompleted: null\ntags:\n  - x\n  - y\nlieu: "Paris: 7e"\n---\nCorps\n- [ ] item\n`;
const note = md.splitNote(withExtra);
const out = md.buildNote(note, { title: 'B: suite', allDay: false, startTime: '12:00', endTime: '13:00', date: '2026-01-02', completed: null });
assert.equal(out, `---\ntitle: "B: suite"\nallDay: false\nstartTime: 12:00\nendTime: 13:00\ndate: 2026-01-02\ncompleted: null\ntags:\n  - x\n  - y\nlieu: "Paris: 7e"\n---\nCorps\n- [ ] item\n`);
const back = md.parseEvent(out);
assert.equal(back.title, 'B: suite');
assert.equal(back.date, '2026-01-02');

// Récurrent multi-jours
const r = md.buildNote(null, { title: 'Sport', allDay: false, startTime: '18:00', endTime: '19:00', type: 'recurring', daysOfWeek: ['M', 'R'], startRecur: '2026-11-01' }, '');
assert.equal(r, `---\ntitle: Sport\nallDay: false\nstartTime: 18:00\nendTime: 19:00\ntype: recurring\ndaysOfWeek: [M, R]\nstartRecur: 2026-11-01\n---\n`);
e = md.parseEvent(r);
assert.equal(md.fileNameFor(e), '(Every M,R) Sport.md');
assert.deepEqual(md.occurrences(e, '2026-11-23', '2026-11-30').map(o => o.date), ['2026-11-23', '2026-11-26']);

// Frontmatter absent / vide
assert.equal(md.parseEvent(''), null);
assert.equal(md.parseEvent('---\n---\n'), null);
// skipDates
e = md.parseEvent(`---\ntitle: S\nstartTime: 9:00\ntype: recurring\ndaysOfWeek: [M]\nstartRecur: 2026-11-01\nskipDates: [2026-11-23]\n---\n`);
assert.deepEqual(md.occurrences(e, '2026-11-16', '2026-12-01').map(o => o.date), ['2026-11-16', '2026-11-30']);
assert.equal(e.startTime, '09:00');
console.log('OK - tous les tests passent');
