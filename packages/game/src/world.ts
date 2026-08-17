export type PolygonType = 'level' | 'solid' | 'floor';

export type ArtefactType = 'key' | 'exit' | 'delay' | 'decompress' | 'anchor' | 'compass' | 'start';

export interface Point {
  x: number
  y: number
}

export interface PolygonPoint {
  x: number
  y: number
  bnx: number  // bisector normal x (scaled so parallel offset works)
  bny: number  // bisector normal y (scaled so parallel offset works)
  enx: number  // edge normal x (unit) between current point and (next one | first one (if current point is last))
  eny: number  // edge normal y (unit) between current point and (next one | first one (if current point is last))
}

export interface Polygon {
  type: PolygonType
  points: PolygonPoint[]
}

export interface Artefact {
  x: number
  y: number
  type: ArtefactType
}

export interface Version {
  polygons: Polygon[]
}

export interface Path {
  points: Point[]
}

export interface World {
  paths: Path[]
  versions: Version[]
  artefacts: Artefact[]
}
