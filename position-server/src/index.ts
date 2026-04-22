/**
 * UWB Positioning System - Server Entry Point
 *
 * Multi-anchor UWB positioning server with WebSocket connectivity
 * and real-time multilateration.
 */

import { httpServer } from './server/http-server';
import { wsManager } from './server/websocket-server';
import { anchorConfig } from './config/anchor-config';
import { db } from './storage/db';

const PORT = parseInt(process.env.PORT || '3000');

// Startup banner
console.log('=====================================');
console.log('  UWB Positioning System Server');
console.log('=====================================');
console.log();

// Start HTTP server
const server = httpServer.start(PORT);

// Initialize WebSocket server
wsManager.init(server);

// Log anchor configuration
const anchors = anchorConfig.getAllAnchors();
console.log();
console.log('Configured anchors:');
for (const anchor of anchors) {
  console.log(
    `  ${anchor.name} (ID: ${anchor.id}): (${anchor.position.x}, ${anchor.position.y}, ${anchor.position.z})`
  );
}
console.log();

// Periodic cleanup of old data
setInterval(() => {
  db.cleanup(24); // Keep last 24 hours
}, 60 * 60 * 1000); // Every hour

// Periodic status logging
setInterval(() => {
  const devices = wsManager.getDeviceCount();
  console.log(
    `Status: ${devices.anchors} anchors, ${devices.tags} tags connected`
  );
}, 30 * 1000); // Every 30 seconds

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

console.log('Server started successfully');
console.log('Waiting for device connections...');
