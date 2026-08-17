import { World } from './world';
import { Settings, defaultSettings } from './settings';
import { Tool } from './tool';
import { View, defaultView } from './view';

/**
 * Everything the editor is. Immutable throughout: a field that did not change
 * keeps its identity, which is what lets `object` wake only the parts that
 * care — panning touches `view` and nothing redraws but the canvas.
 */
export interface EditorState {
  world: World
  settings: Settings
  view: View
  tool: Tool
}

/** Everything that writes to the store goes through one of these. */
export type Update = (fn: (s: EditorState) => EditorState) => void;

export function initialState(world: World): EditorState {
  return {
    world,
    settings: defaultSettings,
    view: defaultView,
    tool: 'point',
  };
}
