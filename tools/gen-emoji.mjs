// Builds the emoji shortcode list used by the web composer and the desktop composer from emojibase-data (MIT).
//   npm i emojibase-data   (in any scratch folder)
//   node tools/gen-emoji.mjs <path to node_modules/emojibase-data>
// Writes apps/web/src/emoji/shortcodes.json and apps/desktop/emoji/emoji-shortcodes.json (the same file),
// plus the license notice next to each. Output: [[emoji, name, ...aliases], ...], most popular first.
// Names come from the "github" set (the names Discord and GitHub use), with the "iamcal" set (Slack's names) as aliases.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(process.argv[2] ?? 'node_modules/emojibase-data');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(src, p), 'utf8'));
const data = read('en/data.json');
const sets = ['github', 'iamcal'].map((n) => read(`en/shortcodes/${n}.json`));
const version = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;

// What people actually type first, in rough order of use. Everything else follows in Unicode order.
const POPULAR = ['joy', 'heart', 'sob', 'pray', '+1', 'thumbsup', 'fire', 'smile', 'grin', 'rofl', 'wink', 'blush', 'thinking', 'eyes',
  'tada', 'clap', '100', 'sunglasses', 'heart_eyes', 'sweat_smile', 'smiley', 'slightly_smiling_face', 'relaxed', 'kissing_heart',
  'cry', 'angry', 'scream', 'sleeping', 'wave', 'ok_hand', 'raised_hands', 'muscle', 'point_right', 'thumbsdown', '-1', 'skull',
  'rocket', 'sparkles', 'star', 'white_check_mark', 'x', 'warning', 'pizza', 'coffee', 'beer', 'birthday', 'gift', 'sunny', 'rainbow',
  'dog', 'cat', 'see_no_evil', 'facepalm', 'shrug', 'party', 'partying_face', 'pleading_face', 'smirk', 'unamused', 'neutral_face'];

const norm = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const list = [];
for (const e of data) {
  if (e.group === undefined) continue;               // regional indicators and skin-tone swatches
  const names = [];
  for (const set of sets) for (const n of norm(set[e.hexcode])) if (!names.includes(n)) names.push(n);
  if (!names.length) continue;                        // no shortcode, nothing to type
  list.push({ emoji: e.emoji, names, order: e.order ?? 99999 });
}
const rank = (x) => { const i = POPULAR.findIndex((p) => x.names.includes(p)); return i < 0 ? POPULAR.length + x.order : i; };
list.sort((a, b) => rank(a) - rank(b));
const out = JSON.stringify(list.map((x) => [x.emoji, ...x.names]));

const license = fs.readFileSync(path.join(src, 'LICENSE'), 'utf8');
const notice = `Emoji shortcode data generated from emojibase-data ${version} (https://github.com/milesj/emojibase), used under the MIT license.\n\n${license}`;
for (const dir of ['apps/web/src/emoji', 'apps/desktop/emoji']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, dir.includes('web') ? 'shortcodes.json' : 'emoji-shortcodes.json'), out);
  fs.writeFileSync(path.join(root, dir, 'LICENSE-emojibase.txt'), notice);
}
console.log(`${list.length} emoji, ${out.length} bytes`);
