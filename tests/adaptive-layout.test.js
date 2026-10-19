import { describe, expect, it, vi } from 'vitest';
import { bindAdaptiveLayout } from '../src/ui/adaptive-layout';

function setup() {
  const handlers = new Map(), visualHandlers = new Map(), frames = new Map(), values = new Map();
  let nextFrame = 0;
  const win = { innerWidth: 852, innerHeight: 393,
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener: type => handlers.delete(type),
    visualViewport: { addEventListener: (type, fn) => visualHandlers.set(type, fn), removeEventListener: type => visualHandlers.delete(type) },
  };
  let resize;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(fn) { resize = fn; } observe() {} disconnect = disconnect; });
  let rect = { top: 59, left: 20, right: 832, bottom: 359, width: 812, height: 350 };
  const surface = { ownerDocument: { defaultView: win }, dataset: {}, style: { setProperty: (key,value) => values.set(key,value), removeProperty: key => values.delete(key) }, getBoundingClientRect: () => rect };
  const binding = bindAdaptiveLayout(surface);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  return { surface, win, values, frames, handlers, visualHandlers, binding, disconnect, flush, resize: () => resize(), setRect: value => { rect = value; } };
}

describe('adaptive pane layout', () => {
  it('measures existing host clearance rather than blindly duplicating safe areas', () => {
    const ui = setup(); ui.flush();
    expect(ui.values.get('--mia-pane-top')).toBe('59px');
    expect(ui.values.get('--mia-pane-left')).toBe('20px');
    expect(ui.values.get('--mia-pane-right-gap')).toBe('20px');
    expect(ui.values.get('--mia-pane-bottom-gap')).toBe('34px');
    expect(ui.surface.dataset.viewportHeight).toBe('short');
    ui.binding.destroy(); vi.unstubAllGlobals();
  });
  it('coalesces rotation, pane and visual viewport changes and ignores hidden panes', () => {
    const ui = setup(); ui.flush();
    ui.setRect({top:0,left:0,right:393,bottom:852,width:393,height:852});
    ui.win.innerWidth = 393; ui.win.innerHeight = 852;
    ui.resize(); ui.handlers.get('resize')(); ui.visualHandlers.get('resize')();
    expect(ui.frames.size).toBe(1); ui.flush();
    expect(ui.values.get('--mia-pane-top')).toBe('0px');
    expect(ui.surface.dataset.viewportHeight).toBe('regular');
    ui.setRect({top:0,left:0,right:0,bottom:0,width:0,height:0}); ui.resize(); ui.flush();
    expect(ui.values.get('--mia-pane-width')).toBe('393px');
    ui.binding.destroy(); vi.unstubAllGlobals();
  });
  it('removes listeners, observers, pending work and styles on close', () => {
    const ui = setup(); ui.flush(); ui.resize(); ui.binding.destroy();
    expect(ui.disconnect).toHaveBeenCalledOnce();
    expect(ui.frames.size).toBe(0); expect(ui.handlers.size).toBe(0); expect(ui.visualHandlers.size).toBe(0);
    expect(ui.values.size).toBe(0); expect(ui.surface.dataset.viewportHeight).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
