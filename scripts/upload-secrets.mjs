import { secrets, wrangler, die } from './local.mjs';
try {
  const values = await secrets(false);
  // Values go through stdin so they never show up in the process list or shell history.
  for (const key of ['BOT_TOKEN', 'WEBHOOK_SECRET']) {
    console.log(`Uploading ${key}...`);
    await wrangler(['secret', 'put', key], values[key] + '\n');
  }
  console.log('Both secrets uploaded.');
} catch (error) { die(error); }
