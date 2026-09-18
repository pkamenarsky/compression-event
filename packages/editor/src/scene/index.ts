// -----------------------------------------------------------------------------
// The door
//
// `./scene` is one module to everything that reads it, and this is the only
// file that says so. `core.ts` is what the world *is* at a keyframe, and
// `reading.ts` is what that turns into once it has been resolved.
//
// Keeping the door separate from the core is what keeps the graph acyclic:
// `reading.ts` reads `./core`, this file reads both, and nothing reads this
// file. Re-exporting `reading` from `core.ts` itself would make the two read
// each other, which the bundler resolves by splitting them into chunks it
// then loads in the wrong order. See the rule in CLAUDE.md.
// -----------------------------------------------------------------------------

export * from './core';
export * from './reading';
export * from './entry';
