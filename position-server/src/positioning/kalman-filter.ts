/**
 * UWB Positioning System - Kalman Filter
 *
 * Simple Kalman filter for position smoothing.
 * Assumes constant velocity model.
 */

import { Position3D } from '../config/types';

export class KalmanFilter {
  // State: [x, y, z, vx, vy, vz]
  private state: number[];

  // State covariance matrix (diagonal approximation)
  private P: number[];

  // Process noise
  private Q: number[];

  // Measurement noise
  private R: number;

  // Time step (assumed constant)
  private dt: number = 0.05; // 50ms

  private is3D: boolean;

  constructor(is3D: boolean = true) {
    this.is3D = is3D;
    const dim = is3D ? 6 : 4;

    // Initialize state
    this.state = Array(dim).fill(0);

    // Initialize covariance (high uncertainty initially)
    this.P = Array(dim).fill(1.0);

    // Process noise (position and velocity)
    if (is3D) {
      this.Q = [0.01, 0.01, 0.01, 0.1, 0.1, 0.1];
    } else {
      this.Q = [0.01, 0.01, 0.1, 0.1];
    }

    // Measurement noise (in meters)
    this.R = 0.05; // 5cm
  }

  /**
   * Update filter with new measurement.
   */
  public update(measurement: Position3D): Position3D {
    // Predict step
    this.predict();

    // Update step
    this.correct(measurement);

    return {
      x: this.state[0],
      y: this.state[1],
      z: this.is3D ? this.state[2] : 0,
    };
  }

  /**
   * Predict step: propagate state forward in time.
   */
  private predict(): void {
    const dt = this.dt;

    if (this.is3D) {
      // x = x + vx * dt
      this.state[0] += this.state[3] * dt;
      this.state[1] += this.state[4] * dt;
      this.state[2] += this.state[5] * dt;

      // Update covariance
      this.P[0] += this.Q[0] + this.P[3] * dt * dt;
      this.P[1] += this.Q[1] + this.P[4] * dt * dt;
      this.P[2] += this.Q[2] + this.P[5] * dt * dt;
      this.P[3] += this.Q[3];
      this.P[4] += this.Q[4];
      this.P[5] += this.Q[5];
    } else {
      this.state[0] += this.state[2] * dt;
      this.state[1] += this.state[3] * dt;

      this.P[0] += this.Q[0] + this.P[2] * dt * dt;
      this.P[1] += this.Q[1] + this.P[3] * dt * dt;
      this.P[2] += this.Q[2];
      this.P[3] += this.Q[3];
    }
  }

  /**
   * Correction step: incorporate measurement.
   */
  private correct(measurement: Position3D): void {
    const R = this.R;

    // Update x
    let S = this.P[0] + R;
    let K = this.P[0] / S;
    let innovation = measurement.x - this.state[0];
    this.state[0] += K * innovation;
    this.P[0] *= 1 - K;

    // Update velocity estimate from position change
    if (this.is3D) {
      this.state[3] += K * innovation / this.dt * 0.5;
    } else {
      this.state[2] += K * innovation / this.dt * 0.5;
    }

    // Update y
    S = this.P[1] + R;
    K = this.P[1] / S;
    innovation = measurement.y - this.state[1];
    this.state[1] += K * innovation;
    this.P[1] *= 1 - K;

    if (this.is3D) {
      this.state[4] += K * innovation / this.dt * 0.5;
    } else {
      this.state[3] += K * innovation / this.dt * 0.5;
    }

    // Update z (3D only)
    if (this.is3D) {
      S = this.P[2] + R;
      K = this.P[2] / S;
      innovation = measurement.z - this.state[2];
      this.state[2] += K * innovation;
      this.P[2] *= 1 - K;
      this.state[5] += K * innovation / this.dt * 0.5;
    }
  }

  /**
   * Reset filter to initial state.
   */
  public reset(): void {
    const dim = this.is3D ? 6 : 4;
    this.state = Array(dim).fill(0);
    this.P = Array(dim).fill(1.0);
  }

  /**
   * Set measurement noise.
   */
  public setMeasurementNoise(noise: number): void {
    this.R = noise;
  }

  /**
   * Set process noise.
   */
  public setProcessNoise(posNoise: number, velNoise: number): void {
    if (this.is3D) {
      this.Q = [posNoise, posNoise, posNoise, velNoise, velNoise, velNoise];
    } else {
      this.Q = [posNoise, posNoise, velNoise, velNoise];
    }
  }

  /**
   * Get current velocity estimate.
   */
  public getVelocity(): Position3D {
    if (this.is3D) {
      return {
        x: this.state[3],
        y: this.state[4],
        z: this.state[5],
      };
    } else {
      return {
        x: this.state[2],
        y: this.state[3],
        z: 0,
      };
    }
  }
}
