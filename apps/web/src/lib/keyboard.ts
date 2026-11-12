// The on-screen keyboard. It covers the page without resizing it (iOS always, Android by default), so a bar pinned to the
// bottom would hide under it. While it is up --keyboard holds its height and the frame and the sheets stand above it
// (globals.css); the tab bar steps aside (data-keyboard, tab-bar.tsx).
const OPEN = 80;

export function watchKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv || !matchMedia("(pointer: coarse)").matches) return;
  const root = document.documentElement;
  const sync = () => {
    const height = innerHeight - vv.height - vv.offsetTop;
    const open = height > OPEN;
    root.style.setProperty("--keyboard", open ? `${height}px` : "0px");
    root.toggleAttribute("data-keyboard", open);
    // iOS slides the page up to show the field; the frame already stands above the keyboard.
    if (open && scrollY) scrollTo(0, 0);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
}
