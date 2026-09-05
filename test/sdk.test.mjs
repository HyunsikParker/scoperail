import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroHash, getAddress, id } from 'ethers';
import {
  SCOPE_RAIL_ABI, admissionReceiptId, canonicalize, checkGrant,
  createMemoryReceiptStore, createRequestCommitment, readGrant,
  runAdmittedWork, submitAdmission, verifyAdmissionReceipt, verifyRequestCommitment,
} from '../sdk/index.mjs';
import { searchSyntheticNotes, providerId as notesProvider, resourceId as notesResource } from '../examples/notes-search.mjs';
import { extractSyntheticTasks, providerId as tasksProvider, resourceId as tasksResource } from '../examples/task-extraction.mjs';

const iface = new Interface(SCOPE_RAIL_ABI);
const contractAddress = getAddress(`0x${'11'.repeat(20)}`);
const delegate = getAddress(`0x${'22'.repeat(20)}`);
const otherAddress = getAddress(`0x${'33'.repeat(20)}`);
const transactionHash = `0x${'44'.repeat(32)}`;
const blockHash = `0x${'55'.repeat(32)}`;
const salt = `0x${'66'.repeat(32)}`;

function fixture(request = { query: 'receipt' }, overrides = {}) {
  const commitment = createRequestCommitment(request, { salt });
  const expected = {
    chainId: 31337n, contractAddress, grantId: 1n, owner: otherAddress, delegate,
    providerId: id('synthetic.provider'), resourceId: id('synthetic.resource'),
    units: 1n, nonce: 0n, requestHash: commitment.requestHash, ...overrides,
  };
  const state = {
    chainId: expected.chainId, head: 101,
    transaction: {
      hash: transactionHash, blockNumber: 100, blockHash,
      chainId: expected.chainId, to: contractAddress, from: delegate, value: 0n,
      data: iface.encodeFunctionData('consume', [expected.grantId, expected.providerId, expected.resourceId, expected.units, expected.nonce, expected.requestHash]),
    },
    block: { number: 100, hash: blockHash, timestamp: 100 },
    receipt: { hash: transactionHash, blockHash, blockNumber: 100, status: 1, to: contractAddress, from: delegate, logs: [] },
  };
  function setEvent(patch = {}, emitter = contractAddress) {
    const event = { ...expected, receiptId: admissionReceiptId(expected), ...patch };
    const encoded = iface.encodeEventLog(iface.getEvent('Admission'), [
      event.receiptId, event.grantId, event.nonce, event.owner, event.delegate, event.providerId,
      event.resourceId, event.units, event.requestHash,
    ]);
    state.receipt.logs = [{ address: emitter, ...encoded, transactionHash, blockHash, removed: false }];
  }
  setEvent();
  const provider = {
    async getNetwork() { return { chainId: state.chainId }; },
    async getBlockNumber() { return state.head; },
    async getTransactionReceipt(hash) { assert.equal(hash, transactionHash); return state.receipt; },
    async getTransaction(hash) { assert.equal(hash, transactionHash); return state.transaction; },
    async getBlock() { return state.block; },
    async waitForTransaction() { return state.receipt; },
  };
  return { state, setEvent, provider, expected, request, salt, transactionHash };
}

test('canonical JSON is sorted, typed and deterministic', () => {
  assert.equal(canonicalize({ z: [true, null, 1.25], a: '한글' }), '{"a":"한글","z":[true,null,1.25]}');
  assert.equal(canonicalize(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}');
  const first = createRequestCommitment({ b: 2, a: 1 }, { salt });
  const second = createRequestCommitment({ a: 1, b: 2 }, { salt });
  assert.equal(first.requestHash, second.requestHash);
  assert.notEqual(first.requestHash, createRequestCommitment({ a: 1, b: 2 }, { salt: `0x${'77'.repeat(32)}` }).requestHash);
  assert.equal(verifyRequestCommitment({ a: 1, b: 2 }, salt, first.requestHash), true);
  assert.throws(() => verifyRequestCommitment({ a: 2, b: 2 }, salt, first.requestHash), /commitment/);
  const random = createRequestCommitment({ fixture: true });
  assert.match(random.salt, /^0x[0-9a-f]{64}$/);
  assert.notEqual(random.salt, createRequestCommitment({ fixture: true }).salt);
});

test('canonical JSON rejects unsupported types and prototype hazards without invoking getters', () => {
  let getterCalls = 0;
  const accessor = { get value() { getterCalls++; return 1; } };
  const cycle = {}; cycle.self = cycle;
  const sparse = Array(2);
  const decorated = [1]; decorated.extra = true;
  const hidden = {}; Object.defineProperty(hidden, 'x', { value: 1 });
  const symbolKey = { [Symbol('x')]: 1 };
  const inputs = [undefined, { x: undefined }, NaN, Infinity, -Infinity, -0, 1n, () => 1,
    new Date(), new Map(), Object.create({ inherited: 1 }), accessor, cycle, sparse, decorated,
    hidden, symbolKey, Symbol('x'), '\ud800', JSON.parse('{"__proto__":{}}'),
    { constructor: 1 }, { nested: { prototype: true } }];
  for (const input of inputs) assert.throws(() => canonicalize(input));
  assert.equal(getterCalls, 0);
});

test('canonical JSON enforces depth, node, and encoded-byte bounds', () => {
  let deep = 1; for (let i = 0; i < 18; i++) deep = { next: deep };
  assert.throws(() => canonicalize(deep), /bounds/);
  assert.throws(() => canonicalize(Array(5001).fill(0)), /bounds/);
  assert.throws(() => canonicalize('x'.repeat(65_536)), /bytes/);
  assert.throws(() => canonicalize('한'.repeat(22_000)), /bytes/);
  assert.throws(() => createRequestCommitment({}, { salt: 'short' }), /salt/);
});

test('grant scope checks reject expiry boundary, budget, nonce and revocation', () => {
  const f = fixture();
  const grant = { owner: otherAddress, delegate, providerId: f.expected.providerId,
    resourceId: f.expected.resourceId, validUntil: 200n, remaining: 4n, maxPerCall: 2n, nextNonce: 0n, revoked: false };
  assert.equal(checkGrant(grant, f.expected, { now: 199 }), true);
  for (const patch of [{ revoked: true }, { validUntil: 199n }, { remaining: 0n },
    { maxPerCall: 0n }, { nextNonce: 1n }, { delegate: otherAddress }, { owner: delegate },
    { providerId: id('wrong') }, { resourceId: id('wrong') }]) {
    assert.throws(() => checkGrant({ ...grant, ...patch }, f.expected, { now: 199 }));
  }
  assert.throws(() => checkGrant(grant, f.expected, { now: 200 }), /expired/);
  assert.throws(() => checkGrant(grant, { ...f.expected, units: 0 }, { now: 199 }), /units/);
});

test('readGrant decodes the supplied ABI at an explicit block', async () => {
  const f = fixture();
  f.provider.call = async transaction => {
    assert.equal(transaction.to, contractAddress);
    assert.equal(transaction.blockTag, 100);
    return iface.encodeFunctionResult('grants', [otherAddress, delegate, f.expected.providerId,
      f.expected.resourceId, 200, 4, 2, 0, false]);
  };
  const grant = await readGrant({ provider: f.provider, ...f.expected, blockTag: 100 });
  assert.equal(grant.remaining, 4n);
  assert.equal(grant.revoked, false);
  await assert.rejects(readGrant({ provider: f.provider, ...f.expected, owner: delegate, blockTag: 100 }), /owner/);
});

test('exact successful receipt verifies without reading current grant state', async () => {
  const f = fixture();
  f.provider.call = () => assert.fail('receipt verification must not reread a later-revoked grant');
  const result = await verifyAdmissionReceipt(f);
  assert.equal(result.receiptId, admissionReceiptId(f.expected));
  assert.equal(result.confirmations, 2n);
  assert.equal(result.grantId, 1n);
  assert.equal(Object.isFrozen(result), true);
});

const receiptFailures = {
  'wrong provider chain': f => { f.state.chainId = 1n; },
  'wrong transaction chain': f => { f.state.transaction.chainId = 1n; },
  'wrong transaction block': f => { f.state.transaction.blockNumber = 99; },
  'wrong transaction block hash': f => { f.state.transaction.blockHash = id('another block'); },
  'pending transaction response': f => { f.state.transaction.blockHash = null; f.state.transaction.blockNumber = null; },
  'wrong receipt contract': f => { f.state.receipt.to = otherAddress; },
  'wrong transaction contract': f => { f.state.transaction.to = otherAddress; },
  'wrong event contract': f => f.setEvent({}, otherAddress),
  'wrong receipt delegate': f => { f.state.receipt.from = otherAddress; },
  'wrong transaction delegate': f => { f.state.transaction.from = otherAddress; },
  'failed transaction': f => { f.state.receipt.status = 0; },
  'missing receipt': f => { f.state.receipt = null; },
  'missing transaction': f => { f.state.transaction = null; },
  'missing event': f => { f.state.receipt.logs = []; },
  'duplicate event': f => { f.state.receipt.logs.push(f.state.receipt.logs[0]); },
  'removed event': f => { f.state.receipt.logs[0].removed = true; },
  'missing canonical block': f => { f.state.block = null; },
  'reorganized block': f => { f.state.block.hash = id('different block'); },
  'insufficient confirmations': f => { f.state.head = 100; },
  'wrong receipt transaction hash': f => { f.state.receipt.hash = id('different transaction'); },
  'wrong log transaction hash': f => { f.state.receipt.logs[0].transactionHash = id('different transaction'); },
  'nonzero transaction value': f => { f.state.transaction.value = 1n; },
  'wrong consume calldata': f => { f.state.transaction.data = '0x'; },
};
for (const [name, corrupt] of Object.entries(receiptFailures)) {
  test(`receipt verifier rejects ${name} before service work`, async () => {
    const f = fixture(); corrupt(f);
    let calls = 0;
    await assert.rejects(runAdmittedWork({ ...f, receiptStore: createMemoryReceiptStore(), work: () => { calls++; } }));
    assert.equal(calls, 0);
  });
}

const eventFailures = {
  grant: { grantId: 2n }, nonce: { nonce: 1n }, owner: { owner: delegate }, delegate: { delegate: otherAddress },
  provider: { providerId: id('different provider') }, resource: { resourceId: id('different resource') },
  units: { units: 2n }, request: { requestHash: id('different request') },
  receiptId: { receiptId: id('different receipt') },
};
for (const [name, patch] of Object.entries(eventFailures)) {
  test(`receipt verifier rejects mismatched event ${name}`, async () => {
    const f = fixture(); f.setEvent(patch);
    await assert.rejects(verifyAdmissionReceipt(f), new RegExp(name));
  });
}

test('receipt verifier rejects an expected envelope that differs from the admitted request', async () => {
  for (const patch of [
    { grantId: 2n }, { nonce: 1n }, { delegate: otherAddress }, { providerId: id('wrong') },
    { resourceId: id('wrong') }, { owner: delegate }, { units: 2n }, { requestHash: id('wrong') }, { requestHash: ZeroHash },
  ]) {
    const f = fixture();
    await assert.rejects(verifyAdmissionReceipt({ ...f, expected: { ...f.expected, ...patch } }));
  }
});

test('confirmation wait is bounded and supports an explicit confirmation policy', async () => {
  const f = fixture(); f.state.head = 100;
  assert.equal((await verifyAdmissionReceipt({ ...f, confirmations: 1 })).confirmations, 1n);
  f.provider.waitForTransaction = () => new Promise(() => {});
  await assert.rejects(verifyAdmissionReceipt({ ...f, timeoutMs: 10 }), /timed out/);
  await assert.rejects(verifyAdmissionReceipt({ ...f, confirmations: 0 }), /confirmations/);
});

test('submitAdmission refuses the wrong chain before asking the signer to send', async () => {
  const f = fixture(); f.state.chainId = 1n;
  let sent = false;
  const signer = { provider: f.provider, getAddress: async () => delegate, sendTransaction: async () => { sent = true; } };
  await assert.rejects(submitAdmission({ signer, expected: f.expected }), /chain/);
  assert.equal(sent, false);
});

test('submitAdmission rejects a self-issued grant from outside the trusted resource owner', async () => {
  const f = fixture();
  f.provider.call = async () => iface.encodeFunctionResult('grants', [delegate, delegate,
    f.expected.providerId, f.expected.resourceId, 200, 4, 2, 0, false]);
  let sent = false;
  const signer = { provider: f.provider, getAddress: async () => delegate, sendTransaction: async () => { sent = true; } };
  await assert.rejects(submitAdmission({ signer, expected: f.expected }), /owner/);
  assert.equal(sent, false);
});

test('receipt verifier requires a trusted owner and rejects an unauthorized self-issued receipt', async () => {
  const f = fixture();
  const { owner: omitted, ...withoutOwner } = f.expected;
  await assert.rejects(verifyAdmissionReceipt({ ...f, expected: withoutOwner }), /owner/);
  f.setEvent({ owner: delegate });
  let calls = 0;
  await assert.rejects(runAdmittedWork({ ...f, receiptStore: createMemoryReceiptStore(), work: () => { calls++; } }), /owner/);
  assert.equal(calls, 0);
});

test('work runs once after verification, and request mutation cannot change admitted input', async () => {
  const f = fixture();
  const originalReceipt = f.provider.getTransactionReceipt;
  f.provider.getTransactionReceipt = async hash => { f.request.query = 'mutated'; return originalReceipt(hash); };
  const store = createMemoryReceiptStore();
  let calls = 0;
  const work = request => { calls++; assert.equal(Object.isFrozen(request), true); return request.query; };
  const result = await runAdmittedWork({ ...f, receiptStore: store, work });
  assert.equal(result.result, 'receipt');
  const repeated = await runAdmittedWork({ ...f, request: { query: 'receipt' }, receiptStore: store, work });
  assert.equal(repeated, result);
  assert.equal(calls, 1);
});

test('concurrent receipt replays share one execution, including failures', async () => {
  const f = fixture(); const receiptStore = createMemoryReceiptStore(); let calls = 0;
  const work = async () => { calls++; throw new Error('synthetic operation failure'); };
  const runs = await Promise.allSettled(Array.from({ length: 4 }, () => runAdmittedWork({ ...f, receiptStore, work })));
  assert.equal(calls, 1);
  assert.ok(runs.every(run => run.status === 'rejected'));
});

test('changed plaintext or salt rejects before any work or receipt lookup', async () => {
  const f = fixture();
  f.provider.getTransactionReceipt = () => assert.fail('commitment mismatch should fail first');
  for (const patch of [{ request: { query: 'different' } }, { salt: id('different salt') }]) {
    await assert.rejects(runAdmittedWork({ ...f, ...patch, receiptStore: createMemoryReceiptStore(), work: () => assert.fail('not authorized') }), /commitment/);
  }
});

test('both synthetic adapters use the same verified execution boundary', async () => {
  for (const [request, providerId, resourceId, work] of [
    [{ query: 'receipt' }, notesProvider, notesResource, searchSyntheticNotes],
    [{ fixtureId: 'release-demo' }, tasksProvider, tasksResource, extractSyntheticTasks],
  ]) {
    const f = fixture(request, { providerId, resourceId });
    const result = await runAdmittedWork({ ...f, receiptStore: createMemoryReceiptStore(), work });
    assert.ok(result.result.length > 0);
    f.setEvent({ owner: delegate });
    await assert.rejects(runAdmittedWork({ ...f, receiptStore: createMemoryReceiptStore(), work }), /owner/);
    f.setEvent({ resourceId: id('unrelated resource') });
    await assert.rejects(runAdmittedWork({ ...f, receiptStore: createMemoryReceiptStore(), work }), /resource/);
  }
});
