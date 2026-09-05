import { pathToFileURL } from 'node:url';
import { id } from 'ethers';
import { requireSingleString, startAdapter } from './adapter-server.mjs';

export const providerId = id('scoperail.demo.task-extraction');
export const resourceId = id('scoperail.demo.synthetic-tasks.v1');
const fixtures = Object.freeze({
  'release-demo': 'Synthetic checklist.\nTODO: Run local contract tests.\nTODO: Verify the admission receipt.\nDONE: Create a synthetic fixture.',
  'revoke-demo': 'Synthetic checklist.\nTODO: Revoke the demo grant.\nTODO: Confirm that a new admission is rejected.',
});

export function validateTaskRequest(request) {
  requireSingleString(request, 'fixtureId', 40);
  if (!Object.hasOwn(fixtures, request.fixtureId)) throw new Error('Unknown synthetic fixture');
}
export function extractSyntheticTasks(request) {
  validateTaskRequest(request);
  return fixtures[request.fixtureId].split('\n')
    .filter(line => line.startsWith('TODO: ')).map(line => line.slice(6));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAdapter({ providerId, resourceId, defaultPort: 8788, validate: validateTaskRequest, work: extractSyntheticTasks });
}
