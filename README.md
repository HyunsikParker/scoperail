# ScopeRail

An onchain admission meter for offchain tools and context services. A resource owner gives a delegate a provider-specific, expiring allowance. The service verifies a confirmed admission before running the committed request.

ScopeRail does not hold funds, approve tokens, execute external contracts, or put request text onchain. Units are an application-defined allowance, not a payment.

## Run locally

Requires Node.js 22.12 or newer and npm.

```sh
npm ci --ignore-scripts
npm test
```

The test command compiles the contract, starts an isolated loopback EVM, tests the contract and SDK, exercises both HTTP adapters, and stops the EVM. It needs no wallet or testnet balance. Local EVM credentials are not printed.

To compile without running tests:

```sh
npm run compile
```

## Integrate a service

1. Assign stable, opaque `providerId` and `resourceId` values. Resolve the authorized owner from your resource ACL; do not accept an owner supplied by the caller.
2. The owner calls `createGrant(delegate, providerId, resourceId, validUntil, budget, maxPerCall)`.
3. The delegate commits a request with `createRequestCommitment(request)`. Keep the request and random salt offchain.
4. The delegate calls `submitAdmission` with the exact scope, cost, next nonce and request hash.
5. The service calls `runAdmittedWork` with its trusted chain, contract, resource owner, provider/resource IDs and unit cost. Only a verified admission reaches the work callback.

```js
import {
  createRequestCommitment, submitAdmission, runAdmittedWork,
} from './sdk/index.mjs';

const request = { query: 'receipt' };
const { salt, requestHash } = createRequestCommitment(request);
const expected = {
  chainId, contractAddress, grantId, owner, delegate,
  providerId, resourceId, units: 1, nonce, requestHash,
};

const admission = await submitAdmission({ signer, expected });
const response = await runAdmittedWork({
  provider, transactionHash: admission.transactionHash,
  expected, request, salt, receiptStore,
  work: searchNotes,
});
```

The snippet's signer belongs to the delegate. The service must reconstruct `expected` from trusted configuration and its own ACL, not blindly reuse an envelope supplied by that delegate. `receiptStore` must durably implement `runOnce(key, operation)` before a production integration performs side effects.

`readGrant` returns the allowance and next nonce. `checkGrant` is a preflight, not a reservation: the contract decides admission atomically. A wait failure can mean a transaction was already broadcast; inspect the attached `transactionHash` before retrying.

### Reference adapters

Both adapters use synthetic fixtures and the same SDK:

| Adapter | Request | Result |
| --- | --- | --- |
| `examples/notes-search.mjs` | `{ "query": "receipt" }` | Matching synthetic notes |
| `examples/task-extraction.mjs` | `{ "fixtureId": "release-demo" }` | Tasks extracted from a synthetic checklist |

Set `RPC_URL`, `CHAIN_ID`, `SCOPERAIL_ADDRESS` and `RESOURCE_OWNER` in the process environment, then run one of:

```sh
node examples/notes-search.mjs
node examples/task-extraction.mjs
```

They listen on loopback ports 8787 and 8788 respectively. Each accepts `POST /run` with JSON fields `transactionHash`, `grantId`, `delegate`, `nonce`, `salt` and `request`. Use decimal strings for grant IDs and nonces. The service fixes the owner, provider, resource and one-unit cost independently of that body. Each service's IDs are exported by its module.

## Authorization and privacy boundaries

- A grant binds its owner, delegate, provider, resource, expiry, per-call cap and total allowance. Nonces start at zero and advance by one for each accepted request.
- Expiry is exclusive: admission at `validUntil` is rejected. Revocation blocks new admissions; it does not undo work already admitted or erase previously shared data.
- The verifier checks the chain, configured contract, sender, direct `consume` calldata, transaction/block agreement, confirmations and exact `Admission` event. Default verification requires two confirmations and has a 60-second timeout. This relies on the configured RPC's accuracy and is not an independent consensus proof.
- Only direct transactions to `consume` are supported. Nested smart-account execution and relayed transactions are not supported by this verifier.
- A commitment is a salted hash, not encryption. Wallet addresses, scope IDs, costs, nonces, timing and commitments are public. Do not put names, contact details or private descriptions in identifiers. The service still receives the request and salt offchain.
- The examples use process-local memory for duplicate delivery. It does not survive a restart or coordinate multiple servers. Production adapters need a trusted resource ACL, a durable idempotency store, authenticated transport and application-specific limits.
- Units do not prove that work was useful, correctly priced or completed. ScopeRail is not a credential registry, oracle, payment system, or independent security audit.

The test suite covers scope/owner binding, revocation, exact expiry, exhausted and concurrent allowances, receipt validation, request commitments, and the two local HTTP integrations. These are project tests, not evidence of third-party adoption or an external audit.

## License and AI assistance

MIT; see [LICENSE](LICENSE). Runtime dependency: ethers (MIT). Build/test dependencies: Hardhat and solc-js (MIT). Their license notices remain with their installed packages.

Codex was used to implement and review the contract, SDK, examples, tests and documentation. No personal dataset or third-party participant code is included. The reference adapters are part of this project, not external integrations.
