import type { DatabaseSync } from "node:sqlite";

// Keep the ciphertext in documents so backup, history and lifecycle use the same database.
export function migratePlayground(db: DatabaseSync, version: number) {
  if (version < 3) db.exec(`
    BEGIN IMMEDIATE;
    CREATE INDEX IF NOT EXISTS web_play_rooms_space ON documents(json_extract(data, '$.spaceId'), id)
      WHERE collection = 'play_rooms';
    CREATE INDEX IF NOT EXISTS web_play_works_space ON documents(json_extract(data, '$.spaceId'), id)
      WHERE collection = 'play_works';
    CREATE INDEX IF NOT EXISTS web_play_room_expiry ON documents(json_extract(data, '$.expiresAt'), id)
      WHERE collection = 'play_rooms';
    PRAGMA user_version = 3;
    COMMIT;
  `);
  // Legacy deadlines were assigned automatically. An unfinished room must have both votes.
  db.exec(`
    UPDATE documents SET data = json_set(data, '$.expiresAt', NULL)
      WHERE collection = 'play_rooms' AND json_extract(data, '$.expiresAt') > 0
      AND json_extract(data, '$.status') <> 'completed'
      AND (coalesce(json_extract(data, '$.cleanupVotes[0]'), -1) NOT IN (0, 1)
        OR coalesce(json_extract(data, '$.cleanupVotes[1]'), -1) NOT IN (0, 1)
        OR json_extract(data, '$.cleanupVotes[0]') = json_extract(data, '$.cleanupVotes[1]'));
  `);
}
