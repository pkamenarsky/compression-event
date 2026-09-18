// -----------------------------------------------------------------------------
// The shape of the module graph
//
// Two rules from CLAUDE.md, checked here because the only other thing that
// checks them is `pnpm build`, and a build is a slow way to hear about it.
//
// Rollup sees a cycle only once it has decided the two sides belong in
// different chunks, which it decides from which entry points reach them. So a
// cycle can sit here for months and then break the page the day an unrelated
// entry point starts reaching one half of it. These run in milliseconds and
// name the cycle.
// -----------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);

    // Follow no symlinks: `node_modules/@ce/*` points back at these same files.
    if (e === 'node_modules') continue;

    if (statSync(p).isDirectory()) sources(p, out);
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
  }

  return out;
}

/** Where a specifier lands, or null where it leaves the tree. */
function resolved(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;

  const base = normalize(join(dirname(from), spec));

  for (const c of [base + '.ts', join(base, 'index.ts')]) {
    try {
      if (statSync(c).isFile()) return c;
    }
    catch {
      // Not that one.
    }
  }

  return null;
}

/**
 * What a file reaches at runtime. A re-export is an edge like any other — the
 * cycle that started all this was `index.ts` re-exporting a file that
 * imported it back — so `export … from` counts here too.
 *
 * `import type` is erased and so is a brace list whose every specifier is
 * `type X`, and neither can hold a module open at load, which is the only
 * thing these rules are about.
 */
function edges(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];

  for (const m of src.matchAll(/^(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|[\w*\s,]+?)\s+from\s+'([^']+)'/gms)) {
    if (m[1] !== undefined) continue;

    const specs = (m[2] ?? '').split(',').map(s => s.trim()).filter(s => s !== '');

    if (specs.length > 0 && specs.every(s => s.startsWith('type '))) continue;

    const to = resolved(file, m[3]);

    if (to !== null) out.push(to);
  }

  return out;
}

const files = sources(join(ROOT, 'packages'));
const show = (p: string) => relative(join(ROOT, 'packages'), p);

describe('the module graph', () => {
  it('has no runtime cycle in it', () => {
    const grey = new Set<string>();
    const done = new Set<string>();
    const found: string[] = [];

    const walk = (at: string, stack: string[]): void => {
      grey.add(at);
      stack.push(at);

      for (const next of edges(at)) {
        if (grey.has(next)) found.push([...stack.slice(stack.indexOf(next)), next].map(show).join(' -> '));
        else if (!done.has(next)) walk(next, stack);
      }

      stack.pop();
      grey.delete(at);
      done.add(at);
    };

    for (const f of files) if (!done.has(f)) walk(f, []);

    expect(found).toEqual([]);
  });

  it('has no member importing its own barrel', () => {
    const bad = files.flatMap(f => edges(f)
      .filter(to => to.endsWith('/index.ts') && dirname(to) === dirname(f))
      .map(to => `${show(f)} imports its own ${show(to)}`));

    expect(bad).toEqual([]);
  });
});
