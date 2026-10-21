import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,symlink,realpath,lstat}from 'node:fs/promises';
import {spawnSync}from 'node:child_process';
import {tmpdir}from 'node:os';
import {join,dirname}from 'node:path';
import {fileURLToPath}from 'node:url';
import {afterEach,expect,it}from 'vitest';
const project=fileURLToPath(new URL('../',import.meta.url)),assets=['main.js','styles.css','manifest.json'];
const owned=[];afterEach(async()=>{for(const root of owned.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp(join(tmpdir(),'mia-installer-'));owned.push(root);const vault=join(root,'vault');await mkdir(vault);return{root,vault,plugin:join(vault,'.obsidian/plugins/mia-study')};}
async function pack(root,label='new'){
 const path=join(root,'package-'+label);await mkdir(join(path,'scripts'),{recursive:true});await writeFile(join(path,'scripts/install-local.mjs'),await readFile(join(project,'scripts/install-local.mjs')));
 const manifest=JSON.parse(await readFile(join(project,'manifest.json'),'utf8'));if(label==='old')manifest.version='0.10.1';
 await writeFile(join(path,'manifest.json'),JSON.stringify(manifest));await writeFile(join(path,'package.json'),JSON.stringify({version:manifest.version}));
 for(const name of ['main.js','styles.css'])await writeFile(join(path,name),label==='old'?`/* old asset fixture ${name} */`:await readFile(join(project,name)));
 return path;
}
function install(packagePath,vault,extra=[],options={}){return spawnSync(process.execPath,[...extra,join(packagePath,'scripts/install-local.mjs'),'--vault',vault],{encoding:'utf8',cwd:dirname(vault),...options});}
async function preserved(vault,plugin){
 const paths={
  [join(vault,'notes.md')]:'# QA 사용자 자료\nDo not change.',
  [join(vault,'.obsidian/community-plugins.json')]:'["other","mia-study"]',
  [join(vault,'.obsidian/workspace.json')]:'{"layout":"keep"}',
  [join(vault,'.obsidian/plugins/other/main.js')]:'/* other plugin */',
  [join(plugin,'data.json')]:'{"version":1,"settings":{"targetRetention":0.87},"reviews":{"q-sentinel":{"reps":8}},"opaque":"preserve exact bytes"}',
  [join(plugin,'ui-state.json')]:'{"resume":"q-sentinel","opaque":"keep"}',
  [join(plugin,'user-extra.bin')]:'\u0000\u0001keep',
 };
 for(const [path,value]of Object.entries(paths)){await mkdir(dirname(path),{recursive:true});await writeFile(path,value);}
 return paths;
}
async function unchanged(paths){for(const [path,value]of Object.entries(paths))expect(await readFile(path,'utf8')).toBe(value);}
async function installed(packagePath,plugin){for(const name of assets)expect(await readFile(join(plugin,name))).toEqual(await readFile(join(packagePath,name)));}

it.each(['config','plugins','plugin'])('rejects %s parent links outside the selected vault without changing external files',async level=>{
 const {root,vault}=await setup(),pkg=await pack(root),outside=join(root,'outside');await mkdir(outside);
 let external,link;
 if(level==='config'){link=join(vault,'.obsidian');external=join(outside,'plugins/mia-study');}
 else if(level==='plugins'){await mkdir(join(vault,'.obsidian'));link=join(vault,'.obsidian/plugins');external=join(outside,'mia-study');}
 else {await mkdir(join(vault,'.obsidian/plugins'),{recursive:true});link=join(vault,'.obsidian/plugins/mia-study');external=outside;}
 await mkdir(external,{recursive:true});await symlink(outside,link,'dir');
 for(const name of assets)await writeFile(join(external,name),'EXTERNAL '+name);
 const result=install(pkg,vault);expect(result.status).not.toBe(0);
 for(const name of assets)expect(await readFile(join(external,name),'utf8')).toBe('EXTERNAL '+name);
});
it('does not create a new vault after a misspelled nonexistent path',async()=>{const{root}=await setup(),pkg=await pack(root),missing=join(root,'typo');expect(install(pkg,missing).status).not.toBe(0);await expect(lstat(missing)).rejects.toMatchObject({code:'ENOENT'});});
it('accepts a config link whose resolved directory remains within the vault',async()=>{const{root,vault}=await setup(),pkg=await pack(root),config=join(vault,'actual-config');await mkdir(config);await symlink(config,join(vault,'.obsidian'),'dir');expect(install(pkg,vault).status).toBe(0);await installed(pkg,join(config,'plugins/mia-study'));});
it('accepts an explicitly selected vault alias',async()=>{const{root,vault,plugin}=await setup(),pkg=await pack(root),alias=join(root,'vault-alias');await symlink(vault,alias,'dir');expect(install(pkg,alias).status).toBe(0);await installed(pkg,plugin);});
it('replaces an asset link itself without overwriting its external target',async()=>{const{root,vault,plugin}=await setup(),pkg=await pack(root),outside=join(root,'external-main');await mkdir(plugin,{recursive:true});await writeFile(outside,'external keep');await symlink(outside,join(plugin,'main.js'),'file');expect(install(pkg,vault).status).toBe(0);expect(await readFile(outside,'utf8')).toBe('external keep');expect((await lstat(join(plugin,'main.js'))).isSymbolicLink()).toBe(false);await installed(pkg,plugin);});
it('installs, reinstalls, updates and restores older asset fixtures without rewriting any study or activation files',async()=>{
 const{root,vault,plugin}=await setup(),old=await pack(root,'old'),current=await pack(root),data=await preserved(vault,plugin);
 for(const candidate of [old,current,current,old,current]){expect(install(candidate,vault).status).toBe(0);await installed(candidate,plugin);await unchanged(data);expect((await readdir(plugin)).filter(n=>n.endsWith('.tmp'))).toEqual([]);}
});
it.each(['missing','empty','version'])('rejects %s source input before altering installed assets or study files',async kind=>{
 const{root,vault,plugin}=await setup(),old=await pack(root,'old'),current=await pack(root),data=await preserved(vault,plugin);expect(install(old,vault).status).toBe(0);
 if(kind==='missing')await rm(join(current,'styles.css'));else if(kind==='empty')await writeFile(join(current,'styles.css'),'');else await writeFile(join(current,'package.json'),'{"version":"wrong"}');
 expect(install(current,vault).status).not.toBe(0);await installed(old,plugin);await unchanged(data);
});
it('rejects invalid arguments and unsupported custom-config arguments without touching the default config',async()=>{
 const{root,vault}=await setup(),pkg=await pack(root),script=join(pkg,'scripts/install-local.mjs');
 for(const args of [[],['--vault','relative'],['--vault',vault,'--config-dir','.custom']]){expect(spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'}).status).not.toBe(0);await expect(lstat(join(vault,'.obsidian'))).rejects.toMatchObject({code:'ENOENT'});}
});
async function faultHook(root,plugin,outcome,operation='rename',name=outcome==='error'?'styles.css':'main.js'){
 const target=await realpath(plugin),marker=join(root,'checkpoint'),hook=join(root,'hook.mjs');
 await writeFile(hook,`import fs from 'node:fs/promises';import{dirname,basename}from'node:path';import{syncBuiltinESMExports}from'node:module';
const operation=${JSON.stringify(operation)},name=${JSON.stringify(name)},original=fs[operation],write=fs.writeFile;
fs[operation]=async(a,b,...rest)=>{const path=operation==='rename'?b:a;const filename=basename(path);const match=await fs.realpath(dirname(path))===${JSON.stringify(target)}&&(operation==='rename'?filename===name:filename.startsWith('.'+name+'.')&&filename.endsWith('.tmp'));
if(match&&${JSON.stringify(outcome)}==='error'){await write(${JSON.stringify(marker)},'before '+operation+' '+name);const error=Error('QA_INSTALL_FAULT');error.code='EIO';throw error;}
const result=await original(a,b,...rest);if(match&&${JSON.stringify(outcome)}==='kill'){await write(${JSON.stringify(marker)},'after '+operation+' '+name);process.kill(process.pid,'SIGKILL');}return result;};syncBuiltinESMExports();`);
 return{hook,marker};
}
it.each(['error','kill'])('preserves complete files and user data after injected %s, and repairs the asset set on rerun',async outcome=>{
 const{root,vault,plugin}=await setup(),old=await pack(root,'old'),current=await pack(root),data=await preserved(vault,plugin);expect(install(old,vault).status).toBe(0);const{hook,marker}=await faultHook(root,plugin,outcome);
 const result=install(current,vault,['--import',hook]);expect(result.status).not.toBe(0);if(outcome==='kill')expect(result.signal).toBe('SIGKILL');else expect(result.stderr).toContain('QA_INSTALL_FAULT');expect(await readFile(marker,'utf8')).toContain('rename');await unchanged(data);
 for(const name of assets){const bytes=await readFile(join(plugin,name));expect(bytes.equals(await readFile(join(old,name)))||bytes.equals(await readFile(join(current,name)))).toBe(true);}
 expect(install(current,vault).status).toBe(0);await installed(current,plugin);await unchanged(data);expect((await readdir(plugin)).filter(n=>n.endsWith('.tmp'))).toEqual([]);
});

it.each(assets)('preserves data and repairs installation after SIGKILL following staging %s',async name=>{
 const{root,vault,plugin}=await setup(),old=await pack(root,'old'),current=await pack(root),data=await preserved(vault,plugin);expect(install(old,vault).status).toBe(0);
 const{hook,marker}=await faultHook(root,plugin,'kill','writeFile',name),result=install(current,vault,['--import',hook]);
 expect(result.signal).toBe('SIGKILL');expect(await readFile(marker,'utf8')).toBe('after writeFile '+name);await unchanged(data);
 for(const asset of assets){const bytes=await readFile(join(plugin,asset));expect(bytes.equals(await readFile(join(old,asset)))||bytes.equals(await readFile(join(current,asset)))).toBe(true);}
 // A rerun repairs the deployable set; it must not delete unrelated or possibly shared temp files.
 const unrelated=join(plugin,'.other.tmp');await writeFile(unrelated,'keep');
 expect(install(current,vault).status).toBe(0);await installed(current,plugin);await unchanged(data);expect(await readFile(unrelated,'utf8')).toBe('keep');
});
