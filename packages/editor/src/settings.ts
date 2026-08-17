/** Editor preferences: what the editor does, rather than what the world is. */
export interface Settings {
  /** World units between two grid dots. */
  gridSize: number
  showGrid: boolean
  snapToGrid: boolean
}

export const defaultSettings: Settings = {
  gridSize: 32,
  showGrid: true,
  snapToGrid: true,
};
