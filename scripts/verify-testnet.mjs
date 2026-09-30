import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FetchRequest, JsonRpcProvider, getAddress, keccak256 } from 'ethers';
import { readGrant, verifyAdmissionReceipt } from '../sdk/index.mjs';
import { services } from '../examples/fixtures.mjs';

// Read-only chain access; only the two checked-in synthetic fixtures are sent locally.
const config = JSON.parse(await readFile('examples/monad-testnet.json', 'utf8'));
assert.equal(config.chainId, 10143);
assert.equal(config.rpc, 'https://testnet-rpc.monad.xyz/');
assert.deepEqual(config.samples.map(sample => sample.serviceKey).sort(), ['notes', 'tasks']);
const rpc = new FetchRequest(config.rpc);
rpc.timeout = 15_000;
const provider = new JsonRpcProvider(rpc);
const directory = await mkdtemp(join(tmpdir(), 'scoperail-testnet-'));
const children = new Set();
let stage = 'deployment';

async function start(sample, owner = sample.expected.owner) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const script = sample.serviceKey === 'notes' ? 'notes-search.mjs' : 'task-extraction.mjs';
  const child = spawn(process.execPath, [`examples/${script}`], {
    env: { ...process.env, RPC_URL: config.rpc, CHAIN_ID: String(config.chainId),
      SCOPERAIL_ADDRESS: config.contractAddress, RESOURCE_OWNER: owner,
      RECEIPT_STORE_DIR: directory, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Adapter startup timeout')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Adapter exited')); });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
    children.delete(child);
  };
  const post = async (request = sample.request) => {
    const response = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(65_000),
      body: JSON.stringify({ transactionHash: sample.transactionHash,
        grantId: String(sample.expected.grantId), delegate: sample.expected.delegate,
        nonce: String(sample.expected.nonce), salt: sample.salt, request }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { post, stop };
}

async function records() {
  const result = [];
  for (const namespace of await readdir(directory, { withFileTypes: true })) {
    assert.ok(namespace.isDirectory());
    for (const claim of await readdir(join(directory, namespace.name), { withFileTypes: true })) {
      assert.ok(claim.isDirectory());
      const path = join(directory, namespace.name, claim.name, 'result');
      const info = await stat(path, { bigint: true });
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      result.push({ path, hash, inode: info.ino, modified: info.mtimeNs });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

try {
  const artifact = JSON.parse(await readFile('artifacts/ScopeRail.json', 'utf8'));
  assert.equal((await provider.getNetwork()).chainId, BigInt(config.chainId));
  assert.equal(keccak256(await provider.getCode(config.contractAddress)), keccak256(artifact.deployedBytecode));
  console.log('PASS Monad Testnet chain and compiled contract bytecode');
  for (const sample of config.samples) {
    stage = sample.serviceKey;
    assert.equal(getAddress(sample.expected.contractAddress), getAddress(config.contractAddress));
    assert.equal(BigInt(sample.expected.chainId), BigInt(config.chainId));
    const grant = await readGrant({ provider, ...sample.expected });
    assert.equal(grant.revoked, true);
    const receipt = await verifyAdmissionReceipt({ provider,
      transactionHash: sample.transactionHash, expected: sample.expected });
    const first = await start(sample);
    const response = await first.post();
    assert.equal(response.status, 200);
    assert.equal(response.body.receiptId, receipt.receiptId);
    assert.deepEqual(response.body.result, services[sample.serviceKey].work(sample.request));
    const saved = await records();
    assert.equal((await first.post()).status, 200);
    assert.deepEqual(await records(), saved);
    await first.stop();
    const restarted = await start(sample);
    assert.deepEqual(await restarted.post(), response);
    assert.deepEqual(await records(), saved);
    const changed = sample.serviceKey === 'notes' ? { query: 'changed' } : { fixtureId: 'revoke-demo' };
    assert.equal((await restarted.post(changed)).status, 403);
    assert.deepEqual(await records(), saved);
    await restarted.stop();
    const wrongOwner = await start(sample, '0x0000000000000000000000000000000000000001');
    assert.equal((await wrongOwner.post()).status, 403);
    await wrongOwner.stop();
    // A wrong-owner adapter may create no completed claim.
    assert.deepEqual(await records(), saved);
    console.log(`PASS ${sample.serviceKey}: confirmed admission after revocation, HTTP result, durable retry/restart, changed request and wrong owner rejected`);
  }
  assert.equal((await records()).length, 2);
  console.log('PASS two synthetic adapters; no wallet, signature or new chain transaction');
} catch {
  console.error(`FAIL ScopeRail testnet verification at ${stage}; RPC availability and local adapter setup are required.`);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
  }
  provider.destroy();
  await rm(directory, { recursive: true, force: true });
}
