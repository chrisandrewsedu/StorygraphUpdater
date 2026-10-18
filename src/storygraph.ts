import puppeteer, { type Browser, type Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';

export interface StoryGraphSearchResult {
  title: string;
  author: string;
  bookUrl: string;
  editionInfo: string;
  coverUrl: string;
}

export interface StoryGraphEdition {
  title: string;
  format: string;       // e.g. "hardcover", "paperback", "audiobook", "ebook"
  info: string;          // e.g. "305 pages • hardcover • 2017"
  bookUrl: string;
  coverUrl: string;
  isbn: string | null;   // the "ISBN/UID:" value on the edition card (ISBN or ASIN)
}

/** Normalize an ISBN/ASIN for comparison: drop non-alphanumerics, uppercase. */
export function normalizeIdentifier(id: string | null | undefined): string {
  return (id ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/** Find the edition whose ISBN/ASIN matches `identifier` (formatting-insensitive). */
export function matchEditionByIdentifier(
  editions: StoryGraphEdition[],
  identifier: string | null | undefined
): StoryGraphEdition | null {
  const norm = normalizeIdentifier(identifier);
  if (!norm) return null;
  return editions.find((e) => normalizeIdentifier(e.isbn) === norm) ?? null;
}

/**
 * Parse one edition card's text (from the /books/<id>/editions page) into an
 * edition. `bookHref` is the card's own /books/<id> link. Returns null without one.
 */
export function parseEditionCard(cardText: string, bookHref: string | null): StoryGraphEdition | null {
  if (!bookHref) return null;
  const lines = cardText.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const infoIdx = lines.findIndex((l) => /•\s*\w+\s*•\s*\d{4}/.test(l)); // "12h 30m • audio • 2026"
  const field = (label: string) =>
    lines.find((l) => l.startsWith(`${label}:`))?.slice(label.length + 1).trim() || null;

  // Title is the first line after the optional "You're currently reading another edition" banner.
  const title = lines.find((l) => !/currently reading another edition|^current edition$/i.test(l)) ?? 'Unknown';
  const isbnRaw = field('ISBN/UID');
  const language = field('Language');
  const publisher = field('Publisher');
  const info = [
    infoIdx >= 0 ? lines[infoIdx] : '',
    language ? `Language: ${language}` : '',
    publisher ? `Publisher: ${publisher}` : '',
  ].filter(Boolean).join('\n');

  return {
    title,
    format: (field('Format') ?? 'unknown').toLowerCase(),
    info,
    bookUrl: bookHref.startsWith('/') ? `https://app.thestorygraph.com${bookHref}` : bookHref,
    coverUrl: '',
    isbn: isbnRaw && isbnRaw.toLowerCase() !== 'none' ? isbnRaw : null,
  };
}

/** Which kind of edition a book is tracked on: audio (minutes) or digital (percent). */
export type EditionKind = 'audio' | 'digital';

export function isAudioFormat(format: string | null | undefined): boolean {
  return format === 'audio' || format === 'audiobook';
}

export function isDigitalFormat(format: string | null | undefined): boolean {
  return format === 'digital' || format === 'ebook' || format === 'kindle';
}

/** An audio edition's length in minutes from its info line ("3h 21m • audio • 2018"), or null. */
export function parseDurationMinutes(info: string): number | null {
  const m = info.match(/(?:^|\n)\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*•\s*audio/i);
  if (!m || (m[1] == null && m[2] == null)) return null;
  return parseInt(m[1] ?? '0', 10) * 60 + parseInt(m[2] ?? '0', 10);
}

/** The "Language: X" value from an edition's info, or null. */
export function parseEditionLanguage(info: string): string | null {
  return info.match(/Language:\s*([^\n]+)/)?.[1]?.trim() || null;
}

const LANGUAGE_CODES: Record<string, string> = { en: 'english', eng: 'english', es: 'spanish', spa: 'spanish', fr: 'french', fre: 'french', fra: 'french', de: 'german', ger: 'german', deu: 'german' };
const normLanguage = (l: string | null | undefined) => {
  const v = (l ?? '').trim().toLowerCase();
  return v ? LANGUAGE_CODES[v] ?? v : null;
};

/** Length match tolerance: StoryGraph rounds to whole minutes, ABS has seconds. */
const DURATION_MATCH_MIN = 2;
/** Another same-language edition this close (but not matching) means we can't be sure. */
const DURATION_AMBIGUOUS_MIN = 10;

/**
 * The audio edition whose length matches the ABS audiobook — only when that is
 * unambiguous: some edition within 2 min, all such matches in one language (ABS's
 * language if known), and no other edition in that language 2–10 min off.
 * Different narrations/dramatizations of a book differ by far more than that.
 */
function matchByDuration(
  audio: StoryGraphEdition[],
  absMinutes: number,
  language: string | null | undefined
): StoryGraphEdition | null {
  const withLen = audio
    .map((e) => ({ e, min: parseDurationMinutes(e.info), lang: normLanguage(parseEditionLanguage(e.info)) }))
    .filter((x): x is { e: StoryGraphEdition; min: number; lang: string | null } => x.min != null);
  let matches = withLen.filter((x) => Math.abs(x.min - absMinutes) <= DURATION_MATCH_MIN);
  const wanted = normLanguage(language);
  if (wanted) matches = matches.filter((x) => x.lang === wanted || x.lang == null);
  if (!matches.length) return null;
  const langs = new Set(matches.map((x) => x.lang).filter(Boolean));
  if (langs.size > 1) return null;
  const lang = wanted ?? [...langs][0] ?? null;
  const nearMiss = withLen.some((x) => {
    const diff = Math.abs(x.min - absMinutes);
    return diff > DURATION_MATCH_MIN && diff <= DURATION_AMBIGUOUS_MIN && (x.lang === lang || x.lang == null || lang == null);
  });
  if (nearMiss) return null;
  return [...matches].sort((a, b) => Math.abs(a.min - absMinutes) - Math.abs(b.min - absMinutes))[0].e;
}

/** Audio editions ordered by how close their length is to the ABS audiobook (unknown last). */
export function sortByDurationMatch(editions: StoryGraphEdition[], absMinutes: number): StoryGraphEdition[] {
  const diff = (e: StoryGraphEdition) => {
    const min = parseDurationMinutes(e.info);
    return min == null ? Number.POSITIVE_INFINITY : Math.abs(min - absMinutes);
  };
  return [...editions].sort((a, b) => diff(a) - diff(b));
}

/** Why an edition was picked — shown in Telegram so a wrong pick is easy to spot. */
export type EditionPickReason = 'id' | 'chosen' | 'duration' | 'only' | 'none';

/**
 * Pick the edition of the given kind to track a book against: audio for an
 * audiobook (journal minutes are only kept on audio editions; print records
 * "0 pages"), digital for an ebook. In order: the edition matching ABS's ASIN or
 * ISBN (both are tried); the chosen URL if it is already that kind (an explicit
 * pick); for audio, an unambiguous length match; the only edition of that kind.
 * Otherwise keeps the chosen URL (reason 'none').
 */
export function pickEdition(
  editions: StoryGraphEdition[],
  chosenUrl: string,
  opts: {
    asin: string | null | undefined;
    isbn: string | null | undefined;
    kind: EditionKind;
    absMinutes?: number | null;
    language?: string | null;
  }
): { url: string; reason: EditionPickReason } {
  const isKind = opts.kind === 'audio' ? isAudioFormat : isDigitalFormat;
  const ofKind = editions.filter((e) => isKind(e.format));
  const byId = matchEditionByIdentifier(ofKind, opts.asin) ?? matchEditionByIdentifier(ofKind, opts.isbn);
  if (byId) return { url: byId.bookUrl, reason: 'id' };
  if (ofKind.some((e) => e.bookUrl === chosenUrl)) return { url: chosenUrl, reason: 'chosen' };
  if (opts.kind === 'audio' && opts.absMinutes) {
    const byLength = matchByDuration(ofKind, opts.absMinutes, opts.language);
    if (byLength) return { url: byLength.bookUrl, reason: 'duration' };
  }
  const unique = new Set(ofKind.map((e) => e.bookUrl));
  if (unique.size === 1) return { url: ofKind[0].bookUrl, reason: 'only' };
  return { url: chosenUrl, reason: 'none' };
}

export function chooseEdition(
  editions: StoryGraphEdition[],
  chosenUrl: string,
  ids: { asin: string | null | undefined; isbn: string | null | undefined },
  kind: EditionKind
): string {
  return pickEdition(editions, chosenUrl, { ...ids, kind }).url;
}

export function chooseAudioEdition(
  editions: StoryGraphEdition[],
  chosenUrl: string,
  ids: { asin: string | null | undefined; isbn: string | null | undefined }
): string {
  return chooseEdition(editions, chosenUrl, ids, 'audio');
}

/** The edition format ("audio", "hardcover", ...) from a book page's "Format: X" line, or null. */
export function parseBookPageFormat(pageText: string): string | null {
  return pageText.match(/Format:\s*([A-Za-z]+)/)?.[1]?.toLowerCase() ?? null;
}

/**
 * Wrap every async method so calls run one at a time, in call order. StoryGraph is
 * driven through ONE browser tab: a Telegram command (e.g. the new-book search)
 * running during the nightly sync would otherwise abort the sync's page load.
 * Methods that call each other internally use the unwrapped object, so no deadlock.
 */
export function serializeMethods<T extends object>(obj: T): T {
  let tail: Promise<unknown> = Promise.resolve();
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'function') {
      wrapped[key] = value;
      continue;
    }
    wrapped[key] = (...args: unknown[]) => {
      const run = tail.then(() => (value as (...a: unknown[]) => unknown).apply(obj, args));
      tail = run.catch(() => undefined); // a failed call must not block the queue
      return run;
    };
  }
  return wrapped as T;
}

/** The review form's stars_decimal option for a quarter-star fraction (half is "5", not "50"). */
export function starsDecimalValue(fraction: 0 | 25 | 50 | 75): string {
  return { 0: '', 25: '25', 50: '5', 75: '75' }[fraction];
}

/** The id of an entry on `date` that exists in `after` but not in `before`, or null. */
export function pickNewEntry(
  before: StoryGraphJournalEntry[],
  after: StoryGraphJournalEntry[],
  date: string
): string | null {
  const old = new Set(before.map((e) => e.entryId));
  return after.find((e) => e.date === date && e.entryId && !old.has(e.entryId))?.entryId ?? null;
}

/** What to record on one dated audiobook journal entry. */
export interface JournalProgress {
  totalMinutes: number; // cumulative minutes listened by end of day
  dayMinutes: number; // minutes listened that day
  percent: number | null; // % of the book reached (StoryGraph won't compute it for edited entries)
}

/** A reading-progress entry read from a StoryGraph journal page. */
export interface StoryGraphJournalEntry {
  entryId: string | null; // the /journal_entries/<id> UUID, if an Edit link was present
  date: string; // 'YYYY-MM-DD'
  minutes: number | null; // cumulative minutes listened, if this is an audiobook progress entry
  percent: number | null;
}

/** Extract the book UUID from a StoryGraph `/books/<id>` URL, or null. */
export function bookIdFromUrl(bookUrl: string): string | null {
  return bookUrl.match(/\/books\/([0-9a-f]{8}-[0-9a-f-]+)/i)?.[1] ?? null;
}

/** Normalize a title for matching: lowercase, drop subtitle/series, strip punctuation. */
export function normalizeTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .split(/[:(]/)[0] // drop ": subtitle" and "(series, #n)"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Find the shelf book whose title matches `title` (subtitle/series-insensitive).
 * Returns the book only on a CONFIDENT single match — null if nothing matches or
 * two different books share the title.
 */
export function matchShelfByTitle(
  books: StoryGraphBook[],
  title: string
): StoryGraphBook | null {
  const norm = normalizeTitle(title);
  if (!norm) return null;
  const matches = books.filter((b) => normalizeTitle(b.title) === norm);
  const uniqueUrls = new Set(matches.map((m) => m.bookUrl));
  return uniqueUrls.size === 1 ? matches[0] : null;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Parse one journal entry's row text (and its Edit link) into structured data.
 * Rows look like "16 April 2026 Edit 16% 64 minutes listened (01:04 out of 06:41)"
 * or "15 April 2026 Edit Started reading". Returns null if no date is present.
 */
export function parseJournalEntryRow(
  rowText: string,
  editHref: string | null
): StoryGraphJournalEntry | null {
  const dateMatch = rowText.match(
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
  );
  if (!dateMatch) return null;
  const day = String(dateMatch[1]).padStart(2, '0');
  const month = String(MONTHS.indexOf(dateMatch[2].toLowerCase()) + 1).padStart(2, '0');
  const date = `${dateMatch[3]}-${month}-${day}`;

  // "(02:04 out of 12:30)" is the cumulative total; "N minutes listened" is that day's
  // minutes (equal to the total only on entries written before per-day minutes were sent).
  const totalMatch = rowText.match(/\((\d+):(\d{2})\s+out of/i);
  const minutesMatch = rowText.match(/(\d+)\s+minutes?\s+listened/i);
  const percentMatch = rowText.match(/(\d+)\s*%/);
  const entryId = editHref?.match(/\/journal_entries\/([0-9a-f-]+)/i)?.[1] ?? null;

  return {
    entryId,
    date,
    minutes: totalMatch
      ? parseInt(totalMatch[1], 10) * 60 + parseInt(totalMatch[2], 10)
      : minutesMatch
        ? parseInt(minutesMatch[1], 10)
        : null,
    percent: percentMatch ? parseInt(percentMatch[1], 10) : null,
  };
}

export interface StoryGraphBook {
  title: string;
  author: string;
  bookUrl: string;
}

export interface StoryGraph {
  login(email: string, password: string): Promise<boolean>;
  isLoggedIn(): Promise<boolean>;
  searchBooks(query: string): Promise<StoryGraphSearchResult[]>;
  getEditions(bookUrl: string): Promise<StoryGraphEdition[]>;
  /** Find the edition of `bookUrl` whose ISBN/ASIN matches `identifier`, or null. */
  findEditionByIdentifier(bookUrl: string, identifier: string): Promise<StoryGraphEdition | null>;
  /**
   * If the user's shelf holds a different edition of this book, switch it to
   * `editionUrl` (journal entries follow the shelved edition). No-op otherwise.
   */
  switchToEdition(editionUrl: string): Promise<void>;
  /** The id of the edition of this book on the user's shelf, or null if none is shelved. */
  findShelvedEdition(bookUrl: string): Promise<string | null>;
  /** The format of one edition ("audio", "hardcover", ...), read from its book page. */
  getEditionFormat(bookUrl: string): Promise<string | null>;
  /** Read the dated progress (journal) entries currently on StoryGraph for a book. */
  getJournalEntries(bookUrl: string): Promise<StoryGraphJournalEntry[]>;
  /** Create a backdated audiobook journal entry for a past date. */
  addBackdatedProgress(bookUrl: string, date: string, progress: JournalProgress): Promise<void>;
  /**
   * Create a dated reading-progress entry as a percent (ebooks on a digital
   * edition). Unlike minutes, the create form's percent field is a plain number
   * input, so one step is enough. Throws if no new entry appears for `date`.
   */
  addPercentProgress(bookUrl: string, date: string, percent: number): Promise<void>;
  /** Set day/total minutes, percent and date on an existing journal entry via the edit endpoint. */
  setEntryMinutes(entryId: string, date: string, progress: JournalProgress): Promise<void>;
  /** Move the "Started reading" date of the current read to `date` ('YYYY-MM-DD'). */
  setStartDate(bookUrl: string, date: string): Promise<void>;
  /** Delete a journal entry by id (used to repair a mismatched day before recreating it). */
  deleteJournalEntry(entryId: string): Promise<void>;
  /** Trigger StoryGraph's "Recalculate Streak" after backdated writes (best-effort). */
  recalculateStreak(): Promise<void>;
  updateProgress(bookUrl: string, percent: number): Promise<void>;
  markAsReading(bookUrl: string): Promise<void>;
  markAsRead(bookUrl: string): Promise<void>;
  markAsDNF(bookUrl: string): Promise<void>;
  /** Rate a book. wholeStars: 0–5, fraction: 0 | 25 | 50 | 75 (represents 0.00/0.25/0.50/0.75 stars). */
  rateBook(bookUrl: string, wholeStars: number, fraction: 0 | 25 | 50 | 75): Promise<void>;
  addToTBR(bookUrl: string): Promise<void>;
  getTBRList(username: string): Promise<StoryGraphBook[]>;
  /** Read the user's "currently reading" shelf (book title + primary book URL). */
  getCurrentlyReading(username: string): Promise<StoryGraphBook[]>;
  close(): Promise<void>;
}

export async function createStoryGraph(dataDir: string): Promise<StoryGraph> {
  const cookiesPath = path.join(dataDir, 'cookies.json');
  const screenshotsDir = path.join(dataDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const browser: Browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Load saved cookies if they exist
  if (fs.existsSync(cookiesPath)) {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
    await page.setCookie(...cookies);
    logger.info('Loaded saved StoryGraph cookies');
  }

  async function saveCookies(): Promise<void> {
    const cookies = await page.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  }

  async function takeFailureScreenshot(action: string): Promise<string> {
    const filename = `fail-${action}-${Date.now()}.png`;
    const filepath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    logger.error(`Screenshot saved: ${filepath}`);
    return filepath;
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Check for Cloudflare Turnstile and attempt to solve it. */
  async function handleTurnstile(url: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const content = await page.content();
      if (!content.includes('security verification') && !content.includes('cf-turnstile')) {
        return; // No challenge, we're good
      }

      logger.warn(`Turnstile detected on ${url} (attempt ${attempt + 1}/3)`);

      // Try to click the Turnstile checkbox inside its iframe
      try {
        const frames = page.frames();
        for (const frame of frames) {
          const checkbox = await frame.$('input[type="checkbox"], .cb-i, [id*="challenge"]').catch(() => null);
          if (checkbox) {
            logger.info('Found Turnstile checkbox, clicking...');
            await checkbox.click();
            await sleep(3000);
            break;
          }
        }
      } catch {
        logger.warn('Could not interact with Turnstile iframe');
      }

      // Wait for challenge to resolve
      await sleep(5000);

      // Check if it cleared
      const afterContent = await page.content();
      if (!afterContent.includes('security verification') && !afterContent.includes('cf-turnstile')) {
        logger.info('Turnstile cleared after checkbox click');
        return;
      }

      // Reload and try again
      logger.warn('Turnstile still present, reloading...');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(5000);
    }

    logger.error(`Turnstile could not be cleared after 3 attempts on ${url}`);
  }

  async function withRetry<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logger.warn(`${action} failed, retrying once...`);
      try {
        return await fn();
      } catch (retryErr) {
        const screenshotPath = await takeFailureScreenshot(action);
        const error = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
        (error as any).screenshotPath = screenshotPath;
        throw error;
      }
    }
  }

  /** POST to /update-status.js?...&status=STATUS using the form's own CSRF token. */
  async function postStatus(status: string, screenshotName: string): Promise<void> {
    const result = await page.evaluate(async (s: string) => {
      // update-status forms each have their own authenticity_token hidden input
      const form = document.querySelector(
        `form[action*="update-status"][action*="status=${s}"]`
      ) as HTMLFormElement | null;
      if (!form) return { ok: false, error: `no form found for status=${s}` };

      const token =
        (form.querySelector('input[name="authenticity_token"]') as HTMLInputElement | null)?.value ||
        document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
      if (!token) return { ok: false, error: 'no CSRF token' };

      const action = form.getAttribute('action') || '';
      try {
        const res = await fetch(action, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': token,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'text/javascript, application/javascript',
          },
          body: new URLSearchParams({ authenticity_token: token }).toString(),
          credentials: 'include',
        });
        return { ok: res.ok, status: res.status };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }, status);

    logger.info(`postStatus(${status}): ${JSON.stringify(result)}`);
    if (!result.ok) {
      throw new Error(`Failed to set status=${status}: ${JSON.stringify(result)}`);
    }
    await sleep(1500);
    await page.screenshot({ path: path.join(screenshotsDir, screenshotName), fullPage: false });
  }

  /**
   * Parse the edition cards on the current editions page. A card is the LARGEST
   * element holding exactly one "ISBN/UID:" line — smaller elements miss fields and
   * page wrappers span every card. Cards render twice (mobile + desktop): dedupe by URL.
   */
  async function readEditionCards(): Promise<Map<string, StoryGraphEdition>> {
    const cards = await page.evaluate(() => {
      const isCard = (el: Element) => ((el.textContent || '').match(/ISBN\/UID:/g) || []).length === 1;
      return Array.from(document.querySelectorAll('body *'))
        .filter((el) => isCard(el) && !(el.parentElement && isCard(el.parentElement)))
        .map((el) => ({
          text: (el as HTMLElement).innerText || el.textContent || '',
          href: el.querySelector('a[href^="/books/"]')?.getAttribute('href') ?? null,
          coverUrl: el.querySelector('img')?.getAttribute('src') ?? '',
        }));
    });
    const byUrl = new Map<string, StoryGraphEdition>();
    for (const c of cards) {
      const e = parseEditionCard(c.text, c.href);
      if (e && !byUrl.has(e.bookUrl)) byUrl.set(e.bookUrl, { ...e, coverUrl: c.coverUrl });
    }
    return byUrl;
  }

  const api: StoryGraph = {
    async login(email: string, password: string): Promise<boolean> {
      return withRetry('login', async () => {
        const loginUrl = 'https://app.thestorygraph.com/users/sign_in';
        logger.info('StoryGraph login: navigating to sign_in page...');
        await page.goto(loginUrl, { waitUntil: 'networkidle2' });
        await handleTurnstile(loginUrl);

        // Verify the login form is present
        const emailInput = await page.$('input[name="user[email]"]');
        if (!emailInput) {
          await page.screenshot({ path: path.join(screenshotsDir, 'debug-login-form.png'), fullPage: true });
          throw new Error('Login form not found after Turnstile');
        }

        logger.info('StoryGraph login: filling credentials...');
        await page.type('input[name="user[email]"]', email, { delay: 50 });
        await page.type('input[name="user[password]"]', password, { delay: 50 });
        await page.click('input[type="submit"], button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

        const loggedIn = !page.url().includes('/sign_in');
        if (loggedIn) {
          await saveCookies();
          logger.info('StoryGraph login successful');
        } else {
          logger.error('StoryGraph login failed — still on sign_in page');
        }
        return loggedIn;
      });
    },

    async isLoggedIn(): Promise<boolean> {
      try {
        await page.goto('https://app.thestorygraph.com/', {
          waitUntil: 'networkidle2',
          timeout: 15000,
        });
        await handleTurnstile('https://app.thestorygraph.com/');
        // Check for "Sign in" link in the page — if present, we're NOT logged in
        const hasSignIn = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          return links.some((a) => a.textContent?.trim().toLowerCase() === 'sign in');
        });
        const loggedIn = !hasSignIn && !page.url().includes('/sign_in');
        logger.info(`isLoggedIn check: ${loggedIn ? 'yes' : 'no'}`);
        return loggedIn;
      } catch {
        return false;
      }
    },

    async searchBooks(query: string): Promise<StoryGraphSearchResult[]> {
      return withRetry('search', async () => {
        const searchUrl = `https://app.thestorygraph.com/browse?search_term=${encodeURIComponent(query)}`;
        logger.info(`StoryGraph search: navigating to ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        logger.info(`StoryGraph search: page loaded, URL is ${page.url()}`);

        await handleTurnstile(searchUrl);

        // Wait for results to load
        const found = await page.waitForSelector('.book-title-author-and-series', { timeout: 10000 }).catch(() => null);
        logger.info(`StoryGraph search: results selector ${found ? 'found' : 'NOT found'}`);

        // Debug screenshot
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-search-latest.png'), fullPage: true });

        const results = await page.evaluate(() => {
          // Each search result card contains multiple anchors: the book title link,
          // the author link, and series tag links. The book link is the only one we
          // want — picking the first <a> blindly grabbed the series tag, causing the
          // wrong-edition / hidden-result bugs we fixed previously.
          const bookElements = document.querySelectorAll('.book-title-author-and-series');
          return Array.from(bookElements).slice(0, 10).map((el) => {
            const bookLink = el.querySelector('a[href*="/books/"]') as HTMLAnchorElement | null;
            if (!bookLink) return null;
            const title = bookLink.textContent?.trim() || '';
            const bookUrl = bookLink.getAttribute('href') || '';

            // Author and edition info from text lines
            const fullText = el.textContent || '';
            const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
            // lines[0] is title, lines[1] is author, lines[2+] is page count/format/editions
            const author = lines.length > 1 ? lines[1] : '';
            const editionInfo = lines.length > 2 ? lines[2] : '';

            // Cover image: find the img in the parent card/row
            const card = el.closest('[class*="book-pane"]')
              || el.closest('[class*="search"]')
              || el.parentElement?.parentElement;
            const imgEl = card?.querySelector('img');
            const coverUrl = imgEl?.getAttribute('src') || '';

            return { title, author, bookUrl, editionInfo, coverUrl };
          }).filter((r): r is NonNullable<typeof r> => r !== null);
        });

        // Prefix relative URLs
        return results.map((r) => ({
          ...r,
          bookUrl: r.bookUrl.startsWith('/')
            ? `https://app.thestorygraph.com${r.bookUrl}`
            : r.bookUrl,
        }));
      });
    },

    async getEditions(bookUrl: string): Promise<StoryGraphEdition[]> {
      return withRetry('getEditions', async () => {
        const bookId = bookIdFromUrl(bookUrl);
        if (!bookId) throw new Error(`Cannot extract book id from ${bookUrl}`);
        const editionsUrl = `https://app.thestorygraph.com/books/${bookId}/editions`;
        logger.info(`StoryGraph getEditions: ${editionsUrl}`);
        await page.goto(editionsUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(editionsUrl);

        // The list loads more as you scroll (?page=N); keep scrolling until it stops growing.
        // Capped: this is a fallback (the ISBN search finds exact editions), and a
        // popular book can have hundreds of editions.
        let seen = -1;
        const deadline = Date.now() + 45_000;
        for (let i = 0; i < 25 && Date.now() < deadline; i++) {
          const count = await page.evaluate(() => document.querySelectorAll('a[href^="/books/"]').length);
          if (count === seen) break;
          seen = count;
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          // Wait for the next page's request to finish before comparing counts.
          await page.waitForNetworkIdle({ idleTime: 700, timeout: 8000 }).catch(() => null);
        }
        const byUrl = await readEditionCards();
        logger.info(`StoryGraph getEditions: parsed ${byUrl.size} editions`);
        return [...byUrl.values()];
      });
    },

    async updateProgress(bookUrl: string, percent: number): Promise<void> {
      return withRetry('updateProgress', async () => {
        logger.info(`StoryGraph updateProgress: navigating to ${bookUrl}`);
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);

        const currentUrl = page.url();
        logger.info(`updateProgress: current URL: ${currentUrl}`);
        if (!currentUrl.includes('/books/')) {
          throw new Error(`Navigation landed on wrong page: ${currentUrl}`);
        }

        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-progress-before.png') });

        // StoryGraph book pages have THREE possible states for the progress tracker:
        //   A) "currently reading" + has progress  →  .edit-progress button (pencil icon)
        //   B) "currently reading" + no progress   →  .track-progress-button (first-time)
        //   C) NOT currently reading (to-read/read)→  no .progress-tracker-pane at all,
        //                                              but a "status=currently-reading"
        //                                              form is present in the dropdown.
        //
        // First, give the button time to render (Stimulus/Turbo timing race).
        let btnHandle = await page
          .waitForSelector('.track-progress-button, .edit-progress', { timeout: 8000 })
          .catch(() => null);

        if (!btnHandle) {
          // Button missing — figure out which state we're in
          const state = await page.evaluate(() => {
            const pane = document.querySelector('.progress-tracker-pane');
            const statusForms = Array.from(
              document.querySelectorAll('form[action*="update-status"]')
            ).map((f) => f.getAttribute('action') ?? '');
            const hasCurrentlyReadingForm = statusForms.some((a) =>
              a.includes('status=currently-reading')
            );
            return {
              paneExists: !!pane,
              hasCurrentlyReadingForm,
              statusForms,
            };
          });
          logger.info(`updateProgress: state detection: ${JSON.stringify(state)}`);

          if (!state.paneExists && state.hasCurrentlyReadingForm) {
            // State C: book is in another status (to-read/read/dnf/paused). Promote it
            // to "currently reading" so the progress tracker pane appears, then retry.
            logger.info('updateProgress: book is not currently-reading on StoryGraph — setting status now');
            await postStatus('currently-reading', 'debug-auto-set-reading.png');
            await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            btnHandle = await page
              .waitForSelector('.track-progress-button, .edit-progress', { timeout: 8000 })
              .catch(() => null);
          }

          if (!btnHandle) {
            await page.screenshot({
              path: path.join(screenshotsDir, 'fail-progress-no-button.png'),
              fullPage: true,
            });
            const reason = !state.paneExists
              ? 'No progress-tracker-pane on the page after attempting to set currently-reading status.'
              : 'progress-tracker-pane exists but neither .track-progress-button nor .edit-progress was found inside it.';
            throw new Error(
              `Progress tracker button not found on StoryGraph. ${reason} Check fail-progress-no-button.png and container logs.`
            );
          }
        }

        await page.screenshot({ path: path.join(screenshotsDir, 'debug-progress-before-click.png') });

        // Click the button to reveal the progress entry form
        let formInfo = await page.evaluate(() => {
          const btn = document.querySelector('.track-progress-button, .edit-progress') as HTMLElement | null;
          if (!btn) return null;
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'clicked';
        });

        // Wait for the form to appear so all hidden inputs (CSRF token etc.) are populated
        await page.waitForSelector('.progress-tracking-form', { timeout: 8000 }).catch(() => null);
        await sleep(500);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-progress-edit.png'), fullPage: true });

        // Submit directly via fetch() bypassing the unreliable Rails UJS click chain.
        // The /update-progress form has no authenticity_token input — it uses the
        // meta[name="csrf-token"] value passed as the X-CSRF-Token request header.
        const fetchResult = await page.evaluate(async (pct: number) => {
          const form = document.querySelector('form[action="/update-progress"]') as HTMLFormElement | null;
          if (!form) return { ok: false, error: 'form not found' };

          // CSRF token is in <meta name="csrf-token"> not in the form inputs
          const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
          const bookId = (form.querySelector('input[name="book_id"]') as HTMLInputElement | null)?.value;
          if (!token) return { ok: false, error: 'no CSRF token in meta tag' };
          if (!bookId) return { ok: false, error: 'no book_id' };

          const body = new URLSearchParams({
            'book_id': bookId,
            'on_book_page': 'true',
            'read_status[progress_type]': 'percentage',   // required: tells server to use progress_number not minutes
            'read_status[progress_number]': String(Math.round(pct)),
            'read_status[progress_minutes]': '',
            'commit': 'Save',
          });

          try {
            const res = await fetch('/update-progress', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'text/javascript, application/javascript',
              },
              body: body.toString(),
              credentials: 'include',
            });
            const text = await res.text();
            return { ok: res.ok, status: res.status, body: text.slice(0, 200) };
          } catch (e: any) {
            return { ok: false, error: e.message };
          }
        }, percent);

        logger.info(`updateProgress: fetch result: ${JSON.stringify(fetchResult)}`);

        if (!fetchResult.ok) {
          await page.screenshot({ path: path.join(screenshotsDir, 'fail-progress-fetch.png'), fullPage: true });
          throw new Error(`fetch to /update-progress failed: ${JSON.stringify(fetchResult)}`);
        }

        // Reload the page to get the server-rendered state and verify the percentage
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await sleep(1000);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-progress-after.png'), fullPage: true });

        const verified = await page.evaluate((expectedPct: number) => {
          const rounded = Math.round(expectedPct);

          // Check the progress bar element — StoryGraph renders the percentage
          // as the text content of the element that has the teal progress bar style.
          // Also check the track-progress-button which shows current % when progress exists.
          const candidates = [
            document.querySelector('.progress-tracker-pane'),
            document.querySelector('[class*="progress-bar"]'),
            document.querySelector('[style*="width"]'),
          ];

          for (const el of candidates) {
            if (!el) continue;
            const text = el.textContent || '';
            for (let delta = 0; delta <= 2; delta++) {
              if (text.includes(`${rounded - delta}%`) || text.includes(`${rounded + delta}%`)) {
                return { ok: true, found: `~${rounded}% in ${el.className?.slice(0, 40)}` };
              }
            }
          }

          // Fallback: check the number input min attribute — StoryGraph sets min=N
          // where N is the current progress, so after a successful save it should reflect the new value
          const numInput = document.querySelector('input[name="read_status[progress_number]"]') as HTMLInputElement | null;
          const minVal = numInput ? parseInt(numInput.min || '0', 10) : null;
          if (minVal !== null && Math.abs(minVal - rounded) <= 2) {
            return { ok: true, found: `min attr=${minVal} matches ~${rounded}%` };
          }

          const pane = document.querySelector('.progress-tracker-pane');
          return { ok: false, paneText: pane?.textContent?.trim().slice(0, 150), minAttr: minVal };
        }, percent);

        logger.info(`updateProgress: verification: ${JSON.stringify(verified)}`);

        if (!verified.ok) {
          await page.screenshot({ path: path.join(screenshotsDir, 'fail-progress-verify.png'), fullPage: true });
          throw new Error(`Progress update did not persist on StoryGraph. Pane: "${verified.paneText}"`);
        }

        logger.info(`Updated progress for ${bookUrl} to ${percent}%`);
      });
    },

    async markAsReading(bookUrl: string): Promise<void> {
      return withRetry('markAsReading', async () => {
        logger.info(`StoryGraph markAsReading: navigating to ${bookUrl}`);
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);

        // Find and click the status dropdown (the teal button with chevron)
        // Then look for "currently reading" option
        const clicked = await page.evaluate(() => {
          // Look for the dropdown trigger — it's a button/link near "to read" or status text
          const allBtns = Array.from(document.querySelectorAll('button, a, [role="button"]'));

          // First try to find a dropdown chevron/arrow near the status
          const dropdownTrigger = allBtns.find((el) => {
            const text = el.textContent?.toLowerCase() || '';
            return text.includes('to read') || text.includes('currently reading') || text.includes('want to read');
          });

          if (dropdownTrigger) {
            (dropdownTrigger as HTMLElement).click();
            return 'clicked_dropdown';
          }
          return 'no_dropdown';
        });
        logger.info(`markAsReading: dropdown click result: ${clicked}`);
        await sleep(1000);

        // Now find "currently reading" in the revealed options
        const selected = await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll('button, a, [role="menuitem"], [role="option"], li'));
          const option = allEls.find((el) => {
            const text = el.textContent?.trim().toLowerCase() || '';
            return text === 'currently reading' || text === 'currently-reading';
          });
          if (option) {
            (option as HTMLElement).click();
            return 'clicked_reading';
          }
          return 'no_reading_option';
        });
        logger.info(`markAsReading: selection result: ${selected}`);

        await sleep(1000);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-mark-reading.png'), fullPage: true });
        logger.info(`Marked as currently reading: ${bookUrl}`);
      });
    },

    async markAsRead(bookUrl: string): Promise<void> {
      return withRetry('markAsRead', async () => {
        logger.info(`StoryGraph markAsRead: navigating to ${bookUrl}`);
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);
        await postStatus('read', 'debug-mark-read.png');
        logger.info(`Marked as read: ${bookUrl}`);
      });
    },

    async markAsDNF(bookUrl: string): Promise<void> {
      return withRetry('markAsDNF', async () => {
        logger.info(`StoryGraph markAsDNF: navigating to ${bookUrl}`);
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);
        await postStatus('did-not-finish', 'debug-mark-dnf.png');
        logger.info(`Marked as DNF: ${bookUrl}`);
      });
    },

    async rateBook(bookUrl: string, wholeStars: number, fraction: 0 | 25 | 50 | 75): Promise<void> {
      return withRetry('rateBook', async () => {
        const bookId = bookIdFromUrl(bookUrl);
        if (!bookId) throw new Error(`Cannot extract book id from ${bookUrl}`);
        // A rating is a review with stars and no text. The book page's "add review"
        // link opens /reviews/new, whose form posts to /reviews with stars_integer
        // (0-5) and stars_decimal ("", "25", "5", "75").
        const reviewUrl = `https://app.thestorygraph.com/reviews/new?book_id=${bookId}`;
        logger.info(`StoryGraph rateBook: ${reviewUrl} — ${wholeStars}.${fraction} stars`);
        await page.goto(reviewUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(reviewUrl);

        const F = 'form:has(select[name="stars_integer"])';
        await page.waitForSelector(`${F} select[name="stars_integer"]`, { timeout: 8000 });
        await page.select(`${F} select[name="stars_integer"]`, String(wholeStars));
        await page.select(`${F} select[name="stars_decimal"]`, starsDecimalValue(fraction));
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null),
          page.evaluate((sel: string) => {
            const form = document.querySelector(sel) as HTMLFormElement;
            form.noValidate = true; // the "href" link field is spuriously required
            form.requestSubmit((form.querySelector('button[type="submit"]') as HTMLButtonElement | null) ?? undefined);
          }, F),
        ]);
        logger.info(`rateBook: submitted, now on ${page.url()}`);
        if (page.url().includes('/reviews/new')) {
          await takeFailureScreenshot('rateBook-not-saved');
          throw new Error('Rating was not saved (still on the review form)');
        }
        logger.info(`Rated ${bookUrl}: ${wholeStars}.${fraction} stars`);
      });
    },

    async addToTBR(bookUrl: string): Promise<void> {
      return withRetry('addToTBR', async () => {
        logger.info(`StoryGraph addToTBR: navigating to ${bookUrl}`);
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);

        const clicked = await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const tbrBtn = allEls.find((el) => {
            const text = el.textContent?.trim().toLowerCase() || '';
            return text.includes('want to read') || text.includes('to read');
          });
          if (tbrBtn) {
            (tbrBtn as HTMLElement).click();
            return 'clicked_tbr';
          }
          return 'no_tbr_button';
        });
        logger.info(`addToTBR: click result: ${clicked}`);

        await sleep(1000);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-add-tbr.png'), fullPage: true });
        logger.info(`Added to TBR: ${bookUrl}`);
      });
    },

    async getTBRList(username: string): Promise<StoryGraphBook[]> {
      return withRetry('getTBRList', async () => {
        await page.goto(`https://app.thestorygraph.com/to-read/${username}`, {
          waitUntil: 'networkidle2',
          timeout: 15000,
        });

        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(1500);
        }

        const books = await page.evaluate(() => {
          const bookElements = document.querySelectorAll('.book-title-author-and-series');
          return Array.from(bookElements).map((el) => {
            const linkEl = el.querySelector('a');
            return {
              title: linkEl?.textContent?.trim() || '',
              author: '',
              bookUrl: linkEl?.getAttribute('href') || '',
            };
          });
        });

        return books.map((b) => ({
          ...b,
          bookUrl: b.bookUrl.startsWith('/')
            ? `https://app.thestorygraph.com${b.bookUrl}`
            : b.bookUrl,
        }));
      });
    },

    async getCurrentlyReading(username: string): Promise<StoryGraphBook[]> {
      return withRetry('getCurrentlyReading', async () => {
        const url = `https://app.thestorygraph.com/currently-reading/${username}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(url);
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(1000);
        }
        const books = await page.evaluate(() => {
          const els = document.querySelectorAll('.book-title-author-and-series');
          return Array.from(els).map((el) => {
            // Prefer the /books/ link — these cards also contain series-tag anchors
            // (/series/<id>), which must NOT be treated as books.
            const linkEl = el.querySelector('a[href*="/books/"]') ?? el.querySelector('a');
            return {
              title: linkEl?.textContent?.trim() || '',
              author: '',
              bookUrl: linkEl?.getAttribute('href') || '',
            };
          });
        });
        // Keep only real book links, dedupe (the shelf renders each twice), absolutize.
        const seen = new Set<string>();
        const out: StoryGraphBook[] = [];
        for (const b of books) {
          if (!/\/books\/[0-9a-f-]{8,}/i.test(b.bookUrl)) continue; // drop series/other links
          const bookUrl = b.bookUrl.startsWith('/') ? `https://app.thestorygraph.com${b.bookUrl}` : b.bookUrl;
          if (seen.has(bookUrl)) continue;
          seen.add(bookUrl);
          out.push({ ...b, bookUrl });
        }
        return out;
      });
    },

    async findEditionByIdentifier(
      bookUrl: string,
      identifier: string
    ): Promise<StoryGraphEdition | null> {
      // The editions page has a "Search by ISBN..." box (/search-editions) that finds the
      // edition wherever it sits in a long, paginated list. Fall back to scanning the list.
      const found = await withRetry('searchEditions', async () => {
        const id = bookIdFromUrl(bookUrl);
        if (!id) throw new Error(`Cannot extract book id from ${bookUrl}`);
        const editionsUrl = `https://app.thestorygraph.com/books/${id}/editions`;
        await page.goto(editionsUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(editionsUrl);
        const input = await page.$('input[name="search_editions"]');
        if (!input) return null;
        await input.type(identifier);
        await Promise.all([
          page.waitForResponse((r) => r.url().includes('/search-editions'), { timeout: 10000 }).catch(() => null),
          page.evaluate(() => (document.querySelector('input[name="search_editions"]') as HTMLInputElement).form?.requestSubmit()),
        ]);
        await sleep(1000);
        return matchEditionByIdentifier([...(await readEditionCards()).values()], identifier);
      }).catch(() => null);
      if (found) {
        logger.info(`findEditionByIdentifier(${identifier}): ${found.format} ${found.bookUrl}`);
        return found;
      }
      return matchEditionByIdentifier(await api.getEditions(bookUrl), identifier);
    },

    async getEditionFormat(bookUrl: string): Promise<string | null> {
      return withRetry('getEditionFormat', async () => {
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);
        // textContent, not innerText: the edition details sit in a collapsed (hidden) section.
        return parseBookPageFormat(await page.evaluate(() => document.body.textContent || ''));
      });
    },

    async findShelvedEdition(bookUrl: string): Promise<string | null> {
      return withRetry('findShelvedEdition', async () => {
        const id = bookIdFromUrl(bookUrl);
        if (!id) throw new Error(`Cannot extract book id from ${bookUrl}`);
        const editionsUrl = `https://app.thestorygraph.com/books/${id}/editions`;
        await page.goto(editionsUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(editionsUrl);
        // Every "switch to this edition" form names the shelved edition as from_book_id.
        const fromIds = await page.evaluate(() =>
          Array.from(document.querySelectorAll('form[action="/switch-editions"] input[name="from_book_id"]')).map(
            (i) => (i as HTMLInputElement).value
          )
        );
        const unique = [...new Set(fromIds.filter(Boolean))];
        logger.info(`findShelvedEdition(${id}): ${unique.join(', ') || 'none shelved'}`);
        return unique.length === 1 ? unique[0] : null;
      });
    },

    async switchToEdition(editionUrl: string): Promise<void> {
      return withRetry('switchToEdition', async () => {
        const toId = bookIdFromUrl(editionUrl);
        if (!toId) throw new Error(`Cannot extract book id from ${editionUrl}`);
        const editionsUrl = `https://app.thestorygraph.com/books/${toId}/editions`;
        await page.goto(editionsUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(editionsUrl);
        // A "switch to this edition" form only exists when another edition is shelved.
        const fromId = await page.evaluate((id: string) => {
          const input = document.querySelector(
            `form[action="/switch-editions"] input[name="to_book_id"][value="${id}"]`
          ) as HTMLInputElement | null;
          if (!input?.form) return null;
          const from = (input.form.querySelector('input[name="from_book_id"]') as HTMLInputElement | null)?.value ?? null;
          input.form.requestSubmit();
          return from;
        }, toId);
        if (!fromId) {
          logger.info(`switchToEdition(${toId}): no other edition shelved, nothing to switch`);
          return;
        }
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null);
        logger.info(`switchToEdition: switched ${fromId} -> ${toId}`);
      });
    },

    async getJournalEntries(bookUrl: string): Promise<StoryGraphJournalEntry[]> {
      return withRetry('getJournalEntries', async () => {
        const bookId = bookIdFromUrl(bookUrl);
        if (!bookId) throw new Error(`Cannot extract book id from ${bookUrl}`);
        const url = `https://app.thestorygraph.com/journal?book_id=${bookId}`;
        logger.info(`StoryGraph getJournalEntries: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        await handleTurnstile(url);
        // Journal can lazy-load; scroll to surface all of this book's entries.
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(1000);
        }

        // Anchor on each entry's "Edit" link, then walk up to the LARGEST ancestor
        // that still holds only this one Edit link. The smallest dated ancestor is
        // just the "4 October 2026 Edit" header and misses the minutes line below it.
        const rows = await page.evaluate(() => {
          const out: Array<{ rowText: string; editHref: string | null }> = [];
          const sel = 'a[href*="/journal_entries/"][href*="/edit"]';
          for (const link of document.querySelectorAll(sel)) {
            const editHref = link.getAttribute('href');
            let el: Element = link;
            while (el.parentElement && el.parentElement.querySelectorAll(sel).length === 1) {
              el = el.parentElement;
            }
            out.push({ rowText: (el.textContent || '').replace(/\s+/g, ' ').trim(), editHref });
          }
          return out;
        });

        const seen = new Set<string>();
        const entries: StoryGraphJournalEntry[] = [];
        for (const r of rows) {
          const entry = parseJournalEntryRow(r.rowText, r.editHref);
          if (!entry) continue;
          const key = entry.entryId ?? `${entry.date}:${entry.minutes}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push(entry);
        }
        logger.info(`getJournalEntries: parsed ${entries.length} entries for ${bookId}`);
        return entries;
      });
    },

    async deleteJournalEntry(entryId: string): Promise<void> {
      return withRetry('deleteJournalEntry', async () => {
        const url = `https://app.thestorygraph.com/journal_entries/${entryId}/edit`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        await handleTurnstile(url);
        const result = await page.evaluate(async (id: string) => {
          const token =
            document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
            (document.querySelector('input[name="authenticity_token"]') as HTMLInputElement | null)?.value;
          if (!token) return { ok: false, error: 'no CSRF token' };
          const body = new URLSearchParams({ _method: 'delete', authenticity_token: token });
          try {
            const res = await fetch(`/journal_entries/${id}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                'X-Requested-With': 'XMLHttpRequest',
                Accept: 'text/html, application/javascript',
              },
              body: body.toString(),
              credentials: 'include',
            });
            return { ok: res.ok, status: res.status };
          } catch (e: any) {
            return { ok: false, error: e.message };
          }
        }, entryId);
        logger.info(`deleteJournalEntry(${entryId}): ${JSON.stringify(result)}`);
        if (!result.ok) throw new Error(`deleteJournalEntry failed: ${JSON.stringify(result)}`);
      });
    },

    async recalculateStreak(): Promise<void> {
      try {
        await page.goto('https://app.thestorygraph.com/journal', { waitUntil: 'networkidle2', timeout: 20000 });
        const result = await page.evaluate(async () => {
          const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
          // The flame/recalculate control posts to a recalculate endpoint when a streak breaks.
          const el = [...document.querySelectorAll('a,button,form')].find((e) =>
            /recalc/i.test((e.getAttribute('href') || '') + (e.getAttribute('action') || '') + (e.textContent || ''))
          ) as HTMLElement | null;
          if (!el) return { ok: false, error: 'no recalculate control found' };
          const href = el.getAttribute('href') || el.getAttribute('action');
          if (href && token) {
            const res = await fetch(href, {
              method: 'POST',
              headers: { 'X-CSRF-Token': token, 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/javascript' },
              credentials: 'include',
            });
            return { ok: res.ok, status: res.status };
          }
          (el as HTMLElement).click();
          return { ok: true, status: 'clicked' };
        });
        logger.info(`recalculateStreak: ${JSON.stringify(result)}`);
      } catch (err) {
        logger.warn(`recalculateStreak best-effort failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async addBackdatedProgress(bookUrl: string, date: string, progress: JournalProgress): Promise<void> {
      return withRetry('addBackdatedProgress', async () => {
        // StoryGraph's "Add note/Edit date" form is JS-driven and the minutes field
        // is unreliable to drive headlessly (HH:MM, overlay-covered, order-sensitive,
        // and breaks on consecutive writes). The DATE selects, however, are reliable,
        // and the journal-entry EDIT endpoint reliably sets the value as a plain
        // minute count. So: (1) create the entry with the correct date (ignore the
        // flaky minutes field), then (2) PUT the cumulative minutes onto it.
        const bookId = bookIdFromUrl(bookUrl);
        if (!bookId) throw new Error(`Cannot extract book id from ${bookUrl}`);
        const formUrl = `https://app.thestorygraph.com/progress-update?book_id=${bookId}&return_to=${encodeURIComponent(bookUrl)}`;
        const [year, month, day] = date.split('-').map((n) => String(parseInt(n, 10)));
        const F = 'form[action="/update-progress-with-note"]';

        // Snapshot existing entries so Step 2 sets minutes on the NEW entry, not an
        // older one on the same date (e.g. the auto "Started reading" placeholder).
        const before = await api.getJournalEntries(bookUrl);

        // --- Step 1: create a dated entry (date selects are reliable) ---
        await page.goto(formUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await handleTurnstile(formUrl);
        await page.waitForSelector(`${F} select[name="progress_update_date[day]"]`, { timeout: 8000 });
        await page.select(`${F} select[name="progress_type"]`, 'minutes').catch(() => null);
        await page.select(`${F} select[name="progress_update_date[day]"]`, day).catch(() => null);
        await page.select(`${F} select[name="progress_update_date[month]"]`, month).catch(() => null);
        await page.select(`${F} select[name="progress_update_date[year]"]`, year).catch(() => null);
        await page.evaluate((sel: string) => {
          const form = document.querySelector(sel) as HTMLFormElement | null;
          if (!form) return;
          form.noValidate = true; // the "href" link field is spuriously required
          form.requestSubmit((form.querySelector('button[type="submit"]') as HTMLButtonElement | null) ?? undefined);
        }, F);
        await page
          .waitForFunction(() => !location.pathname.includes('/progress-update'), { timeout: 12000 })
          .catch(() => null);
        await sleep(800);

        // --- Step 2: find the just-created entry for this date and set its minutes ---
        const entries = await api.getJournalEntries(bookUrl);
        const entryId = pickNewEntry(before, entries, date);
        if (!entryId) {
          throw new Error(`addBackdatedProgress: created entry for ${date} not found to set minutes`);
        }
        await api.setEntryMinutes(entryId, date, progress);
        logger.info(`addBackdatedProgress(${date}, ${progress.totalMinutes}m): entry ${entryId}`);
      });
    },

    async addPercentProgress(bookUrl: string, date: string, percent: number): Promise<void> {
      return withRetry('addPercentProgress', async () => {
        const bookId = bookIdFromUrl(bookUrl);
        if (!bookId) throw new Error(`Cannot extract book id from ${bookUrl}`);
        const formUrl = `https://app.thestorygraph.com/progress-update?book_id=${bookId}&return_to=${encodeURIComponent(bookUrl)}`;
        const [year, month, day] = date.split('-').map((n) => String(parseInt(n, 10)));
        const F = 'form[action="/update-progress-with-note"]';

        const before = await api.getJournalEntries(bookUrl);

        await page.goto(formUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await handleTurnstile(formUrl);
        await page.waitForSelector(`${F} input[name="progress_number"]`, { timeout: 8000 });
        // Digital/print editions offer "pages" or "percentage" (audio offers minutes).
        const types = await page.$$eval(`${F} select[name="progress_type"] option`, (os) =>
          os.map((o) => (o as HTMLOptionElement).value)
        );
        if (!types.includes('percentage')) {
          throw new Error(`addPercentProgress: no percentage option (got ${types.join(', ')}) — is the edition audio?`);
        }
        await page.select(`${F} select[name="progress_type"]`, 'percentage');
        await page.select(`${F} select[name="progress_update_date[day]"]`, day).catch(() => null);
        await page.select(`${F} select[name="progress_update_date[month]"]`, month).catch(() => null);
        await page.select(`${F} select[name="progress_update_date[year]"]`, year).catch(() => null);
        await page.evaluate(
          (sel: string, pct: string) => {
            const form = document.querySelector(sel) as HTMLFormElement | null;
            if (!form) return;
            const input = form.querySelector('input[name="progress_number"]') as HTMLInputElement;
            input.value = pct;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            form.noValidate = true; // the "href" link field is spuriously required
            form.requestSubmit((form.querySelector('button[type="submit"]') as HTMLButtonElement | null) ?? undefined);
          },
          F,
          String(percent)
        );
        await page
          .waitForFunction(() => !location.pathname.includes('/progress-update'), { timeout: 12000 })
          .catch(() => null);
        await sleep(800);

        const entries = await api.getJournalEntries(bookUrl);
        const entryId = pickNewEntry(before, entries, date);
        if (!entryId) throw new Error(`addPercentProgress: no new entry for ${date} after submitting`);
        const recorded = entries.find((e) => e.entryId === entryId)?.percent ?? null;
        if (recorded !== percent) {
          logger.warn(`addPercentProgress(${date}, ${percent}%): entry ${entryId} reads ${recorded}% on the journal`);
        }
        logger.info(`addPercentProgress(${date}, ${percent}%): entry ${entryId}`);
      });
    },

    async setStartDate(bookUrl: string, date: string): Promise<void> {
      return withRetry('setStartDate', async () => {
        // The "Started <date>" pencil on the book page links to the read's
        // "Started reading" journal entry; its date IS the start date.
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);
        const entryId = await page.evaluate(() => {
          const link = Array.from(document.querySelectorAll('a[href*="/edit-journal-entry-from-book"]')).find((a) =>
            /Started\s/.test(a.textContent || '')
          );
          return link?.getAttribute('href')?.match(/journal_entry_id=([0-9a-f-]+)/i)?.[1] ?? null;
        });
        if (!entryId) throw new Error('setStartDate: no "Started" date link on the book page');

        const editUrl = `https://app.thestorygraph.com/journal_entries/${entryId}/edit`;
        await page.goto(editUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await handleTurnstile(editUrl);
        const [year, month, day] = date.split('-').map((n) => String(parseInt(n, 10)));
        const result = await page.evaluate(
          async (id: string, d: string, m: string, y: string) => {
            const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
            if (!token) return { ok: false, error: 'no CSRF token' };
            const body = new URLSearchParams({
              _method: 'put',
              authenticity_token: token,
              'journal_entry[day]': d,
              'journal_entry[month]': m,
              'journal_entry[year]': y,
            });
            const res = await fetch(`/journal_entries/${id}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-Token': token,
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: body.toString(),
              credentials: 'include',
            });
            return { ok: res.ok, status: res.status };
          },
          entryId,
          day,
          month,
          year
        );
        logger.info(`setStartDate(${date}) via entry ${entryId}: ${JSON.stringify(result)}`);
        if (!result.ok) throw new Error(`setStartDate failed: ${JSON.stringify(result)}`);
      });
    },

    async setEntryMinutes(entryId: string, date: string, progress: JournalProgress): Promise<void> {
      return withRetry('setEntryMinutes', async () => {
        const url = `https://app.thestorygraph.com/journal_entries/${entryId}/edit`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        await handleTurnstile(url);
        const [year, month, day] = date.split('-').map((n) => String(parseInt(n, 10)));
        const result = await page.evaluate(
          async (id: string, d: string, m: string, y: string, prog: { totalMinutes: number; dayMinutes: number; percent: number | null }) => {
            // A print-edition entry has no minutes fields and StoryGraph silently drops
            // the value (still 200) — fail loudly instead.
            if (!document.querySelector('input[name="journal_entry[minutes_listened_total]"]')) {
              return { ok: false, error: 'entry has no minutes field (shelved edition is not audio)' };
            }
            const token =
              document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
              (document.querySelector('input[name="authenticity_token"]') as HTMLInputElement | null)?.value;
            if (!token) return { ok: false, error: 'no CSRF token' };
            const body = new URLSearchParams({
              _method: 'put',
              authenticity_token: token,
              'journal_entry[day]': d,
              'journal_entry[month]': m,
              'journal_entry[year]': y,
              // The edit endpoint takes plain minute counts (unlike the create form's HH:MM):
              // minutes_listened is that day's listening, _total the running total.
              'journal_entry[minutes_listened_total]': String(prog.totalMinutes),
              'journal_entry[minutes_listened]': String(prog.dayMinutes),
            });
            // StoryGraph doesn't derive the percent for edited entries (shows 0%).
            if (prog.percent != null) body.set('journal_entry[percent_reached]', String(prog.percent));
            try {
              const res = await fetch(`/journal_entries/${id}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'X-CSRF-Token': token,
                  'X-Requested-With': 'XMLHttpRequest',
                  Accept: 'text/html, text/vnd.turbo-stream.html, application/javascript',
                },
                body: body.toString(),
                credentials: 'include',
              });
              return { ok: res.ok, status: res.status };
            } catch (e: any) {
              return { ok: false, error: e.message };
            }
          },
          entryId,
          day,
          month,
          year,
          progress
        );
        logger.info(
          `setEntryMinutes(${entryId} -> ${date}, ${progress.dayMinutes}m day / ${progress.totalMinutes}m total / ${progress.percent}%): ${JSON.stringify(result)}`
        );
        if (!result.ok) throw new Error(`setEntryMinutes failed: ${JSON.stringify(result)}`);
      });
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };

  return serializeMethods(api);
}
