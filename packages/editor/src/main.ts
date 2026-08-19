import { root } from '@incpt/kontinuum-dom';

import { editor } from './editor';
import { emptyWorld } from './types';

root(document.getElementById('app')!, editor(emptyWorld()));
