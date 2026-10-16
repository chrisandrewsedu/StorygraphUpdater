import cron from 'node-cron';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';
import { createDb } from './db.js';
import { createAbsClient } from './abs-client.js';
import { createStoryGraph } from './storygraph.js';
import { createBot } from './bot.js';
import { runSync, ensureLoggedIn, runSmokeCheck } from './sync.js';
import { formatSmokeReport } from './format.js';

async function main() {
  logger.info('StoryGraph Updater starting...');

  // Initialize database
  const dbPath = path.join(config.dataDir, 'storygraph.db');
  const db = createDb(dbPath);
  logger.info(`Database initialized at ${dbPath}`);

  // Initialize ABS client
  const absClient = createAbsClient(config.abs.url, config.abs.apiToken);
  logger.info(`ABS client configured for ${config.abs.url}`);

  // Initialize StoryGraph automator
  const storygraph = await createStoryGraph(config.dataDir);
  logger.info('StoryGraph automator initialized');

  const creds = { email: config.storygraph.email, password: config.storygraph.password };
  const startLogin = await ensureLoggedIn(storygraph, creds);
  if (!startLogin.ok) logger.error('StoryGraph login failed. Check STORYGRAPH_EMAIL / STORYGRAPH_PASSWORD.');
  else logger.info(startLogin.relogged ? 'Logged into StoryGraph with env credentials' : 'StoryGraph session is active');

  // Initialize Telegram bot
  const bot = createBot({
    token: config.telegram.botToken,
    chatId: config.telegram.chatId,
    db,
    storygraph,
    absClient,
    storygraphUsername: config.storygraph.username,
    storygraphCreds: creds,
  });
  bot.start();

  // Schedule daily sync
  cron.schedule(config.syncCron, async () => {
    logger.info('Running scheduled sync...');
    try {
      // Verify the StoryGraph session; log in again with the saved credentials if it expired.
      const login = await ensureLoggedIn(storygraph, creds);
      if (!login.ok) {
        await bot.sendError('StoryGraph session expired and logging in again failed. Check STORYGRAPH_EMAIL / STORYGRAPH_PASSWORD in .env.');
        return;
      }
      if (login.relogged) logger.info('StoryGraph session had expired — logged in again');

      const results = await runSync(absClient, db, storygraph,
        (book) => { bot.promptNewBook(book); },
        (mapping) => { bot.promptBookFinished(mapping); },
        (mapping) => { bot.promptRating(mapping); }
      );
      await bot.sendSyncSummary(results);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Scheduled sync failed: ${errorMsg}`);
      await bot.sendError(`Scheduled sync failed: ${errorMsg}`);
    }
  });

  logger.info(`Sync scheduled: ${config.syncCron}`);

  // Weekly read-only check that StoryGraph pages still parse — alert only on problems.
  cron.schedule(config.smokeCron, async () => {
    logger.info('Running StoryGraph check...');
    try {
      const login = await ensureLoggedIn(storygraph, creds);
      if (!login.ok) { await bot.sendError('Weekly StoryGraph check: login failed.'); return; }
      const report = await runSmokeCheck(storygraph, db);
      logger.info(`StoryGraph check: ${report.problems.length ? report.problems.join('; ') : 'ok'}`);
      if (report.problems.length) await bot.notify(formatSmokeReport(report));
    } catch (err) {
      await bot.sendError(`Weekly StoryGraph check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  logger.info(`StoryGraph check scheduled: ${config.smokeCron}`);
  logger.info('StoryGraph Updater is running.');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await storygraph.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
