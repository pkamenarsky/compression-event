import { World } from '@ce/game/world';

export * from '@ce/game/world';

export function emptyWorld(): World {
  return {
    paths: [],
    versions: [],
    artefacts: [],
  };
}
