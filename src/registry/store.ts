import { Database } from "bun:sqlite";
import type { Manifest, Agent } from "./schema.ts";

export type StoredApp = {
  id: string;
  base_url: string;
  app_token: string;
  registered_at: number;
  manifest: Manifest | null;
  manifest_fetched_at: number | null;
};

export type AgentLookup = { app: StoredApp; agent: Agent };

export type Store = {
  upsertApp(input: {
    id: string;
    base_url: string;
    app_token: string;
    manifest: Manifest;
  }): void;
  getApp(id: string): StoredApp | null;
  listApps(): StoredApp[];
  lookupAgent(agentId: string): AgentLookup | null;
  deleteApp(id: string): void;
  close(): void;
};

export function createStore(opts: { dbPath: string }): Store {
  const db = new Database(opts.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      app_token TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      manifest_json TEXT,
      manifest_fetched_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agents_app_idx ON agents(app_id);
  `);

  const rowToApp = (row: any): StoredApp => ({
    id: row.id,
    base_url: row.base_url,
    app_token: row.app_token,
    registered_at: row.registered_at,
    manifest: row.manifest_json ? (JSON.parse(row.manifest_json) as Manifest) : null,
    manifest_fetched_at: row.manifest_fetched_at,
  });

  const upsertAppStmt = db.prepare(`
    INSERT INTO apps (id, base_url, app_token, registered_at, manifest_json, manifest_fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      base_url = excluded.base_url,
      app_token = excluded.app_token,
      manifest_json = excluded.manifest_json,
      manifest_fetched_at = excluded.manifest_fetched_at
  `);

  const deleteOtherAgentsStmt = db.prepare(
    `DELETE FROM agents WHERE app_id = ? AND id NOT IN (SELECT value FROM json_each(?))`,
  );
  const insertAgentStmt = db.prepare(
    `INSERT OR REPLACE INTO agents (id, app_id) VALUES (?, ?)`,
  );

  return {
    upsertApp(input) {
      const now = Date.now();
      // First, check that no agent id in the new manifest belongs to a different app.
      const conflictStmt = db.prepare(
        `SELECT id FROM agents WHERE id = ? AND app_id != ?`,
      );
      for (const a of input.manifest.agents) {
        const conflict = conflictStmt.get(a.id, input.id) as { id: string } | null;
        if (conflict) {
          throw new Error(`Agent id "${a.id}" is already owned by another app`);
        }
      }
      db.transaction(() => {
        upsertAppStmt.run(
          input.id,
          input.base_url,
          input.app_token,
          now,
          JSON.stringify(input.manifest),
          now,
        );
        const keepIds = JSON.stringify(input.manifest.agents.map((a) => a.id));
        deleteOtherAgentsStmt.run(input.id, keepIds);
        for (const a of input.manifest.agents) {
          insertAgentStmt.run(a.id, input.id);
        }
      })();
    },

    getApp(id) {
      const row = db.query(`SELECT * FROM apps WHERE id = ?`).get(id) as any;
      return row ? rowToApp(row) : null;
    },

    listApps() {
      const rows = db.query(`SELECT * FROM apps`).all() as any[];
      return rows.map(rowToApp);
    },

    lookupAgent(agentId) {
      const row = db
        .query(
          `SELECT apps.* FROM apps
           JOIN agents ON agents.app_id = apps.id
           WHERE agents.id = ?`,
        )
        .get(agentId) as any;
      if (!row) return null;
      const app = rowToApp(row);
      const agent = app.manifest?.agents.find((a) => a.id === agentId);
      if (!agent) return null;
      return { app, agent };
    },

    deleteApp(id) {
      db.query(`DELETE FROM apps WHERE id = ?`).run(id);
    },

    close() {
      db.close();
    },
  };
}
