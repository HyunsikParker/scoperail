import { pathToFileURL } from 'node:url';
import { id } from 'ethers';
import { requireSingleString, startAdapter } from './adapter-server.mjs';

export const providerId = id('scoperail.demo.notes-search');
export const resourceId = id('scoperail.demo.synthetic-notes.v1');
const notes = Object.freeze([
  Object.freeze({ id: 'demo-1', text: 'Synthetic release: test the receipt verifier before release.' }),
  Object.freeze({ id: 'demo-2', text: 'Synthetic service: revocation blocks new admissions.' }),
  Object.freeze({ id: 'demo-3', text: 'Synthetic storage: persist idempotency records before production.' }),
]);

export function searchSyntheticNotes(request) {
  requireSingleString(request, 'query', 80);
  const query = request.query.toLowerCase();
  return notes.filter(note => note.text.toLowerCase().includes(query));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAdapter({
    providerId, resourceId, defaultPort: 8787,
    validate: request => requireSingleString(request, 'query', 80), work: searchSyntheticNotes,
  });
}
