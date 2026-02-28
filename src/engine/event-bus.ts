/**
 * EventBus — Typed event emitter for bot lifecycle events.
 *
 * Uses eventemitter3 for high-performance event emission.
 * The BotOrchestrator publishes events here; the WebSocket layer
 * (S3) will subscribe and push events to connected clients.
 *
 * Uses composition (not inheritance) because eventemitter3's CJS
 * exports don't play nicely with ESM class extension under NodeNext.
 */

import { EventEmitter } from "eventemitter3";
import type { BotEvent, BotEventType } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// EventBus Singleton
// ═══════════════════════════════════════════════════════════════

class EventBus {
  private static instance: EventBus | null = null;
  private emitter = new EventEmitter();

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  /**
   * Emit a typed bot event.
   */
  emitBotEvent(
    type: BotEventType,
    botId: string,
    userId: number,
    data: Record<string, unknown> = {}
  ): void {
    const event: BotEvent = {
      type,
      botId,
      userId,
      timestamp: Date.now(),
      data,
    };
    this.emitter.emit(type, event);
  }

  /**
   * Listen for a specific event type.
   */
  on(type: BotEventType, handler: (event: BotEvent) => void): void {
    this.emitter.on(type, handler);
  }

  /**
   * Remove a specific listener.
   */
  off(type: BotEventType, handler: (event: BotEvent) => void): void {
    this.emitter.off(type, handler);
  }

  /**
   * Subscribe to all bot events for a specific user.
   * Returns an unsubscribe function.
   */
  subscribeUser(
    userId: number,
    handler: (event: BotEvent) => void
  ): () => void {
    const eventTypes: BotEventType[] = [
      "position:opened",
      "position:closed",
      "position:updated",
      "scan:completed",
      "engine:started",
      "engine:stopped",
      "engine:error",
      "stats:updated",
    ];

    const wrapper = (event: BotEvent) => {
      if (event.userId === userId) {
        handler(event);
      }
    };

    for (const type of eventTypes) {
      this.emitter.on(type, wrapper);
    }

    return () => {
      for (const type of eventTypes) {
        this.emitter.off(type, wrapper);
      }
    };
  }

  /**
   * Subscribe to all bot events for a specific bot.
   * Returns an unsubscribe function.
   */
  subscribeBot(
    botId: string,
    handler: (event: BotEvent) => void
  ): () => void {
    const eventTypes: BotEventType[] = [
      "position:opened",
      "position:closed",
      "position:updated",
      "scan:completed",
      "engine:started",
      "engine:stopped",
      "engine:error",
      "stats:updated",
    ];

    const wrapper = (event: BotEvent) => {
      if (event.botId === botId) {
        handler(event);
      }
    };

    for (const type of eventTypes) {
      this.emitter.on(type, wrapper);
    }

    return () => {
      for (const type of eventTypes) {
        this.emitter.off(type, wrapper);
      }
    };
  }

  /**
   * Reset the singleton (for testing).
   */
  static reset(): void {
    if (EventBus.instance) {
      EventBus.instance.emitter.removeAllListeners();
      EventBus.instance = null;
    }
  }
}

export { EventBus };
export const eventBus = EventBus.getInstance();
