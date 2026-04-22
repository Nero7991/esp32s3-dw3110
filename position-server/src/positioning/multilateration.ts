/**
 * UWB Positioning System - Multilateration Engine
 *
 * Computes 3D position from distance measurements to known anchor positions.
 * Uses Gauss-Newton nonlinear least squares optimization.
 */

import { Position3D } from '../config/types';
import { anchorConfig } from '../config/anchor-config';
import { rangingBuffer } from './ranging-buffer';
import { KalmanFilter } from './kalman-filter';
import { db } from '../storage/db';

interface PositionResult {
  tagId: number;
  x: number;
  y: number;
  z: number;
  accuracyCm: number;
  timestamp: Date;
}

class MultilaterationEngine {
  // Minimum anchors needed for 3D positioning
  private minAnchors3D = 4;
  private minAnchors2D = 2;

  // Maximum iterations for optimization
  private maxIterations = 50;

  // Convergence threshold in meters
  private convergenceThreshold = 0.001;

  // Kalman filters for each tag
  private filters: Map<number, KalmanFilter> = new Map();

  // Current positions
  private positions: Map<number, PositionResult> = new Map();

  /**
   * Compute position for a tag using available measurements.
   */
  public computePosition(tagId: number): PositionResult | null {
    const distances = rangingBuffer.getLatestDistances(tagId);
    if (!distances) return null;

    const anchorPositions = anchorConfig.getAnchorPositions();

    // Filter to only anchors we have both distance and position for
    const validAnchors: Array<{ id: number; pos: Position3D; dist: number }> = [];

    for (const [anchorId, distCm] of distances) {
      const pos = anchorPositions.get(anchorId);
      if (pos) {
        validAnchors.push({
          id: anchorId,
          pos,
          dist: distCm / 100, // Convert cm to meters
        });
      }
    }

    if (validAnchors.length < this.minAnchors2D) {
      return null;
    }

    // Perform multilateration
    const is3D = validAnchors.length >= this.minAnchors3D;
    const position = this.gaussNewton(validAnchors, is3D);

    if (!position) return null;

    // Apply Kalman filter
    let filter = this.filters.get(tagId);
    if (!filter) {
      filter = new KalmanFilter(is3D);
      this.filters.set(tagId, filter);
    }

    const filtered = filter.update(position);

    // Calculate accuracy (residual error)
    const accuracyCm = this.calculateResidual(filtered, validAnchors) * 100;

    const result: PositionResult = {
      tagId,
      x: filtered.x,
      y: filtered.y,
      z: filtered.z,
      accuracyCm: Math.round(accuracyCm),
      timestamp: new Date(),
    };

    // Store result
    this.positions.set(tagId, result);

    // Save to database
    db.savePosition(result);

    return result;
  }

  /**
   * Gauss-Newton optimization for multilateration.
   */
  private gaussNewton(
    anchors: Array<{ id: number; pos: Position3D; dist: number }>,
    is3D: boolean
  ): Position3D | null {
    // Initial guess: centroid of anchors
    let x = anchors.reduce((s, a) => s + a.pos.x, 0) / anchors.length;
    let y = anchors.reduce((s, a) => s + a.pos.y, 0) / anchors.length;
    let z = is3D ? anchors.reduce((s, a) => s + a.pos.z, 0) / anchors.length : 0;

    for (let iter = 0; iter < this.maxIterations; iter++) {
      const n = anchors.length;
      const dim = is3D ? 3 : 2;

      // Build Jacobian matrix and residual vector
      const J: number[][] = [];
      const r: number[] = [];

      for (const anchor of anchors) {
        const dx = x - anchor.pos.x;
        const dy = y - anchor.pos.y;
        const dz = is3D ? z - anchor.pos.z : 0;

        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < 0.001) continue; // Avoid division by zero

        // Residual: measured - calculated
        r.push(anchor.dist - dist);

        // Jacobian row
        const row = [-dx / dist, -dy / dist];
        if (is3D) row.push(-dz / dist);
        J.push(row);
      }

      if (J.length < dim) {
        if (iter === 0) console.log(`GN: J.length=${J.length} < dim=${dim} at iter ${iter}`);
        return null;
      }

      // Solve damped normal equations: (J^T * J + lambda*I) * delta = J^T * r
      // Levenberg-Marquardt damping prevents divergence
      const lambda = 0.1;
      const delta = this.solveNormalEquations(J, r, dim, lambda);

      if (!delta) {
        // Singular even with damping -- return best estimate so far
        break;
      }

      // Limit step size to prevent wild oscillation
      const stepSize = Math.sqrt(delta.reduce((s, d) => s + d * d, 0));
      const maxStep = 1.0; // max 1 meter per iteration
      const scale = stepSize > maxStep ? maxStep / stepSize : 1.0;

      // Update position
      x += delta[0] * scale;
      y += delta[1] * scale;
      if (is3D && delta.length > 2) {
        z += delta[2];
      }

      // Check convergence
      const deltaSize = Math.sqrt(delta.reduce((s, d) => s + d * d, 0));
      if (deltaSize < this.convergenceThreshold) {
        break;
      }
    }

    return { x, y, z };
  }

  /**
   * Solve normal equations using simple matrix operations.
   */
  private solveNormalEquations(
    J: number[][],
    r: number[],
    dim: number,
    lambda: number = 0
  ): number[] | null {
    // J^T * J
    const JtJ: number[][] = Array(dim)
      .fill(0)
      .map(() => Array(dim).fill(0));

    // J^T * r
    const Jtr: number[] = Array(dim).fill(0);

    for (let i = 0; i < J.length; i++) {
      for (let j = 0; j < dim; j++) {
        Jtr[j] += J[i][j] * r[i];
        for (let k = 0; k < dim; k++) {
          JtJ[j][k] += J[i][j] * J[i][k];
        }
      }
    }

    // Levenberg-Marquardt damping: add lambda to diagonal
    if (lambda > 0) {
      for (let i = 0; i < dim; i++) {
        JtJ[i][i] += lambda;
      }
    }

    // Solve using Gaussian elimination with partial pivoting
    return this.gaussianElimination(JtJ, Jtr);
  }

  /**
   * Gaussian elimination with partial pivoting.
   */
  private gaussianElimination(A: number[][], b: number[]): number[] | null {
    const n = A.length;
    const aug = A.map((row, i) => [...row, b[i]]);

    // Forward elimination
    for (let i = 0; i < n; i++) {
      // Find pivot
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) {
          maxRow = k;
        }
      }
      [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];

      if (Math.abs(aug[i][i]) < 1e-10) {
        return null; // Singular matrix
      }

      // Eliminate column
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

  /**
   * Calculate root mean square residual error.
   */
  private calculateResidual(
    position: Position3D,
    anchors: Array<{ pos: Position3D; dist: number }>
  ): number {
    let sumSqError = 0;

    for (const anchor of anchors) {
      const dx = position.x - anchor.pos.x;
      const dy = position.y - anchor.pos.y;
      const dz = position.z - anchor.pos.z;
      const calcDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const error = anchor.dist - calcDist;
      sumSqError += error * error;
    }

    return Math.sqrt(sumSqError / anchors.length);
  }

  public getPosition(tagId: number): PositionResult | null {
    return this.positions.get(tagId) || null;
  }

  public getAllPositions(): PositionResult[] {
    return Array.from(this.positions.values());
  }

  public getPositionCount(): number {
    return this.positions.size;
  }

  public clearPosition(tagId: number): void {
    this.positions.delete(tagId);
    this.filters.delete(tagId);
  }
}

export const positionEngine = new MultilaterationEngine();
