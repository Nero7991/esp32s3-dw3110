/**
 * UWB Positioning System - Type Definitions
 */

export interface Position3D {
  x: number;
  y: number;
  z: number;
}

export interface AnchorConfig {
  id: number;
  mac: string;
  name: string;
  position: Position3D;
}

export interface AnchorConfigFile {
  unit: string;
  anchors: AnchorConfig[];
}

export interface DeviceInfo {
  deviceId: number;
  deviceType: 'anchor' | 'tag';
  mac: string;
  connectedAt: Date;
  lastSeen: Date;
}

export interface RangingReport {
  type: 'ranging';
  anchor_id: number;
  tag_id: number;
  distance_cm: number;
  seq: number;
  ts: number;
}

export interface RegisterMessage {
  type: 'register';
  device_type: 'anchor' | 'tag';
  device_id: number;
  mac: string;
}

export interface AnchorListMessage {
  type: 'anchor_list';
  anchors: Array<{ id: number; mac: string }>;
}

export interface PositionMessage {
  type: 'position';
  tagId: number;
  x: number;
  y: number;
  z: number;
  accuracyCm: number;
}

export interface RegisteredMessage {
  type: 'registered';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
}

export interface SetTagRateMessage {
  type: 'set_tag_rate';
  rate: 'slow' | 'normal' | 'fast';
}

export interface ConfigMessage {
  type: 'config';
  poll_interval_ms: number;
}

export interface AddPassiveTagMessage {
  type: 'add_passive_tag';
  id: number;
  mac: string | number;
  name?: string;
}

export interface RemovePassiveTagMessage {
  type: 'remove_passive_tag';
  id: number;
}

export interface StartPassivePollingMessage {
  type: 'start_passive_polling';
}

export interface StopPassivePollingMessage {
  type: 'stop_passive_polling';
}

export interface LocateAnchorMessage {
  type: 'locate_anchor';
  deviceId: number;
}

export interface SetDeviceModeMessage {
  type: 'set_device_mode';
  deviceId: number;
  mode: number; // 0=anchor, 1=tag, 2=passive_tag
}

export type IncomingMessage =
  | RegisterMessage
  | RangingReport
  | HeartbeatMessage
  | SetTagRateMessage
  | AddPassiveTagMessage
  | RemovePassiveTagMessage
  | StartPassivePollingMessage
  | StopPassivePollingMessage
  | LocateAnchorMessage
  | SetDeviceModeMessage;
export type OutgoingMessage = AnchorListMessage | PositionMessage | RegisteredMessage | ErrorMessage | LogEventMessage | DeviceUpdateMessage | DeviceListMessage | DashboardRangingMessage;

export type LogEventLevel = 'info' | 'warn' | 'error';

export interface LogEventMessage {
  type: 'log_event';
  timestamp: string; // ISO 8601
  level: LogEventLevel;
  event: string;
  detail?: string;
}

export interface TagPosition {
  tagId: number;
  position: Position3D;
  accuracyCm: number;
  timestamp: Date;
  anchorDistances: Map<number, number>;
}

export interface RangingMeasurement {
  anchorId: number;
  tagId: number;
  distanceCm: number;
  timestamp: Date;
}

// Dashboard-specific message types

export interface DeviceUpdateMessage {
  type: 'device_update';
  action: 'connected' | 'disconnected';
  deviceId: number;
  deviceType: 'anchor' | 'tag';
  mac: string;
}

export interface DeviceListMessage {
  type: 'device_list';
  devices: Array<{
    deviceId: number;
    deviceType: 'anchor' | 'tag';
    mac: string;
  }>;
}

export interface DashboardRangingMessage {
  type: 'ranging_update';
  anchorId: number;
  tagId: number;
  distanceCm: number;
}
