// -----------------------------------------------------------------------------
// The page
//
// A window of its own for the game, and nothing to put in it yet: a level comes
// from the editor, which stands the game up in its own page with `play`. What
// is missing here is a level to *load* — a file, or whatever the game is
// eventually shipped as — and until there is one this page has nothing to say
// but where the door is.
// -----------------------------------------------------------------------------

const host = document.getElementById('screen')!;

host.textContent = 'no level here yet — press ⌘↵ in the editor';
host.style.cssText += `
  display: flex; align-items: center; justify-content: center;
  font: 13px ui-monospace, monospace; color: #666;
`;
