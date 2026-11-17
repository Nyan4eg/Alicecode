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
      CREATE TABLE IF NOT EXISTS managed_edits (
        id INTEGER PRIMARY KEY, messageId INTEGER NOT NULL REFERENCES messages(id), path TEXT NOT NULL,
        beforeText TEXT NOT NULL, afterText TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_edits_message ON managed_edits(messageId, path);
      CREATE TABLE IF NOT EXISTS session_cleanup (sessionId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS workspace_states (scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS draft_files (chatId TEXT PRIMARY KEY REFERENCES chats(id), data TEXT NOT NULL);
      UPDATE messages SET status='cancelled' WHERE status='running';
    `);
    this.addColumns('chats', { renamed: 'INTEGER NOT NULL DEFAULT 0', modelId: 'TEXT', archivedAt: 'INTEGER', mode: "TEXT NOT NULL DEFAULT 'code'" });
    this.addColumns('messages', { modelId: 'TEXT', attachments: "TEXT NOT NULL DEFAULT '[]'", mode: "TEXT NOT NULL DEFAULT 'code'" });
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

  saveWorkspace(scope, id, value) {
    if (scope === 'chat') this.chat(id);
    else if (scope !== 'project' || !this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) throw new Error('Проект не найден.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректное состояние окна.');
    const data = JSON.stringify(value);
    if (data.length > (scope === 'chat' ? 150_000 : 8_000_000)) throw new Error('Слишком большой черновик. Сохраните часть файлов.');
    this.db.prepare('INSERT INTO workspace_states VALUES (?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data').run(scope, id, data);
  }

  workspaceStates(scope) {
    return Object.fromEntries(this.db.prepare('SELECT id,data FROM workspace_states WHERE scope=?').all(scope)
      .map(row => [row.id, JSON.parse(row.data)]));
  }

  saveDraftFiles(chatId, files) {
    this.chat(chatId);
    if (!files.length) this.db.prepare('DELETE FROM draft_files WHERE chatId=?').run(chatId);
    else this.db.prepare('INSERT INTO draft_files VALUES (?,?) ON CONFLICT(chatId) DO UPDATE SET data=excluded.data').run(chatId, JSON.stringify(files));
  }

  draftFiles() {
    return this.db.prepare('SELECT chatId,data FROM draft_files').all().map(row => [row.chatId, JSON.parse(row.data)]);
  }

  setMode(chatId, mode) {
    this.chat(chatId);
    if (!['code', 'discuss'].includes(mode)) throw new Error('Неизвестный режим.');
    this.db.prepare('UPDATE chats SET mode=? WHERE id=?').run(mode, chatId);
  }

  set(key, value) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  transaction(operation) {
    this.db.exec('BEGIN');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    if (!chat.archivedAt) this.set(`lastChat:${chat.projectId}`, chat.id);
    return chat;
  }

  selectProject(projectId) {
    const recent = this.setting(`lastChat:${projectId}`);
    const chat = this.db.prepare(`SELECT id FROM chats WHERE projectId=? AND archivedAt IS NULL
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

  leaveChat(chat) {
    const last = 'lastChat:' + chat.projectId;
    const inProject = this.db.prepare('SELECT id FROM chats WHERE projectId=? AND archivedAt IS NULL ORDER BY updatedAt DESC,rowid DESC LIMIT 1')
      .get(chat.projectId);
    const removeSetting = this.db.prepare('DELETE FROM settings WHERE key=?');
    if (this.setting(last) === chat.id) {
      if (inProject) this.set(last, inProject.id);
      else removeSetting.run(last);
    }
    if (this.setting('activeChat') === chat.id) {
      const next = inProject ?? this.db.prepare('SELECT id FROM chats WHERE archivedAt IS NULL ORDER BY updatedAt DESC,rowid DESC LIMIT 1').get();
      if (next) this.set('activeChat', next.id);
      else removeSetting.run('activeChat');
    }
  }

  archiveChat(id, archived) {
    return this.transaction(() => {
      const chat = this.chat(id);
      if (archived && !chat.archivedAt) {
        this.db.prepare('UPDATE chats SET archivedAt=? WHERE id=?').run(Date.now(), id);
        this.leaveChat(chat);
      } else if (!archived && chat.archivedAt) {
        this.db.prepare('UPDATE chats SET archivedAt=NULL WHERE id=?').run(id);
        this.select(id);
      }
    });
  }

  deleteChat(id) {
    return this.transaction(() => {
      const chat = this.chat(id);
      this.db.prepare('DELETE FROM managed_edits WHERE messageId IN (SELECT id FROM messages WHERE chatId=?)').run(id);
      this.db.prepare('DELETE FROM run_reviews WHERE messageId IN (SELECT id FROM messages WHERE chatId=?)').run(id);
      this.db.prepare('DELETE FROM messages WHERE chatId=?').run(id);
      this.db.prepare('DELETE FROM draft_files WHERE chatId=?').run(id);
      this.db.prepare("DELETE FROM workspace_states WHERE scope='chat' AND id=?").run(id);
      this.db.prepare('DELETE FROM chats WHERE id=?').run(id);
      this.leaveChat(chat);
      if (chat.sessionId && !this.db.prepare('SELECT 1 FROM chats WHERE sessionId=?').get(chat.sessionId)) {
        this.db.prepare('INSERT OR IGNORE INTO session_cleanup VALUES (?)').run(chat.sessionId);
      }
    });
  }

  sessionsToRemove() {
    return this.db.prepare('SELECT sessionId FROM session_cleanup WHERE NOT EXISTS (SELECT 1 FROM chats WHERE chats.sessionId=session_cleanup.sessionId)')
      .all().map(row => row.sessionId);
  }

  finishSessionRemoval(id) {
    this.db.prepare('DELETE FROM session_cleanup WHERE sessionId=?').run(id);
  }

  search(value, includeArchived = false) {
    const query = fold(typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '');
    if (!query) return [];
    return this.db.prepare(`
      WITH results AS (
        SELECT 'project' AS kind, p.id AS projectId, NULL AS chatId, NULL AS messageId,
          p.title AS projectTitle, NULL AS chatTitle, p.title AS matchText, 0 AS recency FROM projects p
        UNION ALL
        SELECT 'chat', p.id, c.id, NULL, p.title, c.title, c.title, c.updatedAt
          FROM chats c JOIN projects p ON p.id=c.projectId WHERE (? OR c.archivedAt IS NULL)
        UNION ALL
        SELECT 'message', p.id, c.id, m.id, p.title, c.title, m.text, c.updatedAt
          FROM messages m JOIN chats c ON c.id=m.chatId JOIN projects p ON p.id=c.projectId
          WHERE m.text <> '' AND (? OR c.archivedAt IS NULL)
      )
      SELECT * FROM results WHERE instr(search_fold(matchText), ?) > 0
      ORDER BY CASE kind WHEN 'project' THEN 0 WHEN 'chat' THEN 1 ELSE 2 END,
        recency DESC, messageId DESC LIMIT 40
    `).all(Number(includeArchived === true), Number(includeArchived === true), query)
      .map(({ matchText, recency, ...result }) => ({ ...result, snippet: snippet(matchText, query) }));
  }

  setModel(chatId, modelId) {
    this.chat(chatId);
    this.db.prepare('UPDATE chats SET modelId=? WHERE id=?').run(modelId, chatId);
  }

  setSession(chatId, sessionId) {
    this.db.prepare('UPDATE chats SET sessionId=? WHERE id=?').run(sessionId, chatId);
  }

  beginTurn(chatId, text, modelId = null, attachments = [], mode = 'code') {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE chats SET updatedAt=?,
        title=CASE WHEN renamed=0 AND NOT EXISTS (SELECT 1 FROM messages WHERE chatId=chats.id)
        THEN ? ELSE title END WHERE id=?`).run(Date.now(), text.replace(/\s+/g, ' ').slice(0, 60), chatId);
      this.db.prepare("INSERT INTO messages (chatId,role,text,status,attachments) VALUES (?,'user',?,'done',?)")
        .run(chatId, text, JSON.stringify(attachments));
      const message = this.db.prepare("INSERT INTO messages (chatId,role,text,status,modelId,mode) VALUES (?,'assistant','','running',?,?)")
        .run(chatId, modelId, mode);
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

  externalAttachments(chatId) {
    const rows = this.db.prepare(`SELECT value FROM messages, json_each(messages.attachments)
      WHERE chatId=? AND json_extract(value, '$.kind')='external'`).all(chatId);
    return rows.map(row => JSON.parse(row.value));
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

  startManagedEdit(messageId, path, before, after) {
    return Number(this.db.prepare("INSERT INTO managed_edits (messageId,path,beforeText,afterText,state) VALUES (?,?,?,?,'pending')")
      .run(messageId, path, before, after).lastInsertRowid);
  }

  finishManagedEdit(id, applied) {
    if (applied) this.db.prepare("UPDATE managed_edits SET state='applied' WHERE id=?").run(id);
    else this.db.prepare("DELETE FROM managed_edits WHERE id=? AND state='pending'").run(id);
  }

  managedEdits(chatId, messageId, path) {
    return this.db.prepare(`SELECT e.id,e.beforeText,e.afterText FROM managed_edits e JOIN messages m ON m.id=e.messageId
      WHERE m.chatId=? AND m.id=? AND m.status<>'running' AND e.path=? AND e.state='applied' ORDER BY e.id DESC`)
      .all(chatId, messageId, path);
  }

  markRolledBack(edits) {
    const update = this.db.prepare("UPDATE managed_edits SET state='reverted' WHERE id=? AND state='applied'");
    this.transaction(() => { for (const edit of edits) update.run(edit.id); });
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
    const messages = activeChat ? this.db.prepare(`SELECT messages.*, run_reviews.summary,
      (SELECT json_group_array(DISTINCT path) FROM managed_edits WHERE messageId=messages.id AND state='applied') AS managed
      FROM messages
      LEFT JOIN run_reviews ON messageId=messages.id WHERE chatId=? ORDER BY messages.id`).all(activeChat)
      .map(({ summary, managed, ...message }) => ({ ...message, tools: JSON.parse(message.tools),
        attachments: JSON.parse(message.attachments), review: summary ? JSON.parse(summary) : null,
        managedPaths: JSON.parse(managed) })) : [];
    return { activeChat, projects, chats, messages };
  }
}
