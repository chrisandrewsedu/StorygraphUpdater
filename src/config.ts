import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    chatId: required('TELEGRAM_CHAT_ID'),
  },
  abs: {
    url: required('ABS_URL').replace(/\/$/, ''),
    apiToken: required('ABS_API_TOKEN'),
  },
  storygraph: {
    email: process.env.STORYGRAPH_EMAIL || '',
    password: process.env.STORYGRAPH_PASSWORD || '',
    username: process.env.STORYGRAPH_USERNAME || 'chrisandrews',
  },
  syncCron: process.env.SYNC_CRON || '0 22 * * *',
  /** Weekly read-only check that StoryGraph pages still parse (default Sunday 04:15). */
  smokeCron: process.env.SMOKE_CRON || '15 4 * * 0',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
};
