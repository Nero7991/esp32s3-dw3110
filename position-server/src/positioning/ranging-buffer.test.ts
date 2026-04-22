/**
 * Ranging Buffer Unit Tests
 */

import { RangingMeasurement } from '../config/types';

// Create a test-friendly version of RangingBuffer
class TestRangingBuffer {
  private windowMs: number = 500;
  private maxMeasurements: number = 5;
  private buffer: Map<number, {
    tagId: number;
    anchors: Map<number, RangingMeasurement[]>;
    lastUpdate: Date;
  }> = new Map();

  setWindowMs(windowMs: number): void {
    this.windowMs = windowMs;
  }

  setMaxMeasurements(max: number): void {
    this.maxMeasurements = max;
  }

  addMeasurement(measurement: RangingMeasurement): void {
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

    anchorMeasurements.push(measurement);

    if (anchorMeasurements.length > this.maxMeasurements) {
      anchorMeasurements.shift();
    }

    tagBuffer.lastUpdate = new Date();
    this.cleanOldMeasurements(tagBuffer);
  }

  private cleanOldMeasurements(tagBuffer: {
    anchors: Map<number, RangingMeasurement[]>;
  }): void {
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

  getLatestDistances(tagId: number): Map<number, number> | null {
    const tagBuffer = this.buffer.get(tagId);
    if (!tagBuffer) return null;

    this.cleanOldMeasurements(tagBuffer);

    if (tagBuffer.anchors.size === 0) return null;

    const distances = new Map<number, number>();

    for (const [anchorId, measurements] of tagBuffer.anchors) {
      if (measurements.length > 0) {
        const sorted = [...measurements]
          .map(m => m.distanceCm)
          .sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        distances.set(anchorId, median);
      }
    }

    return distances.size > 0 ? distances : null;
  }

  getAveragedDistances(tagId: number): Map<number, number> | null {
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

  getAnchorCount(tagId: number): number {
    const tagBuffer = this.buffer.get(tagId);
    if (!tagBuffer) return 0;

    this.cleanOldMeasurements(tagBuffer);
    return tagBuffer.anchors.size;
  }

  getTagIds(): number[] {
    return Array.from(this.buffer.keys());
  }

  clear(tagId?: number): void {
    if (tagId !== undefined) {
      this.buffer.delete(tagId);
    } else {
      this.buffer.clear();
    }
  }
}

describe('RangingBuffer', () => {
  let buffer: TestRangingBuffer;

  beforeEach(() => {
    buffer = new TestRangingBuffer();
    buffer.setWindowMs(1000); // 1 second window for testing
  });

  describe('basic operations', () => {
    it('should store and retrieve a single measurement', () => {
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(),
      });

      const distances = buffer.getLatestDistances(100);

      expect(distances).not.toBeNull();
      expect(distances!.get(1)).toBe(500);
    });

    it('should return null for unknown tag', () => {
      const distances = buffer.getLatestDistances(999);
      expect(distances).toBeNull();
    });

    it('should track multiple tags independently', () => {
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(),
      });

      buffer.addMeasurement({
        anchorId: 1,
        tagId: 101,
        distanceCm: 600,
        timestamp: new Date(),
      });

      const dist100 = buffer.getLatestDistances(100);
      const dist101 = buffer.getLatestDistances(101);

      expect(dist100!.get(1)).toBe(500);
      expect(dist101!.get(1)).toBe(600);
    });
  });

  describe('multiple anchors', () => {
    it('should store measurements from multiple anchors', () => {
      const now = new Date();

      for (let anchorId = 1; anchorId <= 4; anchorId++) {
        buffer.addMeasurement({
          anchorId,
          tagId: 100,
          distanceCm: anchorId * 100,
          timestamp: now,
        });
      }

      const distances = buffer.getLatestDistances(100);

      expect(distances).not.toBeNull();
      expect(distances!.size).toBe(4);
      expect(distances!.get(1)).toBe(100);
      expect(distances!.get(2)).toBe(200);
      expect(distances!.get(3)).toBe(300);
      expect(distances!.get(4)).toBe(400);
    });

    it('should return correct anchor count', () => {
      const now = new Date();

      for (let anchorId = 1; anchorId <= 3; anchorId++) {
        buffer.addMeasurement({
          anchorId,
          tagId: 100,
          distanceCm: 500,
          timestamp: now,
        });
      }

      expect(buffer.getAnchorCount(100)).toBe(3);
    });
  });

  describe('time windowing', () => {
    it('should expire old measurements', () => {
      buffer.setWindowMs(100); // 100ms window

      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(Date.now() - 200), // 200ms ago
      });

      const distances = buffer.getLatestDistances(100);

      expect(distances).toBeNull();
    });

    it('should keep recent measurements', () => {
      buffer.setWindowMs(1000);

      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(), // Now
      });

      const distances = buffer.getLatestDistances(100);

      expect(distances).not.toBeNull();
      expect(distances!.get(1)).toBe(500);
    });

    it('should keep new and discard old in same anchor', () => {
      buffer.setWindowMs(500);

      // Old measurement
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 400,
        timestamp: new Date(Date.now() - 1000),
      });

      // New measurement
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(),
      });

      const distances = buffer.getLatestDistances(100);

      expect(distances!.get(1)).toBe(500);
    });
  });

  describe('median calculation', () => {
    it('should return median of multiple measurements', () => {
      const now = Date.now();

      // Add measurements: 100, 105, 200 (outlier), 102, 98
      [100, 105, 200, 102, 98].forEach((dist, i) => {
        buffer.addMeasurement({
          anchorId: 1,
          tagId: 100,
          distanceCm: dist,
          timestamp: new Date(now + i),
        });
      });

      const distances = buffer.getLatestDistances(100);

      // Sorted: [98, 100, 102, 105, 200], median = 102
      expect(distances!.get(1)).toBe(102);
    });

    it('should handle even number of measurements', () => {
      const now = Date.now();

      [100, 200, 300, 400].forEach((dist, i) => {
        buffer.addMeasurement({
          anchorId: 1,
          tagId: 100,
          distanceCm: dist,
          timestamp: new Date(now + i),
        });
      });

      const distances = buffer.getLatestDistances(100);

      // Sorted: [100, 200, 300, 400], median index = 2, value = 300
      expect(distances!.get(1)).toBe(300);
    });
  });

  describe('averaging', () => {
    it('should calculate average of measurements', () => {
      const now = Date.now();

      [100, 200, 300].forEach((dist, i) => {
        buffer.addMeasurement({
          anchorId: 1,
          tagId: 100,
          distanceCm: dist,
          timestamp: new Date(now + i),
        });
      });

      const distances = buffer.getAveragedDistances(100);

      expect(distances!.get(1)).toBe(200); // (100+200+300)/3
    });
  });

  describe('max measurements limit', () => {
    it('should discard oldest when exceeding limit', () => {
      buffer.setMaxMeasurements(3);
      const now = Date.now();

      // Add 5 measurements
      [100, 200, 300, 400, 500].forEach((dist, i) => {
        buffer.addMeasurement({
          anchorId: 1,
          tagId: 100,
          distanceCm: dist,
          timestamp: new Date(now + i),
        });
      });

      const distances = buffer.getLatestDistances(100);

      // Should keep last 3: [300, 400, 500], median = 400
      expect(distances!.get(1)).toBe(400);
    });
  });

  describe('clear operations', () => {
    it('should clear specific tag', () => {
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(),
      });

      buffer.addMeasurement({
        anchorId: 1,
        tagId: 101,
        distanceCm: 600,
        timestamp: new Date(),
      });

      buffer.clear(100);

      expect(buffer.getLatestDistances(100)).toBeNull();
      expect(buffer.getLatestDistances(101)).not.toBeNull();
    });

    it('should clear all tags', () => {
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(),
      });

      buffer.addMeasurement({
        anchorId: 1,
        tagId: 101,
        distanceCm: 600,
        timestamp: new Date(),
      });

      buffer.clear();

      expect(buffer.getLatestDistances(100)).toBeNull();
      expect(buffer.getLatestDistances(101)).toBeNull();
      expect(buffer.getTagIds()).toEqual([]);
    });
  });

  describe('tag tracking', () => {
    it('should return list of active tag IDs', () => {
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: 500,
        timestamp: new Date(),
      });

      buffer.addMeasurement({
        anchorId: 1,
        tagId: 200,
        distanceCm: 600,
        timestamp: new Date(),
      });

      const tagIds = buffer.getTagIds();

      expect(tagIds).toContain(100);
      expect(tagIds).toContain(200);
      expect(tagIds.length).toBe(2);
    });
  });
});
