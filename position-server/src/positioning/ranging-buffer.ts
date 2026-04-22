/**
 * UWB Positioning System - Ranging Buffer
 *
 * Aggregates distance measurements with time windowing.
 */

import { RangingMeasurement } from '../config/types';

interface TagMeasurements {
  tagId: number;
  anchors: Map<number, RangingMeasurement[]>;
  lastUpdate: Date;
}

class RangingBuffer {
  // Time window in ms - measurements older than this are discarded
  private windowMs: number = 30000;

  // Maximum measurements per anchor to keep
  private maxMeasurements: number = 5;

  // Buffer: tagId -> TagMeasurements
  private buffer: Map<number, TagMeasurements> = new Map();

  public setWindowMs(windowMs: number): void {
    this.windowMs = windowMs;
  }

  public setMaxMeasurements(max: number): void {
    this.maxMeasurements = max;
  }

  public addMeasurement(measurement: RangingMeasurement): void {
    const { tagId, anchorId } = measurement;

    let tagBuffer = this.buffer.get(tagId);
    if (!tagBuffer) {
      tagBuffer = {
        tagId,
        anchors: new Map(),
        lastUpdate: new Date(),
      };
      this.buffer.set(tagId, tagBuffer);
    }

    let anchorMeasurements = tagBuffer.anchors.get(anchorId);
    if (!anchorMeasurements) {
      anchorMeasurements = [];
      tagBuffer.anchors.set(anchorId, anchorMeasurements);
    }

    // Add new measurement
    anchorMeasurements.push(measurement);

    // Trim to max measurements
    if (anchorMeasurements.length > this.maxMeasurements) {
      anchorMeasurements.shift();
    }

    tagBuffer.lastUpdate = new Date();

    // Clean old measurements
    this.cleanOldMeasurements(tagBuffer);
  }

  private cleanOldMeasurements(tagBuffer: TagMeasurements): void {
    const cutoff = Date.now() - this.windowMs;

    for (const [anchorId, measurements] of tagBuffer.anchors) {
      const filtered = measurements.filter(
        m => m.timestamp.getTime() > cutoff
      );

      if (filtered.length === 0) {
        tagBuffer.anchors.delete(anchorId);
      } else {
        tagBuffer.anchors.set(anchorId, filtered);
      }
    }
  }

  /**
   * Get latest distances for a tag, one per anchor.
   * Returns Map<anchorId, distanceCm>
   */
  public getLatestDistances(tagId: number): Map<number, number> | null {
    const tagBuffer = this.buffer.get(tagId);
    if (!tagBuffer) return null;

    // Clean old measurements first
    this.cleanOldMeasurements(tagBuffer);

    if (tagBuffer.anchors.size === 0) return null;

    const distances = new Map<number, number>();

    for (const [anchorId, measurements] of tagBuffer.anchors) {
      if (measurements.length > 0) {
        // Use median of recent measurements for robustness
        const sorted = [...measurements]
          .map(m => m.distanceCm)
          .sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        distances.set(anchorId, median);
      }
    }

    return distances.size > 0 ? distances : null;
  }

  /**
   * Get averaged distances for a tag.
   */
  public getAveragedDistances(tagId: number): Map<number, number> | null {
    const tagBuffer = this.buffer.get(tagId);
    if (!tagBuffer) return null;

    this.cleanOldMeasurements(tagBuffer);

    if (tagBuffer.anchors.size === 0) return null;

    const distances = new Map<number, number>();

    for (const [anchorId, measurements] of tagBuffer.anchors) {
      if (measurements.length > 0) {
        const sum = measurements.reduce((s, m) => s + m.distanceCm, 0);
        const avg = sum / measurements.length;
        distances.set(anchorId, avg);
      }
    }

    return distances.size > 0 ? distances : null;
  }

  public getAnchorCount(tagId: number): number {
    const tagBuffer = this.buffer.get(tagId);
    if (!tagBuffer) return 0;

    this.cleanOldMeasurements(tagBuffer);
    return tagBuffer.anchors.size;
  }

  public getTagIds(): number[] {
    return Array.from(this.buffer.keys());
  }

  public clear(tagId?: number): void {
    if (tagId !== undefined) {
      this.buffer.delete(tagId);
    } else {
      this.buffer.clear();
    }
  }
}

export const rangingBuffer = new RangingBuffer();
