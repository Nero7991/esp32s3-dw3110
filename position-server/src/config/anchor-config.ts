/**
 * UWB Positioning System - Anchor Configuration Manager
 */

import * as fs from 'fs';
import * as path from 'path';
import { AnchorConfig, AnchorConfigFile, Position3D } from './types';

const CONFIG_PATH = path.join(__dirname, '../../config/anchors.json');

class AnchorConfigManager {
  private anchors: Map<number, AnchorConfig> = new Map();
  private macToId: Map<string, number> = new Map();
  private unit: string = 'meters';

  constructor() {
    this.loadConfig();
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const config: AnchorConfigFile = JSON.parse(data);

        this.unit = config.unit || 'meters';

        for (const anchor of config.anchors) {
          this.anchors.set(anchor.id, anchor);
          this.macToId.set(anchor.mac.toLowerCase(), anchor.id);
        }

        console.log(`Loaded ${this.anchors.size} anchors from config`);
      } else {
        console.log('No anchor config file found, using defaults');
        this.createDefaultConfig();
      }
    } catch (err) {
      console.error('Error loading anchor config:', err);
      this.createDefaultConfig();
    }
  }

  private createDefaultConfig(): void {
    // Default 4-anchor setup for a 10x8 meter room
    const defaults: AnchorConfig[] = [
      { id: 1, mac: '0x0001', name: 'NW Corner', position: { x: 0, y: 0, z: 2 } },
      { id: 2, mac: '0x0002', name: 'NE Corner', position: { x: 10, y: 0, z: 2 } },
      { id: 3, mac: '0x0003', name: 'SE Corner', position: { x: 10, y: 8, z: 2 } },
      { id: 4, mac: '0x0004', name: 'SW Corner', position: { x: 0, y: 8, z: 2 } },
    ];

    for (const anchor of defaults) {
      this.anchors.set(anchor.id, anchor);
      this.macToId.set(anchor.mac.toLowerCase(), anchor.id);
    }
  }

  public saveConfig(): void {
    const config: AnchorConfigFile = {
      unit: this.unit,
      anchors: Array.from(this.anchors.values()),
    };

    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('Anchor config saved');
  }

  public getAnchor(id: number): AnchorConfig | undefined {
    return this.anchors.get(id);
  }

  public getAnchorByMac(mac: string): AnchorConfig | undefined {
    const id = this.macToId.get(mac.toLowerCase());
    return id !== undefined ? this.anchors.get(id) : undefined;
  }

  public getAllAnchors(): AnchorConfig[] {
    return Array.from(this.anchors.values());
  }

  public getAnchorPositions(): Map<number, Position3D> {
    const positions = new Map<number, Position3D>();
    for (const [id, anchor] of this.anchors) {
      positions.set(id, anchor.position);
    }
    return positions;
  }

  public setAnchorPosition(id: number, position: Position3D): boolean {
    const anchor = this.anchors.get(id);
    if (anchor) {
      anchor.position = position;
      this.saveConfig();
      return true;
    }
    return false;
  }

  public addAnchor(config: AnchorConfig): void {
    this.anchors.set(config.id, config);
    this.macToId.set(config.mac.toLowerCase(), config.id);
    this.saveConfig();
  }

  public removeAnchor(id: number): boolean {
    const anchor = this.anchors.get(id);
    if (anchor) {
      this.anchors.delete(id);
      this.macToId.delete(anchor.mac.toLowerCase());
      this.saveConfig();
      return true;
    }
    return false;
  }

  public getAnchorCount(): number {
    return this.anchors.size;
  }

  public getAnchorList(): Array<{ id: number; mac: string }> {
    return Array.from(this.anchors.values()).map(a => ({
      id: a.id,
      mac: a.mac,
    }));
  }
}

export const anchorConfig = new AnchorConfigManager();
