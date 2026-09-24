import { mkdir } from 'node:fs/promises';
import { config, wrangler, die } from './local.mjs';
try {
  const file = await config();
  await mkdir('backups', { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const output = `backups/${file.name}-${timestamp}.sql`;
  await wrangler(['d1', 'export', 'DB', '--remote', '--output', output]);
  console.log(`Backup saved to ${output}. It contains personal data from the group, keep it private.`);
} catch (error) { die(error); }
