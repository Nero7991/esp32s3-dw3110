/**
 * UWB Positioning System - Database Storage
 *
 * SQLite persistence for position history.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.join(__dirname, '../../data/positions.db');

interface PositionRecord {
  id: number;
  tag_id: number;
  x: number;
  y: number;
  z: number;
  accuracy_cm: number;
  timestamp: string;
}

class DatabaseManager {
  private db: Database.Database | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    try {
      // Ensure data directory exists
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(DB_PATH);

      // Create tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag_id INTEGER NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          z REAL NOT NULL,
          accuracy_cm INTEGER NOT NULL,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_positions_tag_id ON positions(tag_id);
        CREATE INDEX IF NOT EXISTS idx_positions_timestamp ON positions(timestamp);

        CREATE TABLE IF NOT EXISTS ranging_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          anchor_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          distance_cm INTEGER NOT NULL,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ranging_tag_id ON ranging_log(tag_id);
        CREATE INDEX IF NOT EXISTS idx_ranging_timestamp ON ranging_log(timestamp);
      `);

      console.log('Database initialized');
    } catch (err) {
      console.error('Database initialization error:', err);
    }
  }

  public savePosition(position: {
    tagId: number;
    x: number;
    y: number;
    z: number;
    accuracyCm: number;
    timestamp: Date;
  }): void {
    if (!this.db) return;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO positions (tag_id, x, y, z, accuracy_cm, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        position.tagId,
        position.x,
        position.y,
        position.z,
        position.accuracyCm,
        position.timestamp.toISOString()
      );
    } catch (err) {
      console.error('Error saving position:', err);
    }
  }

  public saveRanging(ranging: {
    anchorId: number;
    tagId: number;
    distanceCm: number;
    timestamp: Date;
  }): void {
    if (!this.db) return;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO ranging_log (anchor_id, tag_id, distance_cm, timestamp)
        VALUES (?, ?, ?, ?)
      `);

      stmt.run(
        ranging.anchorId,
        ranging.tagId,
        ranging.distanceCm,
        ranging.timestamp.toISOString()
      );
    } catch (err) {
      console.error('Error saving ranging:', err);
    }
  }

  public getPositionHistory(
    tagId: number,
    limit: number = 100,
    since?: Date
  ): Array<{
    x: number;
    y: number;
    z: number;
    accuracyCm: number;
    timestamp: string;
  }> {
    if (!this.db) return [];

    try {
      let query = `
        SELECT x, y, z, accuracy_cm as accuracyCm, timestamp
        FROM positions
        WHERE tag_id = ?
      `;
      const params: any[] = [tagId];

      if (since) {
        query += ' AND timestamp > ?';
        params.push(since.toISOString());
      }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);

      const stmt = this.db.prepare(query);
      return stmt.all(...params) as any[];
    } catch (err) {
      console.error('Error getting position history:', err);
      return [];
    }
  }

  public getRangingHistory(
    tagId: number,
    limit: number = 100,
    since?: Date
  ): Array<{
    anchorId: number;
    distanceCm: number;
    timestamp: string;
  }> {
    if (!this.db) return [];

    try {
      let query = `
        SELECT anchor_id as anchorId, distance_cm as distanceCm, timestamp
        FROM ranging_log
        WHERE tag_id = ?
      `;
      const params: any[] = [tagId];

      if (since) {
        query += ' AND timestamp > ?';
        params.push(since.toISOString());
      }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);

      const stmt = this.db.prepare(query);
      return stmt.all(...params) as any[];
    } catch (err) {
      console.error('Error getting ranging history:', err);
      return [];
    }
  }

  public cleanup(olderThanHours: number = 24): number {
    if (!this.db) return 0;

    try {
      const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
      const cutoffStr = cutoff.toISOString();

      const stmt1 = this.db.prepare('DELETE FROM positions WHERE timestamp < ?');
      const result1 = stmt1.run(cutoffStr);

      const stmt2 = this.db.prepare('DELETE FROM ranging_log WHERE timestamp < ?');
      const result2 = stmt2.run(cutoffStr);

      const deleted = (result1.changes || 0) + (result2.changes || 0);
      console.log(`Database cleanup: deleted ${deleted} old records`);
      return deleted;
    } catch (err) {
      console.error('Error during cleanup:', err);
      return 0;
    }
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const db = new DatabaseManager();
