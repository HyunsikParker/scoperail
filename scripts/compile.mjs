import { readFile, mkdir, writeFile } from 'node:fs/promises';
import solc from 'solc';

const source = await readFile(new URL('../contracts/ScopeRail.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'ScopeRail.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    metadata: { appendCBOR: false, bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter(item => item.severity === 'error');
if (errors.length) {
  process.stderr.write(errors.map(item => item.formattedMessage).join('\n'));
  process.exit(1);
}
const contract = output.contracts['ScopeRail.sol'].ScopeRail;
const artifact = { contractName: 'ScopeRail', abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}` };
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/ScopeRail.json', import.meta.url), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ contract: artifact.contractName, compiler: solc.version(),
  bytecodeBytes: (artifact.bytecode.length - 2) / 2, embeddedMetadata: false }));
