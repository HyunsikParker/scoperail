import { createServer } from 'node:http';
import { JsonRpcProvider, getAddress } from 'ethers';
import { createMemoryReceiptStore, createRequestCommitment, runAdmittedWork } from '../sdk/index.mjs';

/** Local demo server. Keep chain/contract/service scope in trusted server configuration. */
export function startAdapter({ providerId, resourceId, validate, work, defaultPort }) {
  const { RPC_URL, CHAIN_ID, SCOPERAIL_ADDRESS, RESOURCE_OWNER } = process.env;
  if (!RPC_URL || !CHAIN_ID || !SCOPERAIL_ADDRESS || !RESOURCE_OWNER) {
    throw new Error('Set RPC_URL, CHAIN_ID, SCOPERAIL_ADDRESS and RESOURCE_OWNER before starting this local adapter.');
  }
  if (!/^[1-9][0-9]*$/.test(CHAIN_ID)) throw new Error('Invalid CHAIN_ID.');
  const chainId = BigInt(CHAIN_ID);
  const contractAddress = getAddress(SCOPERAIL_ADDRESS);
  // A production multi-user adapter must resolve this owner from its resource ACL.
  // A grant made by an arbitrary caller is not authority over this service's data.
  const owner = getAddress(RESOURCE_OWNER);
  const provider = new JsonRpcProvider(RPC_URL);
  const receiptStore = createMemoryReceiptStore(); // Not durable across restarts.
  const port = Number(process.env.PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PORT.');
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' || req.url !== '/run') {
      res.writeHead(404).end('{"error":"POST /run required"}');
      return;
    }
    try {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) throw new Error('Request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      validate(body.request);
      const { requestHash } = createRequestCommitment(body.request, { salt: body.salt });
      if (typeof body.salt !== 'string') throw new Error('Salt required');
      const { admission, result } = await runAdmittedWork({
        provider, transactionHash: body.transactionHash, request: body.request, salt: body.salt,
        expected: {
          chainId, contractAddress, owner, providerId, resourceId, units: 1,
          grantId: body.grantId, delegate: body.delegate, nonce: body.nonce, requestHash,
        },
        receiptStore, work,
      });
      res.writeHead(200).end(JSON.stringify({ receiptId: admission.receiptId, result }));
    } catch {
      // Do not expose RPC URLs, request bodies, salts, or provider error details.
      res.writeHead(403).end('{"error":"Request or admission could not be verified"}');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Synthetic adapter listening on http://127.0.0.1:${port}/run\n`);
  });
  return server;
}

export function requireSingleString(request, key, maxLength) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1 || typeof request[key] !== 'string'
      || request[key].length < 1 || request[key].length > maxLength) {
    throw new Error('Invalid synthetic fixture request');
  }
}
