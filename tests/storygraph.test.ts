import { describe, it, expect } from 'vitest';
import {
  normalizeIdentifier,
  matchEditionByIdentifier,
  parseJournalEntryRow,
  bookIdFromUrl,
  normalizeTitle,
  matchShelfByTitle,
  parseEditionCard,
  chooseAudioEdition,
  pickNewEntry,
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

  it('reads the cumulative total from "(HH:MM out of ...)", not the per-day minutes', () => {
    const row = parseJournalEntryRow('5 October 2026 Edit 17% 103 minutes listened (02:04 out of 12:30)', EDIT);
    expect(row).toMatchObject({ date: '2026-10-05', minutes: 124, percent: 17 });
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

describe('parseEditionCard', () => {
  // Real card text from the Exit Party editions page (2026-10), whitespace as rendered.
  const AUDIO_CARD = [
    "You're currently reading another edition",
    'Exit Party',
    'Emily St. John Mandel',
    'with Kirsten Potter (Narrator), Kimberly Farr (Narrator)',
    '12h  30m • audio • 2026',
    'ISBN/UID: 9798217406500',
    'Format: Audio',
    'Language: English',
    'Original Pub Year: 2026',
    'Publisher: Random House Audio',
    'fiction',
    'crime',
  ].join('\n          ');
  const HARDCOVER_CARD = [
    'Exit Party',
    'Emily St. John Mandel',
    '301 pages • hardcover • 2026',
    'ISBN/UID: 9781035081288',
    'Format: Hardcover',
    'Language: English',
    'Publisher: Picador',
  ].join('\n');

  it('parses an audio edition card', () => {
    expect(parseEditionCard(AUDIO_CARD, '/books/9c7d5466-a3b9-41ae-b17c-7b9d75858866')).toEqual({
      title: 'Exit Party',
      format: 'audio',
      info: '12h 30m • audio • 2026\nLanguage: English\nPublisher: Random House Audio',
      bookUrl: 'https://app.thestorygraph.com/books/9c7d5466-a3b9-41ae-b17c-7b9d75858866',
      coverUrl: '',
      isbn: '9798217406500',
    });
  });

  it('parses a print edition card', () => {
    const e = parseEditionCard(HARDCOVER_CARD, '/books/66f5ae10-7a00-4a33-bcb5-e43209c3295c');
    expect(e).toMatchObject({ format: 'hardcover', isbn: '9781035081288', title: 'Exit Party' });
  });

  it('maps an "ISBN/UID: None" card to a null isbn', () => {
    const e = parseEditionCard(HARDCOVER_CARD.replace('9781035081288', 'None'), '/books/abc');
    expect(e?.isbn).toBeNull();
  });

  it('returns null without a book link', () => {
    expect(parseEditionCard(HARDCOVER_CARD, null)).toBeNull();
  });
});

describe('chooseAudioEdition', () => {
  const HC = edition({ format: 'hardcover', isbn: '9781035081288', bookUrl: 'https://app.thestorygraph.com/books/hc' });
  const A1 = edition({ format: 'audio', isbn: '9798217406500', bookUrl: 'https://app.thestorygraph.com/books/a1' });
  const A2 = edition({ format: 'audio', isbn: '9781035081325', bookUrl: 'https://app.thestorygraph.com/books/a2' });

  it('prefers the edition matching the ABS ASIN/ISBN', () => {
    expect(chooseAudioEdition([HC, A2, A1], HC.bookUrl, { asin: 'B0G79HNG5Q', isbn: '9798217406500' })).toBe(A1.bookUrl);
  });

  it('keeps the chosen URL when it is already an audio edition', () => {
    expect(chooseAudioEdition([HC, A1, A2], A2.bookUrl, { asin: null, isbn: null })).toBe(A2.bookUrl);
  });

  it('falls back to the only audio edition', () => {
    expect(chooseAudioEdition([HC, A1], HC.bookUrl, { asin: null, isbn: null })).toBe(A1.bookUrl);
  });

  it('keeps the chosen URL when the audio edition is ambiguous', () => {
    expect(chooseAudioEdition([HC, A1, A2], HC.bookUrl, { asin: null, isbn: null })).toBe(HC.bookUrl);
  });

  it('ignores an identifier match on a non-audio edition', () => {
    expect(chooseAudioEdition([HC, A1], HC.bookUrl, { asin: null, isbn: '9781035081288' })).toBe(A1.bookUrl);
  });
});

describe('pickNewEntry', () => {
  const before = [
    { entryId: 'old-15', date: '2026-10-15', minutes: null, percent: null }, // "Started reading" placeholder
  ];

  it('picks the newly created entry, not an older one on the same date', () => {
    const after = [...before, { entryId: 'new-15', date: '2026-10-15', minutes: null, percent: null }];
    expect(pickNewEntry(before, after, '2026-10-15')).toBe('new-15');
  });

  it('returns null when no new entry exists for the date', () => {
    expect(pickNewEntry(before, before, '2026-10-15')).toBeNull();
  });

  it('ignores new entries on other dates', () => {
    const after = [...before, { entryId: 'new-14', date: '2026-10-14', minutes: null, percent: null }];
    expect(pickNewEntry(before, after, '2026-10-15')).toBeNull();
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
