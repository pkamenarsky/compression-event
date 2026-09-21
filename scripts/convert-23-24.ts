// -----------------------------------------------------------------------------
// A world of operations as a world of keys
//
//   pnpm convert <world.json>...
//
// Writes `<world>.v24.json` beside each. What it reads is a 20, a 21, a 22 or
// a 23; what it writes is a 24. The reading is in `convert.ts`, beside the
// editor it is a reading of — this is the part that takes file names.
//
// A 19 and older goes through `convert-19-20.ts` first, which writes a 21.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { NEWEST, OLDEST, Old, converted } from '../packages/editor/src/convert';

const inputs = process.argv.slice(2).filter(a => a !== '--');

if (inputs.length === 0) {
  console.error(`usage: pnpm convert <world.json>...   (takes a ${OLDEST} to a ${NEWEST}, writes <world>.v24.json beside each)`);
  process.exit(1);
}

let failed = false;

for (const path of inputs) {
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as Old;
    const out = converted(file);

    if ('refused' in out) throw new Error(out.refused);

    const name = path.replace(/(\.json)?$/, '.v24.json');

    writeFileSync(name, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`${path} (${file.format}) -> ${name}  (${out.world.rigs.length} timelines)`);
  }
  catch (e) {
    failed = true;
    console.error(`${path}: ${e instanceof Error ? e.message : e}`);
  }
}

process.exit(failed ? 1 : 0);
