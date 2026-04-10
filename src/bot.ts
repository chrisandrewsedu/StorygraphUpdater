import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';
import type { Database } from './db.js';
import type { StoryGraph, StoryGraphSearchResult, StoryGraphEdition } from './storygraph.js';
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

  /** Send search results as individual photo messages with a select button each. */
  async function sendSearchResults(
    chatIdTarget: string | number,
    results: StoryGraphSearchResult[],
    makeCallbackData: (r: StoryGraphSearchResult) => string,
    headerText: string
  ): Promise<void> {
    if (headerText) await reply(chatIdTarget, headerText);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const caption = `*${i + 1}. ${r.title}*${r.author ? `\n${r.author}` : ''}${r.editionInfo ? `\n_${r.editionInfo}_` : ''}`;
      const keyboard: TelegramBot.InlineKeyboardButton[][] = [[
        { text: `Select this book`, callback_data: makeCallbackData(r) },
      ]];

      if (r.coverUrl) {
        try {
          await bot.sendPhoto(chatIdTarget, r.coverUrl, {
            caption,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard },
          });
          continue;
        } catch (err) {
          logger.warn(`Failed to send cover photo for ${r.title}, falling back to text`);
        }
      }

      await reply(chatIdTarget, caption, { reply_markup: { inline_keyboard: keyboard } });
    }
  }

  /** Send editions as individual photo messages with a select button each. */
  async function sendEditionResults(
    chatIdTarget: string | number,
    editions: StoryGraphEdition[],
    makeCallbackData: (e: StoryGraphEdition) => string,
    headerText: string
  ): Promise<void> {
    if (headerText) await reply(chatIdTarget, headerText);

    for (let i = 0; i < editions.length; i++) {
      const e = editions[i];
      const formatEmoji = e.format === 'audiobook' ? '🎧' : e.format === 'ebook' ? '📱' : e.format === 'hardcover' ? '📕' : e.format === 'paperback' ? '📖' : '📚';
      const caption = `*${i + 1}. ${e.title}*\n${formatEmoji} ${e.format.toUpperCase()}${e.info ? `\n_${e.info}_` : ''}`;
      const keyboard: TelegramBot.InlineKeyboardButton[][] = [[
        { text: `${formatEmoji} Select ${e.format}`, callback_data: makeCallbackData(e) },
      ]];

      if (e.coverUrl) {
        try {
          await bot.sendPhoto(chatIdTarget, e.coverUrl, {
            caption,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard },
          });
          continue;
        } catch (err) {
          logger.warn(`Failed to send cover photo for edition, falling back to text`);
        }
      }

      await reply(chatIdTarget, caption, { reply_markup: { inline_keyboard: keyboard } });
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
      '/link <title> — link an ABS book to a StoryGraph edition',
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
    if (!query) { await reply(msg.chat.id, 'Usage: /search <title>'); return; }

    await reply(msg.chat.id, `Searching StoryGraph for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) { await reply(msg.chat.id, 'No results found.'); return; }

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
    if (!query) { await reply(msg.chat.id, 'Usage: /add <title>'); return; }

    await reply(msg.chat.id, `Searching for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) { await reply(msg.chat.id, 'No results found.'); return; }

      // For /add, show books then let user pick → then show editions
      await sendSearchResults(msg.chat.id, results.slice(0, 5),
        (r) => `add_ed:${cacheUrl(r.bookUrl)}`,
        `Pick the book, then choose the edition to add:`);
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
      if (books.length === 0) { await reply(msg.chat.id, 'Your TBR list is empty.'); return; }

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
      if (books.length === 0) { await reply(msg.chat.id, 'Your TBR list is empty.'); return; }

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
    if (!query) { await reply(msg.chat.id, 'Usage: /reading <title>'); return; }

    await reply(msg.chat.id, `Searching for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) { await reply(msg.chat.id, 'No results found.'); return; }

      await sendSearchResults(msg.chat.id, results.slice(0, 5),
        (r) => `rd_ed:${cacheUrl(r.bookUrl)}`,
        `Pick the book, then choose the edition:`);
    } catch (err) {
      logger.error('/reading error', err);
      await reply(msg.chat.id, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /finished <title> ────────────────────────────────────────────────────────

  bot.onText(/^\/finished (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const query = match?.[1]?.trim();
    if (!query) { await reply(msg.chat.id, 'Usage: /finished <title>'); return; }

    await reply(msg.chat.id, `Searching for: *${query}*...`);
    try {
      const results = await storygraph.searchBooks(query);
      if (results.length === 0) { await reply(msg.chat.id, 'No results found.'); return; }

      await sendSearchResults(msg.chat.id, results.slice(0, 5),
        (r) => `fin_ed:${cacheUrl(r.bookUrl)}`,
        `Pick the book, then choose the edition:`);
    } catch (err) {
      logger.error('/finished error', err);
      await reply(msg.chat.id, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── /link <title> — two-step: pick book → pick edition ──────────────────────

  bot.onText(/^\/link (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const query = match?.[1]?.trim();
    if (!query) { await reply(msg.chat.id, 'Usage: /link <ABS book title>'); return; }

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

      // Step 1: Pick the book (deduplicated by title+author)
      const seen = new Set<string>();
      const deduped = results.filter((r) => {
        const key = `${r.title}::${r.author}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      await sendSearchResults(msg.chat.id, deduped.slice(0, 5),
        (r) => `lk_bk:${absId}:${cacheUrl(r.bookUrl)}`,
        `Step 1: Pick the correct book:`);
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

    // ── Step 2 handlers: fetch editions after book is picked ──

    // lk_bk:<absId>:<urlId> → /link step 2: show editions
    if (data.startsWith('lk_bk:')) {
      const rest = data.slice(6);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return;
      const absId = rest.slice(0, colonIdx);
      const urlId = parseInt(rest.slice(colonIdx + 1), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      await reply(cid, `Loading editions (filtering for audiobooks)...`);
      try {
        const allEditions = await storygraph.getEditions(bookUrl);
        // For /link, filter to audio editions only, prefer English
        const audioEditions = allEditions.filter((e) => e.format === 'audio' || e.format === 'audiobook');
        // Prioritize English editions (info containing "English" or not containing other languages)
        const englishAudio = audioEditions.filter((e) => {
          const lower = e.info.toLowerCase();
          return lower.includes('english') || (!lower.includes('spanish') && !lower.includes('french') && !lower.includes('german') && !lower.includes('portuguese') && !lower.includes('italian'));
        });
        const filteredAudio = englishAudio.length > 0 ? englishAudio : audioEditions;

        const booksInProgress = await absClient.getItemsInProgress();
        const absBook = booksInProgress.find((b) => b.absLibraryItemId === absId);

        if (filteredAudio.length === 0) {
          if (allEditions.length === 0) {
            await reply(cid, `No editions found. Linking directly...`);
            db.upsertBookMapping({
              absLibraryItemId: absId,
              storygraphBookUrl: bookUrl,
              title: absBook?.title ?? absId,
              author: absBook?.author ?? '',
              editionType: 'audio',
            });
            await reply(cid, `Linked *${absBook?.title ?? absId}* to StoryGraph!\n${bookUrl}`);
          } else {
            await reply(cid, `No audiobook editions found. Showing first 3 of ${allEditions.length} editions:`);
            await sendEditionResults(cid, allEditions.slice(0, 3),
              (e) => `lk_ed:${absId}:${cacheUrl(e.bookUrl)}`,
              '');
          }
          return;
        }

        if (filteredAudio.length === 1) {
          const edition = filteredAudio[0];
          db.upsertBookMapping({
            absLibraryItemId: absId,
            storygraphBookUrl: edition.bookUrl || bookUrl,
            title: absBook?.title ?? absId,
            author: absBook?.author ?? '',
            editionType: 'audio',
          });
          await reply(cid, `Found one audiobook edition — auto-linked!\n*${absBook?.title ?? absId}*\n${edition.info}\n${edition.bookUrl || bookUrl}`);
          return;
        }

        // Multiple audio editions — show first 3, with "show more" if needed
        const PAGE_SIZE = 3;
        const first = filteredAudio.slice(0, PAGE_SIZE);
        await sendEditionResults(cid, first,
          (e) => `lk_ed:${absId}:${cacheUrl(e.bookUrl)}`,
          `Found ${filteredAudio.length} audiobook editions (showing first ${Math.min(PAGE_SIZE, filteredAudio.length)}):`);

        if (filteredAudio.length > PAGE_SIZE) {
          // Cache the remaining editions for "show more"
          const remainingId = cacheUrl(JSON.stringify({
            absId,
            editions: filteredAudio.slice(PAGE_SIZE).map((e) => ({
              ...e,
              bookUrl: e.bookUrl,
            })),
          }));
          await reply(cid, `${filteredAudio.length - PAGE_SIZE} more audiobook editions available.`, {
            reply_markup: {
              inline_keyboard: [[{ text: 'Show more editions', callback_data: `lk_more:${remainingId}` }]],
            },
          });
        }
      } catch (err) {
        logger.error('editions fetch error', err);
        await reply(cid, `Failed to load editions: ${err instanceof Error ? err.message : String(err)}\n\nLinking to the main book page instead.`);
        const booksInProgress = await absClient.getItemsInProgress();
        const absBook = booksInProgress.find((b) => b.absLibraryItemId === absId);
        db.upsertBookMapping({
          absLibraryItemId: absId,
          storygraphBookUrl: bookUrl,
          title: absBook?.title ?? absId,
          author: absBook?.author ?? '',
          editionType: 'audio',
        });
        await reply(cid, `Linked *${absBook?.title ?? absId}* to StoryGraph!\n${bookUrl}`);
      }
      return;
    }

    // lk_more:<cacheId> → show more audiobook editions
    if (data.startsWith('lk_more:')) {
      const cacheId = parseInt(data.slice(8), 10);
      const cached = getCachedUrl(cacheId);
      if (!cached) { await reply(cid, 'Button expired. Please search again.'); return; }
      try {
        const { absId: moreAbsId, editions: moreEditions } = JSON.parse(cached) as {
          absId: string;
          editions: StoryGraphEdition[];
        };
        const PAGE_SIZE = 3;
        const page = moreEditions.slice(0, PAGE_SIZE);
        await sendEditionResults(cid, page,
          (e) => `lk_ed:${moreAbsId}:${cacheUrl(e.bookUrl)}`,
          `More audiobook editions:`);
        if (moreEditions.length > PAGE_SIZE) {
          const nextId = cacheUrl(JSON.stringify({
            absId: moreAbsId,
            editions: moreEditions.slice(PAGE_SIZE),
          }));
          await reply(cid, `${moreEditions.length - PAGE_SIZE} more available.`, {
            reply_markup: {
              inline_keyboard: [[{ text: 'Show more editions', callback_data: `lk_more:${nextId}` }]],
            },
          });
        }
      } catch (err) {
        await reply(cid, `Failed to load more editions: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // lk_ed:<absId>:<urlId> → /link step 3: save the specific edition
    if (data.startsWith('lk_ed:')) {
      const rest = data.slice(6);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return;
      const absId = rest.slice(0, colonIdx);
      const urlId = parseInt(rest.slice(colonIdx + 1), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      await reply(cid, `Linking edition...`);
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
        await reply(cid, `Linked *${absBook?.title ?? absId}* to StoryGraph edition!\n${bookUrl}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await reply(cid, `Failed to link: ${errMsg}`);
      }
      return;
    }

    // add_ed:<urlId> → /add step 2: show editions to add to TBR
    if (data.startsWith('add_ed:')) {
      const urlId = parseInt(data.slice(7), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      await reply(cid, `Loading editions...`);
      try {
        const editions = await storygraph.getEditions(bookUrl);
        if (editions.length === 0) {
          await storygraph.addToTBR(bookUrl);
          await reply(cid, `Added to TBR!`);
          return;
        }
        await sendEditionResults(cid, editions,
          (e) => `add:${cacheUrl(e.bookUrl)}`,
          `Pick the edition to add to your TBR:`);
      } catch (err) {
        logger.error('add editions error', err);
        await reply(cid, `Failed to load editions. Adding main book instead...`);
        await storygraph.addToTBR(bookUrl).catch(() => null);
        await reply(cid, `Added to TBR!`);
      }
      return;
    }

    // rd_ed:<urlId> → /reading step 2: show editions
    if (data.startsWith('rd_ed:')) {
      const urlId = parseInt(data.slice(6), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      await reply(cid, `Loading editions...`);
      try {
        const editions = await storygraph.getEditions(bookUrl);
        if (editions.length === 0) {
          await storygraph.markAsReading(bookUrl);
          await reply(cid, `Marked as currently reading!`);
          return;
        }
        await sendEditionResults(cid, editions,
          (e) => `reading:${cacheUrl(e.bookUrl)}`,
          `Pick the edition to mark as currently reading:`);
      } catch (err) {
        logger.error('reading editions error', err);
        await reply(cid, `Failed to load editions. Using main book page...`);
        await storygraph.markAsReading(bookUrl).catch(() => null);
        await reply(cid, `Marked as currently reading!`);
      }
      return;
    }

    // fin_ed:<urlId> → /finished step 2: show editions
    if (data.startsWith('fin_ed:')) {
      const urlId = parseInt(data.slice(7), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      await reply(cid, `Loading editions...`);
      try {
        const editions = await storygraph.getEditions(bookUrl);
        if (editions.length === 0) {
          await storygraph.markAsRead(bookUrl);
          await reply(cid, `Marked as read!`);
          return;
        }
        await sendEditionResults(cid, editions,
          (e) => `finished:${cacheUrl(e.bookUrl)}`,
          `Pick the edition to mark as read:`);
      } catch (err) {
        logger.error('finished editions error', err);
        await reply(cid, `Failed to load editions. Using main book page...`);
        await storygraph.markAsRead(bookUrl).catch(() => null);
        await reply(cid, `Marked as read!`);
      }
      return;
    }

    // ── Direct action handlers (after edition is picked) ──

    // add:<urlId>
    if (data.startsWith('add:')) {
      const urlId = parseInt(data.slice(4), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }
      await reply(cid, `Adding to TBR...`);
      try {
        await storygraph.addToTBR(bookUrl);
        await reply(cid, `Added to TBR!`);
      } catch (err) {
        await reply(cid, `Failed to add to TBR: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // reading:<urlId>
    if (data.startsWith('reading:')) {
      const urlId = parseInt(data.slice(8), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }
      await reply(cid, `Marking as currently reading...`);
      try {
        await storygraph.markAsReading(bookUrl);
        await reply(cid, `Marked as currently reading!`);
      } catch (err) {
        await reply(cid, `Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // finished:<urlId>
    if (data.startsWith('finished:')) {
      const urlId = parseInt(data.slice(9), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }
      await reply(cid, `Marking as read...`);
      try {
        await storygraph.markAsRead(bookUrl);
        await reply(cid, `Marked as read!`);
      } catch (err) {
        await reply(cid, `Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // nby:<absId>:<urlId> — new book auto-link
    if (data.startsWith('nby:')) {
      const rest = data.slice(4);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return;
      const absId = rest.slice(0, colonIdx);
      const urlId = parseInt(rest.slice(colonIdx + 1), 10);
      const bookUrl = getCachedUrl(urlId);
      if (!bookUrl) { await reply(cid, 'Button expired. Please search again.'); return; }

      await reply(cid, `Setting up mapping...`);
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
        await reply(cid, `Linked and marked as currently reading!\n*${absBook?.title ?? absId}*\n${bookUrl}`);
      } catch (err) {
        await reply(cid, `Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // nbs:<absId> — skip new book
    if (data.startsWith('nbs:')) {
      await reply(cid, `Skipped. Use /link to connect this book later.`);
      return;
    }
  });

  // ── Internal helpers ────────────────────────────────────────────────────────

  async function promptNewBookInternal(book: AbsBookProgress): Promise<void> {
    logger.info(`Prompting for new book: ${book.title}`);
    try {
      const results = await storygraph.searchBooks(book.title);
      const top3 = results.slice(0, 3);

      if (top3.length === 0) {
        await reply(chatId, `New book detected in ABS: *${book.title}* by ${book.author}\n\nNo StoryGraph results found. Use /link to connect it manually.`);
        return;
      }

      await reply(chatId, `New audiobook detected: *${book.title}* by ${book.author}\nProgress: ${book.progressPercent.toFixed(1)}%\n\nWhich StoryGraph entry matches? Selecting will link it and mark as currently reading.`);

      await sendSearchResults(chatId, top3,
        (r) => `nby:${book.absLibraryItemId}:${cacheUrl(r.bookUrl)}`,
        '');

      await reply(chatId, 'Or skip for now:', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Skip', callback_data: `nbs:${book.absLibraryItemId}` }]],
        },
      });
    } catch (err) {
      logger.error('promptNewBook error', err);
      await reply(chatId, `New book detected: *${book.title}* by ${book.author}\n\nFailed to search StoryGraph. Use /link to connect it manually.`);
    }
  }

  async function sendSyncSummaryInternal(results: SyncResult[]): Promise<void> {
    if (results.length === 0) {
      await reply(chatId, 'Sync complete. No actions needed.');
      return;
    }

    const lines: string[] = ['*Sync Summary*', ''];
    for (const r of results) {
      const actionLabel = r.action.replace(/_/g, ' ');
      lines.push(`${r.success ? '✅' : '❌'} *${r.book}* — ${actionLabel}`);
      if (!r.success && r.error) lines.push(`  _Error: ${r.error}_`);
    }
    await reply(chatId, lines.join('\n'));
  }

  return {
    start() { logger.info('Telegram bot started (polling)'); },
    async sendSyncSummary(results: SyncResult[]) { await sendSyncSummaryInternal(results); },
    async promptNewBook(book: AbsBookProgress) { await promptNewBookInternal(book); },
    async sendError(message: string) { await reply(chatId, `Error: ${message}`); },
  };
}
