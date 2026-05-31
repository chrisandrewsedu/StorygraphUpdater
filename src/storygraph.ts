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

  const minutesMatch = rowText.match(/(\d+)\s+minutes?\s+listened/i);
  const percentMatch = rowText.match(/(\d+)\s*%/);
  const entryId = editHref?.match(/\/journal_entries\/([0-9a-f-]+)/i)?.[1] ?? null;

  return {
    entryId,
    date,
    minutes: minutesMatch ? parseInt(minutesMatch[1], 10) : null,
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
  /** Read the dated progress (journal) entries currently on StoryGraph for a book. */
  getJournalEntries(bookUrl: string): Promise<StoryGraphJournalEntry[]>;
  /** Create a backdated journal entry (cumulative minutes) for a past date. */
  addBackdatedProgress(bookUrl: string, date: string, minutes: number): Promise<void>;
  /** Set the cumulative minutes (and date) on an existing journal entry via the edit endpoint. */
  setEntryMinutes(entryId: string, date: string, minutes: number): Promise<void>;
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
        // Navigate to the book page first
        logger.info(`StoryGraph getEditions: navigating to ${bookUrl}`);
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);

        // Find and click the "X editions" link
        const editionsLink = await page.$('a[href*="editions"]');
        if (editionsLink) {
          logger.info('StoryGraph getEditions: found editions link, clicking...');
          await editionsLink.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null);
          await sleep(2000);
          await handleTurnstile(page.url());
        } else {
          // Try navigating directly to editions URL
          const editionsUrl = bookUrl.replace(/\/?$/, '/editions');
          logger.info(`StoryGraph getEditions: no editions link found, trying ${editionsUrl}`);
          await page.goto(editionsUrl, { waitUntil: 'networkidle2', timeout: 15000 });
          await handleTurnstile(editionsUrl);
        }

        logger.info(`StoryGraph getEditions: on page ${page.url()}`);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-editions-latest.png'), fullPage: true });

        // Scroll to load all editions
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(1000);
        }

        // Parse editions — the editions page has rich cards with "Format:", "ISBN/UID:", etc.
        const editions = await page.evaluate(() => {
          const results: Array<{title: string; format: string; info: string; bookUrl: string; coverUrl: string; isbn: string | null}> = [];

          // Each edition card contains: cover img, title, author, "Xpages • format • year",
          // and labeled fields like "Format: Audio", "ISBN/UID: ...", "Publisher: ..."
          // Look for "switch to this edition" buttons to identify edition cards
          const switchButtons = document.querySelectorAll('button, a');
          const editionCards = new Set<Element>();

          // Find all cards that contain edition info by looking for "Format:" text
          const allElements = document.querySelectorAll('*');
          for (const el of allElements) {
            const text = el.textContent || '';
            if (text.includes('Format:') && text.includes('Language:') && el.querySelector('img')) {
              editionCards.add(el);
            }
          }

          // If we found edition cards, parse them
          if (editionCards.size > 0) {
            for (const card of editionCards) {
              const cardText = card.textContent || '';

              // Extract Format
              const formatMatch = cardText.match(/Format:\s*([\w\s]+?)(?:\n|$|ISBN)/);
              const format = formatMatch ? formatMatch[1].trim().toLowerCase() : 'unknown';

              // Extract title from bold/heading element
              const titleEl = card.querySelector('h3, h2, .font-bold, [class*="title"]');
              const title = titleEl?.textContent?.trim() || 'Unknown';

              // Extract info line (e.g., "8h 58m • audio • 2017" or "305 pages • hardcover • 2017")
              const infoMatch = cardText.match(/(\d+h?\s*\d*m?|\d+\s*pages)\s*•\s*\w+\s*•\s*\d{4}/);
              const info = infoMatch ? infoMatch[0] : '';

              // Extract book URL from any link in the card
              const linkEl = card.querySelector('a[href*="/books/"]');
              const bookUrl = linkEl?.getAttribute('href') || '';

              // Cover image
              const imgEl = card.querySelector('img');
              const coverUrl = imgEl?.getAttribute('src') || '';

              // Extract publisher
              const pubMatch = cardText.match(/Publisher:\s*(.+?)(?:\n|$)/);
              const publisher = pubMatch ? pubMatch[1].trim() : '';

              // Extract ISBN/UID (may be an ISBN-13/10 or an Amazon ASIN)
              const isbnMatch = cardText.match(/ISBN\/UID:\s*([\w-]+)/);
              const isbn = isbnMatch ? isbnMatch[1].trim() : null;

              const fullInfo = [info, publisher ? `Publisher: ${publisher}` : ''].filter(Boolean).join('\n');

              results.push({ title, format, info: fullInfo, bookUrl, coverUrl, isbn });
            }
          }

          // Fallback: try the simpler .book-title-author-and-series selector
          if (results.length === 0) {
            const bookElements = document.querySelectorAll('.book-title-author-and-series');
            for (const el of bookElements) {
              const linkEl = el.querySelector('a');
              const title = linkEl?.textContent?.trim() || '';
              const bookUrl = linkEl?.getAttribute('href') || '';
              const fullText = el.textContent || '';
              const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
              const info = lines.length > 1 ? lines.slice(1).join(' • ') : '';
              const lowerInfo = info.toLowerCase();
              let format = 'unknown';
              if (lowerInfo.includes('audio')) format = 'audio';
              else if (lowerInfo.includes('digital') || lowerInfo.includes('ebook') || lowerInfo.includes('kindle')) format = 'digital';
              else if (lowerInfo.includes('paperback')) format = 'paperback';
              else if (lowerInfo.includes('hardcover')) format = 'hardcover';

              const card = el.parentElement?.parentElement;
              const imgEl = card?.querySelector('img');
              const coverUrl = imgEl?.getAttribute('src') || '';
              const isbnMatch = fullText.match(/ISBN\/UID:\s*([\w-]+)/);
              const isbn = isbnMatch ? isbnMatch[1].trim() : null;
              results.push({ title, format, info, bookUrl, coverUrl, isbn });
            }
          }

          return results;
        });

        return editions.map((e) => ({
          ...e,
          bookUrl: e.bookUrl.startsWith('/')
            ? `https://app.thestorygraph.com${e.bookUrl}`
            : e.bookUrl,
        }));
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
        logger.info(`StoryGraph rateBook: navigating to ${bookUrl} — rating ${wholeStars}.${fraction}`);
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await handleTurnstile(bookUrl);

        await page.screenshot({ path: path.join(screenshotsDir, 'debug-rate-before.png'), fullPage: false });

        // Step 1: Click the "Write a Review" or rating button to reveal the form
        const clickResult = await page.evaluate(() => {
          // StoryGraph shows a "Write a Review" link or star rating widget on the book page
          const allLinks = Array.from(document.querySelectorAll('a, button'));
          const reviewLink = allLinks.find((el) => {
            const text = el.textContent?.trim().toLowerCase() ?? '';
            const href = (el as HTMLAnchorElement).href ?? '';
            return (
              text.includes('write a review') ||
              text.includes('add review') ||
              text.includes('review this book') ||
              href.includes('book_reviews')
            );
          });
          if (reviewLink) {
            (reviewLink as HTMLElement).click();
            return { clicked: 'review_link', text: reviewLink.textContent?.trim().slice(0, 40) };
          }

          // Fallback: look for the star rating widget (often a row of star SVGs)
          const starWidget = document.querySelector(
            '[class*="star-rating"], [class*="rating"], [data-rating], [aria-label*="rate"]'
          ) as HTMLElement | null;
          if (starWidget) {
            starWidget.click();
            return { clicked: 'star_widget', cls: starWidget.className.slice(0, 40) };
          }

          return { clicked: 'none' };
        });

        logger.info(`rateBook: click result: ${JSON.stringify(clickResult)}`);
        await sleep(1500);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-rate-after-click.png'), fullPage: true });

        // Step 2: Wait for a review form to appear and discover its structure
        const formDiscovery = await page.evaluate(() => {
          const forms = Array.from(document.querySelectorAll('form'));
          const reviewForm = forms.find((f) => {
            const action = f.getAttribute('action') ?? '';
            return action.includes('book_review') || action.includes('review');
          });
          if (!reviewForm) {
            return {
              found: false,
              forms: forms.map((f) => f.getAttribute('action')).filter(Boolean).slice(0, 5),
            };
          }

          const selects = Array.from(reviewForm.querySelectorAll('select')).map((s) => ({
            name: s.name,
            options: Array.from(s.options).map((o) => ({ value: o.value, text: o.text })),
          }));
          const inputs = Array.from(reviewForm.querySelectorAll('input[type!="hidden"]')).map((i) => ({
            name: (i as HTMLInputElement).name,
            type: (i as HTMLInputElement).type,
          }));
          const token = (reviewForm.querySelector('input[name="authenticity_token"]') as HTMLInputElement | null)?.value
            || document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
            || '';
          const bookId = (reviewForm.querySelector('input[name*="book_id"]') as HTMLInputElement | null)?.value ?? '';

          return {
            found: true,
            action: reviewForm.getAttribute('action'),
            method: reviewForm.getAttribute('method'),
            selects,
            inputs,
            token: token.slice(0, 20) + '…',
            bookId,
          };
        });

        logger.info(`rateBook: form discovery: ${JSON.stringify(formDiscovery)}`);

        if (!formDiscovery.found) {
          // Navigate directly to the new-review page as a fallback
          logger.info('rateBook: form not found after click, trying direct navigation to review page');
          // Extract book id from the URL — StoryGraph book URLs: /books/<slug>
          // The review URL is /book_reviews/new?book_id=<slug> or similar
          await page.screenshot({ path: path.join(screenshotsDir, 'fail-rate-no-form.png'), fullPage: true });
          throw new Error('Review form not found on the page. Check fail-rate-no-form.png screenshot.');
        }

        // Step 3: Submit the rating via fetch
        const submitResult = await page.evaluate(
          async (whole: number, frac: number) => {
            const forms = Array.from(document.querySelectorAll('form'));
            const reviewForm = forms.find((f) => {
              const action = f.getAttribute('action') ?? '';
              return action.includes('book_review') || action.includes('review');
            }) as HTMLFormElement | null;
            if (!reviewForm) return { ok: false, error: 'form disappeared' };

            const action = reviewForm.getAttribute('action') ?? '';
            const method = (reviewForm.getAttribute('method') ?? 'post').toUpperCase();

            const token =
              (reviewForm.querySelector('input[name="authenticity_token"]') as HTMLInputElement | null)?.value ||
              document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
              '';

            // Collect all hidden inputs from the form
            const hiddenParams: Record<string, string> = {};
            reviewForm.querySelectorAll('input[type="hidden"]').forEach((inp) => {
              const i = inp as HTMLInputElement;
              if (i.name && i.name !== 'authenticity_token') hiddenParams[i.name] = i.value;
            });

            // Determine the select field names from the form
            const selects = Array.from(reviewForm.querySelectorAll('select'));
            const starSelect = selects.find((s) => s.name.toLowerCase().includes('star') && !s.name.toLowerCase().includes('fraction'));
            const fracSelect = selects.find((s) => s.name.toLowerCase().includes('fraction'));

            const starFieldName = starSelect?.name ?? 'book_review[star_rating]';
            const fracFieldName = fracSelect?.name ?? 'book_review[star_rating_fraction]';

            const body = new URLSearchParams({
              authenticity_token: token,
              ...hiddenParams,
              [starFieldName]: String(whole),
              [fracFieldName]: String(frac),
            });

            try {
              const res = await fetch(action, {
                method,
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'X-CSRF-Token': token,
                  'X-Requested-With': 'XMLHttpRequest',
                  Accept: 'text/javascript, application/javascript, text/html, */*',
                },
                body: body.toString(),
                credentials: 'include',
              });
              const text = await res.text();
              return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
            } catch (e: any) {
              return { ok: false, error: e.message };
            }
          },
          wholeStars,
          fraction
        );

        logger.info(`rateBook: submit result: ${JSON.stringify(submitResult)}`);

        if (!submitResult.ok) {
          await page.screenshot({ path: path.join(screenshotsDir, 'fail-rate-submit.png'), fullPage: true });
          throw new Error(`Rating submission failed: ${JSON.stringify(submitResult)}`);
        }

        await sleep(1000);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-rate-after.png'), fullPage: false });
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
      const editions = await api.getEditions(bookUrl);
      return matchEditionByIdentifier(editions, identifier);
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

        // Anchor on each entry's "Edit" link, then walk up to the smallest ancestor
        // that carries the date — that isolates one entry's row text.
        const rows = await page.evaluate(() => {
          const out: Array<{ rowText: string; editHref: string | null }> = [];
          const links = document.querySelectorAll('a[href*="/journal_entries/"][href*="/edit"]');
          for (const link of links) {
            const editHref = link.getAttribute('href');
            let el: Element | null = link.parentElement;
            let rowText = '';
            for (let depth = 0; depth < 6 && el; depth++) {
              const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (/\b(19|20)\d{2}\b/.test(t) && t.length < 600) {
                rowText = t;
                break;
              }
              el = el.parentElement;
            }
            out.push({ rowText, editHref });
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

    async addBackdatedProgress(bookUrl: string, date: string, minutes: number): Promise<void> {
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
        const target = entries.find((e) => e.date === date && e.entryId);
        if (!target?.entryId) {
          throw new Error(`addBackdatedProgress: created entry for ${date} not found to set minutes`);
        }
        await api.setEntryMinutes(target.entryId, date, minutes);
        logger.info(`addBackdatedProgress(${date}, ${minutes}m): entry ${target.entryId}`);
      });
    },

    async setEntryMinutes(entryId: string, date: string, minutes: number): Promise<void> {
      return withRetry('setEntryMinutes', async () => {
        const url = `https://app.thestorygraph.com/journal_entries/${entryId}/edit`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        await handleTurnstile(url);
        const [year, month, day] = date.split('-').map((n) => String(parseInt(n, 10)));
        const result = await page.evaluate(
          async (id: string, d: string, m: string, y: string, mins: number) => {
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
              // The edit endpoint takes a plain minute count (unlike the create form's HH:MM).
              'journal_entry[minutes_listened_total]': String(mins),
              'journal_entry[minutes_listened]': String(mins),
            });
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
          minutes
        );
        logger.info(`setEntryMinutes(${entryId} -> ${date}, ${minutes}m): ${JSON.stringify(result)}`);
        if (!result.ok) throw new Error(`setEntryMinutes failed: ${JSON.stringify(result)}`);
      });
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };

  return api;
}
