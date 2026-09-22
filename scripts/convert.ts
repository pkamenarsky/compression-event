// -----------------------------------------------------------------------------
// An older world as a world of this format
//
//   pnpm convert <world.json>...
//
// Writes `<world>.v25.json` beside each. What it reads is a 20 to a 24; what
// it writes is a 25. A 20 to a 23 is made keys first and then a 24 is made a
// 25. The reading is in `convert.ts`, beside the editor it is a reading of —
// this is the part that takes file names.
//
// A 19 and older goes through `convert-19-20.ts` first, which writes a 21.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { NEWEST, OLDEST, Old, converted, relative } from '../packages/editor/src/convert';
import { Saved } from '../packages/editor/src/save';

const inputs = process.argv.slice(2).filter(a => a !== '--');

if (inputs.length === 0) {
  console.error(`usage: pnpm convert <world.json>...   (takes a ${OLDEST} to a 24, writes <world>.v25.json beside each)`);
  process.exit(1);
}

let failed = false;

for (const path of inputs) {
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as Old | Saved;
    const keyed = file.format <= NEWEST ? converted(file as Old) : file as Saved;

    if ('refused' in keyed) throw new Error(keyed.refused);

    const out = relative(keyed);

    if ('refused' in out) throw new Error(out.refused);

    const name = path.replace(/(\.json)?$/, '.v25.json');

    writeFileSync(name, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`${path} (${file.format}) -> ${name}  (${out.world.rigs.length} timelines)`);
  }
  catch (e) {
    failed = true;
    console.error(`${path}: ${e instanceof Error ? e.message : e}`);
  }
}

process.exit(failed ? 1 : 0);
