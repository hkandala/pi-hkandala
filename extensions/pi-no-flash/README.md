# pi-no-flash

No flash of pi's own UI at startup.

pi draws its UI before extensions start, then draws it again once they have set their header, footer, and editor. For a moment you see pi's own header and footer, then they change. pi-no-flash holds pi's frames until pi finishes starting, so the first frame already shows every extension's UI, for example [pi-header](../pi-header/README.md), [pi-footer](../pi-footer/README.md), and [pi-content-layout](../pi-content-layout/README.md).

- It waits at most 1 second. If an extension opens a dialog at startup, the dialog still shows.
- It acts only at startup. `/reload` does not draw pi's own UI, so there is nothing to hold.
- It works in both TUI modes, regular and fullscreen. Other modes (`-p`, RPC) draw no TUI, so it does nothing there.

pi has no API for this. pi-no-flash patches the render methods of pi-tui's screens, and puts them back once pi has started. It may need an update when pi changes how it starts.

## Install

```bash
pi install npm:@hkandala/pi-no-flash
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-no-flash`.

## Configuration

None.
