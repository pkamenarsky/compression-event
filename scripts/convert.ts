// -----------------------------------------------------------------------------
// An older world as a world of this format
//
//   pnpm convert <world.json>...
//
// Writes `<world>.v28.json` beside each. What it reads is a 20 to a 27; what
// it writes is a 28. A 20 to a 23 is made keys first, then a 24 is made a 28;
// a 25 has its kinds rewritten, a 26 its effects on single corners and edges
// dropped, and a 27 its effects made lists of layers. The reading is in `convert.ts`, beside the editor it is a reading of —
// this is the part that takes file names.
//
// A 19 and older goes through `convert-19-20.ts` first, which writes a 21.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { NEWEST, OLDEST, Old, Saved27, converted, layered, relative, uncornered, unmasked } from '../packages/editor/src/convert';
import { Saved } from '../packages/editor/src/save';

const inputs = process.argv.slice(2).filter(a => a !== '--');

if (inputs.length === 0) {
  console.error(`usage: pnpm convert <world.json>...   (takes a ${OLDEST} to a 27, writes <world>.v28.json beside each)`);
  process.exit(1);
}

let failed = false;

for (const path of inputs) {
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as Old | Saved27;
    const keyed = file.format <= NEWEST ? converted(file as Old) : file as Saved27;

    if ('refused' in keyed) throw new Error(keyed.refused);

    const kinded = keyed.format === 25 ? unmasked(keyed) : keyed;

    if ('refused' in kinded) throw new Error(kinded.refused);

    const cornerless = kinded.format === 26 ? uncornered(kinded) : kinded;

    if ('refused' in cornerless) throw new Error(cornerless.refused);

    const out: Saved | { refused: string } = cornerless.format === 24 ? relative(cornerless) : layered(cornerless);

    if ('refused' in out) throw new Error(out.refused);

    const name = path.replace(/(\.json)?$/, '.v28.json');

    writeFileSync(name, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`${path} (${file.format}) -> ${name}  (${out.world.rigs.length} timelines)`);
  }
  catch (e) {
    failed = true;
    console.error(`${path}: ${e instanceof Error ? e.message : e}`);
  }
}

process.exit(failed ? 1 : 0);
