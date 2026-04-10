import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface BookMapping {
  id: number;
  absLibraryItemId: string;
  storygraphBookUrl: string;
  title: string;
  author: string;
  editionType: string;
  createdAt: string;
}

export interface SyncLogEntry {
  id: number;
  bookMappingId: number;
  progressPercent: number;
  action: string;
  status: string;
  errorMessage: string | null;
  syncedAt: string;
}

export interface Database {
  upsertBookMapping(data: {
    absLibraryItemId: string;
    storygraphBookUrl: string;
    title: string;
    author: string;
    editionType: string;
  }): void;
  getBookMappingByAbsId(absId: string): BookMapping | null;
  getAllBookMappings(): BookMapping[];
  logSync(data: {
    bookMappingId: number;
    progressPercent: number;
    action: string;
    status: string;
    errorMessage: string | null;
  }): void;
  getLastSync(bookMappingId: number): SyncLogEntry | null;
  setConfig(key: string, value: string): void;
  getConfig(key: string): string | null;
  close(): void;
}

export function createDb(dbPath: string): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS book_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      abs_library_item_id TEXT UNIQUE NOT NULL,
      storygraph_book_url TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      edition_type TEXT NOT NULL DEFAULT 'audio',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_mapping_id INTEGER NOT NULL REFERENCES book_mappings(id),
      progress_percent REAL NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const stmts = {
    upsertMapping: db.prepare(`
      INSERT INTO book_mappings (abs_library_item_id, storygraph_book_url, title, author, edition_type)
      VALUES (@absLibraryItemId, @storygraphBookUrl, @title, @author, @editionType)
      ON CONFLICT(abs_library_item_id) DO UPDATE SET
        storygraph_book_url = @storygraphBookUrl,
        title = @title,
        author = @author,
        edition_type = @editionType
    `),
    getMappingByAbsId: db.prepare(`
      SELECT id, abs_library_item_id as absLibraryItemId, storygraph_book_url as storygraphBookUrl,
             title, author, edition_type as editionType, created_at as createdAt
      FROM book_mappings WHERE abs_library_item_id = ?
    `),
    getAllMappings: db.prepare(`
      SELECT id, abs_library_item_id as absLibraryItemId, storygraph_book_url as storygraphBookUrl,
             title, author, edition_type as editionType, created_at as createdAt
      FROM book_mappings ORDER BY created_at DESC
    `),
    insertSync: db.prepare(`
      INSERT INTO sync_log (book_mapping_id, progress_percent, action, status, error_message)
      VALUES (@bookMappingId, @progressPercent, @action, @status, @errorMessage)
    `),
    getLastSync: db.prepare(`
      SELECT id, book_mapping_id as bookMappingId, progress_percent as progressPercent,
             action, status, error_message as errorMessage, synced_at as syncedAt
      FROM sync_log WHERE book_mapping_id = ? ORDER BY synced_at DESC LIMIT 1
    `),
    setConfig: db.prepare(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    getConfig: db.prepare(`SELECT value FROM config WHERE key = ?`),
  };

  return {
    upsertBookMapping(data) {
      stmts.upsertMapping.run(data);
    },
    getBookMappingByAbsId(absId) {
      return (stmts.getMappingByAbsId.get(absId) as BookMapping) ?? null;
    },
    getAllBookMappings() {
      return stmts.getAllMappings.all() as BookMapping[];
    },
    logSync(data) {
      stmts.insertSync.run(data);
    },
    getLastSync(bookMappingId) {
      return (stmts.getLastSync.get(bookMappingId) as SyncLogEntry) ?? null;
    },
    setConfig(key, value) {
      stmts.setConfig.run(key, value);
    },
    getConfig(key) {
      const row = stmts.getConfig.get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    close() {
      db.close();
    },
  };
}
