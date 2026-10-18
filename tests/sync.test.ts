import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { determineSyncActions, diffDailyProgress, reconcileBook, runSync, ensureLoggedIn, runSmokeCheck, linkBook, planEbookEntry, reconcileEbook, type SyncAction } from '../src/sync.js';
import { createDb, type Database } from '../src/db.js';
import type { AbsClient, AbsDayProgress, AbsListeningSession } from '../src/abs-client.js';
import type { StoryGraph, StoryGraphJournalEntry } from '../src/storygraph.js';
import fs from 'fs';
import path from 'path';

function day(date: string, cumulativeMinutes: number, minutesThatDay = 0, percent: number | null = null): AbsDayProgress {
  return { date, cumulativeSeconds: cumulativeMinutes * 60, cumulativeMinutes, minutesThatDay, percent };
}
const NOW = new Date('2026-05-31T12:00:00Z');

describe('determineSyncActions', () => {
  it('should queue progress update when progress changes by > 1%', () => {
    const actions = determineSyncActions(
      { absLibraryItemId: 'li_1', progressPercent: 55, isFinished: false },
      { lastProgressPercent: 45 }
    );
    expect(actions).toEqual([{ type: 'progress_update', percent: 55 }]);
  });

  it('should skip when progress changes by <= 1%', () => {
    const actions = determineSyncActions(
      { absLibraryItemId: 'li_1', progressPercent: 45.5, isFinished: false },
      { lastProgressPercent: 45 }
    );
    expect(actions).toEqual([]);
  });

  it('should queue mark_read when finished', () => {
    const actions = determineSyncActions(
      { absLibraryItemId: 'li_1', progressPercent: 100, isFinished: true },
      { lastProgressPercent: 90 }
    );
    expect(actions).toEqual([{ type: 'mark_read' }]);
  });

  it('should queue mark_read when progress >= 99%', () => {
    const actions = determineSyncActions(
      { absLibraryItemId: 'li_1', progressPercent: 99.5, isFinished: false },
      { lastProgressPercent: 95 }
    );
    expect(actions).toEqual([{ type: 'mark_read' }]);
  });

  it('should not re-mark as read if last action was already mark_read and succeeded', () => {
    const actions = determineSyncActions(
      { absLibraryItemId: 'li_1', progressPercent: 100, isFinished: true },
      { lastProgressPercent: 100, lastAction: 'mark_read', lastStatus: 'success' }
    );
    expect(actions).toEqual([]);
  });

  it('should retry if last sync failed', () => {
    const actions = determineSyncActions(
      { absLibraryItemId: 'li_1', progressPercent: 35, isFinished: false },
      { lastProgressPercent: 35, lastAction: 'progress_update', lastStatus: 'failed' }
    );
    expect(actions).toEqual([{ type: 'progress_update', percent: 35 }]);
  });

  it('should queue new_book when no previous sync exists', () => {
    const actions = determineSyncActions(
      { absLibraryItemId: 'li_1', progressPercent: 5, isFinished: false },
      null
    );
    expect(actions).toEqual([{ type: 'new_book', percent: 5 }]);
  });
});

describe('diffDailyProgress — same-day placeholder', () => {
  it('uses the entry with minutes when a "Started reading" placeholder shares its date', () => {
    const diff = diffDailyProgress(
      [day('2026-05-28', 30)],
      [{ date: '2026-05-28', minutes: 12 }, { date: '2026-05-28', minutes: null }],
      [],
      NOW
    );
    expect(diff.mismatches).toEqual([{ date: '2026-05-28', absMinutes: 30, sgMinutes: 12 }]);
  });
});

describe('diffDailyProgress', () => {
  it('writes every ABS day when nothing exists yet (ascending)', () => {
    const diff = diffDailyProgress(
      [day('2026-05-29', 30), day('2026-05-30', 60)],
      [],
      [],
      NOW
    );
    expect(diff.toWrite).toEqual([
      { date: '2026-05-29', minutes: 30 },
      { date: '2026-05-30', minutes: 60 },
    ]);
    expect(diff.mismatches).toEqual([]);
  });

  it('treats a day present in the StoryGraph journal as already written', () => {
    const diff = diffDailyProgress(
      [day('2026-05-29', 30), day('2026-05-30', 60)],
      [{ date: '2026-05-29', minutes: 30 }],
      [],
      NOW
    );
    expect(diff.toWrite).toEqual([{ date: '2026-05-30', minutes: 60 }]);
  });

  it('treats a day present in the local table as already written', () => {
    const diff = diffDailyProgress(
      [day('2026-05-29', 30), day('2026-05-30', 60)],
      [],
      [{ date: '2026-05-29', minutes: 30 }],
      NOW
    );
    expect(diff.toWrite).toEqual([{ date: '2026-05-30', minutes: 60 }]);
  });

  it('flags a mismatch when StoryGraph value differs from ABS', () => {
    const diff = diffDailyProgress(
      [day('2026-05-29', 30)],
      [{ date: '2026-05-29', minutes: 12 }],
      [],
      NOW
    );
    expect(diff.toWrite).toEqual([]);
    expect(diff.mismatches).toEqual([{ date: '2026-05-29', absMinutes: 30, sgMinutes: 12 }]);
  });

  it('does not flag a mismatch within the 1-minute rounding tolerance', () => {
    const diff = diffDailyProgress(
      [day('2026-05-29', 30)],
      [{ date: '2026-05-29', minutes: 31 }],
      [],
      NOW
    );
    expect(diff.mismatches).toEqual([]);
  });

  it('does not let a null-minutes placeholder (e.g. "Started reading") suppress the real write', () => {
    const diff = diffDailyProgress(
      [day('2026-05-29', 30)],
      [{ date: '2026-05-29', minutes: null }],
      [],
      NOW
    );
    expect(diff.toWrite).toEqual([{ date: '2026-05-29', minutes: 30 }]);
    expect(diff.mismatches).toEqual([]);
  });

  it('suppresses the write once the day is recorded in the local table', () => {
    const diff = diffDailyProgress(
      [day('2026-05-29', 30)],
      [{ date: '2026-05-29', minutes: null }],
      [{ date: '2026-05-29', minutes: 30 }],
      NOW
    );
    expect(diff.toWrite).toEqual([]);
  });

  it('sets anyOlderThan48h when a day to write is more than 48h old', () => {
    const recent = diffDailyProgress([day('2026-05-30', 60)], [], [], NOW); // ~30h ago
    expect(recent.anyOlderThan48h).toBe(false);

    const old = diffDailyProgress([day('2026-05-28', 60)], [], [], NOW); // >48h ago
    expect(old.anyOlderThan48h).toBe(true);
  });
});

// A controllable fake StoryGraph that records calls and serves a scripted journal.
function fakeStoryGraph(journal: StoryGraphJournalEntry[] = []) {
  const calls: any = { markAsReading: [], addBackdatedProgress: [], deleteJournalEntry: [], markAsRead: [], recalculateStreak: 0, setStartDate: [] };
  const sg: Partial<StoryGraph> = {
    async markAsReading(url) { calls.markAsReading.push(url); },
    async setStartDate(url, date) { calls.setStartDate.push(date); },
    async findShelvedEdition() { return null; }, // shelf still on the mapped edition
    async getJournalEntries() { return journal; },
    async addBackdatedProgress(url, date, p) { calls.addBackdatedProgress.push({ date, minutes: p.totalMinutes }); calls.progress = [...(calls.progress ?? []), p]; },
    async deleteJournalEntry(id) { calls.deleteJournalEntry.push(id); },
    async markAsRead(url) { calls.markAsRead.push(url); },
    async recalculateStreak() { calls.recalculateStreak++; },
  };
  return { sg: sg as StoryGraph, calls };
}

describe('reconcileBook', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'reconcile.db');
  let db: Database;
  let mappingId: number;

  beforeEach(() => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(DB_PATH, { force: true });
    db = createDb(DB_PATH);
    db.upsertBookMapping({
      absLibraryItemId: 'li_r', storygraphBookUrl: 'https://app.thestorygraph.com/books/abc',
      title: 'Test', author: 'A', editionType: 'audio',
    });
    mappingId = db.getBookMappingByAbsId('li_r')!.id;
  });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });

  const mapping = () => db.getBookMappingByAbsId('li_r')!;

  it('writes each missing day ascending and records them locally', async () => {
    const { sg, calls } = fakeStoryGraph([]);
    await reconcileBook(sg, db, mapping(), [day('2026-05-28', 30), day('2026-05-29', 60)], false, NOW);

    expect(calls.addBackdatedProgress).toEqual([
      { date: '2026-05-28', minutes: 30 },
      { date: '2026-05-29', minutes: 60 },
    ]);
    expect(calls.markAsReading.length).toBeGreaterThan(0); // promoted before writing
    expect(db.getJournalEntries(mappingId).map((e) => [e.entryDate, e.minutes])).toEqual([
      ['2026-05-28', 30],
      ['2026-05-29', 60],
    ]);
  });

  it('passes per-day minutes and percent from ABS along with the cumulative total', async () => {
    const { sg, calls } = fakeStoryGraph([]);
    const results = await reconcileBook(sg, db, mapping(), [day('2026-05-28', 30, 30, 4), day('2026-05-29', 124, 94, 17)], false, NOW);
    expect(results[1]).toMatchObject({ action: 'journal_write', date: '2026-05-29', dayMinutes: 94, totalMinutes: 124, percent: 17 });
    expect(calls.progress).toEqual([
      { totalMinutes: 30, dayMinutes: 30, percent: 4 },
      { totalMinutes: 124, dayMinutes: 94, percent: 17 },
    ]);
  });

  it('sets the StoryGraph start date to the first ABS listening day on the first backfill only', async () => {
    const { sg, calls } = fakeStoryGraph([]);
    await reconcileBook(sg, db, mapping(), [day('2026-05-28', 30), day('2026-05-29', 60)], false, NOW);
    expect(calls.setStartDate).toEqual(['2026-05-28']);

    const { sg: sg2, calls: calls2 } = fakeStoryGraph([]);
    await reconcileBook(sg2, db, mapping(), [day('2026-05-28', 30), day('2026-05-29', 60), day('2026-05-30', 90)], false, NOW);
    expect(calls2.setStartDate).toEqual([]); // later nightly runs leave the start date alone
  });

  it('is idempotent — a second run writes nothing (local table guards)', async () => {
    const { sg } = fakeStoryGraph([]);
    await reconcileBook(sg, db, mapping(), [day('2026-05-28', 30)], false, NOW);
    const { sg: sg2, calls: calls2 } = fakeStoryGraph([]); // journal read still empty
    await reconcileBook(sg2, db, mapping(), [day('2026-05-28', 30)], false, NOW);
    expect(calls2.addBackdatedProgress).toEqual([]);
  });

  it('repairs a mismatch by deleting the stale entry and recreating it with the ABS value', async () => {
    const { sg, calls } = fakeStoryGraph([{ entryId: 'ENTRY1', date: '2026-05-28', minutes: 12, percent: 5 }]);
    await reconcileBook(sg, db, mapping(), [day('2026-05-28', 30)], false, NOW);
    expect(calls.deleteJournalEntry).toEqual(['ENTRY1']);
    expect(calls.addBackdatedProgress).toEqual([{ date: '2026-05-28', minutes: 30 }]);
  });

  it('marks the book read when ABS reports it finished', async () => {
    const { sg, calls } = fakeStoryGraph([]);
    await reconcileBook(sg, db, mapping(), [day('2026-05-30', 400)], true, NOW);
    expect(calls.markAsRead).toEqual(['https://app.thestorygraph.com/books/abc']);
  });

  it('recalculates the streak once when backdated writes are older than 48h', async () => {
    const { sg, calls } = fakeStoryGraph([]);
    await reconcileBook(sg, db, mapping(), [day('2026-05-20', 30)], false, NOW);
    expect(calls.recalculateStreak).toBe(1);
  });
});

describe('runSync — books that left ABS in-progress', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'runsync.db');
  let db: Database;

  beforeEach(() => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(DB_PATH, { force: true });
    db = createDb(DB_PATH);
    db.upsertBookMapping({
      absLibraryItemId: 'li_done', storygraphBookUrl: 'https://app.thestorygraph.com/books/done',
      title: 'Done Book', author: 'A', editionType: 'audio',
    });
  });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });

  // Last day: 570 of 600 min yesterday, finished (600) today.
  const sessions: AbsListeningSession[] = [
    { id: 's1', libraryItemId: 'li_done', date: '2026-05-29', dayOfWeek: 'Friday', timeListening: 0, startTime: 0, currentTime: 34200, duration: 36000, startedAt: 0, updatedAt: 0 },
    { id: 's2', libraryItemId: 'li_done', date: '2026-05-30', dayOfWeek: 'Saturday', timeListening: 0, startTime: 34200, currentTime: 36000, duration: 36000, startedAt: 0, updatedAt: 0 },
  ];
  const fakeAbs = (finished: boolean): AbsClient => ({
    async getItemsInProgress() { return []; }, // finished books drop out of in-progress
    async getListeningSessions() { return sessions; },
    async isItemFinished() { return finished; },
  });

  it('writes the remaining days and marks the book finished when ABS says it is finished', async () => {
    const { sg, calls } = fakeStoryGraph([]);
    const prompted: string[] = [];
    const autoFinished: string[] = [];
    await runSync(fakeAbs(true), db, sg, () => {}, (m) => prompted.push(m.title), (m) => autoFinished.push(m.title));

    expect(autoFinished).toEqual(['Done Book']); // the bot asks for a star rating
    expect(calls.addBackdatedProgress.map((c: any) => c.date)).toEqual(['2026-05-29', '2026-05-30']);
    expect(calls.markAsRead).toEqual(['https://app.thestorygraph.com/books/done']);
    expect(prompted).toEqual([]); // no "did you finish it?" prompt needed
    const mappingId = db.getBookMappingByAbsId('li_done')!.id;
    expect(db.getLastSync(mappingId)).toMatchObject({ action: 'mark_read', status: 'success' });
  });

  it('does nothing more on the next run once marked finished', async () => {
    await runSync(fakeAbs(true), db, fakeStoryGraph([]).sg, () => {}, () => {});
    const { sg, calls } = fakeStoryGraph([]);
    await runSync(fakeAbs(true), db, sg, () => {}, () => {});
    expect(calls.markAsRead).toEqual([]);
    expect(calls.addBackdatedProgress).toEqual([]);
  });

  it('still asks via the prompt when the book left without being finished', async () => {
    const mappingId = db.getBookMappingByAbsId('li_done')!.id;
    db.logSync({ bookMappingId: mappingId, progressPercent: 90, action: 'reconcile', status: 'success', errorMessage: null });
    const { sg, calls } = fakeStoryGraph([]);
    const prompted: string[] = [];
    await runSync(fakeAbs(false), db, sg, () => {}, (m) => prompted.push(m.title));
    expect(prompted).toEqual(['Done Book']);
    expect(calls.markAsRead).toEqual([]);
  });
});

describe('ensureLoggedIn', () => {
  const fake = (loggedIn: boolean, loginResult: boolean) => {
    const calls = { login: 0 };
    const sg = {
      async isLoggedIn() { return loggedIn; },
      async login() { calls.login++; return loginResult; },
    } as unknown as StoryGraph;
    return { sg, calls };
  };
  const creds = { email: 'a@b.c', password: 'pw' };

  it('does nothing when the session is still active', async () => {
    const { sg, calls } = fake(true, true);
    expect(await ensureLoggedIn(sg, creds)).toEqual({ ok: true, relogged: false });
    expect(calls.login).toBe(0);
  });

  it('logs in again with the saved credentials when the session expired', async () => {
    const { sg, calls } = fake(false, true);
    expect(await ensureLoggedIn(sg, creds)).toEqual({ ok: true, relogged: true });
    expect(calls.login).toBe(1);
  });

  it('reports failure when the login is rejected', async () => {
    const { sg } = fake(false, false);
    expect(await ensureLoggedIn(sg, creds)).toEqual({ ok: false, relogged: false });
  });

  it('does not try to log in without credentials', async () => {
    const { sg, calls } = fake(false, true);
    expect(await ensureLoggedIn(sg, { email: '', password: '' })).toEqual({ ok: false, relogged: false });
    expect(calls.login).toBe(0);
  });
});

describe('reconcileBook — edition switched by hand on StoryGraph', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'edition.db');
  const OLD = 'https://app.thestorygraph.com/books/01d00000-0000-0000-0000-000000000000';
  const NEW = 'https://app.thestorygraph.com/books/0e0e0000-0000-0000-0000-000000000000';
  let db: Database;

  beforeEach(() => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(DB_PATH, { force: true });
    db = createDb(DB_PATH);
    db.upsertBookMapping({ absLibraryItemId: 'li_e', storygraphBookUrl: OLD, title: 'Switched', author: 'A', editionType: 'audio' });
    db.upsertJournalEntry({ bookMappingId: db.getBookMappingByAbsId('li_e')!.id, entryDate: '2026-05-28', minutes: 30, status: 'success' });
  });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });

  // Journal entries follow the shelved edition: the old URL now reads empty.
  function sgWithShelf(shelvedFormat: string) {
    const writes: string[] = [];
    const sg: Partial<StoryGraph> = {
      async getJournalEntries(url) {
        return url === NEW ? [{ entryId: 'e1', date: '2026-05-28', minutes: 30, percent: 5 }] : [];
      },
      async findShelvedEdition() { return '0e0e0000-0000-0000-0000-000000000000'; },
      async getEditionFormat() { return shelvedFormat; },
      async markAsReading() {},
      async setStartDate() {},
      async addBackdatedProgress(url, date) { writes.push(`${url}|${date}`); },
      async recalculateStreak() {},
    };
    return { sg: sg as StoryGraph, writes };
  }

  it('follows the shelf to the new audio edition and keeps syncing there', async () => {
    const { sg, writes } = sgWithShelf('audio');
    const m = db.getBookMappingByAbsId('li_e')!;
    const results = await reconcileBook(sg, db, m, [day('2026-05-28', 30), day('2026-05-29', 60)], false, NOW);
    expect(db.getBookMappingByAbsId('li_e')!.storygraphBookUrl).toBe(NEW);
    expect(results[0]).toMatchObject({ action: 'edition_changed', success: true });
    expect(writes).toEqual([`${NEW}|2026-05-29`]);
  });

  it('stops with a clear error when the shelf moved to a print edition', async () => {
    const { sg, writes } = sgWithShelf('hardcover');
    const m = db.getBookMappingByAbsId('li_e')!;
    const results = await reconcileBook(sg, db, m, [day('2026-05-28', 30), day('2026-05-29', 60)], false, NOW);
    expect(writes).toEqual([]);
    expect(results).toEqual([
      expect.objectContaining({ action: 'edition_changed', success: false, error: expect.stringContaining('hardcover') }),
    ]);
    expect(db.getBookMappingByAbsId('li_e')!.storygraphBookUrl).toBe(OLD); // unchanged until fixed
  });
});

describe('runSmokeCheck', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'smoke.db');
  const URL = 'https://app.thestorygraph.com/books/50e00000-0000-0000-0000-000000000000';
  let db: Database;

  beforeEach(() => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(DB_PATH, { force: true });
    db = createDb(DB_PATH);
    db.upsertBookMapping({ absLibraryItemId: 'li_s', storygraphBookUrl: URL, title: 'Smoke Book', author: 'A', editionType: 'audio' });
    db.upsertJournalEntry({ bookMappingId: db.getBookMappingByAbsId('li_s')!.id, entryDate: '2026-05-28', minutes: 30, status: 'success' });
  });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });

  const healthy: Partial<StoryGraph> = {
    async searchBooks() { return [{ title: 'Smoke Book', author: 'A', bookUrl: URL, editionInfo: '', coverUrl: '' }]; },
    async getEditions() { return [{ title: 'Smoke Book', format: 'audio', info: '', bookUrl: URL, coverUrl: '', isbn: '1' }]; },
    async getJournalEntries() { return [{ entryId: 'e', date: '2026-05-28', minutes: 30, percent: 5 }]; },
  };

  it('reports no problems when every page parses', async () => {
    expect(await runSmokeCheck(healthy as StoryGraph, db)).toEqual({ checked: 'Smoke Book', problems: [] });
  });

  it('flags each part of the site that stopped parsing', async () => {
    const broken = {
      ...healthy,
      async getEditions() { return []; },
      async getJournalEntries() { return [{ entryId: 'e', date: '2026-05-28', minutes: null, percent: null }]; },
    } as StoryGraph;
    const { problems } = await runSmokeCheck(broken, db);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toMatch(/editions/);
    expect(problems.join(' ')).toMatch(/minutes/);
  });

  it('reports a thrown error as a problem instead of crashing', async () => {
    const throwing = { ...healthy, async searchBooks() { throw new Error('timeout'); } } as StoryGraph;
    const { problems } = await runSmokeCheck(throwing, db);
    expect(problems).toEqual([expect.stringContaining('timeout')]);
  });
});

describe('linkBook', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'link.db');
  const PRINT = 'https://app.thestorygraph.com/books/aaaa0000-0000-0000-0000-000000000000';
  const AUDIO = 'https://app.thestorygraph.com/books/bbbb0000-0000-0000-0000-000000000000';
  let db: Database;
  beforeEach(() => { fs.mkdirSync(DIR, { recursive: true }); fs.rmSync(DB_PATH, { force: true }); db = createDb(DB_PATH); });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });

  const absBook = { absLibraryItemId: 'li_l', title: 'Big Book', author: 'A', durationSeconds: 1, progressPercent: 1,
    currentTimeSeconds: 1, isFinished: false, lastUpdate: 0, coverPath: '', asin: 'B0AUDIO', isbn: '9781111111111' };

  it('finds the audio edition with the ISBN search, even when it is not in the first page of editions', async () => {
    const calls = { getEditions: 0, switched: [] as string[], searched: [] as string[] };
    const sg: Partial<StoryGraph> = {
      async findEditionByIdentifier(_url, id) {
        calls.searched.push(id);
        return id === '9781111111111' ? { title: 'Big Book', format: 'audio', info: '', bookUrl: AUDIO, coverUrl: '', isbn: id } : null;
      },
      async getEditions() { calls.getEditions++; return [{ title: 'Big Book', format: 'hardcover', info: '', bookUrl: PRINT, coverUrl: '', isbn: '1' }]; },
      async switchToEdition(url) { calls.switched.push(url); },
      async markAsReading() {},
    };
    const m = await linkBook(db, sg as StoryGraph, 'li_l', absBook, PRINT);
    expect(m.storygraphBookUrl).toBe(AUDIO);
    expect(calls.searched).toEqual(['B0AUDIO', '9781111111111']); // ASIN first, then ISBN
    expect(calls.getEditions).toBe(0);
    expect(calls.switched).toEqual([AUDIO]);
  });

  it('matches by audiobook length when StoryGraph lists none of the IDs, and says so', async () => {
    const sg: Partial<StoryGraph> = {
      async findEditionByIdentifier() { return null; },
      async getEditions() {
        return [
          { title: 'Big Book', format: 'hardcover', info: '300 pages • hardcover • 2018', bookUrl: PRINT, coverUrl: '', isbn: '1' },
          { title: 'Big Book', format: 'audio', info: '2h 45m • audio • 2018\nLanguage: English', bookUrl: 'https://app.thestorygraph.com/books/cccc0000-0000-0000-0000-000000000000', coverUrl: '', isbn: '2' },
          { title: 'Big Book', format: 'audio', info: '3h 21m • audio • 2018\nLanguage: English', bookUrl: AUDIO, coverUrl: '', isbn: '3' },
        ];
      },
      async switchToEdition() {},
      async markAsReading() {},
    };
    const m = await linkBook(db, sg as StoryGraph, 'li_l', { ...absBook, durationSeconds: 12074 }, PRINT);
    expect(m.storygraphBookUrl).toBe(AUDIO);
    expect(m.matchReason).toBe('duration');
  });

  it('falls back to scanning the editions list when the ISBN search finds no audio edition', async () => {
    const sg: Partial<StoryGraph> = {
      async findEditionByIdentifier() { return null; },
      async getEditions() {
        return [
          { title: 'Big Book', format: 'hardcover', info: '', bookUrl: PRINT, coverUrl: '', isbn: '1' },
          { title: 'Big Book', format: 'audio', info: '', bookUrl: AUDIO, coverUrl: '', isbn: '2' },
        ];
      },
      async switchToEdition() {},
      async markAsReading() {},
    };
    const m = await linkBook(db, sg as StoryGraph, 'li_l', absBook, PRINT);
    expect(m.storygraphBookUrl).toBe(AUDIO);
  });
});

describe('planEbookEntry', () => {
  it('writes the floored percent when it moved past everything recorded', () => {
    expect(planEbookEntry({ date: '2026-10-17', percent: 1.53 }, [])).toEqual({ type: 'write', date: '2026-10-17', percent: 1, replace: false });
    expect(planEbookEntry({ date: '2026-10-18', percent: 9.9 }, [{ date: '2026-10-17', percent: 1 }]))
      .toEqual({ type: 'write', date: '2026-10-18', percent: 9, replace: false });
  });

  it('skips below 1% and when there is no forward progress', () => {
    expect(planEbookEntry({ date: '2026-10-17', percent: 0.6 }, [])).toEqual({ type: 'none' });
    expect(planEbookEntry({ date: '2026-10-18', percent: 9.2 }, [{ date: '2026-10-17', percent: 9 }])).toEqual({ type: 'none' });
    expect(planEbookEntry({ date: '2026-10-18', percent: 5 }, [{ date: '2026-10-17', percent: 9 }])).toEqual({ type: 'none' });
    expect(planEbookEntry(null, [])).toEqual({ type: 'none' });
  });

  it('replaces the day when more was read later the same day', () => {
    expect(planEbookEntry({ date: '2026-10-17', percent: 4 }, [{ date: '2026-10-17', percent: 2 }]))
      .toEqual({ type: 'write', date: '2026-10-17', percent: 4, replace: true });
  });
});

describe('reconcileEbook', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'ebook.db');
  const URL = 'https://app.thestorygraph.com/books/dddd0000-0000-0000-0000-000000000000';
  let db: Database;
  beforeEach(() => {
    fs.mkdirSync(DIR, { recursive: true }); fs.rmSync(DB_PATH, { force: true }); db = createDb(DB_PATH);
    db.upsertBookMapping({ absLibraryItemId: 'li_eb', storygraphBookUrl: URL, title: 'Ethical Machines', author: 'R', editionType: 'digital' });
  });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });
  const mapping = () => db.getBookMappingByAbsId('li_eb')!;

  function fakeEbookSg(journal: StoryGraphJournalEntry[] = [], failWrite = false) {
    const calls: any = { markAsReading: 0, setStartDate: [], percent: [], deleted: [], markAsRead: 0 };
    const sg: Partial<StoryGraph> = {
      async markAsReading() { calls.markAsReading++; },
      async setStartDate(_u, d) { calls.setStartDate.push(d); },
      async getJournalEntries() { return journal; },
      async deleteJournalEntry(id) { calls.deleted.push(id); },
      async addPercentProgress(_u, date, pct) { if (failWrite) throw new Error('boom'); calls.percent.push([date, pct]); },
      async markAsRead() { calls.markAsRead++; },
    };
    return { sg: sg as StoryGraph, calls };
  }

  it('writes the first entry, moves the start date, and records it locally', async () => {
    const { sg, calls } = fakeEbookSg();
    const results = await reconcileEbook(sg, db, mapping(), { date: '2026-10-17', percent: 1.53 }, false);
    expect(calls.percent).toEqual([['2026-10-17', 1]]);
    expect(calls.markAsReading).toBe(1);
    expect(calls.setStartDate).toEqual(['2026-10-17']);
    expect(results).toEqual([{ book: 'Ethical Machines', action: 'journal_write', success: true, date: '2026-10-17', percent: 1, ebook: true }]);
    expect(db.getJournalEntries(mapping().id).map((e) => [e.entryDate, e.percent])).toEqual([['2026-10-17', 1]]);
  });

  it('is idempotent and leaves the start date alone later', async () => {
    await reconcileEbook(fakeEbookSg().sg, db, mapping(), { date: '2026-10-17', percent: 1.5 }, false);
    const again = fakeEbookSg();
    await reconcileEbook(again.sg, db, mapping(), { date: '2026-10-17', percent: 1.5 }, false);
    expect(again.calls.percent).toEqual([]);
    const next = fakeEbookSg();
    await reconcileEbook(next.sg, db, mapping(), { date: '2026-10-18', percent: 6 }, false);
    expect(next.calls.percent).toEqual([['2026-10-18', 6]]);
    expect(next.calls.setStartDate).toEqual([]);
  });

  it('replaces the same-day entry on StoryGraph when more was read that day', async () => {
    await reconcileEbook(fakeEbookSg().sg, db, mapping(), { date: '2026-10-17', percent: 2 }, false);
    const { sg, calls } = fakeEbookSg([
      { entryId: 'START', date: '2026-10-17', minutes: null, percent: null },
      { entryId: 'E1', date: '2026-10-17', minutes: null, percent: 2 },
    ]);
    const results = await reconcileEbook(sg, db, mapping(), { date: '2026-10-17', percent: 5 }, false);
    expect(calls.deleted).toEqual(['E1']);
    expect(calls.percent).toEqual([['2026-10-17', 5]]);
    expect(results[0]).toMatchObject({ action: 'journal_fix', percent: 5 });
  });

  it('does not record a failed write, so the next sync retries it', async () => {
    const results = await reconcileEbook(fakeEbookSg([], true).sg, db, mapping(), { date: '2026-10-17', percent: 3 }, false);
    expect(results[0]).toMatchObject({ success: false });
    expect(db.getJournalEntries(mapping().id)).toEqual([]);
  });

  it('marks the book read when ABS says it is finished', async () => {
    const { sg, calls } = fakeEbookSg();
    await reconcileEbook(sg, db, mapping(), { date: '2026-10-20', percent: 100 }, true);
    expect(calls.percent).toEqual([['2026-10-20', 100]]);
    expect(calls.markAsRead).toBe(1);
  });
});

describe('runSync — ebook mapping', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'runsync-ebook.db');
  let db: Database;
  beforeEach(() => {
    fs.mkdirSync(DIR, { recursive: true }); fs.rmSync(DB_PATH, { force: true }); db = createDb(DB_PATH);
    db.upsertBookMapping({ absLibraryItemId: 'li_eb', storygraphBookUrl: 'https://app.thestorygraph.com/books/eb', title: 'Ethical Machines', author: 'R', editionType: 'digital' });
  });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });

  it('writes the ebook position instead of reading listening sessions', async () => {
    let sessionsRead = 0;
    const abs: AbsClient = {
      async getItemsInProgress() {
        return [{ absLibraryItemId: 'li_eb', title: 'Ethical Machines', author: 'R', durationSeconds: 0, progressPercent: 12.4,
          currentTimeSeconds: 0, isFinished: false, lastUpdate: Date.parse('2026-10-17T16:26:05Z'), coverPath: null,
          asin: null, isbn: null, isEbook: true, ebookPercent: 12.4 }];
      },
      async getListeningSessions() { sessionsRead++; return []; },
      async isItemFinished() { return false; },
      async getEbookProgress() { return null; },
    };
    const percent: any[] = [];
    const sg = { async markAsReading() {}, async setStartDate() {}, async addPercentProgress(_u: string, d: string, p: number) { percent.push([d, p]); } } as unknown as StoryGraph;
    await runSync(abs, db, sg, () => {}, () => {});
    expect(sessionsRead).toBe(0);
    expect(percent).toEqual([['2026-10-17', 12]]); // ABS_TIMEZONE unset in tests → UTC day
    expect(db.getLastSync(db.getBookMappingByAbsId('li_eb')!.id)).toMatchObject({ progressPercent: 12.4, status: 'success' });
  });
});

describe('linkBook — ebook', () => {
  const DIR = path.resolve('./data/test');
  const DB_PATH = path.join(DIR, 'link-ebook.db');
  const PRINT = 'https://app.thestorygraph.com/books/aaaa0000-0000-0000-0000-000000000000';
  const AUDIO = 'https://app.thestorygraph.com/books/bbbb0000-0000-0000-0000-000000000000';
  const DIGITAL = 'https://app.thestorygraph.com/books/cccc0000-0000-0000-0000-000000000000';
  let db: Database;
  beforeEach(() => { fs.mkdirSync(DIR, { recursive: true }); fs.rmSync(DB_PATH, { force: true }); db = createDb(DB_PATH); });
  afterEach(() => { db.close(); fs.rmSync(DB_PATH, { force: true }); });

  it('links an ABS ebook to the digital edition and saves it as digital', async () => {
    const switched: string[] = [];
    const sg: Partial<StoryGraph> = {
      async findEditionByIdentifier() { return null; },
      async getEditions() {
        return [
          { title: 'EM', format: 'hardcover', info: '', bookUrl: PRINT, coverUrl: '', isbn: '9781647822811' },
          { title: 'EM', format: 'audio', info: '', bookUrl: AUDIO, coverUrl: '', isbn: '9798212281089' },
          { title: 'EM', format: 'digital', info: '', bookUrl: DIGITAL, coverUrl: '', isbn: null },
        ];
      },
      async switchToEdition(url) { switched.push(url); },
      async markAsReading() {},
    };
    const absBook = { absLibraryItemId: 'li_eb', title: 'Ethical Machines', author: 'R', durationSeconds: 0, progressPercent: 1.5,
      currentTimeSeconds: 0, isFinished: false, lastUpdate: 0, coverPath: null, asin: null, isbn: null, isEbook: true, ebookPercent: 1.5 };
    const m = await linkBook(db, sg as StoryGraph, 'li_eb', absBook, PRINT);
    expect(m.storygraphBookUrl).toBe(DIGITAL);
    expect(m.editionType).toBe('digital');
    expect(switched).toEqual([DIGITAL]);
  });
});
