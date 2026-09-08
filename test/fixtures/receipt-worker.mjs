import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createFileReceiptStore } from '../../sdk/file-receipt-store.mjs';

const [directory, mode] = process.argv.slice(2);
try {
  const value = await createFileReceiptStore({ directory }).runOnce('receipt', async () => {
    await appendFile(join(directory, 'effects'), 'effect\n');
    if (mode === 'hold') {
      const message = once(process, 'message');
      process.send('claimed');
      await message;
    }
    return { units: 42n };
  });
  process.send(`complete:${value.units}`);
} catch {
  process.send('uncertain');
} finally { process.disconnect(); }
