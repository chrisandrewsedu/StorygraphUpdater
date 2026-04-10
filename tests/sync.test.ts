import { describe, it, expect } from 'vitest';
import { determineSyncActions, type SyncAction } from '../src/sync.js';

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
