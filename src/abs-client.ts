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
  cumulativeSeconds: number; // furthest position reached by end of day
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
    };
    duration: number;
    coverPath: string | null;
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
}

/**
 * Reduce raw listening sessions into one cumulative-progress point per day,
 * sorted chronologically. Takes the furthest position reached on each day,
 * clamps the cumulative series to be monotonically non-decreasing (StoryGraph
 * requires increasing progress), and drops days with no forward progress.
 */
export function reduceSessionsToDailyProgress(
  sessions: AbsListeningSession[]
): AbsDayProgress[] {
  const maxByDate = new Map<string, number>();
  const duration = Math.max(0, ...sessions.map((s) => s.duration || 0));
  for (const s of sessions) {
    const prev = maxByDate.get(s.date) ?? 0;
    if (s.currentTime > prev) maxByDate.set(s.date, s.currentTime);
  }

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
          return {
            absLibraryItemId: item.id,
            title: item.media.metadata.title,
            author: item.media.metadata.authorName,
            durationSeconds: item.media.duration,
            progressPercent: progress ? progress.progress * 100 : 0,
            currentTimeSeconds: progress?.currentTime ?? 0,
            isFinished: progress?.isFinished ?? false,
            lastUpdate: progress?.lastUpdate ?? 0,
            coverPath: item.media.coverPath,
            asin: item.media.metadata.asin ?? null,
            isbn: item.media.metadata.isbn ?? null,
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
  };
}
