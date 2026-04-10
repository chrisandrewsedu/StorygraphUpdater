import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type Database } from '../src/db.js';
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
