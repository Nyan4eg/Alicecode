import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defaultModel, legacyModel } from './models.mjs';
import { diffRange } from './revision.mjs';

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
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        data TEXT NOT NULL, patches TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transfers_chat ON transfers(chatId);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_reviews (
        messageId INTEGER PRIMARY KEY REFERENCES messages(id), summary TEXT NOT NULL, files TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_edits (
        id INTEGER PRIMARY KEY, messageId INTEGER NOT NULL REFERENCES messages(id), path TEXT NOT NULL,
        beforeText TEXT NOT NULL, afterText TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_edits_message ON managed_edits(messageId, path);
      CREATE TABLE IF NOT EXISTS review_notes (
        id INTEGER PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        origin INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, path TEXT NOT NULL,
        anchor TEXT NOT NULL, body TEXT NOT NULL, reply INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_cleanup (sessionId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS workspace_states (scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS draft_files (chatId TEXT PRIMARY KEY REFERENCES chats(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_profiles (projectId TEXT PRIMARY KEY REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS preparation_root ON command_runs
        (json_extract(data,'$.projectId'),json_extract(data,'$.root')) WHERE json_extract(data,'$.source')='preparation';
      CREATE INDEX IF NOT EXISTS command_sequence_profile ON command_runs
        (json_extract(data,'$.chatId'), json_extract(data,'$.root'), json_extract(data,'$.profile.id'))
        WHERE json_extract(data,'$.source')='sequence';
      CREATE TABLE IF NOT EXISTS package_profiles (projectId TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(projectId,id));
      CREATE TABLE IF NOT EXISTS check_files (version TEXT PRIMARY KEY, files TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_workspaces (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, chatId TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_analysis (root TEXT PRIMARY KEY, data TEXT NOT NULL);
      UPDATE messages SET status='cancelled' WHERE status='running';
    `);
    this.addColumns('chats', { renamed: 'INTEGER NOT NULL DEFAULT 0', modelId: 'TEXT', archivedAt: 'INTEGER', mode: "TEXT NOT NULL DEFAULT 'code'",
      approval: "TEXT NOT NULL DEFAULT 'ask'", planning: 'INTEGER NOT NULL DEFAULT 0', draftPlan: 'TEXT', workspace: 'TEXT', pins: "TEXT NOT NULL DEFAULT '[]'", summary: 'TEXT' });
    this.addColumns('messages', { modelId: 'TEXT', attachments: "TEXT NOT NULL DEFAULT '[]'", mode: "TEXT NOT NULL DEFAULT 'code'", task: 'TEXT' });
    this.addColumns('chats', { profileId: "TEXT NOT NULL DEFAULT 'all'" });
    for (const row of this.db.prepare('SELECT id,projectId,workspace FROM chats WHERE workspace IS NOT NULL').all()) {
      this.db.prepare('INSERT OR IGNORE INTO task_workspaces VALUES (?,?,?,?)').run(row.id, row.projectId, row.id, row.workspace);
    }
    for (const run of this.commands().filter(run => ['pending', 'in_progress', 'background'].includes(run.status))) {
      for (const step of run.steps ?? []) {
        if (step.status === 'in_progress') step.status = 'interrupted';
        if (step.status === 'pending') step.status = 'skipped';
      }
      this.saveCommand({ ...run, status: 'interrupted', error: 'Перезапуск приложения: состояние процесса не подтверждено.', endedAt: Date.now() });
    }
    for (const row of this.db.prepare("SELECT data FROM transfers WHERE json_extract(data,'$.running')=1").all()) {
      const card = JSON.parse(row.data);
      card.running = false;
      for (const check of card.checks) if (['pending','in_progress'].includes(check.status)) check.status = 'interrupted';
      this.updateTransfer(card);
    }
    for (const request of this.requests().filter(item => !['done', 'error', 'cancelled', 'interrupted'].includes(item.phase))) this.saveRequest({ ...request, phase: 'interrupted', reason: 'Запрос прерван перезапуском приложения.' });
    for (const [root, analysis] of Object.entries(this.analyses())) this.saveAnalysis(root, { ...analysis, stale: true });
    for (const row of this.db.prepare("SELECT id,task FROM messages WHERE task IS NOT NULL AND status='cancelled'").all()) {
      const task = JSON.parse(row.task);
      if (['running', 'planning'].includes(task.status)) {
        task.status = 'stopped';
        for (const step of task.steps ?? []) if (step.status === 'running') { step.status = 'stopped'; step.note = 'Прервано перезапуском приложения.'; }
        this.db.prepare('UPDATE messages SET task=? WHERE id=?').run(JSON.stringify(task), row.id);
      }
    }
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
    else if (scope === 'editor') this.chat(id);
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

  setTaskOptions(id, { approval, planning }) {
    this.chat(id);
    if (!['ask', 'bypass'].includes(approval) || typeof planning !== 'boolean') throw new Error('Неизвестный режим разрешений.');
    this.db.prepare('UPDATE chats SET approval=?,planning=? WHERE id=?').run(approval, Number(planning), id);
  }

  setDraftPlan(id, plan) {
    this.chat(id);
    this.db.prepare('UPDATE chats SET draftPlan=? WHERE id=?').run(plan ? JSON.stringify(plan) : null, id);
  }

  setTaskWorkspace(id, workspace) {
    const chat = this.chat(id);
    this.db.prepare('UPDATE chats SET workspace=?,sessionId=NULL WHERE id=?').run(JSON.stringify(workspace), id);
    this.saveTaskWorkspace(id, chat.projectId, id, workspace);
  }

  profile(projectId) { return JSON.parse(this.db.prepare('SELECT data FROM project_profiles WHERE projectId=?').get(projectId)?.data ?? '{}'); }
  profiles(projectId) {
    return [this.profile(projectId), ...this.db.prepare('SELECT data FROM package_profiles WHERE projectId=? ORDER BY rowid')
      .all(projectId).map(row => JSON.parse(row.data))];
  }
  selectedProfile(chat) {
    return this.profiles(chat.projectId).find(profile => (profile.id ?? 'all') === chat.profileId) ?? this.profile(chat.projectId);
  }
  selectProfile(chatId, id) {
    const chat = this.chat(chatId);
    if (!this.profiles(chat.projectId).some(profile => (profile.id ?? 'all') === id)) throw Error('Профиль не найден.');
    this.db.prepare('UPDATE chats SET profileId=? WHERE id=?').run(id,chatId);
  }
  putProfile(chat, profile) {
    this.transaction(() => {
      this.writeProfile(chat.projectId, profile);
      this.selectProfile(chat.id,profile.id);
    });
  }
  writeProfile(projectId, profile) {
    if (profile.id === 'all') this.saveProfile(projectId,profile);
    else this.db.prepare('INSERT INTO package_profiles VALUES (?,?,?) ON CONFLICT(projectId,id) DO UPDATE SET data=excluded.data')
      .run(projectId,profile.id,JSON.stringify(profile));
  }
  importProfiles(projectId, profiles, replace) {
    this.transaction(() => {
      const existing = this.profiles(projectId);
      if (replace) {
        this.db.prepare('DELETE FROM package_profiles WHERE projectId=?').run(projectId);
        this.db.prepare('DELETE FROM project_profiles WHERE projectId=?').run(projectId);
        if (existing[0].runtime && !profiles.some(p => p.id === 'all')) this.saveProfile(projectId, { runtime: existing[0].runtime });
      }
      for (const profile of profiles) {
        const prior = existing.find(p => (p.id ?? 'all') === profile.id);
        this.writeProfile(projectId, { ...profile, runtime: prior?.runtime ?? '' });
      }
      if (replace) this.db.prepare("UPDATE chats SET profileId='all' WHERE projectId=? AND profileId<>'all' AND profileId NOT IN (SELECT id FROM package_profiles WHERE projectId=?)").run(projectId,projectId);
    });
  }
  savePins(id, pins) { this.chat(id); this.db.prepare('UPDATE chats SET pins=? WHERE id=?').run(JSON.stringify(pins), id); }
  saveSummary(id, text, through, root, expected = null) {
    const chat = this.chat(id);
    if ((chat.summary?.id ?? null) !== expected) throw new Error('Сводка изменилась. Откройте её заново.');
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('Сводка должна содержать от 1 до 12000 символов.');
    const summary = { id: randomUUID(), text: text.trim(), through, root, createdAt: Date.now() };
    this.db.prepare('UPDATE chats SET summary=?,sessionId=NULL WHERE id=?').run(JSON.stringify(summary), id); return summary;
  }
  requests() { return this.db.prepare('SELECT data FROM api_requests ORDER BY rowid DESC LIMIT 200').all().map(row => JSON.parse(row.data)); }
  saveRequest(value) { this.db.prepare('INSERT INTO api_requests VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, JSON.stringify(value)); }
  analyses() { return Object.fromEntries(this.db.prepare('SELECT * FROM project_analysis').all().map(row => [row.root, JSON.parse(row.data)])); }
  saveAnalysis(root, data) { this.db.prepare('INSERT INTO project_analysis VALUES (?,?) ON CONFLICT(root) DO UPDATE SET data=excluded.data').run(root, JSON.stringify(data)); }
  saveProfile(projectId, profile) {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new Error('Проект не найден.');
    this.db.prepare('INSERT INTO project_profiles VALUES (?,?) ON CONFLICT(projectId) DO UPDATE SET data=excluded.data').run(projectId, JSON.stringify(profile));
  }
  command(id) { const row = this.db.prepare('SELECT data FROM command_runs WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  latestPreparation(projectId,root) {
    const row = this.db.prepare(`SELECT data FROM command_runs WHERE json_extract(data,'$.source')='preparation'
      AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.root')=? ORDER BY rowid DESC LIMIT 1`).get(projectId,root);
    return row && JSON.parse(row.data);
  }
  latestSequence(chatId, root, profileId) {
    const row = this.db.prepare(`SELECT data FROM command_runs WHERE json_extract(data,'$.source')='sequence'
      AND json_extract(data,'$.chatId')=? AND json_extract(data,'$.root')=? AND json_extract(data,'$.profile.id')=?
      ORDER BY rowid DESC LIMIT 1`).get(chatId, root, profileId);
    return row && JSON.parse(row.data);
  }
  commands() { return this.db.prepare('SELECT data FROM command_runs ORDER BY rowid DESC LIMIT 500').all().map(row => JSON.parse(row.data)); }
  saveCommand(run) { this.db.prepare('INSERT INTO command_runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id, JSON.stringify(run)); }
  transfers(chatId) {
    return this.db.prepare('SELECT data FROM transfers WHERE chatId=? ORDER BY rowid DESC').all(chatId).map(row => JSON.parse(row.data));
  }
  addTransfer(card, patches) {
    this.db.prepare('INSERT INTO transfers VALUES (?,?,?,?)').run(card.id, card.chatId, JSON.stringify(card), JSON.stringify(patches));
  }
  updateTransfer(card) {
    this.db.prepare('UPDATE transfers SET data=? WHERE id=? AND chatId=?').run(JSON.stringify(card), card.id, card.chatId);
  }
  transferPatches(chatId, id) {
    const row = this.db.prepare('SELECT patches FROM transfers WHERE id=? AND chatId=?').get(id, chatId);
    if (!row) throw Error('Перенос не найден.');
    return JSON.parse(row.patches);
  }
  taskWorkspaces() { return this.db.prepare('SELECT * FROM task_workspaces ORDER BY rowid DESC').all().map(({ data, ...row }) => ({ ...row, ...JSON.parse(data) })); }
  saveTaskWorkspace(id, projectId, chatId, workspace) {
    this.db.prepare('INSERT INTO task_workspaces VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,chatId=excluded.chatId')
      .run(id, projectId, chatId, JSON.stringify(workspace));
    if (workspace.state === 'removed') this.db.prepare('UPDATE chats SET workspace=NULL,sessionId=NULL WHERE id=?').run(id);
    else this.db.prepare('UPDATE chats SET workspace=? WHERE id=?').run(JSON.stringify(workspace), id);
  }

  task(chatId, messageId) {
    const row = this.db.prepare('SELECT task FROM messages WHERE chatId=? AND id=?').get(chatId, messageId);
    if (!row?.task) throw new Error('Задача не найдена.');
    return JSON.parse(row.task);
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
    const workspace = chat.workspace ? JSON.parse(chat.workspace) : null;
    return { ...chat, projectCwd: chat.cwd, cwd: workspace?.state === 'removed' ? chat.cwd : workspace?.root ?? chat.cwd, workspace, pins: JSON.parse(chat.pins), summary: chat.summary ? JSON.parse(chat.summary) : null,
      draftPlan: chat.draftPlan ? JSON.parse(chat.draftPlan) : null };
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
      this.db.prepare("DELETE FROM api_requests WHERE json_extract(data,'$.chatId')=?").run(id);
      this.db.prepare("DELETE FROM project_analysis WHERE json_extract(data,'$.chatId')=?").run(id);
      this.db.prepare("DELETE FROM workspace_states WHERE scope='chat' AND id=?").run(id);
      this.db.prepare("DELETE FROM workspace_states WHERE scope='editor' AND id=?").run(id);
      this.db.prepare('DELETE FROM chats WHERE id=?').run(id);
      this.db.prepare('UPDATE task_workspaces SET chatId=NULL WHERE chatId=?').run(id);
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

  notes(chatId) {
    return this.db.prepare('SELECT * FROM review_notes WHERE chatId=? ORDER BY id').all(chatId)
      .map(note => ({ ...note, anchor: JSON.parse(note.anchor) }));
  }

  addNote(chatId, origin, path, first, last, body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 2000) throw Error('Введите замечание до 2000 символов.');
    const { patch } = this.reviewFile(chatId, origin, path);
    const anchor = diffRange(patch, first, last);
    this.db.prepare('INSERT INTO review_notes(chatId,origin,path,anchor,body) VALUES(?,?,?,?,?)')
      .run(chatId, origin, path, JSON.stringify(anchor), body.trim());
  }

  beginTurn(chatId, text, modelId = null, attachments = [], mode = 'code', notes = []) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE chats SET updatedAt=?,
        title=CASE WHEN renamed=0 AND NOT EXISTS (SELECT 1 FROM messages WHERE chatId=chats.id)
        THEN ? ELSE title END WHERE id=?`).run(Date.now(), text.replace(/\s+/g, ' ').slice(0, 60), chatId);
      this.db.prepare("INSERT INTO messages (chatId,role,text,status,attachments) VALUES (?,'user',?,'done',?)")
        .run(chatId, text, JSON.stringify(attachments));
      const message = this.db.prepare("INSERT INTO messages (chatId,role,text,status,modelId,mode) VALUES (?,'assistant','','running',?,?)")
        .run(chatId, modelId, mode);
      for (const id of notes) {
        const update = this.db.prepare('UPDATE review_notes SET reply=? WHERE chatId=? AND id=? AND reply IS NULL AND resolved=0')
          .run(message.lastInsertRowid, chatId, id);
        if (!update.changes) throw Error('Замечания изменились. Откройте ревью ещё раз.');
      }
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

  saveTurn(id, { text, tools, status, error, task }) {
    this.db.prepare('UPDATE messages SET text=?, tools=?, status=?, error=?, task=? WHERE id=?')
      .run(text, JSON.stringify(tools), status, error ?? null, task ? JSON.stringify(task) : null, id);
  }

  snapshot() {
    const activeChat = this.setting('activeChat') ?? null;
    const projects = this.db.prepare('SELECT * FROM projects ORDER BY rowid DESC').all();
    const chats = this.db.prepare('SELECT * FROM chats ORDER BY updatedAt DESC, rowid DESC').all()
      .map(chat => ({ ...chat, pins: JSON.parse(chat.pins), summary: chat.summary ? JSON.parse(chat.summary) : null, workspace: chat.workspace ? JSON.parse(chat.workspace) : null, draftPlan: chat.draftPlan ? JSON.parse(chat.draftPlan) : null }));
    const messages = activeChat ? this.db.prepare(`SELECT messages.*, run_reviews.summary,
      (SELECT json_group_array(DISTINCT path) FROM managed_edits WHERE messageId=messages.id AND state='applied') AS managed
      FROM messages
      LEFT JOIN run_reviews ON messageId=messages.id WHERE chatId=? ORDER BY messages.id`).all(activeChat)
      .map(({ summary, managed, ...message }) => ({ ...message, tools: JSON.parse(message.tools),
        task: message.task ? JSON.parse(message.task) : null,
        attachments: JSON.parse(message.attachments), review: summary ? JSON.parse(summary) : null,
        managedPaths: JSON.parse(managed) })) : [];
    return { activeChat, projects, chats, messages };
  }
}
