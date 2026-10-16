import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { determineSyncActions, diffDailyProgress, reconcileBook, runSync, type SyncAction } from '../src/sync.js';
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
    await runSync(fakeAbs(true), db, sg, () => {}, (m) => prompted.push(m.title));

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
