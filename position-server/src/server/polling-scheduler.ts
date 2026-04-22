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
  /* Inter-cycle pause (after all anchors polled for all tags). 0 = run
   * continuously; the cycle wall time is bounded by WiFi RTT for the
   * last poll's report-back. */
  private pollIntervalMs = 0;
  /* Per-poll timeout: WiFi RTT (~10–30 ms) + TWR exchange (~5 ms) + margin. */
  private pollTimeoutMs = 80;
  /* Inter-anchor spacing within a cycle. Must exceed the UWB TWR cycle
   * (~5 ms POLL→RESP→FINAL→REPORT) so the tag's single RX channel doesn't
   * collide. WiFi RTT for the previous anchor's report-back overlaps with
   * this gap, so total cycle wall time ≈ (N-1)*spacing + RTT. */
  private interAnchorSpacingMs = 8;
  private pendingPolls: Map<string, PendingPoll> = new Map();

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

  private static pollKey(anchorId: number, tagId: number): string {
    return `${anchorId}:${tagId}`;
  }

  /**
   * Called by websocket-server when a ranging report arrives.
   * Returns true if this report was consumed by a pending poll.
   */
  public onRangingReport(anchorId: number, tagId: number, distanceCm: number): boolean {
    const key = PollingScheduler.pollKey(anchorId, tagId);
    const pending = this.pendingPolls.get(key);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(distanceCm);
      this.pendingPolls.delete(key);
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
    for (const pending of this.pendingPolls.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingPolls.clear();
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

        /* Pipelined polling: fire each anchor's poll command spaced by
         * interAnchorSpacingMs (just enough for the previous TWR to clear
         * the UWB radio before the next anchor's POLL). Don't wait for
         * the WiFi report-back round-trip — collect all promises in
         * parallel and Promise.all them at the end. */
        const promises: Promise<number | null>[] = [];
        for (let i = 0; i < anchorIds.length; i++) {
          if (!this.running) break;
          const anchorId = anchorIds[i];
          promises.push(this.pollTagFromAnchor(anchorId, tag.mac, tag.id));
          if (i < anchorIds.length - 1) {
            await this.delay(this.interAnchorSpacingMs);
          }
        }
        const results = await Promise.all(promises);
        if (this.onLog) {
          for (let i = 0; i < anchorIds.length; i++) {
            const dist = results[i];
            if (dist !== null) {
              this.onLog(
                'info',
                'Passive ranging',
                `anchor=${anchorIds[i]} tag=0x${tag.id.toString(16).padStart(4, '0')} dist=${dist}cm`,
              );
            }
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
      const key = PollingScheduler.pollKey(anchorId, tagId);
      const timeout = setTimeout(() => {
        this.pendingPolls.delete(key);
        resolve(null);
      }, this.pollTimeoutMs);

      this.pendingPolls.set(key, { resolve, anchorId, tagId, timeout });

      const sent = this.sendPollCommand!(anchorId, tagMac);
      if (!sent) {
        clearTimeout(timeout);
        this.pendingPolls.delete(key);
        resolve(null);
      }
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export const pollingScheduler = new PollingScheduler();
