import cron from 'node-cron';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';
import { createDb } from './db.js';
import { createAbsClient } from './abs-client.js';
import { createStoryGraph } from './storygraph.js';
import { createBot } from './bot.js';
import { runSync } from './sync.js';

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

  // Check if StoryGraph login is needed
  const loggedIn = await storygraph.isLoggedIn();
  if (!loggedIn) {
    if (config.storygraph.email && config.storygraph.password) {
      logger.info('Logging into StoryGraph with env credentials...');
      const success = await storygraph.login(config.storygraph.email, config.storygraph.password);
      if (!success) {
        logger.error('StoryGraph login failed. Check credentials.');
      }
    } else {
      logger.warn('Not logged into StoryGraph. Use /sync after providing credentials via Telegram.');
    }
  } else {
    logger.info('StoryGraph session is active');
  }

  // Initialize Telegram bot
  const bot = createBot({
    token: config.telegram.botToken,
    chatId: config.telegram.chatId,
    db,
    storygraph,
    absClient,
  });
  bot.start();

  // Schedule daily sync
  cron.schedule(config.syncCron, async () => {
    logger.info('Running scheduled sync...');
    try {
      // Verify StoryGraph session before sync
      const isActive = await storygraph.isLoggedIn();
      if (!isActive) {
        await bot.sendError('StoryGraph session expired. Please re-authenticate.');
        return;
      }

      const results = await runSync(absClient, db, storygraph, (book) => {
        bot.promptNewBook(book);
      });
      await bot.sendSyncSummary(results);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Scheduled sync failed: ${errorMsg}`);
      await bot.sendError(`Scheduled sync failed: ${errorMsg}`);
    }
  });

  logger.info(`Sync scheduled: ${config.syncCron}`);
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
