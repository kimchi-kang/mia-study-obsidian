import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudyAutoAdvance } from "../src/ui/study-auto-advance";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
let dom, auto, parent;
beforeEach(() => {
  vi.useFakeTimers();vi.setSystemTime(0);dom=new JSDOM("<body><div>과목 / 정의형</div></body>",{pretendToBeVisual:true});
  const proto=dom.window.HTMLElement.prototype;
  proto.createSpan=function({cls,attr}){const el=this.ownerDocument.createElement("span");el.className=cls;for(const [key,value]of Object.entries(attr))el.setAttribute(key,value);this.append(el);return el;};
  proto.setText=function(text){this.textContent=text;};proto.setAttr=function(key,value){this.setAttribute(key,value);};
  auto=new StudyAutoAdvance();parent=dom.window.document.querySelector("div");
});
afterEach(()=>{auto.reset();dom.window.close();vi.useRealTimers();});
it("pauses on modal open/close at tick time",()=>{
  auto.render(parent,"q",10);vi.advanceTimersByTime(2500);
  const modal=dom.window.document.createElement("div");modal.className="modal-container";dom.window.document.body.append(modal);auto.tick();
  vi.advanceTimersByTime(20000);expect(auto.tick()).toBe(false);
  modal.remove();auto.tick();vi.advanceTimersByTime(7499);expect(auto.tick()).toBe(false);vi.advanceTimersByTime(1);expect(auto.tick()).toBe(true);
});
it("keeps pagehide paused until resume, and respects hidden documents",()=>{
  auto.render(parent,"answer",3);vi.advanceTimersByTime(1000);auto.pause();vi.advanceTimersByTime(10000);expect(auto.tick()).toBe(false);
  auto.resume();vi.advanceTimersByTime(1000);Object.defineProperty(dom.window.document,"hidden",{configurable:true,value:true});auto.sync();
  vi.advanceTimersByTime(10000);expect(auto.tick()).toBe(false);Object.defineProperty(dom.window.document,"hidden",{configurable:true,value:false});auto.sync();
  vi.advanceTimersByTime(1000);expect(auto.tick()).toBe(true);
});
it("supports accessible activation, preserves pause across renders and resets for a new phase",()=>{
  auto.render(parent,"q",10);const el=parent.querySelector(".mia-auto-advance");
  expect(el.getAttribute("role")).toBe("button");expect(el.getAttribute("type")).toBe("button");expect(el.hasAttribute("aria-live")).toBe(false);
  vi.advanceTimersByTime(1000);el.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));expect(el.textContent).toBe("자동 ∥");
  auto.render(parent,"q",10);vi.advanceTimersByTime(20000);expect(auto.tick()).toBe(false);expect(parent.lastChild.textContent).toBe("자동 ∥");
  auto.render(parent,"answer",3);expect(parent.lastChild.textContent).toBe("자동 3");vi.advanceTimersByTime(3000);expect(auto.tick()).toBe(true);
});
it("stops writes after reset",()=>{
  auto.render(parent,"q",10);const el=parent.lastChild,write=vi.spyOn(el,"setText");auto.reset();
  vi.advanceTimersByTime(20000);auto.tick();expect(write).not.toHaveBeenCalled();
});
