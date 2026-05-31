import { logger } from './logger.js';
import { reduceSessionsToDailyProgress } from './abs-client.js';
import type { AbsBookProgress, AbsClient, AbsDayProgress } from './abs-client.js';
import type { Database, BookMapping } from './db.js';
import type { StoryGraph } from './storygraph.js';

/** Minutes tolerance before an ABS↔StoryGraph day is treated as a mismatch (absorbs rounding). */
const MISMATCH_TOLERANCE_MIN = 1;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

export type SyncAction =
  | { type: 'progress_update'; percent: number }
  | { type: 'mark_read' }
  | { type: 'new_book'; percent: number };

interface CurrentProgress {
  absLibraryItemId: string;
  progressPercent: number;
  isFinished: boolean;
}

interface PreviousState {
  lastProgressPercent: number;
  lastAction?: string;
  lastStatus?: string;
}

export function determineSyncActions(
  current: CurrentProgress,
  previous: PreviousState | null
): SyncAction[] {
  // New book — no previous sync
  if (previous === null) {
    return [{ type: 'new_book', percent: current.progressPercent }];
  }

  // Already marked as read — nothing to do
  if (previous.lastAction === 'mark_read' && previous.lastStatus === 'success') {
    return [];
  }

  // Retry if last sync failed
  if (previous.lastStatus === 'failed') {
    if (current.isFinished || current.progressPercent >= 99) {
      return [{ type: 'mark_read' }];
    }
    return [{ type: 'progress_update', percent: current.progressPercent }];
  }

  // Finished or nearly finished
  if (current.isFinished || current.progressPercent >= 99) {
    return [{ type: 'mark_read' }];
  }

  // Progress changed by > 1%
  if (Math.abs(current.progressPercent - previous.lastProgressPercent) > 1) {
    return [{ type: 'progress_update', percent: current.progressPercent }];
  }

  return [];
}

export interface DailyDiff {
  /** Days present in ABS but not yet on StoryGraph (or locally recorded), ascending. */
  toWrite: { date: string; minutes: number }[];
  /** Days whose StoryGraph value disagrees with ABS (ABS is authoritative). */
  mismatches: { date: string; absMinutes: number; sgMinutes: number }[];
  /** True if any day to write or fix is more than 48h in the past (needs streak recalc). */
  anyOlderThan48h: boolean;
}

/**
 * Reconcile ABS's per-day cumulative listening against what already exists on
 * StoryGraph (journal read) and what we've already written locally. A day counts
 * as "present" if either source has it; otherwise it's queued to write. Present
 * days whose StoryGraph minutes differ from ABS (beyond rounding tolerance) are
 * flagged as mismatches to repair. Pure and deterministic.
 */
export function diffDailyProgress(
  absDaily: AbsDayProgress[],
  existing: { date: string; minutes: number | null }[],
  localWritten: { date: string; minutes: number }[],
  now: Date
): DailyDiff {
  const existingByDate = new Map(existing.map((e) => [e.date, e.minutes]));
  const localDates = new Set(localWritten.map((l) => l.date));

  const toWrite: DailyDiff['toWrite'] = [];
  const mismatches: DailyDiff['mismatches'] = [];

  const sorted = [...absDaily].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sorted) {
    const sgMinutes = existingByDate.get(d.date); // number, null (e.g. "Started reading"), or undefined
    // A day counts as already on StoryGraph only if we recorded it locally, or the
    // journal shows a real minutes value for it. A null-minutes placeholder (the
    // auto "Started reading" entry, or a bad-duration edition that hides the value)
    // must NOT suppress the real write — the local table is the idempotency guard.
    const presentRemote = sgMinutes != null;
    if (!localDates.has(d.date) && !presentRemote) {
      toWrite.push({ date: d.date, minutes: d.cumulativeMinutes });
      continue;
    }
    if (presentRemote && Math.abs(sgMinutes - d.cumulativeMinutes) > MISMATCH_TOLERANCE_MIN) {
      mismatches.push({ date: d.date, absMinutes: d.cumulativeMinutes, sgMinutes });
    }
  }

  const cutoff = now.getTime() - FORTY_EIGHT_HOURS_MS;
  const isOld = (date: string) => Date.parse(`${date}T00:00:00Z`) < cutoff;
  const anyOlderThan48h = toWrite.some((w) => isOld(w.date)) || mismatches.some((m) => isOld(m.date));

  return { toWrite, mismatches, anyOlderThan48h };
}

export interface SyncResult {
  book: string;
  action: string;
  percent?: number;
  success: boolean;
  error?: string;
  screenshotPath?: string;
}

/**
 * Reconcile one linked book's day-by-day listening history onto StoryGraph:
 * write missing days (ascending), repair mismatched days (ABS authoritative),
 * mark read when finished, and recalculate the streak after backdated writes.
 * `daily` is the reduced ABS history; `isFinished` comes from ABS.
 */
export async function reconcileBook(
  storygraph: StoryGraph,
  db: Database,
  mapping: BookMapping,
  daily: AbsDayProgress[],
  isFinished: boolean,
  now: Date
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const url = mapping.storygraphBookUrl;

  const existing = (await storygraph.getJournalEntries(url)).filter(Boolean);
  const existingByDate = new Map(existing.map((e) => [e.date, e]));
  const localWritten = db
    .getJournalEntries(mapping.id)
    .filter((e) => e.status === 'success')
    .map((e) => ({ date: e.entryDate, minutes: e.minutes }));

  const diff = diffDailyProgress(
    daily,
    existing.map((e) => ({ date: e.date, minutes: e.minutes })),
    localWritten,
    now
  );

  let didWrite = false;

  // Promote to currently-reading before any journal write (StoryGraph requires it).
  if (diff.toWrite.length > 0) {
    await storygraph.markAsReading(url);
  }

  for (const w of diff.toWrite) {
    try {
      await storygraph.addBackdatedProgress(url, w.date, w.minutes);
      db.upsertJournalEntry({ bookMappingId: mapping.id, entryDate: w.date, minutes: w.minutes, status: 'success' });
      results.push({ book: mapping.title, action: 'journal_write', percent: undefined, success: true });
      didWrite = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.upsertJournalEntry({ bookMappingId: mapping.id, entryDate: w.date, minutes: w.minutes, status: 'failed' });
      results.push({ book: mapping.title, action: 'journal_write', success: false, error: `${w.date}: ${msg}` });
    }
  }

  for (const m of diff.mismatches) {
    const entryId = existingByDate.get(m.date)?.entryId ?? null;
    if (!entryId) continue; // can't repair without the entry handle
    try {
      // ABS is authoritative: drop the stale entry and recreate it with the right value.
      await storygraph.deleteJournalEntry(entryId);
      await storygraph.addBackdatedProgress(url, m.date, m.absMinutes);
      db.upsertJournalEntry({ bookMappingId: mapping.id, entryDate: m.date, minutes: m.absMinutes, status: 'success' });
      results.push({ book: mapping.title, action: 'journal_fix', success: true });
      didWrite = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ book: mapping.title, action: 'journal_fix', success: false, error: `${m.date}: ${msg}` });
    }
  }

  if (isFinished) {
    try {
      await storygraph.markAsRead(url);
      results.push({ book: mapping.title, action: 'mark_read', success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ book: mapping.title, action: 'mark_read', success: false, error: msg });
    }
  }

  if (didWrite && diff.anyOlderThan48h) {
    await storygraph.recalculateStreak();
  }

  return results;
}

/**
 * Reconcile a single mapping from ABS's full session history. Used both for the
 * one-time backfill after linking and as the per-book step of the nightly run.
 */
export async function backfillMapping(
  absClient: AbsClient,
  db: Database,
  storygraph: StoryGraph,
  mapping: BookMapping,
  isFinished: boolean,
  now: Date = new Date()
): Promise<SyncResult[]> {
  const sessions = await absClient.getListeningSessions(mapping.absLibraryItemId);
  const daily = reduceSessionsToDailyProgress(sessions);
  logger.info(`backfillMapping ${mapping.title}: ${daily.length} listening days from ABS`);
  return reconcileBook(storygraph, db, mapping, daily, isFinished, now);
}

export async function runSync(
  absClient: AbsClient,
  db: Database,
  storygraph: StoryGraph,
  onNewBook: (book: AbsBookProgress) => void,
  onBookFinished: (mapping: { mappingId: number; title: string; storygraphBookUrl: string }) => void
): Promise<SyncResult[]> {
  logger.info('Starting sync...');
  const results: SyncResult[] = [];

  const booksInProgress = await absClient.getItemsInProgress();
  logger.info(`Found ${booksInProgress.length} books in progress`);
  const inProgressIds = new Set(booksInProgress.map((b) => b.absLibraryItemId));

  // --- Pass 1: reconcile each in-progress book's day-by-day history onto StoryGraph ---
  const now = new Date();
  for (const book of booksInProgress) {
    const mapping = db.getBookMappingByAbsId(book.absLibraryItemId);

    // Unlinked book — ask the user to link it (Pass 1 can't sync without a mapping).
    if (!mapping) {
      onNewBook(book);
      results.push({ book: book.title, action: 'new_book_detected', success: true });
      continue;
    }

    try {
      const sessions = await absClient.getListeningSessions(book.absLibraryItemId);
      const daily = reduceSessionsToDailyProgress(sessions);
      const bookResults = await reconcileBook(storygraph, db, mapping, daily, book.isFinished, now);
      results.push(...bookResults);

      // Record a sync_log row so Pass 2 (disappeared-book detection) still has the
      // latest progress percentage to reason about.
      const allOk = bookResults.every((r) => r.success);
      db.logSync({
        bookMappingId: mapping.id,
        progressPercent: book.progressPercent,
        action: book.isFinished ? 'mark_read' : 'reconcile',
        status: allOk ? 'success' : 'failed',
        errorMessage: allOk ? null : bookResults.find((r) => !r.success)?.error ?? 'reconcile error',
      });
      logger.info(`Reconciled ${book.title}: ${bookResults.length} journal action(s)`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const screenshotPath = (err as any)?.screenshotPath;
      db.logSync({
        bookMappingId: mapping.id,
        progressPercent: book.progressPercent,
        action: 'reconcile',
        status: 'failed',
        errorMessage: errorMsg,
      });
      results.push({ book: book.title, action: 'reconcile', success: false, error: errorMsg, screenshotPath });
      logger.error(`Failed to reconcile ${book.title}: ${errorMsg}`);
    }
  }

  // --- Pass 2: detect books that disappeared from ABS — prompt user to finish or DNF ---
  const allMappings = db.getAllBookMappings();
  for (const mapping of allMappings) {
    if (inProgressIds.has(mapping.absLibraryItemId)) continue; // still in progress

    const lastSync = db.getLastSync(mapping.id);

    // Skip if already resolved
    const doneActions = ['mark_read', 'mark_dnf', 'finish_prompted'];
    if (lastSync && doneActions.includes(lastSync.action) && lastSync.status === 'success') continue;

    // Only skip on low progress if we have a record — if lastSync is null the book was
    // linked but finished before a progress sync could run, so we still want to prompt
    if (lastSync && lastSync.progressPercent < 80) continue;

    const lastProgressPct = lastSync?.progressPercent ?? 0;
    logger.info(`${mapping.title} is no longer in ABS (last progress: ${Math.round(lastProgressPct)}%) — prompting user`);

    // Log that we've prompted so we don't re-ask every sync
    db.logSync({
      bookMappingId: mapping.id,
      progressPercent: lastProgressPct,
      action: 'finish_prompted',
      status: 'success',
      errorMessage: null,
    });

    results.push({ book: mapping.title, action: 'finish_prompted', success: true });
    onBookFinished({ mappingId: mapping.id, title: mapping.title, storygraphBookUrl: mapping.storygraphBookUrl });
  }

  logger.info(`Sync complete. ${results.length} actions processed.`);
  return results;
}
