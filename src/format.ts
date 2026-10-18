import type { SyncResult } from './sync.js';

/** Escape Telegram (legacy) Markdown special characters in user-facing text. */
export function escapeMd(text: string): string {
  return text.replace(/([_*`\[\]])/g, '\\$1');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_DAY_LINES = 60; // keeps a long backfill well under Telegram's 4096-char limit

/** One journal day as "• Oct 4 — 21 min (total 0:21, 3%)". */
export function formatDayLine(r: SyncResult): string {
  const [, m, d] = (r.date ?? '').split('-').map((n) => parseInt(n, 10));
  const day = r.date ? `${MONTHS[m - 1]} ${d}` : '?';
  const fixed = r.action === 'journal_fix' ? ' — corrected' : '';
  if (r.ebook) return `• ${day} — read to ${Math.round(r.percent ?? 0)}%${fixed}`;
  const total = r.totalMinutes ?? 0;
  const totalStr = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  const pct = r.percent != null ? `, ${Math.round(r.percent)}%` : '';
  return `• ${day} — ${r.dayMinutes ?? 0} min (total ${totalStr}${pct})${fixed}`;
}

/** Telegram message for a /link or /backfill run: headline plus one line per day written. */
export function formatBackfillSummary(results: SyncResult[], title: string): string {
  const days = results.filter((r) => (r.action === 'journal_write' || r.action === 'journal_fix') && r.success);
  const writes = days.filter((r) => r.action === 'journal_write').length;
  const fixes = days.length - writes;
  const read = results.some((r) => r.action === 'mark_read' && r.success);
  const fails = results.filter((r) => !r.success);

  let head = `📚 *${escapeMd(title)}* — ${writes} day(s) written`;
  if (fixes) head += `, ${fixes} corrected`;
  if (read) head += `, marked read`;
  if (!days.length && !read && !fails.length) head += ` (already up to date)`;

  const lines = [head, ...days.slice(0, MAX_DAY_LINES).map(formatDayLine)];
  if (days.length > MAX_DAY_LINES) lines.push(`…and ${days.length - MAX_DAY_LINES} more day(s)`);
  if (fails.length) lines.push(`⚠️ ${fails.length} failed: ${escapeMd(fails.slice(0, 3).map((f) => f.error ?? '').join('; '))}`);
  return lines.join('\n');
}

/** Telegram message for the read-only StoryGraph check (weekly cron and /check). */
export function formatSmokeReport(report: { checked: string | null; problems: string[] }, relogged = false): string {
  const login = relogged ? '\n(Logged in to StoryGraph again — the old session had expired.)' : '';
  if (!report.checked) return `ℹ️ StoryGraph check skipped: no synced book to check against yet.${login}`;
  if (!report.problems.length) {
    return `✅ StoryGraph check passed (search, editions, journal) using *${escapeMd(report.checked)}*.${login}`;
  }
  return [
    `⚠️ *StoryGraph check found problems* using *${escapeMd(report.checked)}* — the site may have changed:`,
    ...report.problems.map((p) => `• ${escapeMd(p)}`),
  ].join('\n') + login;
}

/** Minutes as "3h 21m" (or "45m"). */
export function formatLength(minutes: number): string {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** An edition's length compared with the ABS audiobook, for the edition picker. */
export function formatLengthDiff(editionMinutes: number, absMinutes: number): string {
  const diff = Math.round(editionMinutes - absMinutes);
  if (Math.abs(diff) <= 2) return 'same length as yours';
  return `${Math.abs(diff)} min ${diff > 0 ? 'longer' : 'shorter'} than yours`;
}

/** Why /link chose an edition, so a wrong pick is easy to spot in Telegram. */
export function formatMatchReason(reason: string, absMinutes?: number | null): string {
  switch (reason) {
    case 'id': return 'matched by ISBN/ASIN';
    case 'duration': return `matched by length${absMinutes ? ` (${formatLength(absMinutes)})` : ''}`;
    case 'chosen': return 'the edition you picked';
    case 'only': return 'the only matching edition';
    default: return '⚠️ no confident edition match — please check it';
  }
}
