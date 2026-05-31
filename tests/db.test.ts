import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type Database } from '../src/db.js';
import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TEST_DB_DIR = path.resolve('./data/test');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test.db');

describe('Database', () => {
  let db: Database;

  beforeEach(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    db = createDb(TEST_DB_PATH);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(TEST_DB_PATH, { force: true });
  });

  describe('book_mappings', () => {
    it('should insert and retrieve a book mapping', () => {
      db.upsertBookMapping({
        absLibraryItemId: 'li_abc123',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/abc',
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        editionType: 'audio',
      });

      const mapping = db.getBookMappingByAbsId('li_abc123');
      expect(mapping).toBeDefined();
      expect(mapping!.title).toBe('Project Hail Mary');
      expect(mapping!.author).toBe('Andy Weir');
      expect(mapping!.editionType).toBe('audio');
    });

    it('should return null for unknown ABS ID', () => {
      const mapping = db.getBookMappingByAbsId('li_unknown');
      expect(mapping).toBeNull();
    });

    it('should update existing mapping on upsert', () => {
      db.upsertBookMapping({
        absLibraryItemId: 'li_abc123',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/abc',
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        editionType: 'print',
      });
      db.upsertBookMapping({
        absLibraryItemId: 'li_abc123',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/abc-audio',
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        editionType: 'audio',
      });

      const mapping = db.getBookMappingByAbsId('li_abc123');
      expect(mapping!.editionType).toBe('audio');
      expect(mapping!.storygraphBookUrl).toBe('https://app.thestorygraph.com/books/abc-audio');
    });
  });

  describe('sync_log', () => {
    it('should log a successful sync', () => {
      db.upsertBookMapping({
        absLibraryItemId: 'li_abc123',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/abc',
        title: 'Test Book',
        author: 'Author',
        editionType: 'audio',
      });
      const mapping = db.getBookMappingByAbsId('li_abc123')!;

      db.logSync({
        bookMappingId: mapping.id,
        progressPercent: 45.5,
        action: 'progress_update',
        status: 'success',
        errorMessage: null,
      });

      const lastSync = db.getLastSync(mapping.id);
      expect(lastSync).toBeDefined();
      expect(lastSync!.progressPercent).toBe(45.5);
      expect(lastSync!.status).toBe('success');
    });

    it('should return null when no sync exists', () => {
      const lastSync = db.getLastSync(999);
      expect(lastSync).toBeNull();
    });
  });

  describe('asin/isbn on book_mappings', () => {
    it('persists asin and isbn when provided', () => {
      db.upsertBookMapping({
        absLibraryItemId: 'li_ci',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/cf',
        title: 'Catching Fire',
        author: 'Suzanne Collins',
        editionType: 'audio',
        asin: '1338589016',
        isbn: '9781338589016',
      });
      const mapping = db.getBookMappingByAbsId('li_ci')!;
      expect(mapping.asin).toBe('1338589016');
      expect(mapping.isbn).toBe('9781338589016');
    });

    it('defaults asin/isbn to null when omitted', () => {
      db.upsertBookMapping({
        absLibraryItemId: 'li_none',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/x',
        title: 'X',
        author: 'Y',
        editionType: 'audio',
      });
      const mapping = db.getBookMappingByAbsId('li_none')!;
      expect(mapping.asin).toBeNull();
      expect(mapping.isbn).toBeNull();
    });
  });

  describe('journal_entries', () => {
    let mappingId: number;
    beforeEach(() => {
      db.upsertBookMapping({
        absLibraryItemId: 'li_j',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/j',
        title: 'J',
        author: 'A',
        editionType: 'audio',
      });
      mappingId = db.getBookMappingByAbsId('li_j')!.id;
    });

    it('round-trips entries ordered by date ascending', () => {
      db.upsertJournalEntry({ bookMappingId: mappingId, entryDate: '2026-05-03', minutes: 90, status: 'success' });
      db.upsertJournalEntry({ bookMappingId: mappingId, entryDate: '2026-05-01', minutes: 30, status: 'success' });
      db.upsertJournalEntry({ bookMappingId: mappingId, entryDate: '2026-05-02', minutes: 60, status: 'success' });

      const entries = db.getJournalEntries(mappingId);
      expect(entries.map((e) => e.entryDate)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
      expect(entries.map((e) => e.minutes)).toEqual([30, 60, 90]);
    });

    it('upserts (replaces) an entry for the same date', () => {
      db.upsertJournalEntry({ bookMappingId: mappingId, entryDate: '2026-05-01', minutes: 30, status: 'failed' });
      db.upsertJournalEntry({ bookMappingId: mappingId, entryDate: '2026-05-01', minutes: 35, status: 'success' });

      const entries = db.getJournalEntries(mappingId);
      expect(entries).toHaveLength(1);
      expect(entries[0].minutes).toBe(35);
      expect(entries[0].status).toBe('success');
    });
  });

  describe('migration of a legacy database', () => {
    it('adds asin/isbn columns in place without losing data', () => {
      const legacyPath = path.join(TEST_DB_DIR, 'legacy.db');
      fs.rmSync(legacyPath, { force: true });

      // Create a DB with the pre-asin/isbn schema and a row.
      const legacy = new BetterSqlite3(legacyPath);
      legacy.exec(`
        CREATE TABLE book_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          abs_library_item_id TEXT UNIQUE NOT NULL,
          storygraph_book_url TEXT NOT NULL,
          title TEXT NOT NULL,
          author TEXT NOT NULL,
          edition_type TEXT NOT NULL DEFAULT 'audio',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      legacy.prepare(
        `INSERT INTO book_mappings (abs_library_item_id, storygraph_book_url, title, author, edition_type)
         VALUES ('li_legacy', 'https://app.thestorygraph.com/books/legacy', 'Legacy', 'Auth', 'audio')`
      ).run();
      legacy.close();

      // Re-open with createDb — should migrate columns in place.
      const migrated = createDb(legacyPath);
      const mapping = migrated.getBookMappingByAbsId('li_legacy')!;
      expect(mapping.title).toBe('Legacy');
      expect(mapping.asin).toBeNull();
      expect(mapping.isbn).toBeNull();

      // And new writes can set them.
      migrated.upsertBookMapping({
        absLibraryItemId: 'li_legacy',
        storygraphBookUrl: 'https://app.thestorygraph.com/books/legacy',
        title: 'Legacy',
        author: 'Auth',
        editionType: 'audio',
        asin: 'B00ABCDEF',
        isbn: null,
      });
      expect(migrated.getBookMappingByAbsId('li_legacy')!.asin).toBe('B00ABCDEF');
      migrated.close();
      fs.rmSync(legacyPath, { force: true });
    });
  });

  describe('config', () => {
    it('should set and get config values', () => {
      db.setConfig('last_poll', '2026-04-09T22:00:00Z');
      expect(db.getConfig('last_poll')).toBe('2026-04-09T22:00:00Z');
    });

    it('should return null for missing config', () => {
      expect(db.getConfig('nonexistent')).toBeNull();
    });

    it('should overwrite existing config', () => {
      db.setConfig('key', 'value1');
      db.setConfig('key', 'value2');
      expect(db.getConfig('key')).toBe('value2');
    });
  });
});
