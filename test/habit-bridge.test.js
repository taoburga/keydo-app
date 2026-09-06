import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHabitBridge } from '../lib/habit-bridge.js';
const dir=await mkdtemp(join(tmpdir(),'todo-bridge-test-'));
after(()=>rm(dir,{recursive:true,force:true}));
async function fixture() {
  let state={listId:null,map:{}}, enabled=true, fail=false;
  const lists=[{id:'personal',name:'Habit tracker'}];
  const tasks=[{id:'real',listId:'personal',name:'My personal task',body:'Keep me',completed:false}];
  const checks=new Set(), deleted=[], calls=[];
  const data={APP_DATA_DIR:await mkdtemp(join(dir,'case-')),settingsRead:async()=>({habitSync:enabled}),habitsRead:async()=>({habits:[{id:'h',name:'Exercise',target:3}],checks:{h:[...checks]},kinds:{}}),habitBridgeStateRead:async()=>structuredClone(state),habitBridgeStateWrite:async s=>{state=structuredClone(s);},habitEnsureChecked:async(_id,date)=>{if(fail)throw Object.assign(Error('full'),{code:'ENOSPC'});checks.add(date);},notifyDataChange:()=>{}};
  const rem={listLists:async()=>structuredClone(lists),createList:async name=>{const l={id:'managed-'+lists.length,name};lists.push(l);return l;},getReminders:async id=>structuredClone(tasks.filter(t=>t.listId===id)),addReminder:async p=>{const t={...p,id:'r-'+tasks.length,completed:false};tasks.push(t);return structuredClone(t);},updateReminder:async(id,p)=>{calls.push({id,p});Object.assign(tasks.find(t=>t.id===id),p);return {};},deleteReminder:async id=>{deleted.push(id);tasks.splice(tasks.findIndex(t=>t.id===id),1);},deleteList:async()=>{throw Error('Calendar deletion is forbidden');},invalidateBridgeListCache:()=>{}};
  const bridge=createHabitBridge({rem,data});
  return {bridge,lists,tasks,checks,deleted,calls,get state(){return state;},setEnabled:v=>enabled=v,setFailure:v=>fail=v,data,rem};
}

test('name collision is not adopted and disable never deletes personal tasks',async()=>{
 const f=await fixture();await f.bridge.sync();
 assert.notEqual(f.state.listId,'personal');
 const mapped=f.state.map.h;
 f.tasks.push({id:'added-by-user',listId:f.state.listId,name:'Personal',body:'Keep',completed:false});
 await f.bridge.disable();
 assert.deepEqual(f.deleted,[mapped]);
 assert.ok(f.tasks.some(t=>t.id==='real'));assert.ok(f.tasks.some(t=>t.id==='added-by-user'));
 assert.equal(f.lists.length,2);
});

test('repeat sync reuses owned reminders, records phone checks once, and retains failed saves',async()=>{
 const f=await fixture();await f.bridge.sync();await f.bridge.sync();
 assert.equal(f.tasks.length,2);
 const r=f.tasks.find(t=>t.id===f.state.map.h);
 r.completed=true;r.completionDate=new Date().toISOString();f.setFailure(true);
 await assert.rejects(()=>f.bridge.sync(),/full/);
 assert.equal(r.completed,true);assert.equal(f.checks.size,0);
 f.setFailure(false);await f.bridge.sync();
 assert.equal(r.completed,false);assert.equal(f.checks.size,1);
 r.completed=true;await f.bridge.sync();assert.equal(f.checks.size,1);
});

test('editing away ownership preserves the reminder; name alone is never adopted',async()=>{
 const f=await fixture();await f.bridge.sync();const original=f.state.map.h;
 f.tasks.find(t=>t.id===original).body='This is now my personal task';
 await f.bridge.sync();assert.notEqual(f.state.map.h,original);
 await f.bridge.disable();assert.ok(f.tasks.some(t=>t.id===original));
});

test('disable waits for an active sync and retains pending completed projections',async()=>{
 const f=await fixture();await f.bridge.sync();
 const r=f.tasks.find(t=>t.id===f.state.map.h);r.completed=true;
 await f.bridge.disable();assert.ok(f.tasks.includes(r));
 let release;const paused=new Promise(resolve=>{release=resolve;});
 const old=f.data.habitsRead;let started;const entered=new Promise(r=>started=r);
 f.data.habitsRead=async()=>{started();await paused;return old();};
 const syncing=f.bridge.sync();await entered;
 const disabling=f.bridge.disable();release();await Promise.all([syncing,disabling]);
 assert.equal(f.checks.size,1);assert.ok(!f.tasks.includes(r));
});
