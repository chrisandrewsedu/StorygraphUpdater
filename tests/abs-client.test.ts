import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dayInTimeZone,
  createAbsClient,
  reduceSessionsToDailyProgress,
  type AbsBookProgress,
  type AbsListeningSession,
} from '../src/abs-client.js';

// Build a listening session with only the fields the reducer cares about.
function session(date: string, currentTime: number): AbsListeningSession {
  return {
    id: `s_${date}_${currentTime}`,
    libraryItemId: 'li_1',
    date,
    dayOfWeek: 'Monday',
    timeListening: 0,
    startTime: 0,
    currentTime,
    duration: 36000,
    startedAt: 0,
    updatedAt: 0,
  };
}

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

  it('should expose asin and isbn from item metadata', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        libraryItems: [
          {
            id: 'li_abc123',
            media: {
              metadata: {
                title: 'Catching Fire',
                authorName: 'Suzanne Collins',
                asin: '1338589016',
                isbn: '9781338589016',
              },
              duration: 36000,
              coverPath: null,
            },
            mediaType: 'book',
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ mediaProgress: [] }) });

    const items = await client.getItemsInProgress();
    expect(items[0].asin).toBe('1338589016');
    expect(items[0].isbn).toBe('9781338589016');
  });

  it('should null asin/isbn when metadata omits them', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        libraryItems: [
          {
            id: 'li_x',
            media: { metadata: { title: 'T', authorName: 'A' }, duration: 1, coverPath: null },
            mediaType: 'book',
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ mediaProgress: [] }) });

    const items = await client.getItemsInProgress();
    expect(items[0].asin).toBeNull();
    expect(items[0].isbn).toBeNull();
  });

  describe('getListeningSessions', () => {
    it('pages through all results and filters to the requested item', async () => {
      // Page 0: two pages total, itemsPerPage 2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 3,
          numPages: 2,
          page: 0,
          itemsPerPage: 2,
          sessions: [
            { id: 's1', libraryItemId: 'li_1', date: '2026-05-01', currentTime: 100 },
            { id: 's2', libraryItemId: 'li_OTHER', date: '2026-05-01', currentTime: 50 },
          ],
        }),
      });
      // Page 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 3,
          numPages: 2,
          page: 1,
          itemsPerPage: 2,
          sessions: [{ id: 's3', libraryItemId: 'li_1', date: '2026-05-02', currentTime: 200 }],
        }),
      });

      const sessions = await client.getListeningSessions('li_1');
      expect(sessions.map((s) => s.id)).toEqual(['s1', 's3']);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('reduceSessionsToDailyProgress', () => {
  it('returns empty for no sessions', () => {
    expect(reduceSessionsToDailyProgress([])).toEqual([]);
  });

  it('takes the max currentTime per day and converts to cumulative minutes', () => {
    const daily = reduceSessionsToDailyProgress([
      session('2026-05-01', 600), // 10 min
      session('2026-05-01', 1800), // 30 min (later in the day)
    ]);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({
      date: '2026-05-01',
      cumulativeSeconds: 1800,
      cumulativeMinutes: 30,
      minutesThatDay: 30,
    });
  });

  it('sorts days ascending and computes per-day deltas', () => {
    const daily = reduceSessionsToDailyProgress([
      session('2026-05-03', 5400), // 90 min cumulative
      session('2026-05-01', 1800), // 30 min cumulative
      session('2026-05-02', 3600), // 60 min cumulative
    ]);
    expect(daily.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    expect(daily.map((d) => d.cumulativeMinutes)).toEqual([30, 60, 90]);
    expect(daily.map((d) => d.minutesThatDay)).toEqual([30, 30, 30]);
  });

  it('drops days with no forward progress (zero delta)', () => {
    const daily = reduceSessionsToDailyProgress([
      session('2026-05-01', 1800), // 30 min
      session('2026-05-02', 1800), // still 30 min — no progress
      session('2026-05-03', 3600), // 60 min
    ]);
    expect(daily.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-03']);
    expect(daily.map((d) => d.cumulativeMinutes)).toEqual([30, 60]);
    expect(daily.map((d) => d.minutesThatDay)).toEqual([30, 30]);
  });

  it('computes percent of the book reached from the session duration', () => {
    const daily = reduceSessionsToDailyProgress([
      session('2026-05-01', 1800), // 30 of 600 min = 5%
      session('2026-05-02', 34200), // 570 of 600 min = 95%
    ]);
    expect(daily.map((d) => d.percent)).toEqual([5, 95]);
  });

  it('leaves percent null when ABS reports no duration', () => {
    const daily = reduceSessionsToDailyProgress([{ ...session('2026-05-01', 1800), duration: 0 }]);
    expect(daily[0].percent).toBeNull();
  });

  it("uses the day's last position, not a stray jump to the end earlier that day", () => {
    // Real ABS sessions for 2026-10-20 (Artificial Condition, 12074 s long):
    // the player jumped to the end, then the listener went back to their place.
    const at = (startTime: number, currentTime: number, updatedAt: number) => ({
      ...session('2026-10-20', currentTime),
      id: `s_${updatedAt}`,
      startTime,
      duration: 12074,
      updatedAt,
    });
    const daily = reduceSessionsToDailyProgress([
      at(8828, 9281, 1792555034198),
      at(6262, 8848, 1792526793871),
      at(5395, 6262, 1792522763018),
      at(0, 5395, 1792504160927),
      at(3551, 12074, 1792503945889), // jump to the end
      at(2700, 3551, 1792485678775),
    ]);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ cumulativeSeconds: 9281, cumulativeMinutes: 154, percent: 77 });
  });

  it('clamps a backwards currentTime regression to the prior cumulative', () => {
    const daily = reduceSessionsToDailyProgress([
      session('2026-05-01', 3600), // 60 min
      session('2026-05-02', 1200), // regression to 20 min — clamp, drop
      session('2026-05-03', 4800), // 80 min
    ]);
    expect(daily.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-03']);
    expect(daily.map((d) => d.cumulativeMinutes)).toEqual([60, 80]);
  });
});

describe('ebook items', () => {
  const mockFetch2 = vi.fn();
  beforeEach(() => { vi.stubGlobal('fetch', mockFetch2); mockFetch2.mockReset(); });

  it('reports an ebook-only item with its reading position as the progress', async () => {
    const client = createAbsClient('http://abs.local:13378', 't');
    mockFetch2.mockResolvedValueOnce({ ok: true, json: async () => ({ libraryItems: [{
      id: 'li_eb', mediaType: 'book',
      media: { metadata: { title: 'Ethical Machines', authorName: 'Reid Blackman' }, duration: 0, coverPath: null, numTracks: 0, ebookFormat: 'epub' },
    }] }) });
    mockFetch2.mockResolvedValueOnce({ ok: true, json: async () => ({ mediaProgress: [
      { libraryItemId: 'li_eb', progress: 0, currentTime: 0, duration: 0, isFinished: false, lastUpdate: 1792254365510, ebookProgress: 0.0153 },
    ] }) });
    const [item] = await client.getItemsInProgress();
    expect(item.isEbook).toBe(true);
    expect(item.ebookPercent).toBeCloseTo(1.53, 2);
    expect(item.progressPercent).toBeCloseTo(1.53, 2);
  });

  it('treats an item with audio tracks as an audiobook even if it also has an ebook', async () => {
    const client = createAbsClient('http://abs.local:13378', 't');
    mockFetch2.mockResolvedValueOnce({ ok: true, json: async () => ({ libraryItems: [{
      id: 'li_both', mediaType: 'book',
      media: { metadata: { title: 'Both', authorName: 'A' }, duration: 100, coverPath: null, numTracks: 3, ebookFormat: 'epub' },
    }] }) });
    mockFetch2.mockResolvedValueOnce({ ok: true, json: async () => ({ mediaProgress: [
      { libraryItemId: 'li_both', progress: 0.5, currentTime: 50, duration: 100, isFinished: false, lastUpdate: 1, ebookProgress: 0.1 },
    ] }) });
    const [item] = await client.getItemsInProgress();
    expect(item.isEbook).toBe(false);
    expect(item.progressPercent).toBeCloseTo(50, 0);
  });

  it('getEbookProgress returns the latest position, or null without one', async () => {
    const client = createAbsClient('http://abs.local:13378', 't');
    const me = { ok: true, json: async () => ({ mediaProgress: [
      { libraryItemId: 'li_eb', progress: 0, currentTime: 0, duration: 0, isFinished: false, lastUpdate: 42, ebookProgress: 0.25 },
    ] }) };
    mockFetch2.mockResolvedValueOnce(me);
    expect(await client.getEbookProgress('li_eb')).toEqual({ percent: 25, lastUpdate: 42, isFinished: false });
    mockFetch2.mockResolvedValueOnce(me);
    expect(await client.getEbookProgress('li_other')).toBeNull();
  });
});

describe('dayInTimeZone', () => {
  it('dates a timestamp in the given zone, not UTC', () => {
    const t = Date.parse('2026-10-18T02:30:00Z'); // 22:30 on the 17th in Indiana (EDT)
    expect(dayInTimeZone(t, 'America/Indiana/Indianapolis')).toBe('2026-10-17');
    expect(dayInTimeZone(t, 'UTC')).toBe('2026-10-18');
  });
});
