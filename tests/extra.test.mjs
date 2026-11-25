// node tests/extra.test.mjs
import assert from 'node:assert/strict';
import { parseQuick } from '../js/nlp.js';
import { renderMarkdown, toggleTask } from '../js/markdown.js';

const T = '2026-11-25'; // mercredi
const q = s => { const r = parseQuick(s, T); delete r.matched; return r; };
assert.deepEqual(q('Dîner Alex demain 20h'), { title: 'Dîner Alex', date: '2026-11-26', startTime: '20:00' });
assert.deepEqual(q('Réunion lundi 14h-15h30'), { title: 'Réunion', date: '2026-11-30', startTime: '14:00', endTime: '15:30' });
assert.deepEqual(q('Anniv Jo le 12 mars'), { title: 'Anniv Jo', date: '2027-03-12' });
assert.deepEqual(q('Ciné 28/11 à 21h'), { title: 'Ciné', date: '2026-11-28', startTime: '21:00' });
assert.deepEqual(q('Sport dans 3 jours de 18h à 19h'), { title: 'Sport', date: '2026-11-28', startTime: '18:00', endTime: '19:00' });
assert.deepEqual(q('Verre ce soir'), { title: 'Verre', date: T, startTime: '20:00' });
assert.deepEqual(q('Messe mercredi'), { title: 'Messe', date: '2026-12-02' });
assert.deepEqual(q('Dentiste le 3 à 9h30'), { title: 'Dentiste', date: '2026-12-03', startTime: '09:30' });
assert.deepEqual(q('Pddm vendredi matin'), { title: 'Pddm', date: '2026-11-27', startTime: '09:00' });
assert.deepEqual(q('Week-end Lyon 5 déc.'), { title: 'Week-end Lyon', date: '2026-12-05' });
assert.deepEqual(q('Concert 2027'), { title: 'Concert 2027' });
assert.equal(parseQuick('Juste un titre', T).matched, false);

const body = 'Vient :\n\n- [x] Clémence\n- [ ] Ivan <b>\n\n## Titre\nTexte **gras** [[Lien|alias]] https://ex.com\n';
const html = renderMarkdown(body, 7);
assert.match(html, /data-line="9" checked/);
assert.match(html, /data-line="10">/);
assert.match(html, /Ivan &lt;b&gt;/);
assert.match(html, /<strong>gras<\/strong>/);
assert.match(html, /<span class="wikilink">alias<\/span>/);
assert.match(html, /<a href="https:\/\/ex.com"/);
assert.equal(toggleTask('a\n- [ ] x\n  - [x] y', 1), 'a\n- [x] x\n  - [x] y');
assert.equal(toggleTask('a\n- [ ] x\n  - [x] y', 2), 'a\n- [ ] x\n  - [ ] y');
console.log('OK - nlp + markdown');
