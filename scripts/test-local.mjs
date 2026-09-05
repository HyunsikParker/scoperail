import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const started = performance.now();
const children = new Set();
const cleanup = () => { for (const child of children) child.kill('SIGTERM'); };
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      if (output.length < 1_000_000) output += bytes.toString();
      else child.kill('SIGTERM');
    });
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); resolve({ code, output }); });
  });
}

let node;
try {
  const compile = await run(process.execPath, ['scripts/compile.mjs']);
  if (compile.code !== 0) throw new Error(`Compilation failed: ${compile.output.slice(0, 2000)}`);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const rpc = `http://127.0.0.1:${port}`;
  node = spawn('node_modules/.bin/hardhat', ['--network', 'hardhatMainnet', 'node',
    '--hostname', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
  children.add(node);
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (node.exitCode !== null) throw new Error('Local EVM exited before startup');
    try {
      const response = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(500) });
      const data = await response.json();
      if (data.result !== '0x7a69') throw new Error('Unexpected local chain');
      ready = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!ready) throw new Error('Local EVM startup timed out');
  const requested = process.argv.slice(2);
  const paths = requested.length ? requested : (await readdir('test'))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
  const args = ['--test', '--test-concurrency=1', ...paths];
  const tested = await run(process.execPath, args, { env: { ...process.env, SCOPERAIL_LOCAL_RPC: rpc } });
  const count = label => Number(tested.output.match(new RegExp(`# ${label} (\\d+)`))?.[1] ?? 0);
  const report = { status: tested.code === 0 && count('tests') > 0 ? 'passed' : 'failed', tests: count('tests'),
    passed: count('pass'), failed: count('fail'), skipped: count('skipped'),
    elapsedSeconds: (performance.now() - started) / 1000, chainId: 31337, costUsd: 0 };
  if (process.env.SCOPERAIL_RESULT_FILE) {
    await writeFile(process.env.SCOPERAIL_RESULT_FILE, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await writeFile(process.env.SCOPERAIL_RESULT_FILE + '.tap', tested.output, { mode: 0o600 });
  }
  if (tested.code !== 0) process.stderr.write(tested.output.slice(-7000));
  console.log(JSON.stringify(report));
  process.exitCode = tested.code === 0 && report.tests > 0 ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
