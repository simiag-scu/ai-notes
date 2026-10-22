export const minimumWindowSize = { width: 850, height: 640 };
const defaultWindowSize = { width: 1440, height: 960 };
const finite = value => Number.isFinite(value);

export function fitWindowBounds(bounds, workArea) {
  const minWidth = Math.min(minimumWindowSize.width, workArea.width);
  const minHeight = Math.min(minimumWindowSize.height, workArea.height);
  const valid = bounds && finite(bounds.width) && finite(bounds.height) && bounds.width >= minWidth && bounds.height >= minHeight;
  const width = Math.round(Math.min(workArea.width, Math.max(minWidth, valid ? bounds.width : defaultWindowSize.width)));
  const height = Math.round(Math.min(workArea.height, Math.max(minHeight, valid ? bounds.height : defaultWindowSize.height)));
  const x = valid && finite(bounds.x) ? bounds.x : workArea.x + (workArea.width - width) / 2;
  const y = valid && finite(bounds.y) ? bounds.y : workArea.y + (workArea.height - height) / 2;
  return { x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))), y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))), width, height };
}

// Native macOS fullscreen is asynchronous. Never order a window out of its
// fullscreen Space before did-exit-full-screen, even if isFullScreen is already
// false during the animation. Keep one desired visibility for repeated close /
// Dock activations, and never save intermediate animation frames as normal size.
export class WindowLifecycle {
  constructor(window, { screen, activate, defer = setImmediate, cancelDeferred = clearImmediate }) {
    Object.assign(this, { window, screen, activate, defer, cancelDeferred });
    this.phase = window.isFullScreen() ? 'full-screen' : 'normal';
    this.desiredVisible = window.isVisible();
    this.normalBounds = window.getNormalBounds();
    this.restoreBounds = false; this.pending = null; this.disposed = false;
    this.listeners = new Map();
    this.on('resize', () => this.remember()); this.on('move', () => this.remember());
    this.on('enter-full-screen', () => {
      this.phase = 'full-screen';
      if (!this.desiredVisible || this.restoreBounds) this.exitFullScreen();
    });
    this.on('leave-full-screen', () => {
      // Finish after the native delegate returns, not from inside its callback.
      this.phase = 'settling';
      this.schedule(() => { this.phase = 'normal'; if (this.restoreBounds) this.repairBounds(true); this.restoreBounds = false; this.applyVisibility(); });
    });
    this.on('closed', () => this.dispose());
  }
  on(event, listener) { this.listeners.set(event, listener); this.window.on(event, listener); }
  alive() { return !this.disposed && !this.window.isDestroyed(); }
  remember() {
    const w = this.window;
    if (!this.alive() || this.phase !== 'normal' || this.restoreBounds || !this.desiredVisible || !w.isVisible() || w.isFullScreen() || w.isMinimized() || w.isMaximized()) return;
    const bounds = w.getNormalBounds();
    if (bounds.width >= minimumWindowSize.width && bounds.height >= minimumWindowSize.height) this.normalBounds = bounds;
  }
  schedule(operation) {
    if (this.pending !== null) this.cancelDeferred(this.pending);
    this.pending = this.defer(() => { this.pending = null; if (this.alive()) operation(); });
  }
  repairBounds(force = false) {
    const w = this.window;
    if (!this.alive() || this.phase !== 'normal' || w.isFullScreen()) return;
    const current = w.getBounds();
    const invalidSize = current.width < minimumWindowSize.width || current.height < minimumWindowSize.height;
    const source = force || invalidSize ? this.normalBounds : current;
    const area = this.screen.getDisplayMatching(source).workArea;
    const minimum = [Math.min(minimumWindowSize.width, area.width), Math.min(minimumWindowSize.height, area.height)];
    w.setMinimumSize(...minimum);
    const bounds = fitWindowBounds(source, area);
    if (force || Object.keys(bounds).some(key => bounds[key] !== current[key])) w.setBounds(bounds, false);
    this.normalBounds = bounds;
  }
  applyVisibility() {
    if (!this.alive() || this.phase !== 'normal') return;
    const w = this.window;
    if (!this.desiredVisible) { w.hide(); return; }
    if (w.isMinimized()) w.restore();
    this.repairBounds();
    w.show(); w.focus(); this.activate();
  }
  exitFullScreen() {
    if (!this.alive() || this.phase === 'leaving' || this.phase === 'settling') return;
    this.restoreBounds = true;
    if (this.phase === 'entering') return; // Wait for did-enter before reversing it.
    this.phase = 'leaving';
    this.window.setFullScreen(false);
  }
  hide() {
    if (!this.alive()) return;
    this.remember(); this.desiredVisible = false;
    if (this.phase !== 'normal' || this.window.isFullScreen()) { this.exitFullScreen(); return; }
    this.applyVisibility();
  }
  show() {
    if (!this.alive()) return;
    this.desiredVisible = true;
    if (this.phase === 'leaving' || this.phase === 'settling' || this.restoreBounds) return;
    if (this.window.isFullScreen() || this.phase === 'entering' || this.phase === 'full-screen') { this.window.show(); this.window.focus(); this.activate(); return; }
    this.applyVisibility();
  }
  toggleFullScreen() {
    if (!this.alive() || this.phase === 'entering' || this.phase === 'leaving' || this.phase === 'settling') return;
    this.desiredVisible = true;
    if (this.window.isFullScreen()) { this.phase = 'leaving'; this.window.setFullScreen(false); }
    else { this.remember(); this.phase = 'entering'; this.window.setFullScreen(true); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pending !== null) this.cancelDeferred(this.pending);
    for (const [event, listener] of this.listeners) this.window.removeListener(event, listener);
    this.listeners.clear();
  }
}
