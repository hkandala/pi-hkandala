/**
 * pi-no-flash: no flash of pi's own UI at startup. See README.md.
 */
import { TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

/**
 * pi draws its UI before extensions start (session_start), then again once they have, with their
 * header, footer, and editor: a flash of pi's own UI. Hold its frames until then: pi ends startup
 * with renderNow(), its only call at startup. At most 1s, should that change or a dialog wait.
 * Only at startup, not on /reload (pi doesn't call renderNow() then).
 */
export default function holdStartupFrames() {
  const g = globalThis as Record<symbol, unknown>;
  const key = Symbol.for("pi-no-flash.started");
  if (g[key]) return;
  g[key] = true;
  type Screen = { doRender(): void; renderNow?(...args: unknown[]): void; requestRender(): void };
  const screens = [TuiAltScreen.prototype, TuiMainScreen.prototype] as unknown as Screen[];
  const renders = screens.map((p) => p.doRender);
  const held = new Set<Screen>();
  const release = () => {
    clearTimeout(timer);
    screens.forEach((p, i) => {
      p.doRender = renders[i]!;
      delete p.renderNow; // back to the inherited one
    });
    for (const tui of held) tui.requestRender();
  };
  const timer = setTimeout(release, 1000);
  timer.unref();
  for (const p of screens) {
    const renderNow = p.renderNow!; // inherited
    p.doRender = function (this: Screen) {
      held.add(this);
    };
    p.renderNow = function (this: Screen, ...args: unknown[]) {
      release();
      return renderNow.apply(this, args);
    };
  }
}
