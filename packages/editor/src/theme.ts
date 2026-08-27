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

  /**
   * The polygons as drawn, and the set the game would see.
   *
   * One line for every kind of polygon. The stroke has two things of its own
   * to say — whether a shape is picked, and whether it can be reached at all —
   * and a third meaning stacked on it made all three harder to read. So the
   * kind is a fill instead, and these are what the two kinds that have one are
   * filled with.
   */
  level: '#7b8496',
  /** A solid is hatched: it is material taken away, and hatching says which
   * side of the line the material is on, which a ring alone never did. Faint,
   * because a pillar should not out-shout the room it stands in. */
  solidHatch: 'rgba(176, 112, 95, 0.42)',
  /** A floor is stippled: it is in no set at all, drawn flat underfoot and
   * nothing else. Read against `solidHatch` rather than against the canvas —
   * the two are the whole of what says which kind a shape is, so they differ
   * in texture before they differ in colour. */
  floorDots: 'rgba(150, 142, 160, 0.55)',
  /** An artefact. Not a kind of shape, so none of the polygon strokes would be
   * right for it — and nothing else in the level is this colour, which is what
   * a handful of small things scattered over a drawing needs. */
  artefact: '#6ec9b7',
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
  /** A measuring path. Not part of the level and not any kind of shape, so it
   * gets a line of its own — warm, because everything the level is made of is
   * cool, and a tape laid over a drawing should read as being on top of it
   * rather than in it. */
  path: '#e0a35c',
  pathText: '#f0c894',
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
