# UWB Positioning System Design

## Overview

Multi-anchor UWB positioning system using ESP32-S3 + DW3110 modules for real-time 3D tag tracking.

- **Protocol:** DS-TWR (Double-Sided Two-Way Ranging, ~10cm accuracy)
- **Connectivity:** All devices (anchors + tags) connect via WiFi/WebSocket
- **Server:** Node.js with multilateration engine and web dashboard

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │     position-server (Node.js)       │
                    │  - WebSocket server                 │
                    │  - Multilateration engine           │
                    │  - REST API + Web dashboard         │
                    └──────────────┬──────────────────────┘
                                   │ WebSocket (WiFi)
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
    ┌──────▼──────┐         ┌──────▼──────┐         ┌──────▼──────┐
    │  Anchor 1   │         │  Anchor 2   │         │  Anchor N   │
    │ (x1,y1,z1)  │         │ (x2,y2,z2)  │         │ (xn,yn,zn)  │
    │ Responder   │         │ Responder   │         │ Responder   │
    └──────┬──────┘         └──────┬──────┘         └──────┬──────┘
           │                       │                       │
           │         UWB DS-TWR    │                       │
           └───────────────────────┼───────────────────────┘
                                   │
                            ┌──────▼──────┐
                            │    Tag      │
                            │ Initiator   │
                            │  (mobile)   │
                            └─────────────┘
```

## Component Roles

| Component | Mode | Network | Function |
|-----------|------|---------|----------|
| Anchor | TWR Responder | WiFi + WebSocket | Fixed position, responds to polls, reports distances |
| Tag | TWR Initiator | WiFi + WebSocket | Mobile, polls each anchor sequentially |
| Server | - | WebSocket + HTTP | Receives distances, computes 3D positions |

---

## ESP32 Firmware Structure

### Source Files (main/)

```
main/
  main.c                 # Application entry, mode selection, WiFi/WS integration
  wifi_manager.c/h       # WiFi connection with auto-reconnect
  ws_client.c/h          # WebSocket client with message queuing
  device_config.c/h      # NVS configuration storage
  anchor_mode.c/h        # TWR responder logic
  tag_mode.c/h           # Sequential anchor polling
  position_types.h       # Shared type definitions
  Kconfig.projbuild      # Configuration options
```

### Kconfig Options

| Option | Description |
|--------|-------------|
| `CONFIG_DEVICE_MODE` | 0 = Anchor, 1 = Tag |
| `CONFIG_DEVICE_ID` | Unique 16-bit device ID (hex) |
| `CONFIG_UWB_PANID` | UWB PAN ID (default: 0xDECA) |
| `CONFIG_WIFI_SSID` | WiFi network SSID |
| `CONFIG_WIFI_PASSWORD` | WiFi password |
| `CONFIG_SERVER_URI` | WebSocket server URI (e.g., ws://192.168.1.100:3000/ws) |

### Anchor Mode Flow

1. Initialize as TWR responder
2. Connect to WiFi, then WebSocket
3. Send registration message to server
4. Enable continuous RX (auto re-enable after each frame)
5. On each TWR completion, send ranging report via WebSocket

### Tag Mode Flow

1. Initialize as TWR initiator
2. Connect to WiFi, then WebSocket
3. Send registration, receive anchor list from server
4. Loop: poll each anchor sequentially (50ms each)
5. Send ranging reports via WebSocket

---

## WebSocket Protocol (JSON)

### Device -> Server

**Registration:**
```json
{"type":"register","device_type":"anchor","device_id":1,"mac":"0x0001"}
```

**Ranging Report:**
```json
{"type":"ranging","anchor_id":1,"tag_id":2,"distance_cm":150,"seq":1234,"ts":1708617600000}
```

**Heartbeat:**
```json
{"type":"heartbeat"}
```

### Server -> Device

**Registration Confirmation:**
```json
{"type":"registered"}
```

**Anchor List (to tags):**
```json
{"type":"anchor_list","anchors":[{"id":1,"mac":"0x0001"},{"id":2,"mac":"0x0002"}]}
```

**Position Broadcast:**
```json
{"type":"position","tag_id":2,"x":3.45,"y":2.10,"z":0.0,"accuracy_cm":10}
```

**Error:**
```json
{"type":"error","message":"Invalid message format"}
```

---

## Node.js Server Structure

```
position-server/
  package.json
  tsconfig.json
  src/
    index.ts                  # Entry point
    server/
      websocket-server.ts     # Device connections and message routing
      http-server.ts          # REST API and static file serving
    positioning/
      multilateration.ts      # Gauss-Newton 3D position calculation
      kalman-filter.ts        # Position smoothing
      ranging-buffer.ts       # Distance data aggregation with time windowing
    config/
      anchor-config.ts        # Anchor position management
      types.ts                # TypeScript interfaces
    storage/
      db.ts                   # SQLite persistence for position history
    api/
      routes.ts               # REST endpoints
  public/
    index.html                # Web dashboard
    app.js                    # Real-time visualization
  config/
    anchors.json              # Anchor positions configuration
```

---

## Anchor Configuration (config/anchors.json)

```json
{
  "unit": "meters",
  "anchors": [
    {"id": 1, "mac": "0x0001", "name": "NW Corner", "position": {"x": 0, "y": 0, "z": 2}},
    {"id": 2, "mac": "0x0002", "name": "NE Corner", "position": {"x": 10, "y": 0, "z": 2}},
    {"id": 3, "mac": "0x0003", "name": "SE Corner", "position": {"x": 10, "y": 8, "z": 2}},
    {"id": 4, "mac": "0x0004", "name": "SW Corner", "position": {"x": 0, "y": 8, "z": 2}}
  ]
}
```

---

## Multilateration Algorithm

**Problem:** Given N distance measurements d_i to anchors at known positions A_i, find tag position P.

**Method:** Gauss-Newton nonlinear least squares optimization

```
minimize sum((||P - A_i|| - d_i)^2) for i = 1..N
```

**Implementation:**
1. Initial guess: centroid of anchor positions
2. Iteratively refine using Jacobian-based updates
3. Converge when position delta < 1mm or max iterations reached

**Requirements:**
- Minimum 3 anchors for 2D positioning
- Minimum 4 anchors for 3D positioning
- More anchors improve accuracy via redundancy

**Smoothing:** Kalman filter with constant velocity model reduces noise and provides velocity estimates.

---

## REST API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/anchors | List all anchors with positions |
| GET | /api/anchors/:id | Get single anchor |
| PUT | /api/anchors/:id | Update anchor position |
| GET | /api/positions | Current positions of all tags |
| GET | /api/positions/:tagId | Position of specific tag |
| GET | /api/positions/:tagId/history | Historical position data |
| GET | /api/devices | Connected devices |
| GET | /api/status | System status |

---

## Key Technical Notes

1. **Task Priority:** UWB task runs at high priority (10), WiFi/WebSocket at normal priority (5)
2. **Message Buffering:** Ranging reports queued if WebSocket disconnects temporarily
3. **Timing:** With 4 anchors at 50ms each, full position update every ~200ms (5 Hz)
4. **Accuracy:** DS-TWR provides ~10cm raw accuracy; Kalman filter smooths outliers
5. **Antenna Delay:** Current value 16368 DTU; may need per-device calibration

---

## Build and Run

### ESP32 Firmware

```bash
# Source ESP-IDF environment
. /home/orencollaco/esp/v5.3.1/esp-idf/export.sh

# Configure device mode and network settings
idf.py menuconfig

# Build and flash
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

### Position Server

```bash
cd position-server

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start server
npm start

# Or run in development mode
npm run dev
```

### Dashboard

Open `http://localhost:3000/` in a browser to view the real-time positioning dashboard.

---

## Deployment Checklist

1. Configure anchor positions in `config/anchors.json`
2. Set WiFi credentials and server URI in ESP32 menuconfig
3. Flash anchors with `CONFIG_DEVICE_MODE=0` and unique device IDs (0x0001-0x00FF)
4. Flash tags with `CONFIG_DEVICE_MODE=1` and unique device IDs (0x0100-0xFFFE)
5. Start position server
6. Power on anchors first, then tags
7. Verify connections in dashboard

---

## Future Enhancements

- [ ] TDoA (Time Difference of Arrival) mode for passive tags
- [ ] Multi-floor support with floor detection
- [ ] Geofencing and zone alerts
- [ ] Historical playback in dashboard
- [ ] Calibration wizard for antenna delay
- [ ] MQTT integration for IoT platforms
