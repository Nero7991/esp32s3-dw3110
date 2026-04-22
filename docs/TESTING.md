# UWB Positioning System - Testing Guide

## Overview

This document outlines the unit testing strategy for the UWB positioning system, covering both the Node.js server components and ESP32 firmware where applicable.

---

## Server-Side Tests (position-server)

### Test Framework Setup

```bash
cd position-server
npm install --save-dev jest ts-jest @types/jest
```

**jest.config.js:**
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
};
```

**package.json scripts:**
```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

---

### 1. Multilateration Tests

**File:** `src/positioning/multilateration.test.ts`

#### Test Cases

| Test | Description | Input | Expected Output |
|------|-------------|-------|-----------------|
| Basic 2D positioning | 3 anchors, tag at known position | Distances to (0,0), (10,0), (5,8.66) | Position near (5, 2.89) |
| Basic 3D positioning | 4 anchors, tag at known position | Distances to corners of cube | Position within 10cm of actual |
| Minimum anchors | Only 2 anchors available | 2 distance measurements | Returns null (insufficient) |
| Noisy measurements | Distances with ±5cm noise | Noisy distance array | Position within 15cm of actual |
| Convergence failure | Contradictory distances | Impossible geometry | Returns null or best estimate |
| Zero distance | Tag at anchor position | One distance = 0 | Handles gracefully |

#### Example Test Implementation

```typescript
import { MultilaterationEngine } from './multilateration';

describe('MultilaterationEngine', () => {
  let engine: MultilaterationEngine;

  beforeEach(() => {
    engine = new MultilaterationEngine();
  });

  describe('2D positioning', () => {
    it('should compute correct position with 3 anchors', () => {
      // Equilateral triangle anchors
      const anchors = [
        { id: 1, pos: { x: 0, y: 0, z: 0 }, dist: 5.0 },
        { id: 2, pos: { x: 10, y: 0, z: 0 }, dist: 5.0 },
        { id: 3, pos: { x: 5, y: 8.66, z: 0 }, dist: 5.0 },
      ];

      const result = engine.gaussNewton(anchors, false);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(5.0, 1);
      expect(result!.y).toBeCloseTo(2.89, 1);
    });

    it('should return null with insufficient anchors', () => {
      const anchors = [
        { id: 1, pos: { x: 0, y: 0, z: 0 }, dist: 5.0 },
        { id: 2, pos: { x: 10, y: 0, z: 0 }, dist: 5.0 },
      ];

      const result = engine.gaussNewton(anchors, false);
      expect(result).toBeNull();
    });
  });

  describe('3D positioning', () => {
    it('should compute correct position with 4 anchors', () => {
      // Room corners at z=2m, tag at center floor level
      const anchors = [
        { id: 1, pos: { x: 0, y: 0, z: 2 }, dist: Math.sqrt(25 + 16 + 4) },
        { id: 2, pos: { x: 10, y: 0, z: 2 }, dist: Math.sqrt(25 + 16 + 4) },
        { id: 3, pos: { x: 10, y: 8, z: 2 }, dist: Math.sqrt(25 + 16 + 4) },
        { id: 4, pos: { x: 0, y: 8, z: 2 }, dist: Math.sqrt(25 + 16 + 4) },
      ];

      const result = engine.gaussNewton(anchors, true);

      expect(result).not.toBeNull();
      expect(result!.x).toBeCloseTo(5.0, 0);
      expect(result!.y).toBeCloseTo(4.0, 0);
      expect(result!.z).toBeCloseTo(0.0, 0);
    });
  });

  describe('error handling', () => {
    it('should handle noisy measurements', () => {
      const actualPos = { x: 5, y: 4, z: 0 };
      const anchors = [
        { id: 1, pos: { x: 0, y: 0, z: 2 }, dist: distance(actualPos, {x:0,y:0,z:2}) + 0.05 },
        { id: 2, pos: { x: 10, y: 0, z: 2 }, dist: distance(actualPos, {x:10,y:0,z:2}) - 0.03 },
        { id: 3, pos: { x: 10, y: 8, z: 2 }, dist: distance(actualPos, {x:10,y:8,z:2}) + 0.02 },
        { id: 4, pos: { x: 0, y: 8, z: 2 }, dist: distance(actualPos, {x:0,y:8,z:2}) - 0.04 },
      ];

      const result = engine.gaussNewton(anchors, true);

      expect(result).not.toBeNull();
      // Should be within 15cm despite noise
      const error = distance(result!, actualPos);
      expect(error).toBeLessThan(0.15);
    });
  });
});

function distance(a: {x:number,y:number,z:number}, b: {x:number,y:number,z:number}): number {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
}
```

---

### 2. Kalman Filter Tests

**File:** `src/positioning/kalman-filter.test.ts`

#### Test Cases

| Test | Description | Expected Behavior |
|------|-------------|-------------------|
| Initial state | First measurement | Output equals input (no prior) |
| Smoothing | Noisy input sequence | Output variance < input variance |
| Step response | Sudden position change | Converges to new position within N updates |
| Velocity estimation | Constant velocity motion | Velocity estimate converges to actual |
| Reset | Call reset() | Returns to initial uncertainty |

#### Example Test Implementation

```typescript
import { KalmanFilter } from './kalman-filter';

describe('KalmanFilter', () => {
  describe('2D mode', () => {
    it('should smooth noisy measurements', () => {
      const filter = new KalmanFilter(false);
      const actual = { x: 5, y: 4, z: 0 };
      const noise = 0.1;

      const outputs: Array<{x: number, y: number}> = [];

      // Feed 20 noisy measurements
      for (let i = 0; i < 20; i++) {
        const noisy = {
          x: actual.x + (Math.random() - 0.5) * noise * 2,
          y: actual.y + (Math.random() - 0.5) * noise * 2,
          z: 0,
        };
        const result = filter.update(noisy);
        outputs.push({ x: result.x, y: result.y });
      }

      // Last output should be closer to actual than average input noise
      const lastOutput = outputs[outputs.length - 1];
      const error = Math.sqrt(
        (lastOutput.x - actual.x) ** 2 +
        (lastOutput.y - actual.y) ** 2
      );

      expect(error).toBeLessThan(noise);
    });

    it('should track moving target', () => {
      const filter = new KalmanFilter(false);

      // Simulate constant velocity motion
      const velocity = { x: 0.1, y: 0.05 }; // m per update
      let pos = { x: 0, y: 0, z: 0 };

      for (let i = 0; i < 50; i++) {
        pos.x += velocity.x;
        pos.y += velocity.y;
        filter.update(pos);
      }

      const estVelocity = filter.getVelocity();

      // Velocity estimate should be close to actual
      expect(estVelocity.x).toBeCloseTo(velocity.x / 0.05, 0); // Adjusted for dt
      expect(estVelocity.y).toBeCloseTo(velocity.y / 0.05, 0);
    });
  });

  describe('3D mode', () => {
    it('should handle 3D positions', () => {
      const filter = new KalmanFilter(true);
      const pos = { x: 5, y: 4, z: 1.5 };

      const result = filter.update(pos);

      expect(result.x).toBeCloseTo(pos.x, 1);
      expect(result.y).toBeCloseTo(pos.y, 1);
      expect(result.z).toBeCloseTo(pos.z, 1);
    });
  });
});
```

---

### 3. Ranging Buffer Tests

**File:** `src/positioning/ranging-buffer.test.ts`

#### Test Cases

| Test | Description | Expected Behavior |
|------|-------------|-------------------|
| Add measurement | Single measurement | Retrievable via getLatestDistances |
| Multiple anchors | Measurements from 4 anchors | All 4 distances returned |
| Time windowing | Old measurements | Expired measurements excluded |
| Median calculation | Multiple measurements per anchor | Returns median value |
| Max measurements | Exceed buffer limit | Oldest discarded |
| Clear | Clear specific tag or all | Buffer emptied |

#### Example Test Implementation

```typescript
import { RangingBuffer } from './ranging-buffer';

describe('RangingBuffer', () => {
  let buffer: RangingBuffer;

  beforeEach(() => {
    buffer = new RangingBuffer();
    buffer.setWindowMs(1000); // 1 second window for testing
  });

  it('should store and retrieve measurements', () => {
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

  it('should return measurements from multiple anchors', () => {
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
    expect(distances!.get(4)).toBe(400);
  });

  it('should expire old measurements', async () => {
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

  it('should return median of multiple measurements', () => {
    const now = new Date();

    // Add measurements: 100, 105, 200 (outlier), 102, 98
    [100, 105, 200, 102, 98].forEach((dist, i) => {
      buffer.addMeasurement({
        anchorId: 1,
        tagId: 100,
        distanceCm: dist,
        timestamp: new Date(now.getTime() + i),
      });
    });

    const distances = buffer.getLatestDistances(100);

    // Median of [98, 100, 102, 105, 200] = 102
    expect(distances!.get(1)).toBe(102);
  });

  it('should clear measurements for specific tag', () => {
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
});
```

---

### 4. API Endpoint Tests

**File:** `src/api/routes.test.ts`

#### Test Cases

| Endpoint | Test | Expected |
|----------|------|----------|
| GET /api/anchors | List anchors | Returns array of anchor configs |
| GET /api/anchors/:id | Valid ID | Returns anchor object |
| GET /api/anchors/:id | Invalid ID | Returns 404 |
| PUT /api/anchors/:id | Update position | Returns updated anchor |
| PUT /api/anchors/:id | Invalid position | Returns 400 |
| GET /api/positions | No tags | Returns empty array |
| GET /api/status | Always | Returns status object |

#### Example Test Implementation

```typescript
import request from 'supertest';
import express from 'express';
import { apiRouter } from './routes';

describe('API Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  describe('GET /api/anchors', () => {
    it('should return list of anchors', async () => {
      const res = await request(app).get('/api/anchors');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('position');
    });
  });

  describe('GET /api/anchors/:id', () => {
    it('should return anchor by ID', async () => {
      const res = await request(app).get('/api/anchors/1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(1);
    });

    it('should return 404 for invalid ID', async () => {
      const res = await request(app).get('/api/anchors/999');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/anchors/:id', () => {
    it('should update anchor position', async () => {
      const newPosition = { x: 1.5, y: 2.5, z: 3.0 };

      const res = await request(app)
        .put('/api/anchors/1')
        .send({ position: newPosition });

      expect(res.status).toBe(200);
      expect(res.body.anchor.position).toEqual(newPosition);
    });

    it('should reject invalid position data', async () => {
      const res = await request(app)
        .put('/api/anchors/1')
        .send({ position: { x: 'invalid' } });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/status', () => {
    it('should return system status', async () => {
      const res = await request(app).get('/api/status');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('connectedDevices');
    });
  });
});
```

---

### 5. WebSocket Protocol Tests

**File:** `src/server/websocket-server.test.ts`

#### Test Cases

| Test | Description | Expected |
|------|-------------|----------|
| Device registration | Send register message | Receive 'registered' response |
| Tag receives anchor list | Register as tag | Receive anchor_list message |
| Ranging report | Send ranging data | No error, data processed |
| Invalid message | Malformed JSON | Receive error message |
| Reconnection | Same device ID reconnects | Old connection closed |

---

## ESP32 Firmware Tests

### Unit Test Framework

ESP-IDF includes Unity test framework. Tests run on target device.

**Test location:** `main/test/`

### Testable Components

| Component | Testable Functions | Notes |
|-----------|-------------------|-------|
| device_config | Config save/load, ID generation | Requires NVS mock or real flash |
| position_types | Struct sizes, enums | Compile-time checks |
| Message parsing | JSON encode/decode | Can test with cJSON |

### Example: Device Config Test

```c
#include "unity.h"
#include "device_config.h"

TEST_CASE("device_config_generate_id returns non-zero", "[config]")
{
    uint16_t id = device_config_generate_id();
    TEST_ASSERT_NOT_EQUAL(0, id);
    TEST_ASSERT_NOT_EQUAL(0xFFFF, id);
}

TEST_CASE("device_config_init succeeds", "[config]")
{
    esp_err_t ret = device_config_init();
    TEST_ASSERT_EQUAL(ESP_OK, ret);
}

TEST_CASE("device_config_get returns valid config", "[config]")
{
    device_config_init();
    const device_config_t* config = device_config_get();

    TEST_ASSERT_NOT_NULL(config);
    TEST_ASSERT_NOT_EQUAL(0, config->device_id);
}
```

---

## Integration Tests

### End-to-End Test Scenarios

| Scenario | Setup | Verification |
|----------|-------|--------------|
| Single tag, 4 anchors | 1 tag + 4 anchors + server | Position computed within 15cm |
| Tag movement | Move tag along known path | Position track matches path |
| Anchor failure | Disable 1 of 4 anchors | System continues with 3 (2D mode) |
| Network interruption | Disconnect WiFi briefly | Reconnects, resumes operation |
| Server restart | Restart server while devices connected | Devices reconnect automatically |

### Test Harness

For integration testing, create a simulated environment:

```typescript
// test/integration/simulator.ts

class UWBSimulator {
  private anchors: Map<number, Position3D>;
  private tags: Map<number, Position3D>;

  constructor(anchorPositions: Map<number, Position3D>) {
    this.anchors = anchorPositions;
    this.tags = new Map();
  }

  setTagPosition(tagId: number, position: Position3D): void {
    this.tags.set(tagId, position);
  }

  simulateRanging(tagId: number): Map<number, number> {
    const tagPos = this.tags.get(tagId);
    if (!tagPos) throw new Error('Tag not found');

    const distances = new Map<number, number>();

    for (const [anchorId, anchorPos] of this.anchors) {
      const dist = this.distance(tagPos, anchorPos);
      // Add realistic noise (Gaussian, ~5cm std dev)
      const noise = this.gaussianNoise(0, 0.05);
      distances.set(anchorId, (dist + noise) * 100); // Convert to cm
    }

    return distances;
  }

  private distance(a: Position3D, b: Position3D): number {
    return Math.sqrt(
      (a.x - b.x) ** 2 +
      (a.y - b.y) ** 2 +
      (a.z - b.z) ** 2
    );
  }

  private gaussianNoise(mean: number, stdDev: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
```

---

## Running Tests

### Server Tests

```bash
cd position-server

# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- multilateration.test.ts

# Watch mode during development
npm run test:watch
```

### ESP32 Tests

```bash
# Build and flash test app
idf.py -T test build flash monitor

# Run specific test
idf.py -T "test_device_config" build flash monitor
```

---

## Coverage Requirements

| Component | Target Coverage |
|-----------|-----------------|
| multilateration.ts | 90% |
| kalman-filter.ts | 85% |
| ranging-buffer.ts | 90% |
| API routes | 80% |
| WebSocket server | 75% |

---

## Continuous Integration

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  server-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: cd position-server && npm ci
      - run: cd position-server && npm test -- --coverage
      - uses: codecov/codecov-action@v3
```

---

## Implemented Tests Status

### Current Test Results

All 37 unit tests pass:

| Test Suite | Tests | Status |
|------------|-------|--------|
| multilateration.test.ts | 12 | PASS |
| ranging-buffer.test.ts | 15 | PASS |
| kalman-filter.test.ts | 10 | PASS |

### Test Files Location

- `position-server/src/positioning/multilateration.test.ts`
- `position-server/src/positioning/ranging-buffer.test.ts`
- `position-server/src/positioning/kalman-filter.test.ts`

### Implementation Notes

#### Multilateration Algorithm

The tests use a linearized least squares approach to verify multilateration correctness. Key considerations:

1. **Sign Convention**: The linearization formula is:
   ```
   2(Ai - A0) * P = d0^2 - di^2 + ||Ai||^2 - ||A0||^2
   ```
   The coefficients must be `2(Ai - A0)` not `2(A0 - Ai)` to get correct signs.

2. **3D Anchor Geometry**: For 3D positioning, anchors must NOT be coplanar. If all anchors are at the same height (e.g., z=2), the z-component of the coefficient matrix will be all zeros, making it singular. Use a tetrahedral configuration:
   ```typescript
   const anchorPositions = [
     { x: 0, y: 0, z: 0 },
     { x: 10, y: 0, z: 0 },
     { x: 5, y: 8, z: 0 },
     { x: 5, y: 3, z: 4 },  // Above the plane
   ];
   ```

3. **Minimum Anchors**: 2D requires at least 3 non-collinear anchors; 3D requires at least 4 non-coplanar anchors.

#### Ranging Buffer

Tests verify:
- Time-windowed measurement storage
- Median filtering for outlier rejection
- Per-anchor measurement tracking
- Multi-tag support

#### Kalman Filter

Tests verify:
- Noise smoothing capability
- Step response convergence
- Velocity tracking
- State reset functionality

---

## UWB Communication Debugging Notes

### Issue: TWR RX Timeouts from Tag to Anchors

**Symptom:** Tag sends TWR polls to anchors but gets RX timeouts. Anchors are in RX mode but don't respond.

**Configuration Verified:**
- All devices use same PAN ID: 0xDECA
- All devices use same UWB config: CH 9, 6.8Mbps, PRF 64MHz, Plen 64, PAC 8
- Antenna delay: 16368 DTU

**MAC Address Configuration:**
- Anchors: device_id = mac_addr (0x0001, 0x0002, 0x0003)
- Tag: device_id = mac_addr (0x0064)
- Server sends anchor list with correct MAC addresses
- Tag addresses frames to anchor MAC addresses

**Frame Format:**
- TWR uses IEEE 802.15.4 data frames (MAC154_FC_SHORT)
- Frame Control: `MAC154_FC_TYPE_DATA | MAC154_FC_DST_ADDR_SHORT | MAC154_FC_SRC_ADDR_SHORT | MAC154_FC_PAN_ID_COMP`
- Contains: FC (2B) + SeqNo (1B) + PAN ID (2B) + Dst Addr (2B) + Src Addr (2B) + Func (1B) = 10 bytes min

**Frame Filtering Configuration:**
- `dwmac_set_frame_filter()` enables: `DWT_FF_ENABLE_802_15_4` with `DWT_FF_BEACON_EN | DWT_FF_DATA_EN | DWT_FF_ACK_EN | DWT_FF_COORD_EN`
- Frame filtering requires matching: destination address, PAN ID, and frame type

**Debugging Steps:**

1. **Enable frame filter debug**: Set `CONFIG_DECA_DEBUG_FRAME_FILTER=y` in sdkconfig
   - This enables `DWT_INT_ARFE_BIT_MASK` interrupt which fires when frames are filtered

2. **Check event counters**: Use `dwmac_print_event_counters()` to see:
   - CRCG: frames received with good CRC
   - ARFE: frames rejected by address filter
   - PHE: PHY header errors
   - PTO: preamble timeouts

3. **Disable frame filtering temporarily**: In `anchor_mode_init()`, comment out `dwmac_set_frame_filter()` to test if frames are being received at all

4. **Verify RX is actually enabled**: Check anchor serial output for:
   ```
   dwmac_set_rx_reenable(true)
   dwt_rxenable(DWT_START_RX_IMMEDIATE)
   ```

**Key Code Paths:**

Tag sends poll:
```
tag_mode.c:poll_anchor()
  -> ranging.c:twr_start(anchor_mac)
    -> ranging.c:twr_send_poll()
      -> dwproto.c:dwprot_prepare() with dst=anchor_mac
        -> dwproto.c:dwprot_short_prepare()
          -> sets ps->hdr.dst = anchor_mac
          -> sets ps->hdr.panId = dwmac_get_panid()
```

Anchor receives and responds:
```
dwmac_irq.c:dwmac_irq_rx_ok_cb()
  -> dwmac.c:dwmac_handle_rx_frame()
    -> dwproto.c:dwprot_rx_handler()
      -> ranging.c:twr_handle_message()
        -> ranging.c:twr_send_response()
```

**Possible Root Causes:**

1. **PAN ID mismatch**: Verify CONFIG_UWB_PANID is same in all device sdkconfigs
2. **Antenna issue**: Physical antenna orientation or proximity too close
3. **Clock drift**: Crystal oscillator frequency mismatch between devices
4. **TX power too low**: Default TX power may not be sufficient
5. **Interrupt not enabled**: Ensure IRQ pin is correctly wired and interrupt is enabled

**Resolution:**
To debug, try disabling frame filtering on anchor to see raw RX status:
```c
// In anchor_mode_init(), change:
dwmac_set_frame_filter();
// To:
dwt_configureframefilter(DWT_FF_DISABLE, 0);
```
