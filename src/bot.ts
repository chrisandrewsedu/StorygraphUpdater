import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';
import type { Database } from './db.js';
import type { StoryGraph } from './storygraph.js';
import type { AbsClient, AbsBookProgress } from './abs-client.js';
import { runSync, type SyncResult } from './sync.js';

export interface Bot {
  start(): void;
  sendSyncSummary(results: SyncResult[]): Promise<void>;
  promptNewBook(book: AbsBookProgress): Promise<void>;
  sendError(message: string): Promise<void>;
}

interface CreateBotOptions {
  token: string;
  chatId: string;
  db: Database;
  storygraph: StoryGraph;
  absClient: AbsClient;
  storygraphUsername?: string;
}

export function createBot(options: CreateBotOptions): Bot {
  const { token, chatId, db, storygraph, absClient } = options;
  const storygraphUsername = options.storygraphUsername ?? 'chrisandrews';

  const bot = new TelegramBot(token, { polling: true });

  // ── URL cache for callback_data (Telegram limits to 64 bytes) ───────────────
  const urlCache = new Map<number, string>();
  let urlCounter = 0;

  function cacheUrl(url: string): number {
    const id = ++urlCounter;
    urlCache.set(id, url);
    return id;
  }

  function getCachedUrl(id: number): string | undefined {
    return urlCache.get(id);
  }

  // ── Auth guards ──────────────────────────────────────────────────────────────

  function isAuthorized(msg: TelegramBot.Message): boolean {
    return String(msg.chat.id) === chatId;
  }

  function isAuthorizedCallback(query: TelegramBot.CallbackQuery): boolean {
    return String(query.message?.chat.id) === chatId;
  }

  // ── Helper utilities ─────────────────────────────────────────────────────────

  async function reply(chatIdTarget: string | number, text: string, extra?: TelegramBot.SendMessageOptions): Promise<void> {
    try {
      await bot.sendMessage(chatIdTarget, text, { parse_mode: 'Markdown', ...extra });
    } catch (err) {
      logger.error('Failed to send Telegram message', err);
    }
  }

  async function editMessage(chatIdTarget: string | number, messageId: number, text: string, extra?: TelegramBot.EditMessageTextOptions): Promise<void> {
    try {
      await bot.editMessageText(text, {
        chat_id: chatIdTarget,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...extra,
      });
    } catch (err) {
      logger.error('Failed to edit Telegram message', err);
    }
  }

  // ── /help ────────────────────────────────────────────────────────────────────

  bot.onText(/^\/help/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await reply(msg.chat.id, [
      '*StoryGraph Updater Commands*',
      '',
      '/help — show this message',
      '/status — show currently-in-progress audiobooks and last sync time',
      '/sync — trigger a manual sync now',
      '/search <title> — search StoryGraph for a book',
      '/add <title> — search and add a book to your TBR',
      '/tbr — list your To-Be-Read list',
      '/recommend — pick 3 random books from your TBR',
      '/reading <title> — mark a book as currently reading on StoryGraph',
      '/finished <title> — mark a book as read on StoryGraph',
      '/link <title> — link an ABS book to its StoryGraph entry',
    ].join('\n'));
  });

  // ── /status ──────────────────────────────────────────────────────────────────

  bot.onText(/^\/status/, async (msg) => {
    if (!isAuthorized(msg)) return;
    try {
      const booksInProgress = await absClient.getItemsInProgress();
      const mappings = db.getAllBookMappings();

      const lines: string[] = ['*Currently In-Progress Audiobooks*', ''];

      if (booksInProgress.length === 0) {
        lines.push('_No books in progress._');
      } else {
        for (const book of booksInProgress) {
          const mapping = db.getBookMappingByAbsId(book.absLibraryItemId);
          const lastSync = mapping ? db.getLastSync(mapping.id) : null;
          const syncInfo = lastSync
            ? `Last sync: ${lastSync.action} at ${lastSync.syncedAt}`
            : mapping
              ? 'Mapped but never synced'
              : 'Not mapped to StoryGraph';

          lines.push(`*${book.title}* by ${book.author}`);
          lines.push(`  Progress: ${book.progressPercent.toFixed(1)}%`);
          lines.push(`  ${syncInfo}`);
          lines.push('');
        }
      }

      lines.push(`*Total mapped books:* ${mappings.length}`);

      await reply(msg.chat.id, lines.join('\n'));
    } catch (err) {
      logger.error('/status error', err);
      await reply(msg.chat.id, `Error fetching status: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /sync ────────────────────────────────────────────────────────────────────

  bot.onText(/^\/sync/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await reply(msg.chat.id, 'Starting manual sync...');
    try {
      const results = await runSync(absClient, db, storygraph, (book) => {
        promptNewBookInternal(book).catch((err) => logger.error('promptNewBook error', err));
      });
      await sendSyncSummaryInternal(results);
    } catch (err) {
      logger.error('/sync error', err);
      await reply(msg.chat.id, `Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /search <title> ──────────────────────────────────────────────────────────

  bot.onText(/^\/search (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const query = match?.[1]?.trim();
    if (!query) {
      await reply(msg.chat.id, 'Usage: /search <title>');
      return;
    }

    await reply(msg.chat.id, `Searching StoryGraph for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) {
        await reply(msg.chat.id, 'No results found.');
        return;
      }

      const lines = results.slice(0, 5).map((r, i) =>
        `${i + 1}. *${r.title}*${r.author ? ` — ${r.author}` : ''}${r.editionInfo ? `\n   _${r.editionInfo}_` : ''}\n   ${r.bookUrl}`
      );

      await reply(msg.chat.id, lines.join('\n\n'));
    } catch (err) {
      logger.error('/search error', err);
      await reply(msg.chat.id, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /add <title> ─────────────────────────────────────────────────────────────

  bot.onText(/^\/add (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const query = match?.[1]?.trim();
    if (!query) {
      await reply(msg.chat.id, 'Usage: /add <title>');
      return;
    }

    await reply(msg.chat.id, `Searching for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) {
        await reply(msg.chat.id, 'No results found.');
        return;
      }

      const top5 = results.slice(0, 5);
      const keyboard: TelegramBot.InlineKeyboardButton[][] = top5.map((r, i) => [
        {
          text: `${i + 1}. ${r.title}${r.author ? ` — ${r.author}` : ''}`,
          callback_data: `add:${cacheUrl(r.bookUrl)}`,
        },
      ]);

      const lines = top5.map((r, i) =>
        `${i + 1}. *${r.title}*${r.author ? ` — ${r.author}` : ''}${r.editionInfo ? `\n   _${r.editionInfo}_` : ''}`
      );

      await reply(msg.chat.id, `Select a book to add to TBR:\n\n${lines.join('\n\n')}`, {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      logger.error('/add error', err);
      await reply(msg.chat.id, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /tbr ─────────────────────────────────────────────────────────────────────

  bot.onText(/^\/tbr/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await reply(msg.chat.id, 'Fetching your TBR list...');
    try {
      const books = await storygraph.getTBRList(storygraphUsername);
      if (books.length === 0) {
        await reply(msg.chat.id, 'Your TBR list is empty.');
        return;
      }

      const lines = books.slice(0, 20).map((b, i) => `${i + 1}. *${b.title}*${b.author ? ` — ${b.author}` : ''}`);
      const footer = books.length > 20 ? `\n_...and ${books.length - 20} more._` : '';
      await reply(msg.chat.id, `*Your TBR List* (${books.length} books)\n\n${lines.join('\n')}${footer}`);
    } catch (err) {
      logger.error('/tbr error', err);
      await reply(msg.chat.id, `Failed to fetch TBR: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /recommend ───────────────────────────────────────────────────────────────

  bot.onText(/^\/recommend/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await reply(msg.chat.id, 'Picking 3 random books from your TBR...');
    try {
      const books = await storygraph.getTBRList(storygraphUsername);
      if (books.length === 0) {
        await reply(msg.chat.id, 'Your TBR list is empty.');
        return;
      }

      // Fisher-Yates shuffle and take first 3
      const shuffled = [...books];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const picks = shuffled.slice(0, 3);

      const lines = picks.map((b, i) =>
        `${i + 1}. *${b.title}*${b.author ? ` — ${b.author}` : ''}\n   ${b.bookUrl}`
      );
      await reply(msg.chat.id, `*Random picks from your TBR:*\n\n${lines.join('\n\n')}`);
    } catch (err) {
      logger.error('/recommend error', err);
      await reply(msg.chat.id, `Failed to fetch TBR: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /reading <title> ─────────────────────────────────────────────────────────

  bot.onText(/^\/reading (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const query = match?.[1]?.trim();
    if (!query) {
      await reply(msg.chat.id, 'Usage: /reading <title>');
      return;
    }

    await reply(msg.chat.id, `Searching for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) {
        await reply(msg.chat.id, 'No results found.');
        return;
      }

      const top5 = results.slice(0, 5);
      const keyboard: TelegramBot.InlineKeyboardButton[][] = top5.map((r, i) => [
        {
          text: `${i + 1}. ${r.title}${r.author ? ` — ${r.author}` : ''}`,
          callback_data: `reading:${cacheUrl(r.bookUrl)}`,
        },
      ]);

      const lines = top5.map((r, i) =>
        `${i + 1}. *${r.title}*${r.author ? ` — ${r.author}` : ''}${r.editionInfo ? `\n   _${r.editionInfo}_` : ''}`
      );

      await reply(msg.chat.id, `Select a book to mark as currently reading:\n\n${lines.join('\n\n')}`, {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      logger.error('/reading error', err);
      await reply(msg.chat.id, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /finished <title> ────────────────────────────────────────────────────────

  bot.onText(/^\/finished (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const query = match?.[1]?.trim();
    if (!query) {
      await reply(msg.chat.id, 'Usage: /finished <title>');
      return;
    }

    await reply(msg.chat.id, `Searching for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) {
        await reply(msg.chat.id, 'No results found.');
        return;
      }

      const top5 = results.slice(0, 5);
      const keyboard: TelegramBot.InlineKeyboardButton[][] = top5.map((r, i) => [
        {
          text: `${i + 1}. ${r.title}${r.author ? ` — ${r.author}` : ''}`,
          callback_data: `finished:${cacheUrl(r.bookUrl)}`,
        },
      ]);

      const lines = top5.map((r, i) =>
        `${i + 1}. *${r.title}*${r.author ? ` — ${r.author}` : ''}${r.editionInfo ? `\n   _${r.editionInfo}_` : ''}`
      );

      await reply(msg.chat.id, `Select a book to mark as read:\n\n${lines.join('\n\n')}`, {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      logger.error('/finished error', err);
      await reply(msg.chat.id, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /link <title> ────────────────────────────────────────────────────────────

  bot.onText(/^\/link (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const query = match?.[1]?.trim();
    if (!query) {
      await reply(msg.chat.id, 'Usage: /link <ABS book title>');
      return;
    }

    // Find the ABS book by fuzzy title match
    let absBook: AbsBookProgress | null = null;
    try {
      const booksInProgress = await absClient.getItemsInProgress();
      absBook = booksInProgress.find((b) =>
        b.title.toLowerCase().includes(query.toLowerCase())
      ) ?? null;
    } catch (err) {
      logger.error('/link ABS fetch error', err);
      await reply(msg.chat.id, `Failed to fetch ABS books: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!absBook) {
      await reply(msg.chat.id, `No in-progress ABS book found matching: *${query}*\n\nUse /status to see in-progress books.`);
      return;
    }

    const absId = absBook.absLibraryItemId;
    await reply(msg.chat.id, `Found ABS book: *${absBook.title}*\n\nSearching StoryGraph...`);

    try {
      const results = await storygraph.searchBooks(absBook.title);
      if (results.length === 0) {
        await reply(msg.chat.id, 'No StoryGraph results found. Try /search with different terms.');
        return;
      }

      const top5 = results.slice(0, 5);
      const keyboard: TelegramBot.InlineKeyboardButton[][] = top5.map((r, i) => [
        {
          text: `${i + 1}. ${r.title}${r.author ? ` — ${r.author}` : ''}`,
          callback_data: `link:${absId}:${cacheUrl(r.bookUrl)}`,
        },
      ]);

      const lines = top5.map((r, i) =>
        `${i + 1}. *${r.title}*${r.author ? ` — ${r.author}` : ''}${r.editionInfo ? `\n   _${r.editionInfo}_` : ''}`
      );

      await reply(
        msg.chat.id,
        `Select the StoryGraph entry for *${absBook.title}*:\n\n${lines.join('\n\n')}`,
        { reply_markup: { inline_keyboard: keyboard } }
      );
    } catch (err) {
      logger.error('/link search error', err);
      await reply(msg.chat.id, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── Callback query handler ───────────────────────────────────────────────────

  bot.on('callback_query', async (query) => {
    if (!isAuthorizedCallback(query)) return;

    const data = query.data ?? '';
    const msgId = query.message?.message_id;
    const cid = query.message?.chat.id ?? chatId;

    await bot.answerCallbackQuery(query.id).catch(() => null);

    // add:<urlId>
    if (data.startsWith('add:')) {
      const urlId = parseInt(data.slice(4), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }
      if (msgId) await editMessage(cid, msgId, `Adding to TBR...`);
      try {
        await storygraph.addToTBR(bookUrl);
        if (msgId) await editMessage(cid, msgId, `Added to TBR!`);
        else await reply(cid, `Added to TBR!`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (msgId) await editMessage(cid, msgId, `Failed to add to TBR: ${errMsg}`);
        else await reply(cid, `Failed to add to TBR: ${errMsg}`);
      }
      return;
    }

    // reading:<urlId>
    if (data.startsWith('reading:')) {
      const urlId = parseInt(data.slice(8), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }
      if (msgId) await editMessage(cid, msgId, `Marking as currently reading...`);
      try {
        await storygraph.markAsReading(bookUrl);
        if (msgId) await editMessage(cid, msgId, `Marked as currently reading!`);
        else await reply(cid, `Marked as currently reading!`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (msgId) await editMessage(cid, msgId, `Failed: ${errMsg}`);
        else await reply(cid, `Failed: ${errMsg}`);
      }
      return;
    }

    // finished:<urlId>
    if (data.startsWith('finished:')) {
      const urlId = parseInt(data.slice(9), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }
      if (msgId) await editMessage(cid, msgId, `Marking as read...`);
      try {
        await storygraph.markAsRead(bookUrl);
        if (msgId) await editMessage(cid, msgId, `Marked as read!`);
        else await reply(cid, `Marked as read!`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (msgId) await editMessage(cid, msgId, `Failed: ${errMsg}`);
        else await reply(cid, `Failed: ${errMsg}`);
      }
      return;
    }

    // link:<absId>:<urlId>
    if (data.startsWith('link:')) {
      const rest = data.slice(5);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return;
      const absId = rest.slice(0, colonIdx);
      const urlId = parseInt(rest.slice(colonIdx + 1), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      if (msgId) await editMessage(cid, msgId, `Linking book...`);
      try {
        const booksInProgress = await absClient.getItemsInProgress();
        const absBook = booksInProgress.find((b) => b.absLibraryItemId === absId);

        db.upsertBookMapping({
          absLibraryItemId: absId,
          storygraphBookUrl: bookUrl,
          title: absBook?.title ?? absId,
          author: absBook?.author ?? '',
          editionType: 'audio',
        });

        const text = `Linked *${absBook?.title ?? absId}* to StoryGraph!\n${bookUrl}`;
        if (msgId) await editMessage(cid, msgId, text);
        else await reply(cid, text);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (msgId) await editMessage(cid, msgId, `Failed to link: ${errMsg}`);
        else await reply(cid, `Failed to link: ${errMsg}`);
      }
      return;
    }

    // newbook_yes:<absId>:<urlId>
    if (data.startsWith('nby:')) {
      const rest = data.slice(4);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return;
      const absId = rest.slice(0, colonIdx);
      const urlId = parseInt(rest.slice(colonIdx + 1), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      if (msgId) await editMessage(cid, msgId, `Setting up mapping...`);
      try {
        const booksInProgress = await absClient.getItemsInProgress();
        const absBook = booksInProgress.find((b) => b.absLibraryItemId === absId);

        db.upsertBookMapping({
          absLibraryItemId: absId,
          storygraphBookUrl: bookUrl,
          title: absBook?.title ?? absId,
          author: absBook?.author ?? '',
          editionType: 'audio',
        });

        await storygraph.markAsReading(bookUrl);

        const text = `Linked and marked as currently reading!\n*${absBook?.title ?? absId}*\n${bookUrl}`;
        if (msgId) await editMessage(cid, msgId, text);
        else await reply(cid, text);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (msgId) await editMessage(cid, msgId, `Failed: ${errMsg}`);
        else await reply(cid, `Failed: ${errMsg}`);
      }
      return;
    }

    // newbook_skip:<absId>
    if (data.startsWith('nbs:')) {
      const absId = data.slice(4);
      const text = `Skipped. Use /link to connect this book later.`;
      if (msgId) await editMessage(cid, msgId, text);
      else await reply(cid, text);
      return;
    }
  });

  // ── Internal helpers exposed via Bot interface ────────────────────────────────

  async function promptNewBookInternal(book: AbsBookProgress): Promise<void> {
    logger.info(`Prompting for new book: ${book.title}`);
    try {
      const results = await storygraph.searchBooks(book.title);
      const top3 = results.slice(0, 3);

      if (top3.length === 0) {
        await reply(
          chatId,
          `New book detected in ABS: *${book.title}* by ${book.author}\n\nNo StoryGraph results found. Use /link to connect it manually.`
        );
        return;
      }

      const lines = top3.map((r, i) =>
        `${i + 1}. *${r.title}*${r.author ? ` — ${r.author}` : ''}${r.editionInfo ? `\n   _${r.editionInfo}_` : ''}`
      );

      const keyboard: TelegramBot.InlineKeyboardButton[][] = [
        ...top3.map((r, i) => [
          {
            text: `${i + 1}. ${r.title}${r.author ? ` — ${r.author}` : ''}`,
            callback_data: `nby:${book.absLibraryItemId}:${cacheUrl(r.bookUrl)}`,
          },
        ]),
        [
          {
            text: 'Skip for now',
            callback_data: `nbs:${book.absLibraryItemId}`,
          },
        ],
      ];

      await reply(
        chatId,
        [
          `New audiobook detected: *${book.title}* by ${book.author}`,
          `Progress: ${book.progressPercent.toFixed(1)}%`,
          '',
          'Which StoryGraph entry matches? Selecting will link it and mark as currently reading.',
          '',
          ...lines,
        ].join('\n'),
        { reply_markup: { inline_keyboard: keyboard } }
      );
    } catch (err) {
      logger.error('promptNewBook error', err);
      await reply(
        chatId,
        `New book detected: *${book.title}* by ${book.author}\n\nFailed to search StoryGraph. Use /link to connect it manually.`
      );
    }
  }

  async function sendSyncSummaryInternal(results: SyncResult[]): Promise<void> {
    if (results.length === 0) {
      await reply(chatId, 'Sync complete. No actions needed.');
      return;
    }

    const lines: string[] = ['*Sync Summary*', ''];
    for (const r of results) {
      const icon = r.success ? '' : '';
      const actionLabel = r.action.replace(/_/g, ' ');
      lines.push(`${icon} *${r.book}* — ${actionLabel}`);
      if (!r.success && r.error) {
        lines.push(`  _Error: ${r.error}_`);
      }
    }

    await reply(chatId, lines.join('\n'));
  }

  return {
    start() {
      logger.info('Telegram bot started (polling)');
    },

    async sendSyncSummary(results: SyncResult[]): Promise<void> {
      await sendSyncSummaryInternal(results);
    },

    async promptNewBook(book: AbsBookProgress): Promise<void> {
      await promptNewBookInternal(book);
    },

    async sendError(message: string): Promise<void> {
      await reply(chatId, `Error: ${message}`);
    },
  };
}
