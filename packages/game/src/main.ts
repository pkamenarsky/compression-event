import { World } from './world';

const world: World = {
  paths: [],
  versions: [],
  artefacts: [],
};

const screen = document.getElementById('screen') as HTMLCanvasElement;
const ctx = screen.getContext('2d')!;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  screen.width = Math.floor(screen.clientWidth * dpr);
  screen.height = Math.floor(screen.clientHeight * dpr);
}

function frame() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, screen.width, screen.height);

  ctx.fillStyle = '#555';
  ctx.font = `${Math.floor(screen.height / 40)}px ui-monospace, monospace`;
  ctx.fillText(
    `compression event — ${world.versions.length} versions`,
    24,
    screen.height - 24,
  );

  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
