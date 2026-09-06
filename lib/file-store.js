// Cross-process transactions for local JSON stores. Never steal a lock from a
// living writer: a suspended Mac can resume well after any wall-clock timeout.
import { open, readFile, readlink, symlink, mkdir, unlink, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(tmp, file);
    const dir = await open(dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await handle?.close();
    await unlink(tmp).catch(() => {});
  }
}

export async function withFileLock(file, fn, { timeoutMs = 30000 } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  // symlink publishes ownership atomically. A crash cannot leave the empty
  // owner file that open('wx') followed by writeFile could leave behind.
  const owner = `${process.pid}:${randomUUID()}`;
  const started = Date.now();
  async function readOwner() {
    try { return await readlink(lock); }
    catch (e) {
      if (e.code !== 'EINVAL') throw e;
      // Compatibility with the previous trash lock format during restart.
      const legacy = JSON.parse(await readFile(lock, 'utf8'));
      return `${legacy.pid}:${legacy.id || legacy.owner}`;
    }
  }
  while (true) {
    try { await symlink(owner, lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const previous = await readOwner();
        const pid = Number(previous.split(':')[0]);
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) {
            if (e.code === 'ESRCH' && await readOwner() === previous) {
              await unlink(lock).catch(() => {});
              continue;
            }
          }
        }
      } catch { /* unreadable or changing owner: never guess */ }
      if (Date.now() - started >= timeoutMs) throw new Error('Local data store is busy; retry after the other operation finishes.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await fn(); }
  finally {
    try { if (await readOwner() === owner) await unlink(lock); }
    catch { /* already removed */ }
  }
}
