import { describe, it, expect } from 'vitest';
import {
  normalizeIdentifier,
  matchEditionByIdentifier,
  parseJournalEntryRow,
  bookIdFromUrl,
  normalizeTitle,
  matchShelfByTitle,
  type StoryGraphEdition,
  type StoryGraphBook,
} from '../src/storygraph.js';

function edition(partial: Partial<StoryGraphEdition>): StoryGraphEdition {
  return {
    title: 'T',
    format: 'audio',
    info: '',
    bookUrl: 'https://app.thestorygraph.com/books/x',
    coverUrl: '',
    isbn: null,
    ...partial,
  };
}

describe('normalizeIdentifier', () => {
  it('strips hyphens and spaces and uppercases', () => {
    expect(normalizeIdentifier('978-1-338-58901-6')).toBe('9781338589016');
    expect(normalizeIdentifier(' b00abcdef ')).toBe('B00ABCDEF');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeIdentifier(null)).toBe('');
    expect(normalizeIdentifier(undefined)).toBe('');
  });
});

describe('matchEditionByIdentifier', () => {
  const editions = [
    edition({ format: 'hardcover', isbn: '9781338589016' }),
    edition({ format: 'audio', isbn: 'B00AUDIO01', bookUrl: 'https://app.thestorygraph.com/books/audio' }),
  ];

  it('matches an edition by identifier ignoring formatting', () => {
    const match = matchEditionByIdentifier(editions, '978-1-338-58901-6');
    expect(match?.format).toBe('hardcover');
  });

  it('matches an ASIN-style identifier', () => {
    const match = matchEditionByIdentifier(editions, 'b00audio01');
    expect(match?.bookUrl).toBe('https://app.thestorygraph.com/books/audio');
  });

  it('returns null when no edition matches', () => {
    expect(matchEditionByIdentifier(editions, '0000000000')).toBeNull();
  });

  it('returns null for an empty identifier', () => {
    expect(matchEditionByIdentifier(editions, '')).toBeNull();
    expect(matchEditionByIdentifier(editions, null)).toBeNull();
  });
});

describe('bookIdFromUrl', () => {
  it('extracts the UUID from a StoryGraph book URL', () => {
    expect(bookIdFromUrl('https://app.thestorygraph.com/books/b17121a1-e1d2-4d21-b678-3d2906d205a8'))
      .toBe('b17121a1-e1d2-4d21-b678-3d2906d205a8');
  });
  it('returns null when no book id is present', () => {
    expect(bookIdFromUrl('https://app.thestorygraph.com/journal')).toBeNull();
  });
});

describe('parseJournalEntryRow', () => {
  const EDIT = '/journal_entries/7f33aa6a-74bc-4331-bcfa-85b3902142d4/edit?return_to=%2Fjournal';

  it('parses an audiobook progress row (date + minutes + percent + entry id)', () => {
    const row = parseJournalEntryRow('16 April 2026 Edit 16% 64 minutes listened (01:04 out of 06:41)', EDIT);
    expect(row).toEqual({
      entryId: '7f33aa6a-74bc-4331-bcfa-85b3902142d4',
      date: '2026-04-16',
      minutes: 64,
      percent: 16,
    });
  });

  it('parses a "Started reading" row with a date but no progress', () => {
    const row = parseJournalEntryRow('15 April 2026 Edit Started reading', EDIT);
    expect(row).toMatchObject({ date: '2026-04-15', minutes: null, percent: null });
  });

  it('zero-pads single-digit days and maps month names', () => {
    expect(parseJournalEntryRow('5 January 2025 Edit 3% 10 minutes listened', EDIT)?.date).toBe('2025-01-05');
    expect(parseJournalEntryRow('31 December 2024 Edit 99% 600 minutes listened', EDIT)?.date).toBe('2024-12-31');
  });

  it('returns null when no date can be parsed', () => {
    expect(parseJournalEntryRow('no date here', EDIT)).toBeNull();
  });

  it('returns a null entryId when the edit href is missing', () => {
    expect(parseJournalEntryRow('16 April 2026 16%', null)?.entryId).toBeNull();
  });
});

describe('normalizeTitle', () => {
  it('drops subtitle, series, and punctuation', () => {
    expect(normalizeTitle('Catching Fire')).toBe('catching fire');
    expect(normalizeTitle('No Nonsense Spirituality: All the Tools')).toBe('no nonsense spirituality');
    expect(normalizeTitle('Catching Fire (The Hunger Games, #2)')).toBe('catching fire');
  });
});

describe('matchShelfByTitle', () => {
  const book = (title: string, bookUrl: string): StoryGraphBook => ({ title, author: '', bookUrl });

  it('matches an ABS title to a shelf book, ignoring subtitle/series', () => {
    const shelf = [
      book('A Calendar of Wisdom: Daily Thoughts', 'https://app.thestorygraph.com/books/cal'),
      book('Catching Fire (The Hunger Games, #2)', 'https://app.thestorygraph.com/books/cf'),
    ];
    expect(matchShelfByTitle(shelf, 'Catching Fire')?.bookUrl).toBe('https://app.thestorygraph.com/books/cf');
  });

  it('treats duplicate shelf rows for the same book as a single confident match', () => {
    const shelf = [book('Catching Fire', '/books/cf'), book('Catching Fire', '/books/cf')];
    expect(matchShelfByTitle(shelf, 'Catching Fire')?.bookUrl).toBe('/books/cf');
  });

  it('returns null when nothing matches', () => {
    expect(matchShelfByTitle([book('Dune', '/books/d')], 'Catching Fire')).toBeNull();
  });

  it('returns null when two different books share the title (ambiguous)', () => {
    const shelf = [book('Catching Fire', '/books/a'), book('Catching Fire', '/books/b')];
    expect(matchShelfByTitle(shelf, 'Catching Fire')).toBeNull();
  });
});
