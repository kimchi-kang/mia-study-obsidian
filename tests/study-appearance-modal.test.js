import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ rows: new Map(), notices: [] }));
vi.mock("obsidian", () => {
  class Element {
    children=[]; handlers=new Map(); disabled=false; text="";
    constructor(options={}){this.text=options.text??"";this.cls=options.cls??"";}
    createEl(tag,options={}){const child=new Element(options);child.tag=tag;this.children.push(child);return child;}
    createDiv(options){return this.createEl("div",options);}
    createSpan(options){return this.createEl("span",options);}
    setText(value){this.text=value;}
    setAttribute(){} addClass(){} empty(){this.children=[];} focus=vi.fn();
    addEventListener(type,fn){this.handlers.set(type,fn);}
    click(){if(!this.disabled)this.handlers.get("click")?.();}
    find(text){for(const child of this.children){if(child.tag==="button"&&child.text===text)return child;const found=child.find(text);if(found)return found;}}
  }
  class Control {
    setValue(value){this.value=value;return this;} addOption(){return this;}
    onChange(fn){this.change=value=>{this.value=value;fn(value);};return this;}
  }
  return {
    Modal:class{
      constructor(app){this.app=app;this.contentEl=new Element();this.modalEl=new Element();this.closed=true;}
      setTitle(){} open(){this.closed=false;this.onOpen();} close(){this.closed=true;this.onClose();}
    },
    Notice:class{constructor(message){boundary.notices.push(message);}},
    Setting:class{
      constructor(root){this.controlEl=root.createDiv();}
      setName(name){this.name=name;return this;} setDesc(){return this;}
      addDropdown(fn){const control=new Control();boundary.rows.set(this.name,control);fn(control);return this;}
      addToggle(fn){const control=new Control();boundary.rows.set(this.name,control);fn(control);return this;}
    },
  };
});
import { StudyAppearanceModal } from "../src/ui/study-appearance-modal";
import { StudyUiStore } from "../src/services/study-ui-store";
const setup = (appearance={}) => {
  const local=new Map([["mia-study:appearance:ui.json",appearance]]);
  const app={vault:{adapter:{exists:async()=>false,read:async()=>{throw Error("unexpected file read");},write:async()=>{throw Error("unexpected file write");}}},loadLocalStorage:key=>local.get(key),saveLocalStorage:vi.fn((key,value)=>local.set(key,structuredClone(value)))};
  const store=new StudyUiStore(app,"ui.json");const changed=vi.fn();const modal=new StudyAppearanceModal(app,store,changed);
  modal.open();return {app,store,modal,changed};
};
beforeEach(()=>{boundary.rows.clear();boundary.notices=[];});
describe("appearance dialog user interactions",()=>{
  it.each([false,true])("opening, closing and reopening keeps saved focus=%s without writing",focus=>{
    const ui=setup({focus,swipeEnabled:false,size:"large"});
    expect(boundary.rows.get("집중 모드").value).toBe(focus);
    expect(boundary.rows.get("쓸어서 뒤로가기").value).toBe(false);
    expect(boundary.rows.get("글자 크기").value).toBe("large");
    expect(ui.modal.contentEl.find("보기 설정 저장").disabled).toBe(true);
    expect(ui.modal.modalEl.focus).toHaveBeenCalled();
    ui.modal.close();ui.modal.open();expect(boundary.rows.get("집중 모드").value).toBe(focus);
    expect(ui.app.saveLocalStorage).not.toHaveBeenCalled();expect(ui.changed).not.toHaveBeenCalled();
  });
  it("does not apply or persist a toggle until Save; Cancel discards it",()=>{
    const ui=setup({focus:false});boundary.rows.get("집중 모드").change(true);
    expect(ui.store.appearance.focus).toBe(false);expect(ui.app.saveLocalStorage).not.toHaveBeenCalled();
    ui.modal.contentEl.find("취소").click();ui.modal.open();expect(boundary.rows.get("집중 모드").value).toBe(false);
  });
  it("saves exactly the chosen options once and reopens to the same values",()=>{
    const ui=setup({focus:false,swipeEnabled:true});
    for(const [name,value] of [["글자 크기","large"],["정보량","compact"],["답안 배치","split"],["암기 모드 순서","sequential"],["쓸어넘기기 민감도","firm"],["집중 모드",true],["쓸어서 뒤로가기",false]])boundary.rows.get(name).change(value);
    ui.modal.contentEl.find("보기 설정 저장").click();
    expect(ui.store.appearance).toEqual({size:"large",density:"compact",answerLayout:"split",memorizationOrder:"sequential",swipeSensitivity:"firm",focus:true,swipeEnabled:false});
    expect(ui.app.saveLocalStorage).toHaveBeenCalledTimes(1);expect(ui.changed).toHaveBeenCalledTimes(1);expect(ui.modal.closed).toBe(true);
    ui.modal.open();expect(boundary.rows.get("쓸어서 뒤로가기").value).toBe(false);expect(ui.modal.contentEl.find("보기 설정 저장").disabled).toBe(true);
  });
  it("disables Save when a change is reverted to its original value",()=>{
    const ui=setup({focus:false});boundary.rows.get("집중 모드").change(true);expect(ui.modal.contentEl.find("보기 설정 저장").disabled).toBe(false);
    boundary.rows.get("집중 모드").change(false);expect(ui.modal.contentEl.find("보기 설정 저장").disabled).toBe(true);
  });
  it("keeps the chosen options for retry when saving fails",()=>{
    const ui=setup({focus:false});boundary.rows.get("집중 모드").change(true);
    ui.app.saveLocalStorage.mockImplementationOnce(()=>{throw Error("storage full");});
    ui.modal.contentEl.find("보기 설정 저장").click();expect(ui.modal.closed).toBe(false);expect(ui.store.appearance.focus).toBe(false);expect(boundary.rows.get("집중 모드").value).toBe(true);
    expect(boundary.notices.at(-1)).toContain("저장 실패");ui.modal.contentEl.find("보기 설정 저장").click();expect(ui.store.appearance.focus).toBe(true);
  });
});
