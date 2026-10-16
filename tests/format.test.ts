import { describe, it, expect } from 'vitest';
import { escapeMd, formatDayLine, formatBackfillSummary, formatSmokeReport } from '../src/format.js';
import type { SyncResult } from '../src/sync.js';

const write = (date: string, dayMinutes: number, totalMinutes: number, percent: number | undefined): SyncResult => ({
  book: 'Exit Party', action: 'journal_write', success: true, date, dayMinutes, totalMinutes, percent,
});

describe('escapeMd', () => {
  it('escapes Telegram Markdown specials', () => {
    expect(escapeMd('a_b*c`d[e]')).toBe('a\\_b\\*c\\`d\\[e\\]');
  });
});

describe('formatDayLine', () => {
  it('shows the day, minutes that day, running total and percent', () => {
    expect(formatDayLine(write('2026-10-04', 21, 21, 3))).toBe('• Oct 4 — 21 min (total 0:21, 3%)');
    expect(formatDayLine(write('2026-10-15', 85, 716, 95))).toBe('• Oct 15 — 85 min (total 11:56, 95%)');
  });

  it('omits the percent when unknown', () => {
    expect(formatDayLine(write('2026-10-04', 21, 21, undefined))).toBe('• Oct 4 — 21 min (total 0:21)');
  });

  it('marks a corrected day', () => {
    expect(formatDayLine({ ...write('2026-10-05', 103, 124, 17), action: 'journal_fix' }))
      .toBe('• Oct 5 — 103 min (total 2:04, 17%) — corrected');
  });
});

describe('formatBackfillSummary', () => {
  it('lists every written day under the headline', () => {
    const msg = formatBackfillSummary([write('2026-10-04', 21, 21, 3), write('2026-10-05', 103, 124, 17)], 'Exit Party');
    expect(msg).toBe(
      '📚 *Exit Party* — 2 day(s) written\n' +
      '• Oct 4 — 21 min (total 0:21, 3%)\n' +
      '• Oct 5 — 103 min (total 2:04, 17%)'
    );
  });

  it('says up to date when nothing changed', () => {
    expect(formatBackfillSummary([], 'Exit Party')).toBe('📚 *Exit Party* — 0 day(s) written (already up to date)');
  });

  it('adds marked read and failures', () => {
    const msg = formatBackfillSummary(
      [
        write('2026-10-15', 85, 716, 95),
        { book: 'Exit Party', action: 'mark_read', success: true },
        { book: 'Exit Party', action: 'journal_write', success: false, error: '2026-10-16: boom' },
      ],
      'Exit Party'
    );
    expect(msg).toBe(
      '📚 *Exit Party* — 1 day(s) written, marked read\n' +
      '• Oct 15 — 85 min (total 11:56, 95%)\n' +
      '⚠️ 1 failed: 2026-10-16: boom'
    );
  });

  it('caps very long lists', () => {
    const many = Array.from({ length: 65 }, (_, i) => write(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 10, 10 * (i + 1), 1));
    const lines = formatBackfillSummary(many, 'Long').split('\n');
    expect(lines).toHaveLength(1 + 60 + 1);
    expect(lines.at(-1)).toBe('…and 5 more day(s)');
  });
});

describe('formatSmokeReport', () => {
  it('reports a pass', () => {
    expect(formatSmokeReport({ checked: 'Exit Party', problems: [] }))
      .toBe('✅ StoryGraph check passed (search, editions, journal) using *Exit Party*.');
  });

  it('lists each problem', () => {
    expect(formatSmokeReport({ checked: 'Exit Party', problems: ['journal page parsed no entries'] })).toBe(
      '⚠️ *StoryGraph check found problems* using *Exit Party* — the site may have changed:\n• journal page parsed no entries'
    );
  });

  it('mentions a fresh login and handles no book to check', () => {
    expect(formatSmokeReport({ checked: null, problems: [] }, true)).toBe(
      'ℹ️ StoryGraph check skipped: no synced book to check against yet.\n(Logged in to StoryGraph again — the old session had expired.)'
    );
  });
});
