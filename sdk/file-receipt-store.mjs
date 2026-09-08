import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serialize, deserialize } from 'node:v8';

async function flushDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Trusted local disk only. Never remove an unresolved claim to retry side effects. */
export function createFileReceiptStore({ directory } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Receipt directory required');
  const root = resolve(directory);
  const pending = new Map();

  async function run(key, operation) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const claim = join(root, createHash('sha256').update(key).digest('hex'));
    const resultPath = join(claim, 'result');
    try {
      await mkdir(claim, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const record = deserialize(await readFile(resultPath));
        if (record?.version !== 1 || record.key !== key || !Object.hasOwn(record, 'value')) {
          throw new Error('Invalid receipt record');
        }
        return record.value;
      } catch (cause) {
        throw new Error('Receipt pending, uncertain or unreadable; reconcile before retrying', { cause });
      }
    }
    // Make the claim durable before operation can cause any side effect.
    await flushDirectory(root);
    const value = await operation();
    const bytes = serialize({ version: 1, key, value });
    const temporary = join(claim, `result-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, resultPath);
    await flushDirectory(claim);
    return value;
  }

  return Object.freeze({
    runOnce(key, operation) {
      if (typeof key !== 'string' || !key.length || key.length > 1024 || typeof operation !== 'function') {
        return Promise.reject(new Error('Invalid receipt key or operation'));
      }
      if (pending.has(key)) return pending.get(key);
      const promise = run(key, operation);
      pending.set(key, promise);
      // Disk owns completion and uncertainty; retain only in-flight promises in memory.
      const forget = () => pending.delete(key);
      promise.then(forget, forget);
      return promise;
    },
  });
}
