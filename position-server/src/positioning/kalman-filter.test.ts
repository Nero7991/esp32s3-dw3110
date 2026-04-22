/**
 * Kalman Filter Unit Tests
 */

import { KalmanFilter } from './kalman-filter';

describe('KalmanFilter', () => {
  describe('2D mode', () => {
    it('should return position close to input on first measurement', () => {
      const filter = new KalmanFilter(false);
      const input = { x: 5, y: 4, z: 0 };

      const result = filter.update(input);

      // First measurement should be close to input
      expect(result.x).toBeCloseTo(input.x, 0);
      expect(result.y).toBeCloseTo(input.y, 0);
    });

    it('should smooth noisy measurements', () => {
      const filter = new KalmanFilter(false);
      const actual = { x: 5, y: 4, z: 0 };
      const noise = 0.1;

      // Feed 20 noisy measurements
      let lastResult = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 20; i++) {
        const noisy = {
          x: actual.x + (Math.random() - 0.5) * noise * 2,
          y: actual.y + (Math.random() - 0.5) * noise * 2,
          z: 0,
        };
        lastResult = filter.update(noisy);
      }

      // Final output should be closer to actual than noise level
      const error = Math.sqrt(
        (lastResult.x - actual.x) ** 2 +
        (lastResult.y - actual.y) ** 2
      );

      expect(error).toBeLessThan(noise);
    });

    it('should converge to new position after step change', () => {
      const filter = new KalmanFilter(false);

      // Settle at position 1
      for (let i = 0; i < 10; i++) {
        filter.update({ x: 0, y: 0, z: 0 });
      }

      // Step to position 2
      let lastResult = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 20; i++) {
        lastResult = filter.update({ x: 5, y: 5, z: 0 });
      }

      // Should have converged to new position
      expect(lastResult.x).toBeCloseTo(5, 0);
      expect(lastResult.y).toBeCloseTo(5, 0);
    });

    it('should track constant velocity motion', () => {
      const filter = new KalmanFilter(false);
      const velocity = { x: 0.5, y: 0.3 }; // per update step

      let pos = { x: 0, y: 0, z: 0 };

      for (let i = 0; i < 30; i++) {
        pos.x += velocity.x;
        pos.y += velocity.y;
        filter.update(pos);
      }

      const estVelocity = filter.getVelocity();

      // Velocity estimate should be in the right direction
      expect(Math.sign(estVelocity.x)).toBe(Math.sign(velocity.x));
      expect(Math.sign(estVelocity.y)).toBe(Math.sign(velocity.y));
    });

    it('should reset state correctly', () => {
      const filter = new KalmanFilter(false);

      // Update with some values
      for (let i = 0; i < 10; i++) {
        filter.update({ x: 10, y: 10, z: 0 });
      }

      filter.reset();

      // After reset, first measurement should dominate
      const result = filter.update({ x: 0, y: 0, z: 0 });
      expect(result.x).toBeCloseTo(0, 0);
      expect(result.y).toBeCloseTo(0, 0);
    });
  });

  describe('3D mode', () => {
    it('should handle 3D positions', () => {
      const filter = new KalmanFilter(true);
      const input = { x: 5, y: 4, z: 1.5 };

      // Update multiple times to settle
      let result = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 10; i++) {
        result = filter.update(input);
      }

      expect(result.x).toBeCloseTo(input.x, 0);
      expect(result.y).toBeCloseTo(input.y, 0);
      expect(result.z).toBeCloseTo(input.z, 0);
    });

    it('should smooth 3D noisy measurements', () => {
      const filter = new KalmanFilter(true);
      const actual = { x: 5, y: 4, z: 2 };
      const noise = 0.1;

      let lastResult = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 20; i++) {
        const noisy = {
          x: actual.x + (Math.random() - 0.5) * noise * 2,
          y: actual.y + (Math.random() - 0.5) * noise * 2,
          z: actual.z + (Math.random() - 0.5) * noise * 2,
        };
        lastResult = filter.update(noisy);
      }

      const error = Math.sqrt(
        (lastResult.x - actual.x) ** 2 +
        (lastResult.y - actual.y) ** 2 +
        (lastResult.z - actual.z) ** 2
      );

      expect(error).toBeLessThan(noise * 1.5);
    });

    it('should provide 3D velocity estimate', () => {
      const filter = new KalmanFilter(true);
      const velocity = { x: 0.3, y: 0.2, z: 0.1 };

      let pos = { x: 0, y: 0, z: 0 };

      for (let i = 0; i < 30; i++) {
        pos.x += velocity.x;
        pos.y += velocity.y;
        pos.z += velocity.z;
        filter.update(pos);
      }

      const estVelocity = filter.getVelocity();

      expect(Math.sign(estVelocity.x)).toBe(Math.sign(velocity.x));
      expect(Math.sign(estVelocity.y)).toBe(Math.sign(velocity.y));
      expect(Math.sign(estVelocity.z)).toBe(Math.sign(velocity.z));
    });
  });

  describe('configuration', () => {
    it('should allow setting measurement noise', () => {
      const filter = new KalmanFilter(false);
      filter.setMeasurementNoise(0.1);

      // Should still work after configuration change
      const result = filter.update({ x: 5, y: 5, z: 0 });
      expect(result).toBeDefined();
    });

    it('should allow setting process noise', () => {
      const filter = new KalmanFilter(false);
      filter.setProcessNoise(0.02, 0.2);

      // Should still work after configuration change
      const result = filter.update({ x: 5, y: 5, z: 0 });
      expect(result).toBeDefined();
    });
  });
});
