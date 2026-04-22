/**
 * UWB Positioning System - WebSocket Server
 *
 * Handles device connections, registration, and message routing.
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import { Server } from 'http';
import {
  DeviceInfo,
  IncomingMessage,
  RegisterMessage,
  RangingReport,
  AnchorListMessage,
  PositionMessage,
  RegisteredMessage,
  LogEventMessage,
  LogEventLevel,
} from '../config/types';
import { anchorConfig } from '../config/anchor-config';
import { rangingBuffer } from '../positioning/ranging-buffer';
import { positionEngine } from '../positioning/multilateration';
import { pollingScheduler } from './polling-scheduler';

interface ConnectedDevice extends DeviceInfo {
  ws: WebSocket;
}

const RATE_TO_INTERVAL: Record<string, number> = {
  slow: 40000,
  normal: 100,
  fast: 20,
};

/* Polling-scheduler rate presets. Spacing is the gap between consecutive
 * anchor poll commands within a cycle (must exceed UWB TWR airtime ~5ms
 * to avoid tag RX collision). Pause is the idle time at end of each cycle. */
const RATE_TO_SCHEDULER: Record<string, { spacingMs: number; pauseMs: number }> = {
  slow: { spacingMs: 80, pauseMs: 200 },
  normal: { spacingMs: 30, pauseMs: 30 },
  fast: { spacingMs: 8, pauseMs: 0 },
};

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private devices: Map<number, ConnectedDevice> = new Map();
  private wsToDevice: Map<WebSocket, number> = new Map();
  private dashboardClients: Set<WebSocket> = new Set();
  private currentRate: string = 'normal';

  public init(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      console.log(`New WebSocket connection from ${req.socket.remoteAddress}`);

      ws.on('message', (data) => this.handleMessage(ws, data));
      ws.on('close', () => this.handleDisconnect(ws));
      ws.on('error', (err) => console.error('WebSocket error:', err));
    });

    console.log('WebSocket server initialized on /ws');

    // Periodic stale device check (close devices with no heartbeat for 6s)
    setInterval(() => {
      const now = Date.now();
      for (const [deviceId, device] of this.devices) {
        const age = now - device.lastSeen.getTime();
        if (age > 10000) {
          console.log(`Device ${deviceId} stale (${Math.round(age / 1000)}s), forcing disconnect`);
          device.ws.close();
        }
      }
    }, 3000);

    // Initialize polling scheduler
    pollingScheduler.init({
      sendPollCommand: (anchorId, tagMac) => this.sendToDevice(anchorId, { type: 'poll_tag', tag_mac: tagMac }),
      getConnectedAnchorIds: () => this.getConnectedAnchors().map(d => d.deviceId),
      onLog: (level, event, detail) => this.broadcastLog(level as any, event, detail),
    });
  }

  private broadcastToDashboard(msg: object): void {
    const msgStr = JSON.stringify(msg);
    for (const ws of this.dashboardClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msgStr);
      }
    }
  }

  public broadcastLog(level: LogEventLevel, event: string, detail?: string): void {
    const msg: LogEventMessage = {
      type: 'log_event',
      timestamp: new Date().toISOString(),
      level,
      event,
      detail,
    };
    this.broadcastToDashboard(msg);
  }

  private handleMessage(ws: WebSocket, data: RawData): void {
    try {
      const message: IncomingMessage = JSON.parse(data.toString());

      // Any message from a device counts as liveness — the heartbeat timer
      // on the device only fires when its send queue is idle, so a steady
      // stream of ranging reports would otherwise appear "stale".
      const senderId = this.wsToDevice.get(ws);
      if (senderId !== undefined) {
        const senderDevice = this.devices.get(senderId);
        if (senderDevice) {
          senderDevice.lastSeen = new Date();
        }
      }

      switch (message.type) {
        case 'register':
          this.handleRegister(ws, message as RegisterMessage);
          break;

        case 'ranging':
          this.handleRanging(message as RangingReport);
          break;

        case 'set_tag_rate':
          this.handleSetTagRate(ws, message as any);
          break;

        case 'add_passive_tag':
          this.handleAddPassiveTag(message as any);
          break;

        case 'remove_passive_tag':
          this.handleRemovePassiveTag(message as any);
          break;

        case 'start_passive_polling':
          pollingScheduler.start();
          this.broadcastToDashboard({ type: 'passive_poll_status', running: true, tags: pollingScheduler.getPassiveTags() });
          break;

        case 'locate_anchor':
          this.handleLocateAnchor(message as any);
          break;

        case 'set_device_mode':
          this.handleSetDeviceMode(message as any);
          break;

        case 'stop_passive_polling':
          pollingScheduler.stop();
          this.broadcastToDashboard({ type: 'passive_poll_status', running: false, tags: pollingScheduler.getPassiveTags() });
          break;

        case 'heartbeat': {
          const deviceId = this.wsToDevice.get(ws);
          if (deviceId !== undefined) {
            const device = this.devices.get(deviceId);
            if (device) {
              device.lastSeen = new Date();
              this.broadcastLog(
                'info',
                'Heartbeat',
                `id=0x${deviceId.toString(16).toUpperCase().padStart(4, '0')} type=${device.deviceType}`,
              );
            }
          }
          break;
        }

        default:
          console.warn('Unknown message type:', (message as any).type);
      }
    } catch (err) {
      console.error('Error parsing message:', err);
      this.sendError(ws, 'Invalid message format');
    }
  }

  private handleRegister(ws: WebSocket, msg: RegisterMessage): void {
    // Dashboard clients register with device_type 'dashboard'
    if ((msg as any).device_type === 'dashboard' || (msg as any).deviceType === 'dashboard') {
      this.dashboardClients.add(ws);
      console.log('Dashboard client registered');
      const registered: RegisteredMessage = { type: 'registered' };
      ws.send(JSON.stringify(registered));

      // Send current device list so dashboard knows what's already connected
      const devices = Array.from(this.devices.values()).map(d => ({
        deviceId: d.deviceId,
        deviceType: d.deviceType,
        mac: d.mac,
      }));
      ws.send(JSON.stringify({ type: 'device_list', devices }));

      // Send current rate
      ws.send(JSON.stringify({ type: 'current_rate', rate: this.currentRate }));

      // Send passive poll status
      ws.send(JSON.stringify({
        type: 'passive_poll_status',
        running: pollingScheduler.isRunning(),
        tags: pollingScheduler.getPassiveTags(),
      }));
      return;
    }

    console.log(`Device registration: ${msg.device_type} id=${msg.device_id} mac=${msg.mac}`);

    // Check for existing connection with same ID
    const existing = this.devices.get(msg.device_id);
    if (existing) {
      console.log(`Device ${msg.device_id} reconnecting, closing old connection`);
      this.wsToDevice.delete(existing.ws);
      existing.ws.close();
    }

    // Create device info
    const device: ConnectedDevice = {
      deviceId: msg.device_id,
      deviceType: msg.device_type,
      mac: msg.mac,
      connectedAt: new Date(),
      lastSeen: new Date(),
      ws,
    };

    this.devices.set(msg.device_id, device);
    this.wsToDevice.set(ws, msg.device_id);

    // Send registration confirmation
    const registered: RegisteredMessage = { type: 'registered' };
    ws.send(JSON.stringify(registered));

    // If it's a tag, send the anchor list
    if (msg.device_type === 'tag') {
      this.sendAnchorList(ws);
    }

    this.broadcastLog(
      'info',
      `${msg.device_type === 'tag' ? 'Tag' : 'Anchor'} registered`,
      `id=0x${msg.device_id.toString(16).toUpperCase().padStart(4, '0')} mac=${msg.mac}`,
    );

    // Notify dashboard clients of new device
    this.broadcastToDashboard({
      type: 'device_update',
      action: 'connected',
      deviceId: msg.device_id,
      deviceType: msg.device_type,
      mac: msg.mac,
    });

    // If an anchor just registered, send updated anchor list to all connected tags
    if (msg.device_type === 'anchor') {
      for (const device of this.devices.values()) {
        if (device.deviceType === 'tag' && device.ws.readyState === WebSocket.OPEN) {
          this.sendAnchorList(device.ws);
        }
      }
      // Auto-start the polling scheduler when at least one anchor is up
      // and we have tags configured. The scheduler is idempotent — calling
      // start() while already running is a no-op.
      if (!pollingScheduler.isRunning()
          && pollingScheduler.getPassiveTags().length > 0) {
        console.log('Auto-starting polling scheduler (anchor connected)');
        pollingScheduler.start();
        this.broadcastToDashboard({
          type: 'passive_poll_status',
          running: true,
          tags: pollingScheduler.getPassiveTags(),
        });
      }
    }

    console.log(`Device ${msg.device_id} registered successfully. Total devices: ${this.devices.size}`);
  }

  private handleSetTagRate(ws: WebSocket, msg: { rate: string }): void {
    const sched = RATE_TO_SCHEDULER[msg.rate];
    if (!sched) {
      this.sendError(ws, `Unknown rate: ${msg.rate}`);
      return;
    }

    this.currentRate = msg.rate;
    pollingScheduler.setInterAnchorSpacing(sched.spacingMs);
    pollingScheduler.setPollInterval(sched.pauseMs);
    console.log(
      `Rate set to ${msg.rate}: spacing=${sched.spacingMs}ms pause=${sched.pauseMs}ms`,
    );

    // Notify all dashboards of the rate change
    this.broadcastToDashboard({ type: 'current_rate', rate: msg.rate });
    this.broadcastLog(
      'info',
      'Rate changed',
      `${msg.rate} (spacing=${sched.spacingMs}ms pause=${sched.pauseMs}ms)`,
    );
  }

  private handleSetDeviceMode(msg: any): void {
    const modeNames = ['anchor', 'tag', 'passive_tag'];
    const modeName = modeNames[msg.mode] || `unknown(${msg.mode})`;

    if (this.sendToDevice(msg.deviceId, { type: 'set_mode', mode: msg.mode })) {
      console.log(`Set mode ${modeName} sent to device ${msg.deviceId} (will reboot)`);
      this.broadcastLog('info', 'Mode change', `device=${msg.deviceId} -> ${modeName} (rebooting)`);
    } else {
      console.log(`Set mode failed: device ${msg.deviceId} not connected`);
    }
  }

  private handleLocateAnchor(msg: any): void {
    const id = msg.deviceId;
    if (this.sendToDevice(id, { type: 'locate' })) {
      console.log(`Locate command sent to device ${id}`);
      this.broadcastLog('info', 'Locate', `Blinking anchor id=${id}`);
    } else {
      console.log(`Locate failed: device ${id} not connected`);
    }
  }

  private handleAddPassiveTag(msg: any): void {
    const mac = typeof msg.mac === 'string' ? parseInt(msg.mac, 16) : msg.mac;
    pollingScheduler.addPassiveTag({ id: msg.id, mac, name: msg.name || `Tag ${msg.id}` });
    this.broadcastToDashboard({ type: 'passive_poll_status', running: pollingScheduler.isRunning(), tags: pollingScheduler.getPassiveTags() });
    this.broadcastLog('info', 'Passive tag added', `id=${msg.id} mac=0x${mac.toString(16).padStart(4, '0')}`);
  }

  private handleRemovePassiveTag(msg: any): void {
    pollingScheduler.removePassiveTag(msg.id);
    this.broadcastToDashboard({ type: 'passive_poll_status', running: pollingScheduler.isRunning(), tags: pollingScheduler.getPassiveTags() });
    this.broadcastLog('info', 'Passive tag removed', `id=${msg.id}`);
  }

  private handleRanging(msg: RangingReport): void {
    // Let polling scheduler check if this is a response to a passive tag poll
    pollingScheduler.onRangingReport(msg.anchor_id, msg.tag_id, msg.distance_cm);

    // Add measurement to buffer
    rangingBuffer.addMeasurement({
      anchorId: msg.anchor_id,
      tagId: msg.tag_id,
      distanceCm: msg.distance_cm,
      timestamp: new Date(),
    });

    console.log(`Ranging: anchor=${msg.anchor_id} tag=${msg.tag_id} dist=${msg.distance_cm}cm`);

    this.broadcastLog(
      'info',
      'Ranging report',
      `anchor=0x${msg.anchor_id.toString(16).toUpperCase().padStart(4, '0')} tag=0x${msg.tag_id.toString(16).toUpperCase().padStart(4, '0')} dist=${msg.distance_cm} cm`,
    );

    // Forward ranging data to dashboard for distance ring visualization
    this.broadcastToDashboard({
      type: 'ranging_update',
      anchorId: msg.anchor_id,
      tagId: msg.tag_id,
      distanceCm: msg.distance_cm,
    });

    // Try to compute position
    const position = positionEngine.computePosition(msg.tag_id);
    if (position) {
      this.broadcastLog(
        'info',
        'Position computed',
        `tag=0x${position.tagId.toString(16).toUpperCase().padStart(4, '0')} x=${position.x.toFixed(2)} y=${position.y.toFixed(2)} z=${position.z.toFixed(2)} acc=${position.accuracyCm} cm`,
      );
      this.broadcastPosition(position);
    }
  }

  private handleDisconnect(ws: WebSocket): void {
    // Remove dashboard client if applicable
    if (this.dashboardClients.has(ws)) {
      this.dashboardClients.delete(ws);
      console.log('Dashboard client disconnected');
      return;
    }

    const deviceId = this.wsToDevice.get(ws);
    if (deviceId !== undefined) {
      const device = this.devices.get(deviceId);
      const label = device?.deviceType === 'tag' ? 'Tag' : 'Anchor';
      console.log(`Device ${deviceId} (${device?.deviceType}) disconnected`);

      this.broadcastLog(
        'warn',
        `${label} disconnected`,
        `id=0x${deviceId.toString(16).toUpperCase().padStart(4, '0')}`,
      );

      // Notify dashboard clients of disconnection
      this.broadcastToDashboard({
        type: 'device_update',
        action: 'disconnected',
        deviceId,
        deviceType: device?.deviceType || 'anchor',
        mac: device?.mac || '',
      });

      this.devices.delete(deviceId);
      this.wsToDevice.delete(ws);

      // If an anchor disconnected, send updated anchor list to all tags
      if (device?.deviceType === 'anchor') {
        for (const d of this.devices.values()) {
          if (d.deviceType === 'tag' && d.ws.readyState === WebSocket.OPEN) {
            this.sendAnchorList(d.ws);
          }
        }
      }
    }
  }

  private sendAnchorList(ws: WebSocket): void {
    // Only send anchors that are actually connected to avoid
    // the tag wasting time polling non-existent anchors
    const connectedAnchors: Array<{ id: number; mac: string }> = [];
    for (const device of this.devices.values()) {
      if (device.deviceType === 'anchor') {
        connectedAnchors.push({ id: device.deviceId, mac: device.mac });
      }
    }
    const msg: AnchorListMessage = {
      type: 'anchor_list',
      anchors: connectedAnchors,
    };
    ws.send(JSON.stringify(msg));
    console.log(`Sent anchor list with ${connectedAnchors.length} connected anchors`);
  }

  private broadcastPosition(position: {
    tagId: number;
    x: number;
    y: number;
    z: number;
    accuracyCm: number;
  }): void {
    const msg: PositionMessage = {
      type: 'position',
      tagId: position.tagId,
      x: position.x,
      y: position.y,
      z: position.z,
      accuracyCm: position.accuracyCm,
    };

    const msgStr = JSON.stringify(msg);

    // Send to UWB devices
    for (const device of this.devices.values()) {
      if (device.ws.readyState === WebSocket.OPEN) {
        device.ws.send(msgStr);
      }
    }

    // Also send to dashboard clients
    this.broadcastToDashboard(msg);
  }

  public sendToDevice(deviceId: number, msg: object): boolean {
    const device = this.devices.get(deviceId);
    if (device && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private sendError(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: 'error', message }));
  }

  public getConnectedDevices(): DeviceInfo[] {
    return Array.from(this.devices.values()).map(
      ({ ws, ...info }) => info
    );
  }

  public getConnectedTags(): DeviceInfo[] {
    return this.getConnectedDevices().filter(d => d.deviceType === 'tag');
  }

  public getConnectedAnchors(): DeviceInfo[] {
    return this.getConnectedDevices().filter(d => d.deviceType === 'anchor');
  }

  public getDeviceCount(): { anchors: number; tags: number; total: number } {
    let anchors = 0;
    let tags = 0;
    for (const device of this.devices.values()) {
      if (device.deviceType === 'anchor') anchors++;
      else tags++;
    }
    return { anchors, tags, total: this.devices.size };
  }
}

export const wsManager = new WebSocketManager();
