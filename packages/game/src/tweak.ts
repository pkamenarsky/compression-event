// -----------------------------------------------------------------------------
// The tweak panel
//
// The render config, on screen, over the editor's first-person view: a switch
// for every stage, a slider for every number and a picker for every colour,
// built off the config's own shape so that a field added to `RenderConfig`
// turns up here without anyone telling this file. Where each slider runs is
// `RANGES` in `config.ts`; a string starting `#` is a colour.
//
// Along the top: the presets and the configurations saved in this browser, to
// switch between; saving the one in force under a name; copying it out as a
// literal to paste into `PRESETS`; and whatever switches of its own the view
// hosting it wants to put there.
//
// Owns no state but what is on screen. The config is the caller's: the panel
// asks for it and hands back a changed copy. Keys typed into it stay in it, so
// that a number being typed is not a shortcut to whatever is underneath.
// -----------------------------------------------------------------------------

import { PRESETS, RANGES, RenderConfig, forget, save, saved } from './config';
import { SKIES } from './sky';
import { WARPS } from './warp';

export interface Tweak {
  readonly open: boolean
  toggle(): void
  /** Bring the controls back into line with the config, after it was changed
   * from somewhere else. */
  refresh(): void
  dispose(): void
}

/** A switch the hosting view puts along the top, for something that is its
 * own business rather than the config's. */
export interface Toggle {
  label: string
  get(): boolean
  set(on: boolean): void
}

/** The keys that still reach the page from inside the panel: the ones that
 * close it, and leave. */
const PASSED = ['Backquote', 'Escape'];

type Leaf = boolean | number | string;

export function tweak(
  host: HTMLElement,
  config: () => RenderConfig,
  set: (next: RenderConfig) => void,
  toggles: Toggle[] = [],
): Tweak {
  const panel = document.createElement('div');

  panel.style.cssText = `
    position: absolute; right: 8px; top: 26px; width: 280px;
    max-height: calc(100% - 40px); overflow-y: auto;
    background: rgba(0, 0, 0, 0.85); color: #ddd;
    font: 11px ui-monospace, monospace; padding: 8px;
    z-index: 11; display: none;
  `;

  // The host grabs the pointer on a click, and a click on a slider is not one
  // meant for the game.
  for (const type of ['click', 'mousedown', 'pointerdown', 'wheel']) {
    panel.addEventListener(type, e => e.stopPropagation());
  }

  for (const type of ['keydown', 'keyup'] as const) {
    panel.addEventListener(type, e => {
      if (!PASSED.includes(e.code)) e.stopPropagation();
    });
  }

  host.append(panel);

  let open = false;

  /** What the list along the top last loaded, so that forgetting knows which. */
  let chosen = '';

  /** A changed copy of the config, with the field at `path` set. */
  const changed = (path: string[], value: Leaf): RenderConfig => {
    const next = structuredClone(config());
    let at = next as unknown as Record<string, unknown>;

    for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;

    at[path[path.length - 1]] = value;

    return next;
  };

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] => {
    const it = document.createElement(tag);

    it.style.cssText = css;
    it.textContent = text;

    return it;
  };

  const button = (text: string, act: () => void): HTMLButtonElement => {
    const it = el('button', 'font: inherit; margin-left: 4px;', text);

    it.addEventListener('click', act);

    return it;
  };

  const row = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const it = el('div', 'display: flex; align-items: center; gap: 6px; margin: 2px 0;');

    it.append(el('span', 'flex: 0 0 84px; color: #999;', label), ...controls);

    return it;
  };

  /** A slider and a box for the exact number, kept in step with each other. */
  const number = (path: string[], value: number, commit: (v: number) => void): [HTMLInputElement, HTMLInputElement] => {
    const [min, max, step] = RANGES[path.join('.')] ?? [0, Math.max(1, Math.abs(value) * 3), 0.01];
    const slider = el('input', 'flex: 1; min-width: 0;');
    const exact = el('input', 'width: 48px; font: inherit;');

    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);

    exact.type = 'number';
    exact.step = String(step);
    exact.value = String(value);

    slider.addEventListener('input', () => {
      exact.value = slider.value;
      commit(Number(slider.value));
    });

    exact.addEventListener('change', () => {
      if (exact.value === '' || !Number.isFinite(Number(exact.value))) return;

      slider.value = exact.value;
      commit(Number(exact.value));
    });

    return [slider, exact];
  };

  /** One field of the config, as whatever control its value calls for. */
  const control = (path: string[], value: Leaf): HTMLElement[] => {
    const commit = (v: Leaf): void => set(changed(path, v));

    if (typeof value === 'boolean') {
      const it = el('input');

      it.type = 'checkbox';
      it.checked = value;
      it.addEventListener('change', () => commit(it.checked));

      return [it];
    }

    if (typeof value === 'number') return number(path, value, commit);

    if (value.startsWith('#')) {
      const it = el('input', 'width: 48px; height: 18px; padding: 0; border: 0; background: none;');
      const exact = el('span', 'color: #999;', value);

      it.type = 'color';
      it.value = value;
      it.addEventListener('input', () => {
        exact.textContent = it.value;
        commit(it.value);
      });

      return [it, exact];
    }

    // The strings there are, each out of its own list.
    const it = el('select', 'font: inherit; flex: 1;');
    const kinds: readonly string[] = path[0] === 'sky' ? SKIES : WARPS;

    for (const w of kinds) it.append(new Option(w, w, false, w === value));

    it.addEventListener('change', () => commit(it.value));

    return [it];
  };

  /** Every field under `path`, nested ones indented under their name. */
  const fields = (into: HTMLElement, path: string[], node: Record<string, unknown>, depth: number): void => {
    for (const [key, value] of Object.entries(node)) {
      const at = [...path, key];

      if (typeof value === 'object' && value !== null) {
        into.append(el('div', `margin: 6px 0 2px ${depth * 10}px; color: #7f7;`, key));
        fields(into, at, value as Record<string, unknown>, depth + 1);
      }
      else {
        const it = row(key, ...control(at, value as Leaf));

        it.style.marginLeft = `${depth * 10}px`;
        into.append(it);
      }
    }
  };

  const everything = (): Record<string, RenderConfig> => ({
    ...Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [`preset: ${k}`, v])),
    ...Object.fromEntries(Object.entries(saved()).map(([k, v]) => [`saved: ${k}`, v])),
  });

  /** The top: what to load, and what to do with the one in force. */
  const header = (): HTMLElement => {
    const it = el('div');
    const list = el('select', 'font: inherit; flex: 1;');
    const all = everything();

    list.append(new Option('— load —', ''));

    for (const name of Object.keys(all)) list.append(new Option(name, name, false, name === chosen));

    list.addEventListener('change', () => {
      if (list.value === '') return;

      chosen = list.value;
      set(structuredClone(all[chosen]));
      build();
    });

    const saving = button('save', () => {
      const name = prompt('save this configuration as', chosen.replace(/^saved: /, ''));

      if (name === null || name.trim() === '') return;

      save(name.trim(), config());
      chosen = `saved: ${name.trim()}`;
      build();
    });

    const copying = button('copy', () => {
      // A literal in this codebase's style, ready to go into `PRESETS`.
      const literal = JSON.stringify(config(), null, 2)
        .replace(/"(\w+)":/g, '$1:')
        .replace(/"/g, '\'');

      void navigator.clipboard?.writeText(literal);
    });

    const forgetting = button('forget', () => {
      if (!chosen.startsWith('saved: ')) return;

      forget(chosen.slice('saved: '.length));
      chosen = '';
      build();
    });

    forgetting.disabled = !chosen.startsWith('saved: ');

    const top = el('div', 'display: flex; align-items: center; margin-bottom: 6px;');

    top.append(list);
    it.append(top, row('', saving, copying, forgetting));

    for (const t of toggles) {
      const box = el('input');

      box.type = 'checkbox';
      box.checked = t.get();
      box.addEventListener('change', () => t.set(box.checked));

      it.append(row(t.label, box));
    }

    return it;
  };

  const build = (): void => {
    const scroll = panel.scrollTop;

    panel.replaceChildren(header());
    fields(panel, [], config() as unknown as Record<string, unknown>, 0);
    panel.scrollTop = scroll;
  };

  return {
    get open(): boolean {
      return open;
    },

    toggle(): void {
      open = !open;
      panel.style.display = open ? 'block' : 'none';

      if (open) build();
    },

    refresh(): void {
      if (open) build();
    },

    dispose(): void {
      panel.remove();
    },
  };
}
