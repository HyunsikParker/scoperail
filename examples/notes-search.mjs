import { pathToFileURL } from 'node:url';
import { requireSingleString, startAdapter } from './adapter-server.mjs';
import { services, searchSyntheticNotes } from './fixtures.mjs';
export { searchSyntheticNotes };

export const { providerId, resourceId } = services.notes;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAdapter({
    providerId, resourceId, defaultPort: 8787,
    validate: request => requireSingleString(request, 'query', 80), work: searchSyntheticNotes,
  });
}
