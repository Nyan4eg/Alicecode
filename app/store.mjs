import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, sessionId TEXT, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id),
        role TEXT NOT NULL, text TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      UPDATE messages SET status='cancelled' WHERE status='running';
    `);
  }

  setting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  }

  set(key, value) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  addProject(title, path) {
    const existing = this.db.prepare('SELECT id FROM projects WHERE path=?').get(path);
    if (existing) {
      const chat = this.db.prepare('SELECT id FROM chats WHERE projectId=? ORDER BY updatedAt DESC LIMIT 1')
        .get(existing.id);
      return chat ? this.select(chat.id) : this.addChat(existing.id);
    }
    const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, title, path);
      const chat = this.addChat(id);
      this.db.exec('COMMIT');
      return chat;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addChat(projectId) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO chats VALUES (?, ?, 'Новый чат', NULL, ?)")
      .run(id, projectId, Date.now());
    return this.select(id);
  }

  chat(id) {
    const chat = this.db.prepare(`SELECT chats.*, projects.path AS cwd, projects.title AS projectTitle
      FROM chats JOIN projects ON projects.id=chats.projectId WHERE chats.id=?`).get(id);
    if (!chat) throw new Error('Чат не найден.');
    return chat;
  }

  select(id) {
    const chat = this.chat(id);
    this.set('activeChat', chat.id);
    return chat;
  }

  setSession(chatId, sessionId) {
    this.db.prepare('UPDATE chats SET sessionId=? WHERE id=?').run(sessionId, chatId);
  }

  beginTurn(chatId, text) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE chats SET updatedAt=?,
        title=CASE WHEN NOT EXISTS (SELECT 1 FROM messages WHERE chatId=chats.id)
        THEN ? ELSE title END WHERE id=?`).run(Date.now(), text.replace(/\s+/g, ' ').slice(0, 60), chatId);
      this.db.prepare("INSERT INTO messages (chatId,role,text,status) VALUES (?,'user',?,'done')")
        .run(chatId, text);
      const message = this.db.prepare("INSERT INTO messages (chatId,role,text,status) VALUES (?,'assistant','','running')")
        .run(chatId);
      this.db.exec('COMMIT');
      return Number(message.lastInsertRowid);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveTurn(id, { text, tools, status, error }) {
    this.db.prepare('UPDATE messages SET text=?, tools=?, status=?, error=? WHERE id=?')
      .run(text, JSON.stringify(tools), status, error ?? null, id);
  }

  snapshot() {
    const activeChat = this.setting('activeChat') ?? null;
    const projects = this.db.prepare('SELECT * FROM projects ORDER BY rowid DESC').all();
    const chats = this.db.prepare('SELECT * FROM chats ORDER BY updatedAt DESC, rowid DESC').all();
    const messages = activeChat ? this.db.prepare('SELECT * FROM messages WHERE chatId=? ORDER BY id')
      .all(activeChat).map(message => ({ ...message, tools: JSON.parse(message.tools) })) : [];
    return { activeChat, projects, chats, messages };
  }
}
