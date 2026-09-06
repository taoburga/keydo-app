import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir=await mkdtemp(join(tmpdir(),'todo-server-recovery-'));
process.env.TODO_APP_DATA_DIR=dir;
const data=await import('../lib/app-data.js');
const {operationStore}=await import('../lib/operations.js');
after(()=>rm(dir,{recursive:true,force:true}));

test('actual restore handler preserves all fields and is idempotent after trash removal',async()=>{
 const source=await readFile(new URL('../server.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('function _localYMD('),source.indexOf('// Query string for the access log'));
 let creates=0;const payloads=[];
 class BadRequestError extends Error {}
 const deps={trashGet:data.trashGet,trashRemove:data.trashRemove,runOperation:operationStore(dir),listLists:async()=>[{id:'list'}],addReminder:async p=>{creates++;payloads.push(p);return JSON.parse(JSON.stringify({...p,id:'new',allDay:true}));},BadRequestError};
 const restore=new Function(...Object.keys(deps),code+';return restoreFromTrash;')(...Object.values(deps));
 const original={id:'old',name:'Task',listId:'list',body:'Notes',url:'https://example.com',priority:'high',dueDate:new Date(2026,8,6).toISOString(),allDay:true,completed:true,completionDate:'2026-09-01T12:00:00.000Z',recurrence:'monthly',recurrenceRules:[{frequency:2,interval:1,daysOfWeek:[{day:6,week:2}],occurrenceCount:6}],alarms:[{type:'relative',offset:-600}]};
 const entry=await data.trashAdd({task:original});
 const [a,b]=await Promise.all([restore(entry.trashId),restore(entry.trashId)]);
 assert.deepEqual(a,b);assert.equal(creates,1);
 assert.equal(payloads[0].dueDate,'2026-09-06');
 assert.deepEqual(payloads[0].recurrenceRules,original.recurrenceRules);
 assert.equal(payloads[0].completed,true);assert.equal(payloads[0].completionDate,original.completionDate);
 assert.equal(payloads[0].body,'Notes');assert.deepEqual(payloads[0].alarms,original.alarms);
 assert.equal(await data.trashGet(entry.trashId),null);
 assert.deepEqual(await restore(entry.trashId),a);assert.equal(creates,1);
});
