import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defaultModel, legacyModel } from './models.mjs';

const fold = value => value.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/g, ' ');

function cleanTitle(value) {
  const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!title || title.length > 100) throw new Error('Введите название длиной от 1 до 100 символов.');
  return title;
}

function snippet(text, needle) {
  const line = text.replace(/\s+/g, ' ').trim().normalize('NFKC');
  const position = Math.max(0, fold(line).indexOf(needle));
  const start = Math.max(0, position - 40);
  const end = Math.min(line.length, start + 145);
  return (start ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
}

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
      CREATE TABLE IF NOT EXISTS run_reviews (
        messageId INTEGER PRIMARY KEY REFERENCES messages(id), summary TEXT NOT NULL, files TEXT NOT NULL
      );
      UPDATE messages SET status='cancelled' WHERE status='running';
    `);
    this.addColumns('chats', { renamed: 'INTEGER NOT NULL DEFAULT 0', modelId: 'TEXT' });
    this.addColumns('messages', { modelId: 'TEXT', attachments: "TEXT NOT NULL DEFAULT '[]'" });
    this.db.prepare('UPDATE chats SET modelId=? WHERE modelId IS NULL').run(legacyModel.id);
    this.db.function('search_fold', { deterministic: true }, fold);
  }

  addColumns(table, columns) {
    const existing = this.db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
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
    if (existing) return this.selectProject(existing.id);
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
    this.db.prepare("INSERT INTO chats (id, projectId, title, updatedAt, modelId) VALUES (?, ?, 'Новый чат', ?, ?)")
      .run(id, projectId, Date.now(), defaultModel.id);
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
    this.set(`lastChat:${chat.projectId}`, chat.id);
    return chat;
  }

  selectProject(projectId) {
    const recent = this.setting(`lastChat:${projectId}`);
    const chat = this.db.prepare(`SELECT id FROM chats WHERE projectId=?
      ORDER BY (id=?) DESC, updatedAt DESC, rowid DESC LIMIT 1`).get(projectId, recent ?? '');
    return chat ? this.select(chat.id) : this.addChat(projectId);
  }

  renameProject(id, title) {
    if (!this.db.prepare('UPDATE projects SET title=? WHERE id=?').run(cleanTitle(title), id).changes) {
      throw new Error('Проект не найден.');
    }
  }

  renameChat(id, title) {
    if (!this.db.prepare('UPDATE chats SET title=?, renamed=1 WHERE id=?').run(cleanTitle(title), id).changes) {
      throw new Error('Чат не найден.');
    }
  }

  search(value) {
    const query = fold(typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '');
    if (!query) return [];
    return this.db.prepare(`
      WITH results AS (
        SELECT 'project' AS kind, p.id AS projectId, NULL AS chatId, NULL AS messageId,
          p.title AS projectTitle, NULL AS chatTitle, p.title AS matchText, 0 AS recency FROM projects p
        UNION ALL
        SELECT 'chat', p.id, c.id, NULL, p.title, c.title, c.title, c.updatedAt
          FROM chats c JOIN projects p ON p.id=c.projectId
        UNION ALL
        SELECT 'message', p.id, c.id, m.id, p.title, c.title, m.text, c.updatedAt
          FROM messages m JOIN chats c ON c.id=m.chatId JOIN projects p ON p.id=c.projectId WHERE m.text <> ''
      )
      SELECT * FROM results WHERE instr(search_fold(matchText), ?) > 0
      ORDER BY CASE kind WHEN 'project' THEN 0 WHEN 'chat' THEN 1 ELSE 2 END,
        recency DESC, messageId DESC LIMIT 40
    `).all(query).map(({ matchText, recency, ...result }) => ({ ...result, snippet: snippet(matchText, query) }));
  }

  setModel(chatId, modelId) {
    this.chat(chatId);
    this.db.prepare('UPDATE chats SET modelId=? WHERE id=?').run(modelId, chatId);
  }

  setSession(chatId, sessionId) {
    this.db.prepare('UPDATE chats SET sessionId=? WHERE id=?').run(sessionId, chatId);
  }

  beginTurn(chatId, text, modelId = null, attachments = []) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE chats SET updatedAt=?,
        title=CASE WHEN renamed=0 AND NOT EXISTS (SELECT 1 FROM messages WHERE chatId=chats.id)
        THEN ? ELSE title END WHERE id=?`).run(Date.now(), text.replace(/\s+/g, ' ').slice(0, 60), chatId);
      this.db.prepare("INSERT INTO messages (chatId,role,text,status,attachments) VALUES (?,'user',?,'done',?)")
        .run(chatId, text, JSON.stringify(attachments));
      const message = this.db.prepare("INSERT INTO messages (chatId,role,text,status,modelId) VALUES (?,'assistant','','running',?)")
        .run(chatId, modelId);
      this.db.exec('COMMIT');
      return Number(message.lastInsertRowid);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  beginReplay(chatId, tool) {
    const result = this.db.prepare("INSERT INTO messages (chatId,role,text,tools,status) VALUES (?,'assistant','',?,'running')")
      .run(chatId, JSON.stringify([tool]));
    return Number(result.lastInsertRowid);
  }

  messageTool(chatId, messageId, toolId) {
    const row = this.db.prepare("SELECT tools FROM messages WHERE id=? AND chatId=? AND status IN ('done','error','cancelled')")
      .get(messageId, chatId);
    return row ? JSON.parse(row.tools).find(tool => tool.id === toolId) : undefined;
  }

  saveReview(id, { files, ...summary }) {
    const review = { ...summary, files: files.map(({ patch, ...file }) => file) };
    this.db.prepare('INSERT INTO run_reviews (messageId,summary,files) VALUES (?,?,?)')
      .run(id, JSON.stringify(review), JSON.stringify(files));
    return review;
  }

  reviewFile(chatId, messageId, path) {
    const row = this.db.prepare(`SELECT run_reviews.files FROM run_reviews JOIN messages ON messages.id=messageId
      WHERE messageId=? AND chatId=?`).get(messageId, chatId);
    const file = row && JSON.parse(row.files).find(item => item.path === path);
    if (!file) throw new Error('Изменение за запуск не найдено.');
    return file;
  }

  saveTurn(id, { text, tools, status, error }) {
    this.db.prepare('UPDATE messages SET text=?, tools=?, status=?, error=? WHERE id=?')
      .run(text, JSON.stringify(tools), status, error ?? null, id);
  }

  snapshot() {
    const activeChat = this.setting('activeChat') ?? null;
    const projects = this.db.prepare('SELECT * FROM projects ORDER BY rowid DESC').all();
    const chats = this.db.prepare('SELECT * FROM chats ORDER BY updatedAt DESC, rowid DESC').all();
    const messages = activeChat ? this.db.prepare(`SELECT messages.*, run_reviews.summary FROM messages
      LEFT JOIN run_reviews ON messageId=messages.id WHERE chatId=? ORDER BY messages.id`).all(activeChat)
      .map(({ summary, ...message }) => ({ ...message, tools: JSON.parse(message.tools),
        attachments: JSON.parse(message.attachments), review: summary ? JSON.parse(summary) : null })) : [];
    return { activeChat, projects, chats, messages };
  }
}
