import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractFactory, JsonRpcProvider } from 'ethers';
import { createRequestCommitment, submitAdmission } from '../sdk/index.mjs';
import { services } from '../examples/fixtures.mjs';

const children = new Set();
const runtime = await mkdtemp(join(tmpdir(), 'scoperail-demo-'));
let server, provider, closing = false;
async function cleanup(code = 0) {
  if (closing) return;
  closing = true;
  server?.closeAllConnections(); server?.close(); provider?.destroy();
  for (const child of children) child.kill('SIGTERM');
  await rm(runtime, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGTERM', () => cleanup(0));
process.on('SIGINT', () => cleanup(0));
async function command(args, env = process.env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    output += bytes.toString();
    if (output.length > 100000) child.kill('SIGTERM');
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); code === 0 ? resolve(output) : reject(new Error(output.slice(-1500))); });
  });
}
try {
  if (process.env.SCOPERAIL_DEMO_TEST_FIRST === '1') {
    const tested = await command(['scripts/test-local.mjs']);
    process.stdout.write(tested);
  } else await command(['scripts/compile.mjs']);
  const probe = netServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const rpc = `http://127.0.0.1:${port}`;
  const node = spawn('node_modules/.bin/hardhat', ['--network', 'hardhatMainnet', 'node', '--hostname', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
  children.add(node);
  provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 50;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (node.exitCode !== null) throw new Error('Local EVM stopped before startup');
    try { if (BigInt(await provider.send('eth_chainId', [])) === 31337n) { ready = true; break; } }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!ready) throw new Error('Local EVM startup timed out');
  const [owner, delegate] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const artifact = JSON.parse(await readFile('artifacts/ScopeRail.json', 'utf8'));
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, owner).deploy();
  await contract.waitForDeployment();
  const samples = [];
  for (const [serviceKey, service] of Object.entries(services)) {
    const grantId = await contract.nextGrantId();
    await (await contract.createGrant(await delegate.getAddress(), service.providerId, service.resourceId,
      (await provider.getBlock('latest')).timestamp + 3600, 2, 1)).wait();
    const { requestHash, salt } = createRequestCommitment(service.request);
    const expected = { chainId: 31337, contractAddress: await contract.getAddress(), grantId,
      owner: await owner.getAddress(), delegate: await delegate.getAddress(),
      providerId: service.providerId, resourceId: service.resourceId, units: 1, nonce: 0, requestHash };
    const admission = await submitAdmission({ signer: delegate, expected, confirmations: 1, timeoutMs: 5000 });
    samples.push({ serviceKey, transactionHash: admission.transactionHash, expected, request: service.request, salt });
    await (await contract.revoke(grantId)).wait();
  }
  const config = { chainId: 31337, rpc, contractAddress: await contract.getAddress(), samples };
  const configFile = join(runtime, 'config.json'), outdir = join(runtime, 'site');
  await writeFile(configFile, JSON.stringify(config, (_, value) => typeof value === 'bigint' ? value.toString() : value), { mode: 0o600 });
  await command(['scripts/build-demo.mjs'], { ...process.env, SCOPERAIL_DEMO_CONFIG: configFile,
    SCOPERAIL_DEMO_LOCAL: '1', SCOPERAIL_DEMO_DIST: outdir });
  const routes = new Map([['/', ['index.html','text/html']], ['/index.html',['index.html','text/html']],
    ['/app.js',['app.js','text/javascript']], ['/style.css',['style.css','text/css']],
    ['/README.md',['README.md','text/plain']], ['/LICENSE',['LICENSE','text/plain']],
    ['/THIRD_PARTY_LICENSES.txt',['THIRD_PARTY_LICENSES.txt','text/plain']]]);
  server = httpServer(async (req, res) => {
    const route = routes.get(req.url);
    if (req.method !== 'GET' || !route) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', route[1] + '; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${rpc}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      res.end(await readFile(join(outdir, route[0])));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const status = { status: 'ready', url: `http://127.0.0.1:${server.address().port}`, chainId: 31337,
    localOnly: true, externalTransactions: 0, sampleAdmissions: samples.length, costUsd: 0 };
  if (process.env.SCOPERAIL_DEMO_STATUS_FILE) await writeFile(process.env.SCOPERAIL_DEMO_STATUS_FILE, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(status));
} catch (error) {
  console.error('Local demo failed: ' + error.message.slice(0, 1500));
  await cleanup(1);
}
