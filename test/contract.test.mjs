import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AbiCoder, ContractFactory, JsonRpcProvider, ZeroAddress, ZeroHash, id, keccak256 } from 'ethers';

let provider, owner, delegate, outsider, artifact;
const providerId = id('synthetic-notes-provider');
const resourceId = id('synthetic-project-notes');
const requestHash = id('synthetic-salted-request');

before(async () => {
  const rpc = process.env.SCOPERAIL_LOCAL_RPC;
  assert.match(rpc ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 30;
  assert.equal((await provider.getNetwork()).chainId, 31337n);
  [owner, delegate, outsider] = await Promise.all([0, 1, 2].map(i => provider.getSigner(i)));
  artifact = JSON.parse(await readFile(new URL('../artifacts/ScopeRail.json', import.meta.url)));
});
after(async () => { await provider?.destroy(); });

async function fixture({ budget = 5, maxPerCall = 2, lifetime = 3600 } = {}) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, owner).deploy();
  await contract.waitForDeployment();
  const block = await provider.getBlock('latest');
  const deadline = block.timestamp + lifetime;
  const created = await contract.createGrant(await delegate.getAddress(), providerId, resourceId,
    deadline, budget, maxPerCall);
  await created.wait();
  return { contract, agent: contract.connect(delegate), deadline };
}

async function rejected(call, contract, expected) {
  await assert.rejects(call, error => {
    const data = error.data ?? error.info?.error?.data?.data ?? error.info?.error?.data;
    if (typeof data !== 'string') return false;
    return contract.interface.parseError(data)?.name === expected;
  });
}

test('grant binds owner, delegate, resource, provider, deadline and exact budget', async () => {
  const { contract, deadline } = await fixture();
  const grant = await contract.grants(1);
  assert.equal(grant.owner, await owner.getAddress());
  assert.equal(grant.delegate, await delegate.getAddress());
  assert.equal(grant.providerId, providerId);
  assert.equal(grant.resourceId, resourceId);
  assert.equal(grant.validUntil, BigInt(deadline));
  assert.equal(grant.remaining, 5n);
  assert.equal(grant.maxPerCall, 2n);
  assert.equal(grant.nextNonce, 0n);
  assert.equal(grant.revoked, false);
});

test('invalid configurations and nonexistent grants are rejected', async () => {
  const { contract } = await fixture();
  const now = (await provider.getBlock('latest')).timestamp;
  const delegateAddress = await delegate.getAddress();
  for (const args of [
    [ZeroAddress, providerId, resourceId, now + 100, 5, 2],
    [delegateAddress, ZeroHash, resourceId, now + 100, 5, 2],
    [delegateAddress, providerId, ZeroHash, now + 100, 5, 2],
    [delegateAddress, providerId, resourceId, now, 5, 2],
    [delegateAddress, providerId, resourceId, now + 100, 0, 0],
    [delegateAddress, providerId, resourceId, now + 100, 1, 2]
  ]) await rejected(() => contract.createGrant.staticCall(...args), contract, 'InvalidConfiguration');
  await rejected(() => contract.revoke.staticCall(999), contract, 'InvalidGrant');
});

test('only exact delegate can consume; only owner can revoke', async () => {
  const { contract } = await fixture();
  for (const signer of [owner, outsider]) {
    await rejected(() => contract.connect(signer).consume.staticCall(1, providerId, resourceId, 1, 0, requestHash), contract, 'NotDelegate');
  }
  await rejected(() => contract.connect(delegate).revoke.staticCall(1), contract, 'NotOwner');
  assert.equal((await contract.grants(1)).remaining, 5n);
});

test('cross-provider and cross-resource requests do not consume budget', async () => {
  const { contract, agent } = await fixture();
  await rejected(() => agent.consume.staticCall(1, id('other-provider'), resourceId, 1, 0, requestHash), contract, 'ScopeMismatch');
  await rejected(() => agent.consume.staticCall(1, providerId, id('other-resource'), 1, 0, requestHash), contract, 'ScopeMismatch');
  assert.equal((await contract.grants(1)).remaining, 5n);
  assert.equal((await contract.grants(1)).nextNonce, 0n);
});

test('per-call limits, nonzero commitment and ordered nonce are enforced', async () => {
  const { contract, agent } = await fixture();
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 0, 0, requestHash), contract, 'InvalidUnits');
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 3, 0, requestHash), contract, 'InvalidUnits');
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 1, 1, requestHash), contract, 'NonceMismatch');
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 1, 0, ZeroHash), contract, 'InvalidCommitment');
  await (await agent.consume(1, providerId, resourceId, 1, 0, requestHash)).wait();
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 1, 0, requestHash), contract, 'NonceMismatch');
  assert.equal((await contract.grants(1)).remaining, 4n);
});

test('exact total budget depletion permits no additional admissions', async () => {
  const { contract, agent } = await fixture({ budget: 3, maxPerCall: 2 });
  await (await agent.consume(1, providerId, resourceId, 2, 0, requestHash)).wait();
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 2, 1, requestHash), contract, 'BudgetExceeded');
  await (await agent.consume(1, providerId, resourceId, 1, 1, id('second-request'))).wait();
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 1, 2, id('third-request')), contract, 'BudgetExceeded');
  assert.equal((await contract.grants(1)).remaining, 0n);
  assert.equal((await contract.grants(1)).nextNonce, 2n);
});

test('revocation blocks a previously prepared request and preserves accepted history', async () => {
  const { contract, agent } = await fixture();
  const receipt = await (await agent.consume(1, providerId, resourceId, 1, 0, requestHash)).wait();
  await (await contract.revoke(1)).wait();
  await (await contract.revoke(1)).wait();
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 1, 1, id('queued-request')), contract, 'Revoked');
  assert.equal((await provider.getTransactionReceipt(receipt.hash)).status, 1);
  assert.equal((await contract.grants(1)).remaining, 4n);
});

test('expiry is exclusive at the exact deadline', async () => {
  const { contract, agent, deadline } = await fixture();
  await provider.send('evm_setNextBlockTimestamp', [deadline]);
  await provider.send('evm_mine', []);
  await rejected(() => agent.consume.staticCall(1, providerId, resourceId, 1, 0, requestHash), contract, 'Expired');
});

test('admission receipt binds chain, contract, grant, nonce, request and cost', async () => {
  const { contract, agent } = await fixture();
  const receipt = await (await agent.consume(1, providerId, resourceId, 2, 0, requestHash)).wait();
  const event = receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === 'Admission');
  const expected = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256', 'uint64', 'bytes32', 'uint32'],
    [31337n, await contract.getAddress(), 1n, 0n, requestHash, 2n]));
  assert.equal(event.args.receiptId, expected);
  assert.equal(event.args.owner, await owner.getAddress());
  assert.equal(event.args.delegate, await delegate.getAddress());
  assert.equal(event.args.providerId, providerId);
  assert.equal(event.args.resourceId, resourceId);
  assert.equal(event.args.units, 2n);
  assert.equal(event.args.requestHash, requestHash);
});

test('two concurrent admissions cannot both consume the final unit', async () => {
  const { contract, agent } = await fixture({ budget: 1, maxPerCall: 1 });
  const results = await Promise.allSettled([0, 1].map(async i => {
    const tx = await agent.consume(1, providerId, resourceId, 1, 0, id(`parallel-${i}`), { gasLimit: 250000 });
    return tx.wait();
  }));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await contract.grants(1)).remaining, 0n);
  assert.equal((await contract.grants(1)).nextNonce, 1n);
});

test('contract accepts neither direct funding nor value with grant creation', async () => {
  const { contract, deadline } = await fixture();
  await assert.rejects(() => owner.sendTransaction({ to: contract.target, value: 1n }));
  await assert.rejects(async () => contract.createGrant.staticCall(await delegate.getAddress(), providerId, resourceId,
    deadline, 1, 1, { value: 1n }));
  assert.equal(await provider.getBalance(contract.target), 0n);
});
