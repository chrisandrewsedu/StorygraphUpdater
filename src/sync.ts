import { logger } from './logger.js';
import type { AbsBookProgress, AbsClient } from './abs-client.js';
import type { Database, BookMapping } from './db.js';
import type { StoryGraph } from './storygraph.js';

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
  if (previous.lastAction === 'mark_read') {
    return [];
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

export interface SyncResult {
  book: string;
  action: string;
  success: boolean;
  error?: string;
  screenshotPath?: string;
}

export async function runSync(
  absClient: AbsClient,
  db: Database,
  storygraph: StoryGraph,
  onNewBook: (book: AbsBookProgress) => void
): Promise<SyncResult[]> {
  logger.info('Starting sync...');
  const results: SyncResult[] = [];

  const booksInProgress = await absClient.getItemsInProgress();
  logger.info(`Found ${booksInProgress.length} books in progress`);

  for (const book of booksInProgress) {
    const mapping = db.getBookMappingByAbsId(book.absLibraryItemId);
    const lastSync = mapping ? db.getLastSync(mapping.id) : null;

    const previous = lastSync
      ? { lastProgressPercent: lastSync.progressPercent, lastAction: lastSync.action }
      : mapping
        ? { lastProgressPercent: 0 }
        : null;

    const actions = determineSyncActions(
      {
        absLibraryItemId: book.absLibraryItemId,
        progressPercent: book.progressPercent,
        isFinished: book.isFinished,
      },
      previous
    );

    for (const action of actions) {
      if (action.type === 'new_book') {
        // Notify via Telegram — user must confirm the StoryGraph mapping
        onNewBook(book);
        results.push({ book: book.title, action: 'new_book_detected', success: true });
        continue;
      }

      if (!mapping) {
        logger.warn(`No mapping for ${book.title} — skipping ${action.type}`);
        continue;
      }

      try {
        if (action.type === 'progress_update') {
          await storygraph.updateProgress(mapping.storygraphBookUrl, action.percent);
        } else if (action.type === 'mark_read') {
          await storygraph.markAsRead(mapping.storygraphBookUrl);
        }

        db.logSync({
          bookMappingId: mapping.id,
          progressPercent: book.progressPercent,
          action: action.type,
          status: 'success',
          errorMessage: null,
        });

        results.push({ book: book.title, action: action.type, success: true });
        logger.info(`Synced ${book.title}: ${action.type}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const screenshotPath = (err as any)?.screenshotPath;

        db.logSync({
          bookMappingId: mapping.id,
          progressPercent: book.progressPercent,
          action: action.type,
          status: 'failed',
          errorMessage: errorMsg,
        });

        results.push({
          book: book.title,
          action: action.type,
          success: false,
          error: errorMsg,
          screenshotPath,
        });
        logger.error(`Failed to sync ${book.title}: ${errorMsg}`);
      }
    }
  }

  logger.info(`Sync complete. ${results.length} actions processed.`);
  return results;
}
