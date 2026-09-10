// -----------------------------------------------------------------------------
// The tweak panel
//
// The render config, on screen, while the game runs behind it: a switch for
// every stage and a slider for every number, built off the config's own shape
// so that a field added to `RenderConfig` turns up here without anyone telling
// this file. Where each slider runs is `RANGES` in `config.ts`.
//
// Along the top: the presets and the configurations saved in this browser, to
// switch between; saving the one in force under a name; copying it out as a
// literal to paste into `PRESETS`; and holding the warp at a fixed amount, so
// that it can be looked at without waiting for the level to close.
//
// Owns no state but what is on screen. The config is the caller's: the panel
// asks for it and hands back a changed copy.
// -----------------------------------------------------------------------------

import { PRESETS, RANGES, RenderConfig, forget, save, saved } from './config';
import { WARPS } from './warp';

export interface Tweak {
  readonly open: boolean
  toggle(): void
  /** Bring the controls back into line with the config, after it was changed
   * from somewhere else. */
  refresh(): void
  /** Whether an event happened inside the panel, so that the game can leave
   * keys typed into it alone. */
  holds(target: EventTarget | null): boolean
  /** The amount the warp is held at, or null to let the level drive it. */
  held(): number | null
  dispose(): void
}

type Leaf = boolean | number | string;

export function tweak(
  host: HTMLElement,
  config: () => RenderConfig,
  set: (next: RenderConfig) => void,
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
  for (const type of ['click', 'mousedown', 'pointerdown']) {
    panel.addEventListener(type, e => e.stopPropagation());
  }

  host.append(panel);

  let open = false;
  let hold: number | null = null;

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

    // The one string there is, and the one there is a list of.
    const it = el('select', 'font: inherit; flex: 1;');

    for (const w of WARPS) it.append(new Option(w, w, false, w === value));

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

    // Holding the warp still, so there is something to look at between shifts.
    const holding = el('input');

    holding.type = 'checkbox';
    holding.checked = hold !== null;

    const [slider, exact] = number(['hold'], hold ?? 1, v => {
      if (hold !== null) hold = v;
    });

    slider.min = '-1';
    slider.max = '1';

    holding.addEventListener('change', () => {
      hold = holding.checked ? Number(slider.value) : null;
    });

    it.append(row('hold warp', holding, slider, exact));

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

    holds(target: EventTarget | null): boolean {
      return target instanceof Node && panel.contains(target);
    },

    held(): number | null {
      return hold;
    },

    dispose(): void {
      panel.remove();
    },
  };
}
