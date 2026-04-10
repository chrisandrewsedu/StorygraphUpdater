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
  updateProgress(bookUrl: string, percent: number): Promise<void>;
  markAsReading(bookUrl: string): Promise<void>;
  markAsRead(bookUrl: string): Promise<void>;
  addToTBR(bookUrl: string): Promise<void>;
  getTBRList(username: string): Promise<StoryGraphBook[]>;
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

  return {
    async login(email: string, password: string): Promise<boolean> {
      return withRetry('login', async () => {
        await page.goto('https://app.thestorygraph.com/users/sign_in', {
          waitUntil: 'networkidle2',
        });

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
          // Each search result is a card with: cover image | book-title-author-and-series | buttons
          // We look at the parent card to find the cover image too
          const bookElements = document.querySelectorAll('.book-title-author-and-series');
          return Array.from(bookElements).slice(0, 10).map((el) => {
            const linkEl = el.querySelector('a');
            const title = linkEl?.textContent?.trim() || '';
            const bookUrl = linkEl?.getAttribute('href') || '';

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
          });
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
          const results: Array<{title: string; format: string; info: string; bookUrl: string; coverUrl: string}> = [];

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

              const fullInfo = [info, publisher ? `Publisher: ${publisher}` : ''].filter(Boolean).join('\n');

              results.push({ title, format, info: fullInfo, bookUrl, coverUrl });
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
              results.push({ title, format, info, bookUrl, coverUrl });
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

        // Click the pencil/edit icon next to the progress bar
        // It has title="Edit your progress"
        const editBtn = await page.$('[title="Edit your progress"], [aria-label="Edit your progress"]');
        if (editBtn) {
          logger.info('Found "Edit your progress" button, clicking...');
          await editBtn.click();
          await sleep(2000);
        } else {
          logger.warn('Could not find "Edit your progress" button');
          await page.screenshot({ path: path.join(screenshotsDir, 'fail-progress-no-edit-btn.png'), fullPage: true });
        }

        // Take a screenshot to see what the edit form looks like
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-progress-edit.png'), fullPage: true });

        // Look for a percentage input field
        const percentInput = await page.$('input[type="number"], input[type="range"], input[name*="progress"], input[name*="percent"]');
        if (percentInput) {
          logger.info('Found progress input, setting value...');
          await percentInput.click({ clickCount: 3 }); // Select all existing text
          await percentInput.type(Math.round(percent).toString());
          await sleep(500);
        } else {
          logger.warn('Could not find progress input field');
          await page.screenshot({ path: path.join(screenshotsDir, 'fail-progress-no-input.png'), fullPage: true });
        }

        // Submit the form
        const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) {
          logger.info('Submitting progress update...');
          await submitBtn.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null);
        }

        await page.screenshot({ path: path.join(screenshotsDir, 'debug-progress-after.png'), fullPage: true });
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

        // The book page shows "mark as finished" as an option
        const clicked = await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"]'));
          // Look for "mark as finished" or "finished" button
          const finishedBtn = allEls.find((el) => {
            const text = el.textContent?.trim().toLowerCase() || '';
            return text.includes('mark as') && text.includes('finished');
          });
          if (finishedBtn) {
            (finishedBtn as HTMLElement).click();
            return 'clicked_finished';
          }
          // Fallback: look for "Read" option
          const readBtn = allEls.find((el) => {
            const text = el.textContent?.trim().toLowerCase() || '';
            return text === 'read' || text === 'mark as read';
          });
          if (readBtn) {
            (readBtn as HTMLElement).click();
            return 'clicked_read';
          }
          return 'no_button_found';
        });
        logger.info(`markAsRead: click result: ${clicked}`);

        await sleep(1000);
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-mark-read.png'), fullPage: true });
        logger.info(`Marked as read: ${bookUrl}`);
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

    async close(): Promise<void> {
      await browser.close();
    },
  };
}
