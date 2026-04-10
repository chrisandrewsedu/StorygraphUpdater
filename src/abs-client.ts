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
    };
    duration: number;
    coverPath: string | null;
  };
}

export interface AbsClient {
  getItemsInProgress(): Promise<AbsBookProgress[]>;
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
          };
        });
    },
  };
}
