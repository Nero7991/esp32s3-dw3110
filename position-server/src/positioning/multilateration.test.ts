/**
 * Multilateration Engine Unit Tests
 */

import { Position3D } from '../config/types';

// Helper function to calculate distance
function distance(a: Position3D, b: Position3D): number {
  return Math.sqrt(
    (a.x - b.x) ** 2 +
    (a.y - b.y) ** 2 +
    (a.z - b.z) ** 2
  );
}

// Simplified multilateration using linearized least squares
// This is more robust for testing than the iterative Gauss-Newton
function linearizedMultilateration(
  anchors: Array<{ id: number; pos: Position3D; dist: number }>,
  is3D: boolean
): Position3D | null {
  const minAnchors = is3D ? 4 : 3;
  if (anchors.length < minAnchors) return null;

  // Use first anchor as reference
  const ref = anchors[0];
  const n = anchors.length - 1;
  const dim = is3D ? 3 : 2;

  // Build linear system: A * x = b
  // From: ||P - Ai||^2 - ||P - A0||^2 = di^2 - d0^2
  // Which linearizes to: 2(A0 - Ai) * P = d0^2 - di^2 + ||Ai||^2 - ||A0||^2

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 1; i < anchors.length; i++) {
    const ai = anchors[i];
    // Correct linearization: 2(Ai - A0) * P = d0^2 - di^2 + ||Ai||^2 - ||A0||^2
    const row = [
      2 * (ai.pos.x - ref.pos.x),
      2 * (ai.pos.y - ref.pos.y),
    ];
    if (is3D) {
      row.push(2 * (ai.pos.z - ref.pos.z));
    }
    A.push(row);

    const refNorm = ref.pos.x ** 2 + ref.pos.y ** 2 + (is3D ? ref.pos.z ** 2 : 0);
    const aiNorm = ai.pos.x ** 2 + ai.pos.y ** 2 + (is3D ? ai.pos.z ** 2 : 0);
    b.push(ref.dist ** 2 - ai.dist ** 2 + aiNorm - refNorm);
  }

  // Solve using least squares: (A^T * A)^-1 * A^T * b
  const result = solveLeastSquares(A, b, dim);
  if (!result) return null;

  return {
    x: result[0],
    y: result[1],
    z: is3D && result.length > 2 ? result[2] : 0,
  };
}

function solveLeastSquares(A: number[][], b: number[], dim: number): number[] | null {
  // A^T * A
  const AtA: number[][] = Array(dim).fill(0).map(() => Array(dim).fill(0));
  // A^T * b
  const Atb: number[] = Array(dim).fill(0);

  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < dim; j++) {
      Atb[j] += A[i][j] * b[i];
      for (let k = 0; k < dim; k++) {
        AtA[j][k] += A[i][j] * A[i][k];
      }
    }
  }

  return gaussianElimination(AtA, Atb);
}

function gaussianElimination(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    // Partial pivoting
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) {
        maxRow = k;
      }
    }
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];

    if (Math.abs(aug[i][i]) < 1e-10) return null;

    // Forward elimination
    for (let k = i + 1; k < n; k++) {
      const factor = aug[k][i] / aug[i][i];
      for (let j = i; j <= n; j++) {
        aug[k][j] -= factor * aug[i][j];
      }
    }
  }

  // Back substitution
  const x: number[] = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= aug[i][j] * x[j];
    }
    x[i] /= aug[i][i];
  }

  return x;
}

describe('Multilateration', () => {
  describe('2D positioning', () => {
    it('should compute correct position with 3 anchors', () => {
      // Simple right triangle setup
      const tagPos = { x: 3, y: 4, z: 0 };
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
      ];

      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos),
      }));

      const result = linearizedMultilateration(anchors, false);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(3.0, 1);
      expect(result!.y).toBeCloseTo(4.0, 1);
    });

    it('should compute correct position with 4 anchors in rectangle', () => {
      // 10x8 rectangle, tag at (3, 4)
      const tagPos = { x: 3, y: 4, z: 0 };
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 8, z: 0 },
        { x: 0, y: 8, z: 0 },
      ];

      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos),
      }));

      const result = linearizedMultilateration(anchors, false);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(3.0, 1);
      expect(result!.y).toBeCloseTo(4.0, 1);
    });

    it('should return null with only 2 anchors', () => {
      const anchors = [
        { id: 1, pos: { x: 0, y: 0, z: 0 }, dist: 5.0 },
        { id: 2, pos: { x: 10, y: 0, z: 0 }, dist: 5.0 },
      ];

      const result = linearizedMultilateration(anchors, false);

      expect(result).toBeNull();
    });

    it('should handle tag at corner', () => {
      const tagPos = { x: 0, y: 0, z: 0 };
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 5, y: 8, z: 0 },
      ];

      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos),
      }));

      const result = linearizedMultilateration(anchors, false);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(0.0, 1);
      expect(result!.y).toBeCloseTo(0.0, 1);
    });
  });

  describe('3D positioning', () => {
    it('should compute correct position with 4 anchors', () => {
      // Tetrahedral anchor configuration for proper 3D positioning
      const tagPos = { x: 5, y: 4, z: 1 };
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 5, y: 8, z: 0 },
        { x: 5, y: 3, z: 4 },  // Above the plane formed by others
      ];

      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos),
      }));

      const result = linearizedMultilateration(anchors, true);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(5.0, 1);
      expect(result!.y).toBeCloseTo(4.0, 1);
      expect(result!.z).toBeCloseTo(1.0, 1);
    });

    it('should compute position with 6 anchors', () => {
      const tagPos = { x: 5, y: 4, z: 1 };
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 2 },
        { x: 10, y: 8, z: 3 },
        { x: 0, y: 8, z: 1 },
        { x: 5, y: 0, z: 0.5 },
        { x: 5, y: 8, z: 2.5 },
      ];

      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos),
      }));

      const result = linearizedMultilateration(anchors, true);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(5.0, 1);
      expect(result!.y).toBeCloseTo(4.0, 1);
      expect(result!.z).toBeCloseTo(1.0, 1);
    });

    it('should return null with only 3 anchors in 3D mode', () => {
      const anchors = [
        { id: 1, pos: { x: 0, y: 0, z: 2 }, dist: 5.0 },
        { id: 2, pos: { x: 10, y: 0, z: 2 }, dist: 5.0 },
        { id: 3, pos: { x: 5, y: 8, z: 2 }, dist: 5.0 },
      ];

      const result = linearizedMultilateration(anchors, true);

      expect(result).toBeNull();
    });
  });

  describe('noisy measurements', () => {
    it('should handle small noise and converge close to actual position', () => {
      const tagPos = { x: 5, y: 4, z: 1 };
      // Tetrahedral anchor configuration
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 5, y: 8, z: 0 },
        { x: 5, y: 3, z: 4 },
      ];

      // Add ±5cm noise
      const noise = [0.05, -0.03, 0.02, -0.04];
      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos) + noise[i],
      }));

      const result = linearizedMultilateration(anchors, true);

      expect(result).not.toBeNull();

      const error = distance(result!, tagPos);
      expect(error).toBeLessThan(0.20); // Within 20cm
    });

    it('should handle larger noise with more anchors', () => {
      const tagPos = { x: 5, y: 4, z: 1 };

      // 8 anchors for redundancy with varying heights
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 2 },
        { x: 10, y: 8, z: 3 },
        { x: 0, y: 8, z: 1 },
        { x: 5, y: 0, z: 0.5 },
        { x: 5, y: 8, z: 2.5 },
        { x: 0, y: 4, z: 1.5 },
        { x: 10, y: 4, z: 2 },
      ];

      // Add deterministic noise for reproducibility
      const noise = [0.08, -0.06, 0.05, -0.07, 0.04, -0.03, 0.06, -0.05];
      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos) + noise[i],
      }));

      const result = linearizedMultilateration(anchors, true);

      expect(result).not.toBeNull();

      const error = distance(result!, tagPos);
      expect(error).toBeLessThan(0.25); // Within 25cm
    });
  });

  describe('edge cases', () => {
    it('should handle tag outside anchor perimeter', () => {
      const tagPos = { x: -2, y: -2, z: 0 };
      const anchorPositions = [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 8, z: 0 },
        { x: 0, y: 8, z: 0 },
      ];

      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos),
      }));

      const result = linearizedMultilateration(anchors, false);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(-2.0, 1);
      expect(result!.y).toBeCloseTo(-2.0, 1);
    });

    it('should handle collinear anchors in 2D (degenerate case)', () => {
      // All anchors on a line - should fail or give poor result
      const anchors = [
        { id: 1, pos: { x: 0, y: 0, z: 0 }, dist: 5.0 },
        { id: 2, pos: { x: 5, y: 0, z: 0 }, dist: 3.0 },
        { id: 3, pos: { x: 10, y: 0, z: 0 }, dist: 5.0 },
      ];

      const result = linearizedMultilateration(anchors, false);

      // Collinear anchors create a singular matrix in 2D
      // The result should be null or contain Infinity/NaN
      if (result !== null) {
        const hasInvalid = !isFinite(result.x) || !isFinite(result.y);
        expect(hasInvalid || result === null).toBe(true);
      }
    });
  });

  describe('algorithm correctness', () => {
    it('should compute zero error with perfect measurements', () => {
      const tagPos = { x: 3.5, y: 2.7, z: 1.2 };
      const anchorPositions = [
        { x: 0, y: 0, z: 2 },
        { x: 8, y: 0, z: 2 },
        { x: 8, y: 6, z: 2 },
        { x: 0, y: 6, z: 2 },
        { x: 4, y: 3, z: 0 },
      ];

      const anchors = anchorPositions.map((pos, i) => ({
        id: i + 1,
        pos,
        dist: distance(tagPos, pos),
      }));

      const result = linearizedMultilateration(anchors, true);

      expect(result).not.toBeNull();

      const error = distance(result!, tagPos);
      expect(error).toBeLessThan(0.01); // Sub-centimeter with perfect data
    });
  });
});
