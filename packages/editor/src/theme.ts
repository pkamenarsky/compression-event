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
   * The polygons as drawn, and the two sets the game would see.
   *
   * One line per set, and within a set one line for both ways a polygon can
   * go. The stroke has two things of its own to say — whether a shape is
   * picked, and whether it can be reached at all — and a third meaning stacked
   * on those made all three harder to read. So which way a polygon goes is a
   * fill instead, and these are what the ones that have a fill are filled with.
   */
  level: '#7b8496',
  /**
   * A floor's own outline. Warm where the level is cool, because the two are
   * separate sets that overlap by construction — a floor is nearly always
   * drawn inside a room — and one line for both would leave a drawing where
   * every floor edge reads as a wall that is not there.
   *
   * This is the one thing the stroke says besides picked and reachable, and it
   * gets to because it is not a third meaning stacked on the same axis: it is
   * *which drawing this line belongs to*, and both drawings then say picked
   * and reachable in their own terms.
   */
  floor: '#b07a45',
  /** What a pillar is hatched with: it is material taken away, and hatching
   * says which side of the line the material is on, which a ring alone never
   * did. Faint, because a pillar should not out-shout the room it stands in. */
  solidHatch: 'rgba(176, 112, 95, 0.42)',
  /** A hole cut in a floor, stippled. Read against `solidHatch` rather than
   * against the canvas — the two are what say which way a shape goes, so they
   * differ in texture before they differ in colour. */
  floorDots: 'rgba(196, 132, 74, 0.55)',
  /**
   * A floor, filled — faintly, because it is the ordinary case on its side of
   * the drawing the way a room is on the other.
   *
   * A room is left unfilled and a floor is not, which is not an inconsistency:
   * a floor lies *inside* something, and one drawn as an outline alone inside
   * a group's outline leaves nothing saying which side of it the floor is on.
   * A ring that is a hole and a ring that is an island look the same until one
   * of them is filled.
   */
  floorFill: 'rgba(196, 132, 74, 0.10)',
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
  /**
   * Under a picked *loose* group, which is a different thing and says so in a
   * different colour. A sealed group is a shape in the set and fills green
   * with the rest of what a group means; a loose one is a handle round shapes
   * that are in the set on their own account, and orange is what says the two
   * are not the same kind of thing at a glance.
   */
  looseFill: 'rgba(214, 148, 78, 0.16)',
  /**
   * The same green as a line, for the things that are picked by way of a group
   * rather than in themselves.
   *
   * A measuring path is the one thing that needs it. Everything else in a
   * picked group is drawn as part of the union and says so with `groupFill`; a
   * tape is not in any union — it is a line lying over one — so it has to say
   * it in its own stroke. Blue is what a thing picked in itself is drawn in
   * everywhere, so a tape that turns green is saying *the group has hold of me,
   * not you*, which is the difference that decides what the next gesture moves.
   */
  grouped: '#5fb98a',
  /** Outside the group standing open: still drawn, so the level around it can
   * be worked against, but not pickable and not competing for the eye. */
  outside: '#4a4d57',
  vertex: '#c8cad2',
  /** The source ring under an eroded polygon: where the handles are. */
  source: '#6f7788',
  /**
   * The same ring where it is the whole of what is on screen: a shape eroded
   * away to nothing, drawn as the ground it started on.
   *
   * Red, and only where such a shape is *not* picked. Everything else on the
   * canvas says whether it is picked with its own outline — the heavy stroke
   * and the fill under it — and a shape with no outline left has nothing to
   * say it with, so the dashed ring has to say both at once: this is here, and
   * this is not the one you have hold of. Picking it puts it back in `source`,
   * which is the colour every other source ring is drawn in.
   */
  gone: '#b8574f',
  /** The hairline joining a corner to where the erosion sent it. Under the
   * source's own line, because it is an aside about a ring already drawn. */
  leader: 'rgba(111, 119, 136, 0.55)',
  draft: '#8fb4ff',
  /** A measuring path. Not part of the level and not any kind of shape, so it
   * gets a line of its own — warm, because everything the level is made of is
   * cool, and a tape laid over a drawing should read as being on top of it
   * rather than in it. */
  path: '#e0a35c',
  pathText: '#f0c894',
  csg: '#f2c14e',
  /** The floor set the game would see, over the top the same way. Orange to
   * the level's yellow: two answers about two sets, drawn in the same weight
   * because neither is an aside about the other. */
  csgFloor: '#e07c2e',
  /** The bake played back: the same sets, but the ones the game would draw, so
   * they are thinner and brighter than the editor's own answer sitting under
   * them. */
  replay: '#ffe98c',
  replayFloor: '#ffbe7a',

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
