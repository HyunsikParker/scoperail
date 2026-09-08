import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReceiptStore } from '../sdk/file-receipt-store.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'scoperail-receipts-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function worker(t, path, mode = 'complete') {
  const child = fork(new URL('./fixtures/receipt-worker.mjs', import.meta.url), [path, mode], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  return child;
}

test('completed BigInt result survives a fresh process without repeating work', { timeout: 10000 }, async t => {
  const path = await directory(t);
  const a = worker(t, path);
  assert.equal((await once(a, 'message'))[0], 'complete:42');
  await once(a, 'exit');
  const b = worker(t, path);
  assert.equal((await once(b, 'message'))[0], 'complete:42');
  await once(b, 'exit');
  assert.equal(await readFile(join(path, 'effects'), 'utf8'), 'effect\n');
});

test('competing process cannot run pending work; completed result becomes reusable', { timeout: 10000 }, async t => {
  const path = await directory(t);
  const a = worker(t, path, 'hold');
  assert.equal((await once(a, 'message'))[0], 'claimed');
  const b = worker(t, path);
  assert.equal((await once(b, 'message'))[0], 'uncertain');
  await once(b, 'exit');
  const message = once(a, 'message');
  a.send('complete');
  assert.equal((await message)[0], 'complete:42');
  await once(a, 'exit');
  assert.equal(await readFile(join(path, 'effects'), 'utf8'), 'effect\n');
});

test('killed worker leaves an unresolved claim and never automatically repeats its side effect', { timeout: 10000 }, async t => {
  const path = await directory(t);
  const a = worker(t, path, 'hold');
  assert.equal((await once(a, 'message'))[0], 'claimed');
  const exited = once(a, 'exit');
  a.kill('SIGKILL');
  await exited;
  const b = worker(t, path);
  assert.equal((await once(b, 'message'))[0], 'uncertain');
  await once(b, 'exit');
  assert.equal(await readFile(join(path, 'effects'), 'utf8'), 'effect\n');
});

test('same-process callers share pending work and failure remains claimed', async t => {
  const store = createFileReceiptStore({ directory: await directory(t) });
  let calls = 0;
  const work = async () => { calls++; throw new Error('uncertain side effect'); };
  const a = store.runOnce('receipt', work);
  const b = store.runOnce('receipt', work);
  assert.equal(a, b);
  await assert.rejects(a, /uncertain side effect/);
  await assert.rejects(store.runOnce('receipt', work), /reconcile/);
  assert.equal(calls, 1);
});

test('corrupted completed data fails closed instead of repeating work', async t => {
  const path = await directory(t);
  const store = createFileReceiptStore({ directory: path });
  await store.runOnce('receipt', () => 42n);
  const [claim] = await readdir(path);
  await writeFile(join(path, claim, 'result'), 'broken');
  let calls = 0;
  await assert.rejects(store.runOnce('receipt', () => calls++), /reconcile/);
  assert.equal(calls, 0);
});
