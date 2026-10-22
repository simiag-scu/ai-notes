import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WindowLifecycle, fitWindowBounds } from '../desktop/window-lifecycle.mjs';

const area = { x: 0, y: 30, width: 1470, height: 890 };
class NativeWindow extends EventEmitter {
  constructor() { super(); this.bounds = { x: 100, y: 80, width: 1100, height: 740 }; this.normal = { ...this.bounds }; this.visible = true; this.full = false; this.minimum = [850, 640]; this.calls = []; this.destroyed = false; }
  isDestroyed() { return this.destroyed; } isFullScreen() { return this.full; } isVisible() { return this.visible; } isMinimized() { return false; } isMaximized() { return false; }
  getNormalBounds() { return { ...this.normal }; } getBounds() { return { ...this.bounds }; }
  setMinimumSize(...size) { this.minimum = size; }
  setBounds(bounds) { this.calls.push('bounds'); this.bounds = { ...bounds }; this.normal = { ...bounds }; this.emit('resize'); }
  setFullScreen(full) { this.calls.push(full ? 'enter-request' : 'leave-request'); this.full = full; }
  show() { this.calls.push('show'); this.visible = true; } hide() { this.calls.push('hide'); this.visible = false; }
  focus() { this.calls.push('focus'); } restore() { this.calls.push('restore'); }
  entered() { this.full = true; this.bounds = { ...area }; this.emit('enter-full-screen'); }
  left() { this.full = false; this.bounds = { ...this.normal }; this.emit('leave-full-screen'); }
}
function fixture(t) {
  const window = new NativeWindow(), tasks = new Map(); let id = 0;
  const lifecycle = new WindowLifecycle(window, { screen: { getDisplayMatching: () => ({ workArea: area }) }, activate: () => window.calls.push('activate'), defer: fn => { tasks.set(++id, fn); return id; }, cancelDeferred: key => tasks.delete(key) });
  const flush = () => { for (const [key, task] of [...tasks]) { tasks.delete(key); task(); } };
  t.after(() => lifecycle.dispose()); return { window, lifecycle, flush };
}
test('全屏关闭等 native leave 事件及回调返回后才隐藏，不依赖同步 fullScreen 标记', t => {
  const { window, lifecycle, flush } = fixture(t); window.entered(); lifecycle.hide();
  assert.equal(window.visible, true); assert.deepEqual(window.calls, ['leave-request']);
  // Native state can turn false before did-exit-full-screen arrives.
  lifecycle.hide(); lifecycle.hide(); assert.equal(window.visible, true);
  window.left(); assert.equal(window.visible, true); flush();
  assert.equal(window.visible, false); assert.equal(window.full, false);
  assert.ok(window.calls.indexOf('bounds') < window.calls.indexOf('hide'));
  lifecycle.show(); assert.deepEqual(window.bounds, { x: 100, y: 80, width: 1100, height: 740 }); assert.equal(window.visible, true);
});
test('进入全屏动画中收到关闭，等待进入完成再退出，重复关闭不叠加切换', t => {
  const { window, lifecycle, flush } = fixture(t);
  lifecycle.toggleFullScreen(); lifecycle.hide(); lifecycle.hide();
  assert.deepEqual(window.calls, ['enter-request']); assert.equal(window.visible, true);
  window.entered(); assert.deepEqual(window.calls, ['enter-request', 'leave-request']);
  window.left(); flush(); assert.equal(window.visible, false); assert.equal(window.full, false);
});
test('退出全屏途中 Dock 激活取消待隐藏，完成动画后只恢复一次', t => {
  const { window, lifecycle, flush } = fixture(t); window.entered(); lifecycle.hide(); lifecycle.show(); lifecycle.show();
  assert.equal(window.calls.includes('show'), false); window.left(); flush();
  assert.equal(window.visible, true); assert.equal(window.full, false); assert.equal(window.calls.includes('hide'), false);
  assert.equal(window.calls.filter(x => x === 'show').length, 1);
});
test('窗口销毁取消未完成回调，不在退出时再次显示或改写窗口', t => {
  const { window, lifecycle, flush } = fixture(t); window.entered(); lifecycle.hide(); window.left();
  const calls = [...window.calls]; window.destroyed = true; window.emit('closed'); flush(); assert.deepEqual(window.calls, calls);
});
test('普通关闭保留窗口内容与尺寸，异常尺寸恢复为可操作大小并重设最小尺寸', t => {
  const { window, lifecycle } = fixture(t); lifecycle.hide(); assert.equal(window.full, false); lifecycle.show();
  assert.deepEqual(window.bounds, { x: 100, y: 80, width: 1100, height: 740 });
  window.visible = false; window.bounds = { x: -9000, y: 50, width: 2, height: 2 }; window.minimum = [0, 0];
  lifecycle.show(); assert.deepEqual(window.minimum, [850, 640]); assert.deepEqual(window.bounds, { x: 100, y: 80, width: 1100, height: 740 });
});
test('恢复位置适配外接屏断开、负坐标屏幕和较小工作区，拒绝微小缓存尺寸', () => {
  const fit = fitWindowBounds({ x: 9999, y: -500, width: 1100, height: 740 }, area);
  assert.deepEqual(fit, { x: 370, y: 30, width: 1100, height: 740 });
  const tiny = fitWindowBounds({ x: 0, y: 0, width: 1, height: 1 }, area); assert.ok(tiny.width >= 850 && tiny.height >= 640);
  const negative = fitWindowBounds({ x: -2000, y: 80, width: 1100, height: 740 }, { x: -1470, y: 0, width: 1470, height: 900 }); assert.equal(negative.x, -1470);
  assert.deepEqual(fitWindowBounds(null, { x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 0, width: 800, height: 600 });
});
