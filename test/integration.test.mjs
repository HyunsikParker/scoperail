import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { ContractFactory, JsonRpcProvider } from 'ethers';
import {
  createMemoryReceiptStore, createRequestCommitment, runAdmittedWork,
  submitAdmission, verifyAdmissionReceipt,
} from '../sdk/index.mjs';
import * as notes from '../examples/notes-search.mjs';
import * as tasks from '../examples/task-extraction.mjs';

let provider, owner, delegate, otherOwner, artifact;
before(async () => {
  assert.match(process.env.SCOPERAIL_LOCAL_RPC ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  provider = new JsonRpcProvider(process.env.SCOPERAIL_LOCAL_RPC, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 30;
  assert.equal((await provider.getNetwork()).chainId, 31337n);
  [owner, delegate, otherOwner] = await Promise.all([0, 1, 2].map(i => provider.getSigner(i)));
  artifact = JSON.parse(await readFile(new URL('../artifacts/ScopeRail.json', import.meta.url)));
});
after(async () => provider?.destroy());

async function fixture(service, request, grantOwner = owner) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, grantOwner).deploy();
  await contract.waitForDeployment();
  await (await contract.createGrant(await delegate.getAddress(), service.providerId, service.resourceId,
    (await provider.getBlock('latest')).timestamp + 3600, 3, 1)).wait();
  const commitment = createRequestCommitment(request);
  const expected = {
    chainId: 31337n, contractAddress: await contract.getAddress(), grantId: 1n,
    owner: await grantOwner.getAddress(), delegate: await delegate.getAddress(),
    providerId: service.providerId, resourceId: service.resourceId,
    nonce: 0n, units: 1n, requestHash: commitment.requestHash,
  };
  const admission = await submitAdmission({ signer: delegate, expected, confirmations: 1, timeoutMs: 5000 });
  await provider.send('evm_mine', []);
  return { contract, expected, admission, request, ...commitment };
}

async function adapter(t, script, expected, trustedOwner = expected.owner) {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, RPC_URL: process.env.SCOPERAIL_LOCAL_RPC, CHAIN_ID: '31337',
      SCOPERAIL_ADDRESS: expected.contractAddress, RESOURCE_OWNER: trustedOwner, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('adapter startup timed out')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`adapter exited: ${code}`)); });
    child.stderr.resume();
  });
  return async fixture => {
    const response = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ transactionHash: fixture.admission.transactionHash,
        grantId: String(fixture.expected.grantId), delegate: fixture.expected.delegate,
        nonce: String(fixture.expected.nonce), salt: fixture.salt, request: fixture.request }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('real chain receipt authorizes notes-search HTTP adapter and repeat delivery returns the same result', async t => {
  const f = await fixture(notes, { query: 'receipt' });
  const post = await adapter(t, 'examples/notes-search.mjs', f.expected);
  const first = await post(f);
  assert.equal(first.status, 200);
  assert.equal(first.body.receiptId, f.admission.receiptId);
  assert.deepEqual(first.body.result, notes.searchSyntheticNotes(f.request));
  assert.deepEqual(await post(f), first);
});

test('same SDK authorizes the independent task-extraction HTTP adapter', async t => {
  const f = await fixture(tasks, { fixtureId: 'release-demo' });
  const post = await adapter(t, 'examples/task-extraction.mjs', f.expected);
  const result = await post(f);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result, tasks.extractSyntheticTasks(f.request));
});

test('real receipts must match the service trusted owner and service scope before work runs', async () => {
  const f = await fixture(notes, { query: 'receipt' });
  let calls = 0;
  for (const mismatch of [{ owner: await otherOwner.getAddress() }, { providerId: tasks.providerId },
    { resourceId: tasks.resourceId }]) {
    await assert.rejects(() => runAdmittedWork({
      provider, transactionHash: f.admission.transactionHash, expected: { ...f.expected, ...mismatch },
      request: f.request, salt: f.salt, receiptStore: createMemoryReceiptStore(), work: () => { calls++; },
    }), /mismatch/);
  }
  assert.equal(calls, 0);
});

test('HTTP adapter uses its configured resource owner, not the owner of any caller-provided grant', async t => {
  const f = await fixture(notes, { query: 'receipt' }, otherOwner);
  const post = await adapter(t, 'examples/notes-search.mjs', f.expected, await owner.getAddress());
  assert.equal((await post(f)).status, 403);
});

test('SDK preserves previously accepted work after revocation and blocks a new admission', async () => {
  const f = await fixture(notes, { query: 'receipt' });
  await (await f.contract.revoke(1)).wait();
  const old = await verifyAdmissionReceipt({ provider, transactionHash: f.admission.transactionHash, expected: f.expected });
  assert.equal(old.receiptId, f.admission.receiptId);
  const nonceBefore = await provider.getTransactionCount(await delegate.getAddress());
  await assert.rejects(() => submitAdmission({ signer: delegate, expected: { ...f.expected, nonce: 1n }, confirmations: 1 }), /revoked/);
  assert.equal(await provider.getTransactionCount(await delegate.getAddress()), nonceBefore);
});
