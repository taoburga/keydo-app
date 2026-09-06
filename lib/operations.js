// Durable receipts for irreversible creates. A lost reply must never turn a
// retry into a second reminder. Unknown outcomes fail closed for manual review.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { APP_DATA_DIR } from './app-data.js';
import { atomicWrite, withFileLock } from './file-store.js';

export function operationStore(dir = APP_DATA_DIR) {
  const file = join(dir, 'operations.json');
  return async function run(key, payload, mutate) {
    if (typeof key !== 'string' || !key || key.length > 200) throw new Error('A valid operation ID is required.');
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return withFileLock(file, async () => {
      let entries = {};
      try { entries = JSON.parse(await readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw new Error('Operation receipts are unreadable; no change attempted.'); }
      const old = entries[key];
      if (old && old.hash !== hash) throw new Error('Operation ID was reused with different input.');
      if (old?.state === 'done') return old.result;
      if (old || Object.values(entries).some(e => e.hash === hash && e.state === 'pending')) {
        throw new Error('The earlier operation has an unknown outcome. Check Reminders before retrying; no duplicate was created.');
      }
      // Retain unknown outcomes indefinitely. Keep completed receipts for 90
      // days, longer than trash retention and interactive retry windows.
      const cutoff = Date.now() - 90 * 86400000;
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.state === 'done' && entry.at < cutoff) delete entries[id];
      }
      entries[key] = { hash, at: Date.now(), state: 'pending' };
      await atomicWrite(file, JSON.stringify(entries));
      let result;
      try { result = await mutate(); }
      catch (error) {
        // Daemon validation errors guarantee no commit (store.reset). All
        // transport/timeouts remain pending, even if they look retryable.
        if (error.userError) {
          delete entries[key];
          await atomicWrite(file, JSON.stringify(entries));
        }
        throw error;
      }
      entries[key] = { hash, at: Date.now(), state: 'done', result };
      await atomicWrite(file, JSON.stringify(entries));
      return result;
    }, { timeoutMs: 65000 });
  };
}
export const runOperation = operationStore();
