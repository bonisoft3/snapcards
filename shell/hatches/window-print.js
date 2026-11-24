export default (screen, { signal }) => {
  for (const el of screen.querySelectorAll("#btn-window-print, #btn-print-trigger")) el.addEventListener("click", () => window.print(), { signal });
  return () => {};
};
