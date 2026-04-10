import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAbsClient, type AbsBookProgress } from '../src/abs-client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('AbsClient', () => {
  const client = createAbsClient('http://abs.local:13378', 'test-token');

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should fetch items in progress', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        libraryItems: [
          {
            id: 'li_abc123',
            media: {
              metadata: {
                title: 'Project Hail Mary',
                authorName: 'Andy Weir',
              },
              duration: 58800,
              coverPath: '/metadata/items/li_abc123/cover.jpg',
            },
            mediaType: 'book',
          },
        ],
      }),
    });

    // For /api/me call to get progress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        mediaProgress: [
          {
            libraryItemId: 'li_abc123',
            progress: 0.45,
            currentTime: 26460,
            duration: 58800,
            isFinished: false,
            lastUpdate: 1712700000000,
          },
        ],
      }),
    });

    const items = await client.getItemsInProgress();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Project Hail Mary');
    expect(items[0].author).toBe('Andy Weir');
    expect(items[0].progressPercent).toBeCloseTo(45, 0);
    expect(items[0].isFinished).toBe(false);
  });

  it('should throw on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(client.getItemsInProgress()).rejects.toThrow('ABS API error: 401');
  });
});
