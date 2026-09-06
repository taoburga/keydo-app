import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);

test('EventKit recovery preserves ordinal weekdays, intervals, multiple rules and ends', {skip:process.platform!=='darwin'}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'todo-recurrence-test-'));
  try {
    const source=await readFile(new URL('../daemon/Reminders.swift',import.meta.url),'utf8');
    const helpers=source.slice(source.indexOf('func recurrenceSnapshot('),source.indexOf('func alarmsArray(')).replaceAll('_ r: EKReminder','_ r: Fixture');
    const harness=`import Foundation
import EventKit
enum DaemonError: Error { case userError(String) }
let isoFormatter: ISO8601DateFormatter = { let f=ISO8601DateFormatter(); f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]; return f }()
func parseISODate(_ s:String)->Date? { isoFormatter.date(from:s) }
final class Fixture {
 var recurrenceRules: [EKRecurrenceRule]? = []
 func addRecurrenceRule(_ r:EKRecurrenceRule) { recurrenceRules!.append(r) }
 func removeRecurrenceRule(_ r:EKRecurrenceRule) { recurrenceRules!.removeAll { $0 === r } }
}
${helpers}
let ordinal=EKRecurrenceRule(recurrenceWith:.monthly,interval:1,daysOfTheWeek:[EKRecurrenceDayOfWeek(.friday,weekNumber:2)],daysOfTheMonth:nil,monthsOfTheYear:nil,weeksOfTheYear:nil,daysOfTheYear:nil,setPositions:nil,end:EKRecurrenceEnd(occurrenceCount:6))
let alternating=EKRecurrenceRule(recurrenceWith:.weekly,interval:2,daysOfTheWeek:[EKRecurrenceDayOfWeek(.monday),EKRecurrenceDayOfWeek(.thursday)],daysOfTheMonth:nil,monthsOfTheYear:nil,weeksOfTheYear:nil,daysOfTheYear:nil,setPositions:nil,end:EKRecurrenceEnd(end:Date(timeIntervalSince1970:1900000000)))
let original=[ordinal,alternating].map(recurrenceSnapshot)
let fixture=Fixture()
try applyRecurrenceSnapshots(fixture,snapshots:original)
let rebuilt=fixture.recurrenceRules!.map(recurrenceSnapshot)
let before = try JSONSerialization.data(withJSONObject:original,options:.sortedKeys)
let after = try JSONSerialization.data(withJSONObject:rebuilt,options:.sortedKeys)
assert(before == after)
assert(fixture.recurrenceRules![0].daysOfTheWeek![0].weekNumber == 2)
assert(fixture.recurrenceRules![0].recurrenceEnd!.occurrenceCount == 6)
do { try applyRecurrenceSnapshots(fixture,snapshots:[["frequency":0,"interval":0]]); fatalError("accepted invalid rule") } catch {}
assert(fixture.recurrenceRules!.count == 2)
print("round-trip ok")
`;
    await writeFile(join(dir,'test.swift'),harness);
    await exec('swiftc',['-module-cache-path',join(dir,'cache'),join(dir,'test.swift'),'-o',join(dir,'check')]);
    const {stdout}=await exec(join(dir,'check'));
    assert.match(stdout,/round-trip ok/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
