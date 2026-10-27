import { describe, expect, it, vi } from 'vitest';
import {createRequire} from 'node:module';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const notices=[];
vi.mock('obsidian',()=>({
 Modal:class {constructor(){this.contentEl=document.createElement('div');}setTitle(t){this.title=t;}close(){this.closed=true;}},
 PluginSettingTab:class {}, Setting:class {},
 Notice:class {constructor(message){notices.push(message);}}
}));
import {SettingsConflictModal} from '../src/ui/settings-conflict-modal';
import {MiaSettingTab} from '../src/ui/settings-tab';
import {MiaDataStore} from '../src/services/data-store';
import {DEFAULT_SETTINGS} from '../src/core/models';
function setup(apply){
 const dom=new JSDOM('<body/>');vi.stubGlobal('document',dom.window.document);
 dom.window.HTMLElement.prototype.createEl=function(tag,options={}){const el=document.createElement(tag);if(options.text)el.textContent=options.text;for(const[k,v]of Object.entries(options.attr??{}))el.setAttribute(k,v);this.appendChild(el);return el;};
 const active=structuredClone(DEFAULT_SETTINGS),other=structuredClone(active);other.targetRetention=.8;
 const modal=new SettingsConflictModal({},active,[{id:'other',ancestors:[],settings:other}],apply);modal.onOpen();return modal;
}
describe('settings recovery UI',()=>{
 it('shows full read-only originals and prevents double apply while saving',async()=>{
  let finish;const apply=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));const modal=setup(apply);
  const originals=[...modal.contentEl.querySelectorAll('textarea')];expect(originals).toHaveLength(2);expect(originals.every(e=>e.readOnly)).toBe(true);expect(JSON.parse(originals[1].value).targetRetention).toBe(.8);
  const button=[...modal.contentEl.querySelectorAll('button')].find(e=>e.textContent==='이 설정 전체 적용');button.click();button.click();expect(apply).toHaveBeenCalledOnce();expect(button.disabled).toBe(true);finish();await vi.waitFor(()=>expect(modal.closed).toBe(true));
 });
 it('keeps both recovery values available and allows retry after a failed save',async()=>{
  const apply=vi.fn().mockRejectedValue(Error('disk full'));const modal=setup(apply),button=modal.contentEl.querySelector('button');button.click();await vi.waitFor(()=>expect(button.disabled).toBe(false));expect(modal.closed).toBeUndefined();expect(modal.contentEl.querySelectorAll('textarea')).toHaveLength(2);expect(notices.at(-1)).toContain('disk full');
 });
});

it('serializes rapid local settings edits without treating the previous local keystroke as a peer conflict',async()=>{
 let disk=null;const store=new MiaDataStore({loadData:async()=>structuredClone(disk),saveData:async value=>{disk=structuredClone(value);}});await store.load();let baseline=structuredClone(store.settings);
 const tab=new MiaSettingTab({}, {store});tab.display=vi.fn();const before=notices.length;
 const save=value=>tab.save(async()=>{await store.updateSettings({maximumIntervalDays:value},baseline);baseline=structuredClone(store.settings);});
 await Promise.all([save(100),save(1000)]);expect(store.settings.maximumIntervalDays).toBe(1000);expect(store.settingsConflicts).toEqual([]);expect(notices).toHaveLength(before);
});
