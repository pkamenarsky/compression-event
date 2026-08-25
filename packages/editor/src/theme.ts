export const theme = {
  /** The canvas, and what is drawn on it. */
  canvas: '#16171b',
  grid: '#34363f',
  axis: '#4a4d59',
  selection: '#5b8cff',
  selectionFill: 'rgba(91, 140, 255, 0.14)',

  /**
   * Other versions, drawn as outlines under the one on screen. Indexed by how
   * many versions away, so the ramp reads as a direction: earlier is cool,
   * later is warm. Opacity alone goes muddy past about three stacked, so the
   * hue ramps too, and the depth drawn is capped at the length of these.
   */
  ghostBehind: [
    'rgba(110, 150, 230, 0.50)',
    'rgba(120, 120, 220, 0.32)',
    'rgba(130, 100, 205, 0.20)',
    'rgba(130, 90, 190, 0.13)',
  ],
  ghost: [
    'rgba(235, 165, 90, 0.50)',
    'rgba(230, 135, 85, 0.32)',
    'rgba(220, 110, 90, 0.20)',
    'rgba(205, 95, 95, 0.13)',
  ],

  /** The polygons as drawn, and the set the game would see. */
  level: '#7b8496',
  solid: '#b0705f',
  picked: '#5b8cff',
  /** Under a picked polygon. Faint enough that two overlapping ones still read
   * as two, and that the CSG outline over the top keeps the eye. */
  pickedFill: 'rgba(91, 140, 255, 0.16)',
  /** Under a picked group. A group is not a kind of polygon and gets no line
   * of its own — it is drawn as the union it stands for, in the stroke of its
   * kind — so the fill is the whole of what says one is picked rather than
   * several polygons. */
  groupFill: 'rgba(95, 185, 138, 0.16)',
  /** Outside the group standing open: still drawn, so the level around it can
   * be worked against, but not pickable and not competing for the eye. */
  outside: '#4a4d57',
  vertex: '#c8cad2',
  /** The source ring under an eroded polygon: where the handles are. */
  source: '#6f7788',
  draft: '#8fb4ff',
  csg: '#f2c14e',
  /** The bake played back: the same set, but the one the game would draw, so
   * it is thinner and brighter than the editor's own answer sitting under it. */
  replay: '#ffe98c',

  /** The chrome floating above it. */
  panel: '#2a2b31',
  panelShadow: 'rgba(0, 0, 0, 0.45)',
  border: '#3d3f47',
  text: '#e8e8ea',
  muted: '#9a9ba3',
  faded: '#6b6d76',
  accent: '#5b8cff',
  onAccent: '#0f1116',
};
