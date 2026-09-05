import { pathToFileURL } from 'node:url';
import { startAdapter } from './adapter-server.mjs';
import { services, validateTaskRequest, extractSyntheticTasks } from './fixtures.mjs';
export { validateTaskRequest, extractSyntheticTasks };

export const { providerId, resourceId } = services.tasks;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAdapter({ providerId, resourceId, defaultPort: 8788, validate: validateTaskRequest, work: extractSyntheticTasks });
}
