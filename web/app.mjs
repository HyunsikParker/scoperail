import { BrowserProvider, Contract, JsonRpcProvider, getAddress, keccak256, ZeroAddress } from 'ethers';
import { SCOPE_RAIL_ABI, readGrant, checkGrant, createRequestCommitment,
  submitAdmission, runAdmittedWork, createMemoryReceiptStore } from '../sdk/index.mjs';
import { services } from '../examples/fixtures.mjs';

const config = __DEMO_CONFIG__;
const $ = id => document.getElementById(id);
const provider = new JsonRpcProvider(config.rpc, undefined, { cacheTimeout: -1 });
provider.pollingInterval = 250;
const confirmations = config.local ? 1 : 2;
const receiptStore = createMemoryReceiptStore();
const state = { ready: false, busy: false, owner: null, delegate: null, signer: null, signerAddress: null, walletChain: null, ownerAddress: null,
  delegateAddress: null, grantId: null, grant: null, serviceKey: 'notes', last: null, workCount: 0,
  blockTime: 0, pendingTransaction: null, uncertainTransaction: null };
const format = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

function message(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function roleSigner(role) { return config.local ? state[role] : state.signer; }
function hasRole(role) {
  const address = config.local ? state[role + 'Account'] : state.signerAddress;
  return Boolean(address && state.grant && address === state.grant[role]);
}
function walletReady() { return config.local || state.walletChain === BigInt(config.chainId); }
async function requireWrite(role) {
  if (state.uncertainTransaction) throw new Error('ScopeRail: unresolved transaction; writes are paused');
  const signer = roleSigner(role);
  if (!signer || !walletReady()) throw new Error('ScopeRail: connect a wallet on the configured chain');
  if (!config.local) {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    const chain = await window.ethereum.request({ method: 'eth_chainId' });
    if (BigInt(chain) !== BigInt(config.chainId) || !accounts[0] || getAddress(accounts[0]) !== state.signerAddress)
      throw new Error('ScopeRail: wallet changed; wait for the connected signer to refresh');
  }
  if (role !== 'creator' && (!hasRole(role) || getAddress(await signer.getAddress()) !== state.grant[role]))
    throw new Error(`ScopeRail: only the grant ${role} may perform this action`);
  return signer;
}
function render() {
  const expired = state.grant && BigInt(state.blockTime) >= state.grant.validUntil;
  const active = state.grant && !state.grant.revoked && !expired && state.grant.remaining > 0n;
  const writeLocked = state.busy || Boolean(state.uncertainTransaction);
  $('connect').disabled = !state.ready || state.busy || Boolean(config.local ? state.owner : state.signer);
  $('create').disabled = !state.ready || writeLocked || !(config.local ? state.owner : state.signer) || !walletReady() || Boolean(active);
  $('run').disabled = writeLocked || !hasRole('delegate') || !walletReady() || !active;
  $('revoke').disabled = writeLocked || !hasRole('owner') || !walletReady() || !state.grant || state.grant.revoked;
  $('retry').disabled = state.busy || !state.last;
  $('check').disabled = state.busy || !state.grant?.revoked;
  $('service').disabled = state.busy || Boolean(active);
  $('load').disabled = !state.ready || state.busy;
  $('grant-id').disabled = state.busy;
  $('delegate-address').disabled = state.busy || Boolean(active);
  $('signer-address').textContent = config.local ? (state.ownerAccount ? `Local owner: ${state.ownerAccount} · local delegate: ${state.delegateAccount}` : 'Not connected') : (state.signerAddress || 'Not connected');
  $('signer-role').textContent = !walletReady() && state.walletChain !== null ? 'Wrong wallet chain · writes disabled' : [hasRole('owner') && 'owner', hasRole('delegate') && 'delegate'].filter(Boolean).join(' + ') || 'No loaded-grant role';
  $('owner-address').textContent = state.grant?.owner || '—';
  $('loaded-delegate').textContent = state.grant?.delegate || '—';
  $('request').textContent = format(services[state.serviceKey].request);
  $('remaining').textContent = state.grant ? state.grant.revoked || expired ? '0' : String(state.grant.remaining) : '—';
  $('grant-status').textContent = !state.grant ? 'No grant yet' : state.grant.revoked ? `Grant ${state.grantId} · revoked`
    : expired ? `Grant ${state.grantId} · expired` : state.grant.remaining === 0n ? `Grant ${state.grantId} · exhausted` : `Grant ${state.grantId} · active`;
  $('work-count').textContent = String(state.workCount);
  document.querySelectorAll('#sample-buttons button').forEach(button => { button.disabled = state.busy || !state.ready; });
}
async function assertDeployment() {
  if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) throw new Error('Wrong configured chain');
  const code = await provider.getCode(config.contractAddress);
  if (code === '0x' || keccak256(code) !== config.bytecodeHash) throw new Error('Deployment bytecode does not match this build');
  for (const signer of [state.owner, state.delegate, state.signer]) if (signer &&
    (await signer.provider.getNetwork()).chainId !== BigInt(config.chainId)) throw new Error('Switch the wallet to the configured test network');
}
async function action(label, work) {
  if (state.busy) return;
  state.busy = true; message(label); render();
  try { await assertDeployment(); await work(); state.pendingTransaction = null; }
  catch (error) {
    if (state.pendingTransaction || error.transactionHash) {
      state.uncertainTransaction = state.pendingTransaction || error.transactionHash;
      message(`A transaction was broadcast but the action is not verified. Writes are paused. Inspect ${state.uncertainTransaction} before continuing.`, true);
      return;
    }
    const known = typeof error.message === 'string' && error.message.startsWith('ScopeRail:');
    message(error.code === 'ACTION_REJECTED' ? 'Wallet request cancelled. Nothing was retried.'
      : known ? error.message : 'The action could not be verified. No automatic retry was made.', true);
  } finally { state.busy = false; render(); }
}
async function refreshGrant() {
  state.grant = await readGrant({ provider, chainId: config.chainId, contractAddress: config.contractAddress,
    grantId: state.grantId });
  state.ownerAddress = state.grant.owner; state.delegateAddress = state.grant.delegate;
  state.blockTime = (await provider.getBlock('latest')).timestamp;
}
function expected(requestHash, nonce = state.grant.nextNonce) {
  const service = services[state.serviceKey];
  return { chainId: config.chainId, contractAddress: config.contractAddress, grantId: state.grantId,
    owner: state.ownerAddress, delegate: state.delegateAddress,
    providerId: service.providerId, resourceId: service.resourceId, units: 1, nonce, requestHash };
}
async function deliver(payload, cached = false) {
  const countBefore = state.workCount;
  const { admission, result } = await runAdmittedWork({ provider, ...payload, confirmations, receiptStore,
    work: request => { const result = services[payload.serviceKey].work(request); state.workCount++; return result; } });
  $('result').textContent = format(result);
  const delivery = cached || state.workCount === countBefore ? 'cached delivery' : 'work executed';
  $('result-status').textContent = `${services[payload.serviceKey].label} · verified receipt · ${delivery}`;
  $('receipt').replaceChildren(...Object.entries({ chain: config.chainId, contract: config.contractAddress,
    grant: admission.grantId, nonce: admission.nonce, units: admission.units,
    receipt: admission.receiptId, transaction: admission.transactionHash }).map(([key, value]) => {
    const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = key; dd.textContent = String(value); row.append(dt, dd); return row;
  }));
  state.last = payload;
}

$('connect').textContent = config.local ? 'Use local test accounts' : 'Connect testnet wallet';
if (config.local) {
  $('sample-description').textContent = 'No wallet needed. Verify a recorded local-chain admission, then run its synthetic fixture.';
  $('wallet-note').textContent = 'Local EVM only. No external network or real funds are used.';
}
let walletRevision = 0;
async function syncWallet(requestAccess = false) {
  const revision = ++walletRevision;
  state.signer = null; state.signerAddress = null; state.walletChain = null; render();
  const accounts = await window.ethereum.request({ method: requestAccess ? 'eth_requestAccounts' : 'eth_accounts' });
  const chain = BigInt(await window.ethereum.request({ method: 'eth_chainId' }));
  if (revision !== walletRevision) return;
  state.walletChain = chain;
  if (accounts[0] && chain === BigInt(config.chainId)) {
    const signer = await new BrowserProvider(window.ethereum).getSigner(accounts[0]);
    if (revision !== walletRevision) return;
    state.signer = signer; state.signerAddress = getAddress(accounts[0]);
    if (!$('delegate-address').value) $('delegate-address').value = state.signerAddress;
  }
  render();
}
$('connect').addEventListener('click', () => action('Connecting a test wallet…', async () => {
  if (config.local) {
    [state.owner, state.delegate] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
    state.ownerAccount = getAddress(await state.owner.getAddress());
    state.delegateAccount = getAddress(await state.delegate.getAddress());
    $('delegate-address').value = state.delegateAccount;
  } else {
    if (!window.ethereum) { message('Open this page in a browser with an EVM wallet. Samples work without a wallet.', true); return; }
    await syncWallet(true);
  }
  $('wallet-note').textContent = config.local
    ? 'Local EVM only. Separate unlocked owner and delegate test accounts; no real network or funds.'
    : 'The connected signer creates grants. Enter the delegate address, then switch accounts to act in that role. Using the same address for both roles is also supported.';
  message(walletReady() ? 'Wallet connected. Create a grant or load an existing grant ID.' : 'Select the configured test network in your wallet.');
}));
$('load').addEventListener('click', () => action('Loading the onchain grant…', async () => {
  const input = $('grant-id').value.trim();
  if (!/^[1-9][0-9]*$/.test(input) || BigInt(input) >= 2n ** 256n) throw new Error('ScopeRail: enter a positive uint256 grant ID');
  const grantId = BigInt(input);
  const grant = await readGrant({ provider, chainId: config.chainId, contractAddress: config.contractAddress, grantId });
  const serviceKey = Object.keys(services).find(key => services[key].providerId === grant.providerId && services[key].resourceId === grant.resourceId);
  if (!serviceKey) throw new Error('ScopeRail: this grant is not for either synthetic reference service');
  const block = await provider.getBlock('latest');
  Object.assign(state, { grantId, grant, ownerAddress: grant.owner, delegateAddress: grant.delegate, serviceKey, blockTime: block.timestamp });
  $('service').value = serviceKey;
  message(`Grant ${grantId} loaded. Owner and delegate are read from the chain.`);
}));
$('service').addEventListener('change', () => {
  state.serviceKey = $('service').value; state.grant = null; state.grantId = null; render();
});
$('create').addEventListener('click', () => action('Creating the onchain allowance…', async () => {
  const signer = config.local ? state.owner : await requireWrite('creator');
  if (config.local && (!signer || state.uncertainTransaction)) throw new Error('ScopeRail: writes are unavailable');
  let delegateAddress;
  try { delegateAddress = getAddress($('delegate-address').value.trim()); } catch { throw new Error('ScopeRail: enter a valid delegate address'); }
  if (delegateAddress === ZeroAddress) throw new Error('ScopeRail: delegate cannot be the zero address');
  const ownerAddress = getAddress(await signer.getAddress());
  const service = services[state.serviceKey];
  const block = await provider.getBlock('latest');
  const contract = new Contract(config.contractAddress, SCOPE_RAIL_ABI, signer);
  const transaction = await contract.createGrant(delegateAddress, service.providerId, service.resourceId,
    block.timestamp + 600, 2, 1, { chainId: config.chainId });
  state.pendingTransaction = transaction.hash;
  const receipt = await transaction.wait(confirmations, 60000);
  const event = receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === 'GrantCreated');
  if (!event || getAddress(event.args.owner) !== ownerAddress || getAddress(event.args.delegate) !== delegateAddress) throw new Error('Grant event not verified');
  state.grantId = event.args.grantId;
  $('grant-id').value = String(state.grantId);
  await refreshGrant();
  message(`Grant ${state.grantId} confirmed. Two calls are available to this service only.`);
}));
$('run').addEventListener('click', () => action('Admitting the request; the service has not run yet…', async () => {
  await refreshGrant();
  const signer = await requireWrite('delegate');
  const request = services[state.serviceKey].request;
  const { requestHash, salt } = createRequestCommitment(request);
  const scope = expected(requestHash);
  const admission = await submitAdmission({ signer, expected: scope, confirmations });
  state.pendingTransaction = admission.transactionHash;
  await deliver({ transactionHash: admission.transactionHash, expected: scope, request, salt, serviceKey: state.serviceKey });
  await refreshGrant();
  message('Admission confirmed and verified. The service executed exactly once in this tab.');
}));
$('retry').addEventListener('click', () => action('Verifying the same receipt again…', async () => {
  await deliver(state.last, true);
  message('Cached result returned. No new transaction, allowance consumption or repeated work.');
}));
$('revoke').addEventListener('click', () => action('Revoking the remaining allowance…', async () => {
  await refreshGrant();
  const signer = await requireWrite('owner');
  const contract = new Contract(config.contractAddress, SCOPE_RAIL_ABI, signer);
  const transaction = await contract.revoke(state.grantId, { chainId: config.chainId });
  state.pendingTransaction = transaction.hash;
  await transaction.wait(confirmations, 60000);
  await refreshGrant();
  if (!state.grant.revoked) throw new Error('Revocation not verified');
  message('Revocation confirmed. New admissions are blocked; previously admitted work remains valid.');
}));
$('check').addEventListener('click', () => action('Checking the revoked onchain grant…', async () => {
  await refreshGrant();
  const requestHash = createRequestCommitment(services[state.serviceKey].request).requestHash;
  const block = await provider.getBlock('latest');
  try { checkGrant(state.grant, expected(requestHash), { now: block.timestamp }); }
  catch (error) {
    if (error.message !== 'ScopeRail: grant revoked or invalid') throw error;
    $('result-status').textContent = 'New admission blocked · service not run';
    message('The SDK rejected a new admission because the onchain grant is revoked. No transaction was sent.');
    return;
  }
  throw new Error('Revoked grant was unexpectedly allowed');
}));

for (const sample of config.samples) {
  const button = document.createElement('button');
  button.textContent = `Verify ${services[sample.serviceKey].label.toLowerCase()}`;
  button.addEventListener('click', () => action('Reading and verifying the sample admission from the chain…', async () => {
    await deliver(sample);
    message(`${services[sample.serviceKey].label} sample verified against the chain. The synthetic result is shown below.`);
  }));
  $('sample-buttons').append(button);
}
$('samples').hidden = config.samples.length === 0;
if (!config.local && window.ethereum?.on) {
  const changed = () => {
    syncWallet().then(() => {
      if (!state.busy && !state.uncertainTransaction) message('Wallet updated. The loaded onchain grant is retained.');
    }).catch(() => { message('Wallet unavailable. The loaded grant is retained; reconnect to write.', true); }).finally(render);
  };
  window.ethereum.on('accountsChanged', changed);
  window.ethereum.on('chainChanged', changed);
}
render();
try {
  await assertDeployment(); state.ready = true;
  $('network').textContent = config.local ? 'LOCAL EVM · 31337' : 'MONAD TESTNET · 10143';
  $('network').classList.add('ready');
  $('network-detail').textContent = 'Contract bytecode verified';
  message(config.local ? 'Local chain is ready. No Monad deployment is implied.' : 'Monad Testnet is ready. Sample verification needs no wallet.');
} catch { $('network').textContent = 'DEPLOYMENT UNAVAILABLE'; message('The configured chain or deployed contract could not be verified. Actions are disabled.', true); }
render();
