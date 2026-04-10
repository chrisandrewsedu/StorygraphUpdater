import puppeteer, { type Browser, type Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';

export interface StoryGraphSearchResult {
  title: string;
  author: string;
  bookUrl: string;
  editionInfo: string;
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
        return !page.url().includes('/sign_in');
      } catch {
        return false;
      }
    },

    async searchBooks(query: string): Promise<StoryGraphSearchResult[]> {
      return withRetry('search', async () => {
        const searchUrl = `https://app.thestorygraph.com/browse?search_term=${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });

        // Wait for results to load
        await page.waitForSelector('.book-title-author-and-series', { timeout: 10000 }).catch(() => null);

        const results = await page.evaluate(() => {
          const bookElements = document.querySelectorAll('.book-title-author-and-series');
          return Array.from(bookElements).slice(0, 10).map((el) => {
            const linkEl = el.querySelector('a');
            const titleEl = el.querySelector('a');
            const parentCard = el.closest('[class*="book-pane"]') || el.parentElement;
            const editionEl = parentCard?.querySelector('.text-sm.text-darkestGrey, .text-sm.font-light');

            return {
              title: titleEl?.textContent?.trim() || '',
              author: '',
              bookUrl: linkEl?.getAttribute('href') || '',
              editionInfo: editionEl?.textContent?.trim() || '',
            };
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

    async updateProgress(bookUrl: string, percent: number): Promise<void> {
      return withRetry('updateProgress', async () => {
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });

        const progressBtn = await page.$('[data-action*="progress"], button:has-text("Update progress"), a:has-text("Update progress")');
        if (progressBtn) {
          await progressBtn.click();
          await sleep(1000);
        }

        const percentInput = await page.$('input[type="number"], input[name*="progress"], input[name*="percent"]');
        if (percentInput) {
          await percentInput.click({ clickCount: 3 });
          await percentInput.type(Math.round(percent).toString());
        }

        const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null);
        }

        logger.info(`Updated progress for ${bookUrl} to ${percent}%`);
      });
    },

    async markAsReading(bookUrl: string): Promise<void> {
      return withRetry('markAsReading', async () => {
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });

        const statusBtn = await page.waitForSelector(
          'button:has-text("currently reading"), button:has-text("Currently Reading"), [data-action*="reading"]',
          { timeout: 5000 }
        ).catch(() => null);

        if (statusBtn) {
          await statusBtn.click();
          await sleep(1000);
        } else {
          const dropdownTrigger = await page.$('[data-action*="dropdown"], .dropdown-trigger, button[aria-haspopup]');
          if (dropdownTrigger) {
            await dropdownTrigger.click();
            await sleep(500);
            const readingOption = await page.waitForSelector(
              'a:has-text("Currently Reading"), button:has-text("Currently Reading"), [data-value="currently-reading"]',
              { timeout: 5000 }
            );
            await readingOption?.click();
          }
        }

        await sleep(1000);
        logger.info(`Marked as currently reading: ${bookUrl}`);
      });
    },

    async markAsRead(bookUrl: string): Promise<void> {
      return withRetry('markAsRead', async () => {
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });

        const dropdownTrigger = await page.$('[data-action*="dropdown"], .dropdown-trigger, button[aria-haspopup]');
        if (dropdownTrigger) {
          await dropdownTrigger.click();
          await sleep(500);
        }

        const readOption = await page.waitForSelector(
          'a:has-text("Read"), button:has-text("Read"), [data-value="read"]',
          { timeout: 5000 }
        ).catch(() => null);

        if (readOption) {
          await readOption.click();
          await sleep(1000);
        }

        logger.info(`Marked as read: ${bookUrl}`);
      });
    },

    async addToTBR(bookUrl: string): Promise<void> {
      return withRetry('addToTBR', async () => {
        await page.goto(bookUrl, { waitUntil: 'networkidle2', timeout: 15000 });

        const tbrBtn = await page.waitForSelector(
          'button:has-text("Want to Read"), button:has-text("want to read"), a:has-text("Want to Read")',
          { timeout: 5000 }
        ).catch(() => null);

        if (tbrBtn) {
          await tbrBtn.click();
          await sleep(1000);
        }

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
