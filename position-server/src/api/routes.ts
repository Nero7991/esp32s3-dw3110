/**
 * UWB Positioning System - REST API Routes
 */

import { Router, Request, Response } from 'express';
import { anchorConfig } from '../config/anchor-config';
import { wsManager } from '../server/websocket-server';
import { positionEngine } from '../positioning/multilateration';
import { db } from '../storage/db';
import { Position3D } from '../config/types';

export const apiRouter = Router();

// Get all anchors with positions
apiRouter.get('/anchors', (req: Request, res: Response) => {
  const anchors = anchorConfig.getAllAnchors();
  res.json(anchors);
});

// Get single anchor
apiRouter.get('/anchors/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const anchor = anchorConfig.getAnchor(id);

  if (anchor) {
    res.json(anchor);
  } else {
    res.status(404).json({ error: 'Anchor not found' });
  }
});

// Update anchor position
apiRouter.put('/anchors/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const position: Position3D = req.body.position;

  if (!position || typeof position.x !== 'number' ||
      typeof position.y !== 'number' || typeof position.z !== 'number') {
    res.status(400).json({ error: 'Invalid position data' });
    return;
  }

  if (anchorConfig.setAnchorPosition(id, position)) {
    res.json({ success: true, anchor: anchorConfig.getAnchor(id) });
  } else {
    res.status(404).json({ error: 'Anchor not found' });
  }
});

// Get current positions of all tags
apiRouter.get('/positions', (req: Request, res: Response) => {
  const positions = positionEngine.getAllPositions();
  res.json(positions);
});

// Get position of specific tag
apiRouter.get('/positions/:tagId', (req: Request, res: Response) => {
  const tagId = parseInt(req.params.tagId);
  const position = positionEngine.getPosition(tagId);

  if (position) {
    res.json(position);
  } else {
    res.status(404).json({ error: 'Tag position not found' });
  }
});

// Get position history for a tag
apiRouter.get('/positions/:tagId/history', (req: Request, res: Response) => {
  const tagId = parseInt(req.params.tagId);
  const limit = parseInt(req.query.limit as string) || 100;
  const since = req.query.since ? new Date(req.query.since as string) : undefined;

  const history = db.getPositionHistory(tagId, limit, since);
  res.json(history);
});

// Get connected devices
apiRouter.get('/devices', (req: Request, res: Response) => {
  const devices = wsManager.getConnectedDevices();
  const counts = wsManager.getDeviceCount();
  res.json({ devices, counts });
});

// Get system status
apiRouter.get('/status', (req: Request, res: Response) => {
  const devices = wsManager.getDeviceCount();
  const anchors = anchorConfig.getAnchorCount();
  const positions = positionEngine.getPositionCount();

  res.json({
    status: 'running',
    uptime: process.uptime(),
    connectedDevices: devices,
    configuredAnchors: anchors,
    trackedTags: positions,
    timestamp: new Date().toISOString(),
  });
});

// Debug: Get ranging buffer state
import { rangingBuffer } from '../positioning/ranging-buffer';

apiRouter.get('/debug/ranging', (req: Request, res: Response) => {
  const tagIds = rangingBuffer.getTagIds();
  const result: Record<number, { anchorCount: number; distances: Record<number, number> | null }> = {};

  for (const tagId of tagIds) {
    const distances = rangingBuffer.getLatestDistances(tagId);
    result[tagId] = {
      anchorCount: rangingBuffer.getAnchorCount(tagId),
      distances: distances ? Object.fromEntries(distances) : null,
    };
  }

  res.json({
    trackedTags: tagIds,
    buffers: result,
  });
});
