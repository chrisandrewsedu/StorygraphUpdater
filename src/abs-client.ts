import { logger } from './logger.js';

export interface AbsBookProgress {
  absLibraryItemId: string;
  title: string;
  author: string;
  durationSeconds: number;
  progressPercent: number;
  currentTimeSeconds: number;
  isFinished: boolean;
  lastUpdate: number;
  coverPath: string | null;
  asin: string | null;
  isbn: string | null;
  /** ABS metadata language (e.g. "English"), used to disambiguate edition length matches. */
  language?: string | null;
  /** True for an ebook-only item (an ebook file and no audio tracks). */
  isEbook: boolean;
  /** Ebook reading position, 0–100 (0 when the item has no ebook progress). */
  ebookPercent: number;
}

/** The latest ebook reading position ABS has for an item (ABS keeps no per-day history). */
export interface AbsEbookProgress {
  percent: number; // 0–100
  lastUpdate: number; // epoch ms of the last position change
  isFinished: boolean;
}

/** A single Audiobookshelf listening session (from /api/me/listening-sessions). */
export interface AbsListeningSession {
  id: string;
  libraryItemId: string;
  date: string; // 'YYYY-MM-DD' (ABS local day)
  dayOfWeek: string;
  timeListening: number; // seconds listened during this session
  startTime: number; // playback position at session start (sec)
  currentTime: number; // playback position at session update (sec)
  duration: number; // total media duration (sec)
  startedAt: number;
  updatedAt: number;
}

/** Cumulative listening progress reached by the end of a given day. */
export interface AbsDayProgress {
  date: string; // 'YYYY-MM-DD'
  cumulativeSeconds: number; // position at the end of the day (clamped non-decreasing)
  cumulativeMinutes: number; // floor(cumulativeSeconds / 60)
  minutesThatDay: number; // delta vs the previous retained day
  percent: number | null; // % of the book reached by end of day (null if ABS has no duration)
}

interface AbsMediaProgress {
  libraryItemId: string;
  progress: number;
  currentTime: number;
  duration: number;
  isFinished: boolean;
  lastUpdate: number;
  ebookProgress?: number | null;
}

interface AbsLibraryItem {
  id: string;
  mediaType: string;
  media: {
    metadata: {
      title: string;
      authorName: string;
      asin?: string | null;
      isbn?: string | null;
      language?: string | null;
    };
    duration: number;
    coverPath: string | null;
    numTracks?: number;
    ebookFormat?: string | null;
  };
}

interface AbsListeningSessionsResponse {
  total: number;
  numPages: number;
  page: number;
  itemsPerPage: number;
  sessions: AbsListeningSession[];
}

export interface AbsClient {
  getItemsInProgress(): Promise<AbsBookProgress[]>;
  getListeningSessions(libraryItemId: string): Promise<AbsListeningSession[]>;
  /** True if ABS marks this item finished (finished items drop out of items-in-progress). */
  isItemFinished(libraryItemId: string): Promise<boolean>;
  /** The item's latest ebook position, or null if ABS has none. */
  getEbookProgress(libraryItemId: string): Promise<AbsEbookProgress | null>;
}

/**
 * The calendar day ('YYYY-MM-DD') of an epoch-ms timestamp in `timeZone`.
 * Ebook entries are dated with this, in the ABS server's zone, to match the
 * days ABS uses for listening sessions.
 */
export function dayInTimeZone(epochMs: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(epochMs)
  );
}

/**
 * Reduce raw listening sessions into one cumulative-progress point per day,
 * sorted chronologically. Takes the position where each day's last session
 * ended (not the furthest point: a stray seek to the end of the book, then a
 * seek back, would read as 100%), clamps the cumulative series to be
 * monotonically non-decreasing (StoryGraph requires increasing progress), and
 * drops days with no forward progress.
 */
export function reduceSessionsToDailyProgress(
  sessions: AbsListeningSession[]
): AbsDayProgress[] {
  const lastByDate = new Map<string, { updatedAt: number; currentTime: number }>();
  const duration = Math.max(0, ...sessions.map((s) => s.duration || 0));
  for (const s of sessions) {
    const prev = lastByDate.get(s.date);
    const updatedAt = s.updatedAt || 0;
    if (
      !prev ||
      updatedAt > prev.updatedAt ||
      (updatedAt === prev.updatedAt && s.currentTime > prev.currentTime)
    ) {
      lastByDate.set(s.date, { updatedAt, currentTime: s.currentTime });
    }
  }
  const maxByDate = new Map([...lastByDate].map(([date, last]) => [date, last.currentTime]));

  const dates = [...maxByDate.keys()].sort();
  const result: AbsDayProgress[] = [];
  let prevCumulativeMinutes = 0;
  let prevCumulativeSeconds = 0;

  for (const date of dates) {
    const cumulativeSeconds = Math.max(maxByDate.get(date)!, prevCumulativeSeconds);
    const cumulativeMinutes = Math.floor(cumulativeSeconds / 60);
    const minutesThatDay = cumulativeMinutes - prevCumulativeMinutes;
    if (minutesThatDay <= 0) continue; // no forward progress this day
    const percent = duration > 0 ? Math.min(100, Math.round((cumulativeSeconds / duration) * 100)) : null;
    result.push({ date, cumulativeSeconds, cumulativeMinutes, minutesThatDay, percent });
    prevCumulativeMinutes = cumulativeMinutes;
    prevCumulativeSeconds = cumulativeSeconds;
  }

  return result;
}

export function createAbsClient(baseUrl: string, apiToken: string): AbsClient {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  async function apiFetch<T>(endpoint: string): Promise<T> {
    const url = `${baseUrl}${endpoint}`;
    logger.info(`ABS API: GET ${endpoint}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`ABS API error: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    async getItemsInProgress(): Promise<AbsBookProgress[]> {
      // Get library items in progress (has metadata like title, author)
      const itemsRes = await apiFetch<{ libraryItems: AbsLibraryItem[] }>(
        '/api/me/items-in-progress'
      );

      // Get user's media progress (has progress percentages)
      const meRes = await apiFetch<{ mediaProgress: AbsMediaProgress[] }>('/api/me');

      const progressMap = new Map<string, AbsMediaProgress>();
      for (const mp of meRes.mediaProgress) {
        progressMap.set(mp.libraryItemId, mp);
      }

      return itemsRes.libraryItems
        .filter((item) => item.mediaType === 'book')
        .map((item) => {
          const progress = progressMap.get(item.id);
          const isEbook = !item.media.numTracks && !!item.media.ebookFormat;
          const ebookPercent = (progress?.ebookProgress ?? 0) * 100;
          return {
            absLibraryItemId: item.id,
            title: item.media.metadata.title,
            author: item.media.metadata.authorName,
            durationSeconds: item.media.duration,
            // For ebooks the audio `progress` stays 0; report the reading position instead.
            progressPercent: isEbook ? ebookPercent : progress ? progress.progress * 100 : 0,
            currentTimeSeconds: progress?.currentTime ?? 0,
            isFinished: progress?.isFinished ?? false,
            lastUpdate: progress?.lastUpdate ?? 0,
            coverPath: item.media.coverPath,
            asin: item.media.metadata.asin ?? null,
            isbn: item.media.metadata.isbn ?? null,
            language: item.media.metadata.language ?? null,
            isEbook,
            ebookPercent,
          };
        });
    },

    async getListeningSessions(libraryItemId: string): Promise<AbsListeningSession[]> {
      const itemsPerPage = 100;
      const all: AbsListeningSession[] = [];
      let page = 0;
      let numPages = 1;
      do {
        const res = await apiFetch<AbsListeningSessionsResponse>(
          `/api/me/listening-sessions?itemsPerPage=${itemsPerPage}&page=${page}`
        );
        numPages = res.numPages;
        all.push(...res.sessions);
        page++;
      } while (page < numPages);

      // The endpoint is user-global; keep only this book's sessions.
      return all.filter((s) => s.libraryItemId === libraryItemId);
    },

    async isItemFinished(libraryItemId: string): Promise<boolean> {
      const meRes = await apiFetch<{ mediaProgress: AbsMediaProgress[] }>('/api/me');
      return meRes.mediaProgress.some((mp) => mp.libraryItemId === libraryItemId && mp.isFinished);
    },

    async getEbookProgress(libraryItemId: string): Promise<AbsEbookProgress | null> {
      const meRes = await apiFetch<{ mediaProgress: AbsMediaProgress[] }>('/api/me');
      const mp = meRes.mediaProgress.find((m) => m.libraryItemId === libraryItemId);
      if (!mp || (!mp.ebookProgress && !mp.isFinished)) return null;
      return { percent: (mp.ebookProgress ?? 0) * 100, lastUpdate: mp.lastUpdate, isFinished: mp.isFinished };
    },
  };
}
