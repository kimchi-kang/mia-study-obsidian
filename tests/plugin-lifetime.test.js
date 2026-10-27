import{describe,it,expect,vi,afterEach}from'vitest';
vi.mock('obsidian',()=>({
 Plugin:class{register(){}registerView(){}addRibbonIcon(){}addCommand(){}addSettingTab(){}},Modal:class{},ItemView:class{},PluginSettingTab:class{},MarkdownView:class{},TFile:class{},TFolder:class{},Component:class{},Setting:class{},Notice:class{},Platform:{isMobile:false},normalizePath:p=>p,
}));
import MiaStudyPlugin from '../src/main';
import {QuestionIndex} from '../src/services/question-index';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function host(){
 const callbacks=[],local=new Map(),events=new Map();
 const vault={configDir:'.obsidian',getName:()=> 'test',adapter:{exists:async()=>false,read:vi.fn(),write:vi.fn()},getMarkdownFiles:vi.fn(()=>[]),getAbstractFileByPath:vi.fn(()=>undefined),on:vi.fn((name,fn)=>{events.set(name,fn);return{name};}),offref:vi.fn(ref=>events.delete(ref.name)),cachedRead:vi.fn()};
 const plugin=new MiaStudyPlugin();plugin.app={vault,loadLocalStorage:key=>local.get(key),saveLocalStorage:(key,value)=>local.set(key,value),workspace:{onLayoutReady:fn=>callbacks.push(fn)}};
 plugin.manifest={id:'mia-study',version:'0.10.2',dir:'.obsidian/plugins/mia-study'};plugin.loadData=vi.fn(async()=>null);plugin.saveData=vi.fn();
 return{plugin,vault,callbacks,local,events};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('plugin deferred startup cancellation',()=>{
 it('does not register vault events when layout becomes ready after unload',async()=>{
  const env=host();await env.plugin.onload();env.plugin.onunload();env.callbacks[0]();await flush();expect(env.vault.on).not.toHaveBeenCalled();expect(env.vault.getMarkdownFiles).not.toHaveBeenCalled();
 });
 it('does not register UI or layout callbacks if unloaded during initial data loading',async()=>{
  const env=host();let finish;env.plugin.loadData=()=>new Promise(resolve=>{finish=()=>resolve(null);});const loading=env.plugin.onload();await flush();expect(finish).toBeTypeOf("function");env.plugin.onunload();finish();await loading;
  expect(env.callbacks).toEqual([]);expect(env.local.get('mia-study:startup-diagnostics:v1').at(-1).phase).toBe('unloaded');
 });
 it('does not continue subject synchronization when unloaded during the first index read',async()=>{
  const env=host();await env.plugin.onload();let finish;env.vault.getMarkdownFiles.mockReturnValue([{path:'MIA/과목/a.md',extension:'md'}]);env.vault.cachedRead=()=>new Promise(resolve=>{finish=()=>resolve('');});
  env.callbacks[0]();await flush();env.plugin.onunload();finish();await flush();expect(env.events.size).toBe(0);expect(env.vault.getAbstractFileByPath).not.toHaveBeenCalled();
 });
 it('does not begin legacy loading after unload during portable mode detection',async()=>{
  const env=host();let finish;env.vault.adapter.exists=()=>new Promise(resolve=>{finish=()=>resolve(false);});const loading=env.plugin.onload();env.plugin.onunload();finish();await loading;expect(env.plugin.loadData).not.toHaveBeenCalled();expect(env.callbacks).toEqual([]);
 });
 it('ignores external settings notifications after unload',async()=>{
  const env=host();await env.plugin.onload();env.plugin.onunload();const calls=env.plugin.loadData.mock.calls.length;await env.plugin.onExternalSettingsChange();expect(env.plugin.loadData).toHaveBeenCalledTimes(calls);
 });
});
describe('index start and stop resources',()=>{
 it('shares startup and does not register duplicate event handlers',async()=>{
  const env=host(),index=new QuestionIndex(env.plugin.app,()=>[]);const first=index.start(),second=index.start();await Promise.all([first,second]);expect(env.vault.on).toHaveBeenCalledTimes(4);index.stop();expect(env.vault.offref).toHaveBeenCalledTimes(4);
 });
 it('cancels a pending file debounce on stop and does not notify later',async()=>{
  vi.useFakeTimers();vi.stubGlobal('window',{setTimeout,clearTimeout});const env=host(),index=new QuestionIndex(env.plugin.app,()=>[]);await index.start();const notify=vi.fn();index.subscribe(notify);
  env.events.get('modify')({path:'a.md',extension:'md'});expect(vi.getTimerCount()).toBe(1);index.stop();await vi.advanceTimersByTimeAsync(1000);expect(vi.getTimerCount()).toBe(0);expect(env.vault.cachedRead).not.toHaveBeenCalled();expect(notify).not.toHaveBeenCalled();
 });
 it('restarts cleanly after stopping',async()=>{
  const env=host(),index=new QuestionIndex(env.plugin.app,()=>[]);await index.start();index.stop();await index.start();expect(env.events.size).toBe(4);expect(env.vault.on).toHaveBeenCalledTimes(8);index.stop();expect(env.events.size).toBe(0);
 });
});


describe('additional startup boundaries',()=>{
 it('does not publish loaded state if unloaded during the resume read',async()=>{
  const env=host();let finish;env.vault.adapter.exists=vi.fn(path=>path.endsWith('/ui-state.json')?new Promise(resolve=>{finish=()=>resolve(false);}):Promise.resolve(false));
  const loading=env.plugin.onload();await flush();env.plugin.onunload();finish();await loading;expect(env.callbacks).toEqual([]);expect(env.local.get('mia-study:startup-diagnostics:v1').at(-1).phase).toBe('unloaded');
 });
 it('cleans up registrations after a failed index start and permits retry',async()=>{
  const env=host(),index=new QuestionIndex(env.plugin.app,()=>[]);env.vault.getMarkdownFiles.mockImplementationOnce(()=>{throw Error('vault unavailable');});
  await expect(index.start()).rejects.toThrow('vault unavailable');expect(env.events.size).toBe(0);await index.start();expect(env.events.size).toBe(4);index.stop();
 });
 it('does not stop a new index lifetime when an old startup fails later',async()=>{
  const env=host(),index=new QuestionIndex(env.plugin.app,()=>[]);env.vault.getMarkdownFiles.mockImplementationOnce(()=>{throw Error('old lifetime');});
  const old=index.start();index.stop();const latest=index.start();await expect(old).rejects.toThrow('old lifetime');await latest;expect(env.events.size).toBe(4);index.stop();
 });
});

describe('external source configuration delivery',()=>{
 it('rebuilds the question index when another device changes source roots',async()=>{
  const env=host();
  const files=[{path:'MIA/A/문제은행.md',extension:'md'},{path:'Remote/B/문제은행.md',extension:'md'}];
  env.vault.getMarkdownFiles.mockReturnValue(files);
  env.vault.cachedRead=async file=>`### 질문\n\n> [!question] 문제\n> 검증 질문\n^mia-q-${file.path.startsWith('MIA/')?'local':'remote'}\n\n#### 정답\n\n답\n`;
  await env.plugin.onload();await env.plugin.index.start();
  expect(env.plugin.index.registered.map(q=>q.id)).toEqual(['mia-q-local']);
  const {MiaDataStore}=await import('../src/services/data-store');
  let remoteData=null;const remote=new MiaDataStore({loadData:async()=>remoteData,saveData:async data=>{remoteData=structuredClone(data);}});
  await remote.load();await remote.updateSettings({sourceRoots:['Remote']});
  env.plugin.loadData.mockResolvedValue(remoteData);
  await env.plugin.onExternalSettingsChange();
  expect(env.plugin.store.settings.sourceRoots).toEqual(['Remote']);
  expect(env.plugin.index.registered.map(q=>q.id)).toEqual(['mia-q-remote']);
  env.plugin.onunload();
 });
});
