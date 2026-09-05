import {
  AbiCoder, Contract, Interface, ZeroAddress, ZeroHash,
  getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes,
} from 'ethers';

export const SCOPE_RAIL_ABI = [
  'function grants(uint256) view returns (address owner,address delegate,bytes32 providerId,bytes32 resourceId,uint64 validUntil,uint32 remaining,uint32 maxPerCall,uint64 nextNonce,bool revoked)',
  'function createGrant(address delegate,bytes32 providerId,bytes32 resourceId,uint64 validUntil,uint32 budget,uint32 maxPerCall) returns (uint256 grantId)',
  'function revoke(uint256 grantId)',
  'function consume(uint256 grantId,bytes32 providerId,bytes32 resourceId,uint32 units,uint64 expectedNonce,bytes32 requestHash) returns (bytes32 receiptId)',
  'event GrantCreated(uint256 indexed grantId,address indexed owner,address indexed delegate,bytes32 providerId,bytes32 resourceId,uint64 validUntil,uint32 budget,uint32 maxPerCall)',
  'event GrantRevoked(uint256 indexed grantId)',
  'event Admission(bytes32 indexed receiptId,uint256 indexed grantId,uint64 nonce,address owner,address delegate,bytes32 providerId,bytes32 resourceId,uint32 units,bytes32 requestHash)',
];

const abi = AbiCoder.defaultAbiCoder();
const iface = new Interface(SCOPE_RAIL_ABI);
const admissionTopic = iface.getEvent('Admission').topicHash;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BYTES = 65_536;
const MAX_NODES = 5_000;
const MAX_DEPTH = 16;
const utf8 = new TextEncoder();

function fail(message) { throw new Error(`ScopeRail: ${message}`); }
function uint(value, bits, name, nonzero = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(`invalid ${name}`);
  if (!['bigint', 'number', 'string'].includes(typeof value)) fail(`invalid ${name}`);
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) fail(`invalid ${name}`);
  let parsed;
  try { parsed = BigInt(value); } catch { fail(`invalid ${name}`); }
  if (parsed < (nonzero ? 1n : 0n) || parsed >= (1n << BigInt(bits))) fail(`invalid ${name}`);
  return parsed;
}
function address(value, name) {
  try { return getAddress(value); } catch { fail(`invalid ${name}`); }
}
function bytes32(value, name, nonzero = false) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`invalid ${name}`);
  const result = value.toLowerCase();
  if (nonzero && result === ZeroHash) fail(`invalid ${name}`);
  return result;
}
function equals(actual, expected, name) {
  if (actual !== expected) fail(`${name} mismatch`);
}
function settings(confirmations, timeoutMs) {
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 64) fail('invalid confirmations');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) fail('invalid timeoutMs');
}
async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ScopeRail: verification timed out')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function assertChain(provider, chainId) {
  equals(uint((await provider.getNetwork()).chainId, 256, 'network chainId', true), chainId, 'chain');
}

/** Deterministic, bounded JSON. Rejects accessors, sparse arrays, cycles and exotic values. */
export function canonicalize(value) {
  const ancestors = new Set();
  const chunks = [];
  let bytes = 0;
  let nodes = 0;
  function append(part) {
    bytes += utf8.encode(part).byteLength;
    if (bytes > MAX_BYTES) fail('request exceeds 65536 bytes');
    chunks.push(part);
  }
  function string(value) {
    if (value.length > MAX_BYTES || utf8.encode(value).byteLength > MAX_BYTES) fail('request exceeds 65536 bytes');
    // Unpaired UTF-16 surrogates have no unique valid UTF-8 representation.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('invalid Unicode string');
    append(JSON.stringify(value));
  }
  function walk(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('request structure exceeds bounds');
    if (item === null) return append('null');
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') return append(String(item));
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail('unsupported JSON number');
      return append(JSON.stringify(item));
    }
    if (typeof item !== 'object') fail('unsupported JSON value');
    if (ancestors.has(item)) fail('cyclic request');
    const isArray = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('unsupported object prototype');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_NODES) fail('request structure exceeds bounds');
    for (const key of keys) {
      if (typeof key !== 'string' || forbiddenKeys.has(key)) fail('unsafe JSON property');
      const descriptor = descriptors[key];
      if (!('value' in descriptor) || (!descriptor.enumerable && !(isArray && key === 'length'))) fail('unsupported JSON property');
    }
    ancestors.add(item);
    if (isArray) {
      const length = descriptors.length.value;
      if (length > MAX_NODES || keys.length !== length + 1) fail('sparse or decorated array');
      append('[');
      for (let i = 0; i < length; i++) {
        if (!Object.hasOwn(descriptors, String(i))) fail('sparse or decorated array');
        if (i) append(',');
        walk(descriptors[i].value, depth + 1);
      }
      append(']');
    } else {
      append('{');
      keys.sort().forEach((key, index) => {
        if (index) append(',');
        string(key); append(':'); walk(descriptors[key].value, depth + 1);
      });
      append('}');
    }
    ancestors.delete(item);
  }
  walk(value, 0);
  return chunks.join('');
}

/** Keep salt and request private; only requestHash belongs in consume calldata. */
export function createRequestCommitment(request, { salt = hexlify(randomBytes(32)) } = {}) {
  const canonicalJson = canonicalize(request);
  const normalizedSalt = bytes32(salt, 'salt');
  const requestHash = keccak256(abi.encode(
    ['string', 'bytes32', 'bytes32'],
    ['ScopeRail request v1', normalizedSalt, keccak256(toUtf8Bytes(canonicalJson))],
  ));
  return Object.freeze({ requestHash, salt: normalizedSalt, canonicalJson });
}

export function verifyRequestCommitment(request, salt, requestHash) {
  equals(createRequestCommitment(request, { salt }).requestHash, bytes32(requestHash, 'requestHash', true), 'request commitment');
  return true;
}

function scope(request) {
  return {
    owner: address(request.owner, 'owner'),
    delegate: address(request.delegate, 'delegate'),
    providerId: bytes32(request.providerId, 'providerId', true),
    resourceId: bytes32(request.resourceId, 'resourceId', true),
    units: uint(request.units, 32, 'units', true),
    nonce: uint(request.nonce, 64, 'nonce'),
  };
}
function envelope(expected) {
  return Object.freeze({
    ...scope(expected),
    chainId: uint(expected.chainId, 256, 'chainId', true),
    contractAddress: address(expected.contractAddress, 'contractAddress'),
    grantId: uint(expected.grantId, 256, 'grantId', true),
    requestHash: bytes32(expected.requestHash, 'requestHash', true),
  });
}

export async function readGrant({ provider, chainId, contractAddress, grantId, owner, blockTag = 'latest' }) {
  const network = uint(chainId, 256, 'chainId', true);
  await assertChain(provider, network);
  const contract = new Contract(address(contractAddress, 'contractAddress'), SCOPE_RAIL_ABI, provider);
  const result = await contract.grants(uint(grantId, 256, 'grantId', true), { blockTag });
  const grant = Object.freeze({
    owner: address(result.owner, 'owner'), delegate: address(result.delegate, 'delegate'),
    providerId: bytes32(result.providerId, 'providerId'), resourceId: bytes32(result.resourceId, 'resourceId'),
    validUntil: uint(result.validUntil, 64, 'validUntil'), remaining: uint(result.remaining, 32, 'remaining'),
    maxPerCall: uint(result.maxPerCall, 32, 'maxPerCall'), nextNonce: uint(result.nextNonce, 64, 'nextNonce'),
    revoked: result.revoked,
  });
  if (grant.owner === ZeroAddress) fail('grant does not exist');
  if (owner !== undefined) equals(grant.owner, address(owner, 'expected owner'), 'owner');
  await assertChain(provider, network);
  return grant;
}

/** Preflight only. The contract decides admission atomically against current state. */
export function checkGrant(grant, request, { now = Math.floor(Date.now() / 1000) } = {}) {
  const wanted = scope(request);
  if (address(grant.owner, 'owner') === ZeroAddress) fail('grant does not exist');
  equals(address(grant.owner, 'owner'), wanted.owner, 'owner');
  if (grant.revoked !== false) fail('grant revoked or invalid');
  if (uint(now, 64, 'now') >= uint(grant.validUntil, 64, 'validUntil')) fail('grant expired');
  equals(address(grant.delegate, 'delegate'), wanted.delegate, 'delegate');
  equals(bytes32(grant.providerId, 'providerId'), wanted.providerId, 'provider');
  equals(bytes32(grant.resourceId, 'resourceId'), wanted.resourceId, 'resource');
  equals(uint(grant.nextNonce, 64, 'nextNonce'), wanted.nonce, 'nonce');
  if (wanted.units > uint(grant.maxPerCall, 32, 'maxPerCall')) fail('per-call limit exceeded');
  if (wanted.units > uint(grant.remaining, 32, 'remaining')) fail('budget exhausted');
  return true;
}

export function admissionReceiptId(expected) {
  const e = envelope(expected);
  return keccak256(abi.encode(
    ['uint256', 'address', 'uint256', 'uint64', 'bytes32', 'uint32'],
    [e.chainId, e.contractAddress, e.grantId, e.nonce, e.requestHash, e.units],
  ));
}

/** Verifies a direct consume transaction. The configured RPC is a trust boundary. */
export async function verifyAdmissionReceipt({ provider, transactionHash, expected, confirmations = 2, timeoutMs = 60_000 }) {
  settings(confirmations, timeoutMs);
  const hash = bytes32(transactionHash, 'transactionHash', true);
  const e = envelope(expected);
  return bounded(async () => {
    await assertChain(provider, e.chainId);
    let receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) fail('transaction receipt missing');
    let head = uint(await provider.getBlockNumber(), 64, 'head block');
    if (head - uint(receipt.blockNumber, 64, 'receipt block') + 1n < BigInt(confirmations)) {
      if (typeof provider.waitForTransaction !== 'function') fail('insufficient confirmations');
      await provider.waitForTransaction(hash, confirmations, timeoutMs);
      receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) fail('transaction receipt missing');
      head = uint(await provider.getBlockNumber(), 64, 'head block');
    }
    equals(uint(receipt.status, 8, 'receipt status'), 1n, 'transaction success');
    equals(bytes32(receipt.hash, 'receipt hash'), hash, 'transaction hash');
    equals(address(receipt.to, 'receipt contract'), e.contractAddress, 'receipt contract');
    equals(address(receipt.from, 'receipt sender'), e.delegate, 'receipt delegate');
    const blockNumber = uint(receipt.blockNumber, 64, 'receipt block');
    if (head - blockNumber + 1n < BigInt(confirmations)) fail('insufficient confirmations');
    const [block, transaction] = await Promise.all([
      provider.getBlock(receipt.blockNumber), provider.getTransaction(hash),
    ]);
    if (!block) fail('canonical block missing');
    equals(uint(block.number, 64, 'block number'), blockNumber, 'block number');
    equals(bytes32(block.hash, 'block hash'), bytes32(receipt.blockHash, 'receipt block hash'), 'canonical block');
    if (!transaction) fail('transaction missing');
    equals(bytes32(transaction.hash, 'transaction hash'), hash, 'transaction hash');
    equals(uint(transaction.blockNumber, 64, 'transaction block number'), blockNumber, 'transaction block number');
    equals(bytes32(transaction.blockHash, 'transaction block hash'), bytes32(receipt.blockHash, 'receipt block hash'), 'transaction block');
    equals(uint(transaction.chainId, 256, 'transaction chainId'), e.chainId, 'transaction chain');
    equals(address(transaction.to, 'transaction contract'), e.contractAddress, 'transaction contract');
    equals(address(transaction.from, 'transaction sender'), e.delegate, 'transaction delegate');
    equals(uint(transaction.value, 256, 'transaction value'), 0n, 'transaction value');
    const calldata = iface.encodeFunctionData('consume', [e.grantId, e.providerId, e.resourceId, e.units, e.nonce, e.requestHash]);
    if (typeof transaction.data !== 'string') fail('transaction calldata missing');
    equals(transaction.data.toLowerCase(), calldata.toLowerCase(), 'consume calldata');
    if (!Array.isArray(receipt.logs)) fail('receipt logs missing');
    const admissions = receipt.logs.filter(log => {
      let emitter;
      try { emitter = getAddress(log.address); } catch { return false; }
      return emitter === e.contractAddress && Array.isArray(log.topics) && log.topics[0]?.toLowerCase() === admissionTopic.toLowerCase();
    });
    if (admissions.length !== 1) fail('expected exactly one Admission event');
    const log = admissions[0];
    if (log.removed) fail('removed Admission event');
    if (log.transactionHash !== undefined) equals(bytes32(log.transactionHash, 'log transaction hash'), hash, 'log transaction');
    if (log.blockHash !== undefined) equals(bytes32(log.blockHash, 'log block hash'), bytes32(receipt.blockHash, 'receipt block hash'), 'log block');
    const event = iface.parseLog(log);
    if (!event || event.name !== 'Admission') fail('Admission event missing');
    equals(event.args.grantId, e.grantId, 'event grant');
    equals(event.args.nonce, e.nonce, 'event nonce');
    equals(address(event.args.owner, 'event owner'), e.owner, 'event owner');
    equals(address(event.args.delegate, 'event delegate'), e.delegate, 'event delegate');
    equals(event.args.providerId.toLowerCase(), e.providerId, 'event provider');
    equals(event.args.resourceId.toLowerCase(), e.resourceId, 'event resource');
    equals(event.args.units, e.units, 'event units');
    equals(event.args.requestHash.toLowerCase(), e.requestHash, 'event request');
    const receiptId = admissionReceiptId(e);
    equals(event.args.receiptId.toLowerCase(), receiptId, 'receiptId');
    await assertChain(provider, e.chainId);
    // Never reread grant state here: revocation only prevents new admissions.
    return Object.freeze({ ...e, receiptId, transactionHash: hash, blockNumber, confirmations: head - blockNumber + 1n });
  }, timeoutMs);
}

/** Signs only the exact consume call; no approval, funding, key custody or tool work. */
export async function submitAdmission({ signer, expected, confirmations = 2, timeoutMs = 60_000 }) {
  settings(confirmations, timeoutMs);
  const e = envelope(expected);
  const provider = signer.provider;
  if (!provider) fail('signer must have a provider');
  await assertChain(provider, e.chainId);
  equals(address(await signer.getAddress(), 'signer'), e.delegate, 'signer delegate');
  const block = await provider.getBlock('latest');
  if (!block) fail('latest block missing');
  const grant = await readGrant({ provider, ...e, blockTag: block.number });
  checkGrant(grant, e, { now: block.timestamp });
  await assertChain(provider, e.chainId);
  const contract = new Contract(e.contractAddress, SCOPE_RAIL_ABI, signer);
  const transaction = await contract.consume(e.grantId, e.providerId, e.resourceId, e.units, e.nonce, e.requestHash, { chainId: e.chainId });
  // A wait failure may still mean a transaction was broadcast; do not blindly resubmit.
  try {
    const mined = await bounded(() => transaction.wait(confirmations, timeoutMs), timeoutMs);
    if (!mined) fail('transaction receipt missing');
    return await verifyAdmissionReceipt({ provider, transactionHash: transaction.hash, expected: e, confirmations, timeoutMs });
  } catch (cause) {
    const error = new Error('ScopeRail: admission not verified; inspect transactionHash before retrying', { cause });
    error.transactionHash = transaction.hash;
    throw error;
  }
}

/** Demo-only, process-local idempotency. Production services need a durable equivalent. */
export function createMemoryReceiptStore({ maxEntries = 10_000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) fail('invalid receipt-store capacity');
  const entries = new Map();
  return Object.freeze({
    runOnce(key, operation) {
      if (entries.has(key)) return entries.get(key);
      if (entries.size >= maxEntries) fail('receipt store full');
      // Retain failures too: an uncertain side effect is not safe to repeat.
      const pending = Promise.resolve().then(operation);
      entries.set(key, pending);
      return pending;
    },
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Commit the exact immutable input, verify receipt, then run idempotent service work. */
export async function runAdmittedWork({ request, salt, work, receiptStore, ...verification }) {
  if (typeof work !== 'function' || typeof receiptStore?.runOnce !== 'function') fail('work and receiptStore are required');
  const snapshot = deepFreeze(JSON.parse(canonicalize(request)));
  const expected = envelope(verification.expected);
  verifyRequestCommitment(snapshot, salt, expected.requestHash);
  const admission = await verifyAdmissionReceipt({ ...verification, expected });
  return receiptStore.runOnce(admission.receiptId, async () => Object.freeze({
    admission, result: await work(snapshot, admission),
  }));
}
