import { root } from '@incpt/kontinuum-dom';

import { editor } from './editor';
import { emptyWorld } from './world';

root(document.getElementById('app')!, editor(emptyWorld()));
