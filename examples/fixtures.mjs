import { id } from 'ethers';

export function requireSingleString(request, key, maxLength) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1 || typeof request[key] !== 'string'
      || request[key].length < 1 || request[key].length > maxLength) {
    throw new Error('Invalid synthetic fixture request');
  }
}

const notes = Object.freeze([
  Object.freeze({ id: 'demo-1', text: 'Synthetic release: test the receipt verifier before release.' }),
  Object.freeze({ id: 'demo-2', text: 'Synthetic service: revocation blocks new admissions.' }),
  Object.freeze({ id: 'demo-3', text: 'Synthetic storage: persist idempotency records before production.' }),
]);
const checklists = Object.freeze({
  'release-demo': 'Synthetic checklist.\nTODO: Run local contract tests.\nTODO: Verify the admission receipt.\nDONE: Create a synthetic fixture.',
  'revoke-demo': 'Synthetic checklist.\nTODO: Revoke the demo grant.\nTODO: Confirm that a new admission is rejected.',
});

export function searchSyntheticNotes(request) {
  requireSingleString(request, 'query', 80);
  return notes.filter(note => note.text.toLowerCase().includes(request.query.toLowerCase()));
}
export function validateTaskRequest(request) {
  requireSingleString(request, 'fixtureId', 40);
  if (!Object.hasOwn(checklists, request.fixtureId)) throw new Error('Unknown synthetic fixture');
}
export function extractSyntheticTasks(request) {
  validateTaskRequest(request);
  return checklists[request.fixtureId].split('\n')
    .filter(line => line.startsWith('TODO: ')).map(line => line.slice(6));
}

export const services = Object.freeze({
  notes: Object.freeze({ label: 'Notes search', providerId: id('scoperail.demo.notes-search'),
    resourceId: id('scoperail.demo.synthetic-notes.v1'), work: searchSyntheticNotes,
    request: Object.freeze({ query: 'receipt' }) }),
  tasks: Object.freeze({ label: 'Task extraction', providerId: id('scoperail.demo.task-extraction'),
    resourceId: id('scoperail.demo.synthetic-tasks.v1'), work: extractSyntheticTasks,
    request: Object.freeze({ fixtureId: 'release-demo' }) }),
});
