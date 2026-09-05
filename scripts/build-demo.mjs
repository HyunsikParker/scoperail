import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { getAddress, keccak256 } from 'ethers';
import { admissionReceiptId, canonicalize, verifyRequestCommitment } from '../sdk/index.mjs';
import { services } from '../examples/fixtures.mjs';

if (!process.env.SCOPERAIL_DEMO_CONFIG) throw new Error('SCOPERAIL_DEMO_CONFIG must name a verified deployment configuration.');
const input = JSON.parse(await readFile(process.env.SCOPERAIL_DEMO_CONFIG, 'utf8'));
const local = process.env.SCOPERAIL_DEMO_LOCAL === '1';
if (input.chainId !== (local ? 31337 : 10143)) throw new Error('Only Monad Testnet or an explicitly local build is allowed.');
if (local ? !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.rpc) : input.rpc !== 'https://testnet-rpc.monad.xyz/') {
  throw new Error('Unexpected RPC; public builds are pinned to the official testnet endpoint.');
}
const artifact = JSON.parse(await readFile('artifacts/ScopeRail.json', 'utf8'));
const suppliedSamples = input.samples ?? [];
if (!Array.isArray(suppliedSamples) || suppliedSamples.length > 2) throw new Error('At most two synthetic sample admissions are supported.');
const samples = [];
const config = { chainId: input.chainId, rpc: input.rpc, local,
  contractAddress: getAddress(input.contractAddress), bytecodeHash: keccak256(artifact.deployedBytecode), samples };
for (const sample of suppliedSamples) {
  if (!['notes', 'tasks'].includes(sample.serviceKey) || !sample.expected
      || Number(sample.expected.chainId) !== config.chainId
      || getAddress(sample.expected.contractAddress) !== config.contractAddress
      || !/^0x[0-9a-fA-F]{64}$/.test(sample.transactionHash)
      || !/^0x[0-9a-fA-F]{64}$/.test(sample.salt)) throw new Error('Invalid sample admission.');
  const service = services[sample.serviceKey];
  const expected = Object.fromEntries(['chainId','contractAddress','grantId','owner','delegate',
    'providerId','resourceId','units','nonce','requestHash'].map(key => [key, sample.expected[key]]));
  admissionReceiptId(expected); // Validate the complete typed envelope before bundling.
  if (expected.providerId !== service.providerId || expected.resourceId !== service.resourceId
      || BigInt(expected.units) !== 1n || canonicalize(sample.request) !== canonicalize(service.request)) {
    throw new Error('Only the exact synthetic service fixtures may be bundled.');
  }
  verifyRequestCommitment(service.request, sample.salt, expected.requestHash);
  samples.push({ serviceKey: sample.serviceKey, expected, request: service.request,
    salt: sample.salt, transactionHash: sample.transactionHash });
}
const outdir = resolve(process.env.SCOPERAIL_DEMO_DIST ?? 'dist');
await mkdir(outdir, { recursive: true });
await build({ entryPoints: ['web/app.mjs'], outfile: resolve(outdir, 'app.js'), bundle: true,
  platform: 'browser', format: 'esm', target: ['es2022'], minify: true, sourcemap: false,
  legalComments: 'eof', define: { __DEMO_CONFIG__: JSON.stringify(config) }, logLevel: 'silent' });
for (const name of ['index.html', 'style.css']) await copyFile(`web/${name}`, resolve(outdir, name));
for (const name of ['README.md', 'LICENSE']) await copyFile(name, resolve(outdir, name));
if (!local) {
  await mkdir(resolve(outdir, 'examples'), { recursive: true });
  await writeFile(resolve(outdir, 'examples/monad-testnet.json'), JSON.stringify({
    chainId: config.chainId, rpc: config.rpc, contractAddress: config.contractAddress, samples,
  }, null, 2) + '\n');
}
// Preserve upstream notices without source maps, absolute paths or build manifests.
const license = await readFile('node_modules/ethers/LICENSE.md', 'utf8');
await writeFile(resolve(outdir, 'THIRD_PARTY_LICENSES.txt'), `ethers\n\n${license}`);
console.log(JSON.stringify({ status: 'built', chainId: config.chainId, local, sourceMaps: false, samples: samples.length }));
