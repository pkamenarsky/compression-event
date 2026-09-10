// -----------------------------------------------------------------------------
// The game, serving one level
//
//   pnpm server -- [--port 3000] level.json
//
// The dev server with the game at `/` and the given file at `/level.json`, which
// is what the game page loads. The file is read on every request rather than
// once, so a level saved over from the editor is the one the next reload plays.
//
// On every interface, as the dev server always is, so a phone on the same
// network can open the address it prints.
// -----------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

const { values, positionals } = parseArgs({
  options: { port: { type: 'string', short: 'p' } },
  allowPositionals: true,
});

if (positionals.length !== 1) {
  console.error('usage: pnpm server -- [--port <port>] <level.json>');
  process.exit(1);
}

// Against where the command was typed: `npm run` and `pnpm` both move into the
// package first, and say where they came from in INIT_CWD.
const level = resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]);

// Refused up front rather than at the first request: a typo in the path is
// better said here than as a page with nothing in it.
try {
  JSON.parse(await readFile(level, 'utf8'));
}
catch (e) {
  console.error(`${level}: ${e.message}`);
  process.exit(1);
}

const port = values.port === undefined ? Number(process.env.PORT) || 3000 : Number(values.port);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`--port ${values.port} is not a port`);
  process.exit(1);
}

/** `/level.json` from the file, and `/` to the game. */
const serving = {
  name: 'serve-level',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? '/').split('?')[0];

      if (path === '/') {
        res.statusCode = 302;
        res.setHeader('Location', '/game.html');
        res.end();
        return;
      }

      if (path !== '/level.json') {
        next();
        return;
      }

      try {
        const text = await readFile(level);

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(text);
      }
      catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
  },
};

const server = await createServer({
  root: resolve(import.meta.dirname, '..'),
  server: { port, strictPort: true },
  plugins: [serving],
});

await server.listen();

console.log(`\n  serving ${level}\n`);
server.printUrls();
