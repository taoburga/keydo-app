import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { operationStore } from '../lib/operations.js';
import { reorderTreeTies, remapAction, mapLimited } from '../public/state-safety.js';
const dir = await mkdtemp(join(tmpdir(), 'todo-regressions-'));
after(() => rm(dir, { recursive: true, force: true }));

// Each store fixture runs in a new process so import-time data-directory
// configuration cannot accidentally reuse a real Application Support store.
async function storeFixture(script) {
  const fixture = await mkdtemp(join(dir, 'store-'));
  const url = new URL('../lib/app-data.js', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; const m = await import(${JSON.stringify(url)}); ${script}`], {
      env: { ...process.env, TODO_APP_DATA_DIR: fixture }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(stderr)));
  });
}

test('capacity refusal never evicts an unexpired recovery snapshot', () => storeFixture(`
  const old = await m.trashAdd({task:{id:'old',name:'Old'}});
  await assert.rejects(() => m.trashAddMany({tasks:Array.from({length:2000},(_,i)=>({id:String(i),name:'Fake'}))}), /full/);
  assert.equal((await m.trashList()).length,1);
  assert.ok(await m.trashGet(old.trashId));
`));

test('concurrent habits and idempotent phone checks preserve every check and kind', () => storeFixture(`
  const a=await m.habitAdd({name:'A',target:3,kinds:['push']});
  const b=await m.habitAdd({name:'B',target:3});
  await Promise.all([m.habitToggle(a.id,'2026-09-06','2026-09-06','push'),m.habitToggle(b.id,'2026-09-06','2026-09-06')]);
  await Promise.all([m.habitEnsureChecked(a.id,'2026-09-06','2026-09-06'),m.habitEnsureChecked(a.id,'2026-09-06','2026-09-06')]);
  const data=await m.habitsRead();
  assert.deepEqual(data.checks[a.id],['2026-09-06']);
  assert.deepEqual(data.checks[b.id],['2026-09-06']);
  assert.equal(data.kinds[a.id]['2026-09-06'],'push');
`));

test('concurrent setting patches and meeting prep writes retain both changes', () => storeFixture(`
  await Promise.all([m.settingsWrite({habitSync:true}),m.settingsWrite({defaultDueTime:'08:30'})]);
  assert.deepEqual(await m.settingsRead(),{habitSync:true,defaultDueTime:'08:30'});
  const date = new Date().toISOString().slice(0,10);
  await Promise.all([m.prepSet({date,title:'A'}),m.prepSet({date,title:'B'})]);
  assert.equal((await m.prepList({date})).length,2);
`));

test('both corrupt recovery copies fail closed instead of overwriting history', () => storeFixture(`
  const {writeFile}=await import('node:fs/promises');
  for(const name of ['trash.json','trash.json.bak','habits.json','habits.json.bak']) await writeFile(m.APP_DATA_DIR+'/'+name,'{broken');
  await assert.rejects(()=>m.trashAdd({task:{id:'x',name:'x'}}),/unreadable/);
  await assert.rejects(()=>m.habitAdd({name:'x',target:1}),/unreadable/);
`));

test('concurrent/repeated restore receipts execute the mutation only once', async () => {
  const run=operationStore(await mkdtemp(join(dir,'receipt-')));
  let calls=0;
  const create=async()=>{calls++;await new Promise(r=>setTimeout(r,30));return {id:'new'};};
  const [a,b]=await Promise.all([run('restore:x',{trashId:'x'},create),run('restore:x',{trashId:'x'},create)]);
  assert.deepEqual(a,b);assert.equal(calls,1);
  assert.deepEqual(await run('restore:x',{trashId:'x'},create),{id:'new'});
});

test('an ambiguous create blocks retries even with a new operation ID', async () => {
  const run=operationStore(await mkdtemp(join(dir,'unknown-')));
  let calls=0;
  await assert.rejects(()=>run('one',{name:'A'},async()=>{calls++;throw Error('reply lost');}),/reply lost/);
  await assert.rejects(()=>run('two',{name:'A'},async()=>{calls++;}),/unknown outcome/);
  assert.equal(calls,1);
});

test('definite validation failure permits a corrected retry; IDs cannot change meaning', async()=>{
  const run=operationStore(await mkdtemp(join(dir,'validation-')));
  await assert.rejects(()=>run('a',{name:'A'},async()=>{throw Object.assign(Error('bad date'),{userError:true});}),/bad date/);
  await run('a',{name:'A'},async()=>({id:'new'}));
  await assert.rejects(()=>run('a',{name:'B'},async()=>({id:'wrong'})),/different input/);
});

test('saved tie order moves complete subtrees and never crosses section boundaries',()=>{
  const rows=[{id:'p',priority:'high',_depth:0},{id:'c',priority:'high',_depth:1},{id:'q',priority:'high',_depth:0},{_isSection:true,label:'Other'},{id:'z',priority:'high',_depth:0}];
  const result=reorderTreeTies(rows,{'high':['z','c','q','p']},t=>t.priority);
  assert.deepEqual(result.map(t=>t.id||'header'),['q','p','c','header','z']);
});

test('remapping updates nested undo references without rewriting user text',()=>{
  const action={taskId:'old',task:{id:'old',name:'old'},items:[{taskId:'old'}],detachSnapshot:{grandparent:'old',orderedChildIds:['old'],childOrderInParent:['old']}};
  remapAction(action,'old','new');
  assert.equal(action.taskId,'new');assert.equal(action.task.name,'old');
  assert.equal(action.items[0].taskId,'new');
  assert.deepEqual(action.detachSnapshot.orderedChildIds,['new']);
});

test('title fetch workers honor concurrency bounds',async()=>{
  let active=0,peak=0,done=0;
  await mapLimited(Array.from({length:20}),4,async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;done++;});
  assert.equal(peak,4);assert.equal(done,20);
});

test('late list responses and responses during editing do not replace current rows',async()=>{
  const src=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=src.slice(src.indexOf('let _tasksRequest ='),src.indexOf('\nfunction viewTitle('));
  const pending={};const state={view:'list',currentListId:'A',tasks:[],lists:[{id:'A',name:'A'},{id:'B',name:'B'}],selectedIdx:0};
  const els={listHeader:{textContent:''}};const noop=()=>{};let editing=false;
  const deps={state,els,document:{querySelector:()=>editing},_activeViewKey:()=>state.currentListId,_scheduleLiveRefresh:noop,api:{reminders:id=>new Promise(r=>pending[id]=r)},_refreshBusy:noop,_enterRemindersInboxIfNeeded:noop,_updateQuickAddPlaceholder:noop,isSearchView:()=>false,isListView:()=>true,getShowCompleted:()=>false,_ingestParentTags:noop,sortTasks:x=>x,_isManualOrderingActive:()=>true,_bucketCompletedTasks:()=>[],_settleStickyEdit:x=>x,renderTasks:noop,reportError:noop,_isNonTaskRow:()=>false};
  const load=new Function(...Object.keys(deps),code+';return loadTasks;')(...Object.values(deps));
  const a=load();state.currentListId='B';const b=load();pending.B([{id:'B-task',completed:false}]);await b;pending.A([{id:'A-task',completed:false}]);await a;
  assert.equal(state.tasks[0].id,'B-task');assert.equal(els.listHeader.textContent,'B');
  const c=load();editing=true;pending.B([{id:'replacement',completed:false}]);await c;
  assert.equal(state.tasks[0].id,'B-task');
});

test('partial GC snapshots retain organization, and backup failure aborts deletion',async()=>{
 const src=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const code=src.slice(src.indexOf('async function _gcLocalMaps()'),src.indexOf('// Search operators:'));
 const noop=()=>{};
 for(const backupFails of [false,true]) {
   const state={tasks:[],inFlight:0,parentMap:{child:'parent'},taskSectionMap:{parent:'Work'},orderByGroup:{},collapsedParents:{},snoozeMap:{parent:'2099-01-01'},ingestedParents:new Set(),tieOrder:{}};
   const storage=new Map(backupFails?[['todo-app:gcMissing:v1',JSON.stringify({parent:1,child:1})]]:[]);
   const deps={state,GC_KEY:'gc',CP_KEY:'cp',_editingNow:()=>false,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>{if(backupFails&&k==='todo-app:organizationBackup:v1')throw Error('quota');storage.set(k,v);}},api:{allReminders:async()=>[{id:'unrelated'}]},persistParentMap:noop,persistOrder:noop,persistSections:noop,persistTieOrder:noop,persistSnooze:noop,persistIngested:noop};
   await new Function(...Object.keys(deps),code+';return _gcLocalMaps();')(...Object.values(deps));
   assert.deepEqual(state.parentMap,{child:'parent'});assert.deepEqual(state.taskSectionMap,{parent:'Work'});
 }
});

test('failed undo stays available and concurrent undo does not pop a second action',async()=>{
 const src=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const code=src.slice(src.indexOf('let _undoBusy ='),src.indexOf('// Remove any localStorage references to a deleted task id'));
 const action={type:'patch',taskId:'x'},older={type:'patch',taskId:'y'};
 const undoStack=[older,action],redoStack=[];const noop=()=>{};let calls=0;
 const deps={undoStack,redoStack,setStatus:noop,_diagCrumb:noop,setBusy:noop,reportError:noop,refreshAllTasks:async()=>{},loadTasks:async()=>{},_applyAction:async()=>{calls++;await new Promise(r=>setTimeout(r,10));throw Error('offline');}};
 const undo=new Function(...Object.keys(deps),code+';return performUndo;')(...Object.values(deps));
 await Promise.all([undo(),undo()]);assert.equal(calls,1);assert.deepEqual(undoStack,[older,action]);assert.equal(redoStack.length,0);
});
