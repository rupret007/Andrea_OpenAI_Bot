import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('backfills legacy runtime orchestration actor_ref into actor_id', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE runtime_orchestration_jobs (
          job_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          group_jid TEXT NOT NULL,
          parent_job_id TEXT,
          thread_id TEXT,
          runtime_route TEXT NOT NULL,
          requested_runtime TEXT,
          selected_runtime TEXT,
          status TEXT NOT NULL,
          stop_requested INTEGER DEFAULT 0,
          prompt_preview TEXT NOT NULL,
          latest_output_text TEXT,
          final_output_text TEXT,
          error_text TEXT,
          log_file TEXT,
          source_system TEXT NOT NULL,
          actor_ref TEXT,
          correlation_id TEXT,
          reply_ref TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      legacyDb
        .prepare(
          `
            INSERT INTO runtime_orchestration_jobs (
              job_id, kind, group_folder, group_jid, parent_job_id, thread_id,
              runtime_route, requested_runtime, selected_runtime, status,
              stop_requested, prompt_preview, latest_output_text, final_output_text,
              error_text, log_file, source_system, actor_ref, correlation_id,
              reply_ref, created_at, started_at, finished_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'job-legacy',
          'create',
          'main',
          'tg:main',
          null,
          'thread-legacy',
          'local_required',
          null,
          'codex_local',
          'succeeded',
          0,
          'Legacy job',
          'done',
          'done',
          null,
          null,
          'nanobot',
          'tg:operator',
          'corr-1',
          null,
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          '2026-04-02T00:00:01.000Z',
        );
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getRuntimeOrchestrationJob, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const job = getRuntimeOrchestrationJob('job-legacy');
      expect(job?.actorId).toBe('tg:operator');
      expect(job?.actorType).toBeNull();

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
