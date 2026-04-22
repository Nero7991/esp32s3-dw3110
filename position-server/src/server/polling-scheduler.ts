/**
 * UWB Positioning System - Passive Tag Polling Scheduler
 *
 * Orchestrates sequential anchor-initiated TWR polls to passive tags.
 * Sends one poll_tag command at a time to avoid UWB collisions.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PassiveTagConfig {
  id: number;
  mac: number;
  name: string;
}

interface PendingPoll {
  resolve: (distanceCm: number | null) => void;
  anchorId: number;
  tagId: number;
  timeout: ReturnType<typeof setTimeout>;
}

const CONFIG_PATH = path.join(__dirname, '../../config/passive-tags.json');

export class PollingScheduler {
  private passiveTags: PassiveTagConfig[] = [];
  private running = false;
  private pollIntervalMs = 200;
  private pollTimeoutMs = 300;
  private pendingPoll: PendingPoll | null = null;

  // Injected dependencies
  private sendPollCommand: ((anchorDeviceId: number, tagMac: number) => boolean) | null = null;
  private getConnectedAnchorIds: (() => number[]) | null = null;
  private onLog: ((level: string, event: string, detail?: string) => void) | null = null;

  constructor() {
    this.loadConfig();
  }

  public init(opts: {
    sendPollCommand: (anchorDeviceId: number, tagMac: number) => boolean;
    getConnectedAnchorIds: () => number[];
    onLog?: (level: string, event: string, detail?: string) => void;
  }): void {
    this.sendPollCommand = opts.sendPollCommand;
    this.getConnectedAnchorIds = opts.getConnectedAnchorIds;
    this.onLog = opts.onLog || null;
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (Array.isArray(data.passive_tags)) {
          this.passiveTags = data.passive_tags.map((t: any) => ({
            id: t.id,
            mac: typeof t.mac === 'string' ? parseInt(t.mac, 16) : t.mac,
            name: t.name || `Passive Tag ${t.id}`,
          }));
        }
        console.log(`Loaded ${this.passiveTags.length} passive tags from config`);
      }
    } catch (err) {
      console.error('Error loading passive tags config:', err);
    }
  }

  private saveConfig(): void {
    try {
      const data = {
        passive_tags: this.passiveTags.map(t => ({
          id: t.id,
          mac: `0x${t.mac.toString(16).padStart(4, '0')}`,
          name: t.name,
        })),
      };
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error saving passive tags config:', err);
    }
  }

  /**
   * Called by websocket-server when a ranging report arrives.
   * Returns true if this report was consumed by a pending poll.
   */
  public onRangingReport(anchorId: number, tagId: number, distanceCm: number): boolean {
    if (
      this.pendingPoll &&
      this.pendingPoll.anchorId === anchorId &&
      this.pendingPoll.tagId === tagId
    ) {
      clearTimeout(this.pendingPoll.timeout);
      this.pendingPoll.resolve(distanceCm);
      this.pendingPoll = null;
      return true;
    }
    return false;
  }

  public addPassiveTag(tag: PassiveTagConfig): void {
    const existing = this.passiveTags.findIndex(t => t.id === tag.id);
    if (existing >= 0) {
      this.passiveTags[existing] = tag;
    } else {
      this.passiveTags.push(tag);
    }
    this.saveConfig();
    console.log(`Passive tag added: ${tag.name} (id=${tag.id}, mac=0x${tag.mac.toString(16)})`);
  }

  public removePassiveTag(tagId: number): void {
    this.passiveTags = this.passiveTags.filter(t => t.id !== tagId);
    this.saveConfig();
    console.log(`Passive tag removed: id=${tagId}`);
  }

  public getPassiveTags(): PassiveTagConfig[] {
    return [...this.passiveTags];
  }

  public isRunning(): boolean {
    return this.running;
  }

  public start(): void {
    if (this.running) return;
    if (this.passiveTags.length === 0) {
      console.log('No passive tags configured, not starting scheduler');
      return;
    }
    this.running = true;
    console.log(`Passive polling started for ${this.passiveTags.length} tags`);
    if (this.onLog) this.onLog('info', 'Passive polling started', `${this.passiveTags.length} tags`);
    this.pollLoop();
  }

  public stop(): void {
    this.running = false;
    if (this.pendingPoll) {
      clearTimeout(this.pendingPoll.timeout);
      this.pendingPoll.resolve(null);
      this.pendingPoll = null;
    }
    console.log('Passive polling stopped');
    if (this.onLog) this.onLog('info', 'Passive polling stopped');
  }

  public setPollInterval(ms: number): void {
    this.pollIntervalMs = Math.max(50, ms);
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      for (const tag of this.passiveTags) {
        if (!this.running) break;

        const anchorIds = this.getConnectedAnchorIds!();
        if (anchorIds.length === 0) {
          await this.delay(1000);
          continue;
        }

        for (const anchorId of anchorIds) {
          if (!this.running) break;
          const dist = await this.pollTagFromAnchor(anchorId, tag.mac, tag.id);
          if (dist !== null && this.onLog) {
            this.onLog(
              'info',
              'Passive ranging',
              `anchor=${anchorId} tag=0x${tag.id.toString(16).padStart(4, '0')} dist=${dist}cm`,
            );
          }
        }
      }

      if (this.running) {
        await this.delay(this.pollIntervalMs);
      }
    }
  }

  private pollTagFromAnchor(
    anchorId: number,
    tagMac: number,
    tagId: number,
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPoll = null;
        resolve(null);
      }, this.pollTimeoutMs);

      this.pendingPoll = { resolve, anchorId, tagId, timeout };

      const sent = this.sendPollCommand!(anchorId, tagMac);
      if (!sent) {
        clearTimeout(timeout);
        this.pendingPoll = null;
        resolve(null);
      }
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export const pollingScheduler = new PollingScheduler();
