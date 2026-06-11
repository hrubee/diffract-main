/**
 * Flat, solid backdrop.
 *
 * Renders a single full-viewport fill in the theme's canvas color. It reads
 * the theme-switchable `--background-base` custom property so `ThemeProvider`
 * can repaint it without a remount.
 *
 * Previously this composited the Nous DS `<Overlays dark />` look — a bundled
 * filler photo (z-2), a warm corner vignette (z-99), and an animated noise
 * grain (z-101). Those layers are intentionally removed so the canvas is a
 * single solid color (dark maroon by default) with no imagery or texture.
 */
export function Backdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1]"
      style={{ backgroundColor: "var(--background-base)" }}
    />
  );
}
