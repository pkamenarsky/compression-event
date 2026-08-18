import { root } from '@incpt/kontinuum-dom';

import { editor } from './editor';
import { EMPTY_WORLD } from './types';

root(document.getElementById('app')!, editor(EMPTY_WORLD));
