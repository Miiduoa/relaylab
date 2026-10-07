import { parseScenario } from "./scenario.ts";
import type { Scenario } from "./scenario.ts";

export type MessageStatus = "waiting" | "ready" | "leased" | "done" | "dead";
export type EventKind =
  | "produced"
  | "delivered"
  | "effect"
  | "deduplicated"
  | "ack"
  | "ack-lost"
  | "stale-ack"
  | "failed"
  | "expired"
  | "retry"
  | "dead-letter"
  | "crashed"
  | "recovered";
export interface TraceEvent {
  seq: number;
  time: number;
  kind: EventKind;
  message?: string;
  worker?: number;
  attempt?: number;
  detail: string;
}
export interface Message {
  id: string;
  status: MessageStatus;
  attempts: number;
  lease: number | null;
  effects: number;
  producedAt: number;
  finishedAt: number | null;
}
export interface Worker {
  id: number;
  state: "idle" | "busy" | "down";
  delivery: number | null;
}
export interface Delivery {
  id: number;
  message: string;
  worker: number;
  attempt: number;
  start: number;
  end: number;
  outcome: "processing" | "success" | "failed" | "crashed";
  valid: boolean;
}
interface Scheduled {
  time: number;
  order: number;
  type: "produce" | "finish" | "expire" | "ready" | "recover";
  message?: string;
  delivery?: number;
  worker?: number;
}
export interface Snapshot {
  now: number;
  steps: number;
  complete: boolean;
  messages: Message[];
  workers: Worker[];
  deliveries: Delivery[];
  events: TraceEvent[];
  metrics: {
    produced: number;
    queued: number;
    inFlight: number;
    acknowledged: number;
    dead: number;
    deliveries: number;
    effects: number;
    duplicates: number;
    suppressed: number;
  };
}

/** Mulberry32: random draws depend only on the seed and engine transitions. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export class Simulation {
  readonly scenario: Scenario;
  private readonly rand: () => number;
  private queue: Scheduled[] = [];
  private order = 0;
  private now = 0;
  private steps = 0;
  private messages: Message[] = [];
  private workers: Worker[];
  private deliveries: Delivery[] = [];
  private events: TraceEvent[] = [];
  private committed = new Set<string>();

  constructor(input: Scenario) {
    this.scenario = Object.freeze(parseScenario(input));
    this.rand = random(this.scenario.seed);
    this.workers = Array.from({ length: this.scenario.workers }, (_, i) => ({
      id: i + 1,
      state: "idle",
      delivery: null,
    }));
    for (let i = 0; i < this.scenario.messageCount; i++)
      this.schedule({
        time: i * this.scenario.arrivalInterval,
        type: "produce",
        message: `M${String(i + 1).padStart(2, "0")}`,
      });
  }

  private schedule(event: Omit<Scheduled, "order">) {
    this.queue.push({ ...event, order: this.order++ });
  }
  private trace(
    kind: EventKind,
    detail: string,
    message?: Message,
    delivery?: Delivery,
    worker?: number,
  ) {
    this.events.push({
      seq: this.events.length + 1,
      time: this.now,
      kind,
      detail,
      message: message?.id,
      attempt: delivery?.attempt,
      worker: delivery?.worker ?? worker,
    });
  }
  private retry(message: Message, delivery: Delivery) {
    message.lease = null;
    if (message.attempts >= this.scenario.maxAttempts) {
      message.status = "dead";
      message.finishedAt = this.now;
      this.trace(
        "dead-letter",
        "已用完投遞次數，移至死信佇列。",
        message,
        delivery,
      );
    } else {
      message.status = "waiting";
      const delay = this.scenario.backoff * 2 ** (message.attempts - 1);
      this.schedule({
        time: this.now + delay,
        type: "ready",
        message: message.id,
      });
      this.trace("retry", `等待 ${delay} ms 後可重新投遞。`, message, delivery);
    }
  }
  private dispatch() {
    for (const worker of this.workers) {
      if (worker.state !== "idle") continue;
      const message = this.messages.find((m) => m.status === "ready");
      if (!message) break;
      const duration = Math.max(
        1,
        this.scenario.processingTime +
          Math.round((this.rand() * 2 - 1) * this.scenario.jitter),
      );
      const crashes = this.rand() < this.scenario.crashRate;
      const end =
        this.now + (crashes ? Math.max(1, Math.round(duration / 2)) : duration);
      const delivery: Delivery = {
        id: this.deliveries.length + 1,
        message: message.id,
        worker: worker.id,
        attempt: ++message.attempts,
        start: this.now,
        end,
        outcome: crashes ? "crashed" : "processing",
        valid: true,
      };
      // Crash is sampled at dispatch; the worker changes state at the scheduled interruption.
      this.deliveries.push(delivery);
      worker.state = "busy";
      worker.delivery = delivery.id;
      message.status = "leased";
      message.lease = delivery.id;
      this.trace(
        "delivered",
        `W${worker.id} 取得第 ${delivery.attempt} 次投遞。`,
        message,
        delivery,
      );
      this.schedule({ time: end, type: "finish", delivery: delivery.id });
      this.schedule({
        time: this.now + this.scenario.visibilityTimeout,
        type: "expire",
        delivery: delivery.id,
      });
    }
  }

  /** Advance one scheduled transition (same-time events have stable insertion order). */
  step(): Snapshot {
    if (!this.queue.length) return this.snapshot();
    this.queue.sort((a, b) => a.time - b.time || a.order - b.order);
    const event = this.queue.shift()!;
    this.now = event.time;
    this.steps++;
    const delivery = event.delivery
      ? this.deliveries[event.delivery - 1]
      : undefined;
    const message = this.messages.find(
      (m) => m.id === (event.message ?? delivery?.message),
    );

    if (event.type === "produce") {
      const created: Message = {
        id: event.message!,
        status: "ready",
        attempts: 0,
        lease: null,
        effects: 0,
        producedAt: this.now,
        finishedAt: null,
      };
      this.messages.push(created);
      this.trace("produced", "訊息進入佇列。", created);
    } else if (event.type === "ready" && message?.status === "waiting") {
      message.status = "ready";
    } else if (event.type === "recover") {
      const worker = this.workers[event.worker! - 1];
      worker.state = "idle";
      this.trace(
        "recovered",
        `W${worker.id} 恢復，可接收下一份工作。`,
        undefined,
        undefined,
        worker.id,
      );
    } else if (
      event.type === "expire" &&
      message &&
      delivery &&
      message.lease === delivery.id &&
      message.status === "leased"
    ) {
      delivery.valid = false;
      this.trace(
        "expired",
        "可見期限到期；原 delivery 的 ACK 將不再有效。",
        message,
        delivery,
      );
      this.retry(message, delivery);
    } else if (event.type === "finish" && message && delivery) {
      const worker = this.workers[delivery.worker - 1];
      worker.delivery = null;
      if (delivery.outcome === "crashed") {
        worker.state = "down";
        this.trace(
          "crashed",
          "Worker 在寫入前中斷；等待租約到期。",
          message,
          delivery,
        );
        this.schedule({
          time: this.now + this.scenario.recoveryTime,
          type: "recover",
          worker: worker.id,
        });
      } else {
        worker.state = "idle";
        if (this.rand() < this.scenario.failureRate) {
          delivery.outcome = "failed";
          this.trace("failed", "處理失敗，尚未產生副作用。", message, delivery);
          if (message.lease === delivery.id && message.status === "leased") {
            delivery.valid = false;
            this.retry(message, delivery);
          }
        } else {
          delivery.outcome = "success";
          if (this.scenario.idempotent && this.committed.has(message.id)) {
            this.trace(
              "deduplicated",
              "相同 message key 已經寫入，略過重複副作用。",
              message,
              delivery,
            );
          } else {
            message.effects++;
            this.committed.add(message.id);
            this.trace(
              "effect",
              message.effects > 1
                ? "再次寫入：同一則訊息產生了重複副作用。"
                : "副作用已寫入。",
              message,
              delivery,
            );
          }
          const lost =
            this.rand() < this.scenario.ackLossRate ||
            (this.scenario.firstAckLost &&
              message.id === "M01" &&
              delivery.attempt === 1);
          if (lost)
            this.trace(
              "ack-lost",
              "寫入已成功，但 ACK 遺失；佇列不知道這件事。",
              message,
              delivery,
            );
          else if (
            message.lease === delivery.id &&
            message.status === "leased"
          ) {
            message.status = "done";
            message.lease = null;
            message.finishedAt = this.now;
            this.trace(
              "ack",
              "當前租約已確認，訊息離開佇列。",
              message,
              delivery,
            );
          } else
            this.trace(
              "stale-ack",
              "租約已失效；忽略這份舊 ACK。",
              message,
              delivery,
            );
        }
      }
    }
    this.dispatch();
    // Obsolete timers are removed. They must not inflate duration or replay frames.
    this.queue = this.queue.filter(
      (e) =>
        e.type !== "expire" ||
        this.messages.some(
          (m) => m.status === "leased" && m.lease === e.delivery,
        ),
    );
    return this.snapshot();
  }

  run(): Snapshot {
    let guard = 0;
    while (this.queue.length) {
      this.step();
      if (++guard > 10000)
        throw new Error("Simulation transition limit exceeded.");
    }
    return this.snapshot();
  }

  snapshot(): Snapshot {
    const effects = this.messages.reduce((sum, m) => sum + m.effects, 0);
    const uniqueEffects = this.messages.filter((m) => m.effects > 0).length;
    return {
      now: this.now,
      steps: this.steps,
      complete: this.queue.length === 0,
      messages: this.messages.map((m) => ({ ...m })),
      workers: this.workers.map((w) => ({ ...w })),
      deliveries: this.deliveries.map((d) => ({ ...d })),
      events: this.events.map((e) => ({ ...e })),
      metrics: {
        produced: this.messages.length,
        queued: this.messages.filter(
          (m) => m.status === "waiting" || m.status === "ready",
        ).length,
        inFlight: this.messages.filter((m) => m.status === "leased").length,
        acknowledged: this.messages.filter((m) => m.status === "done").length,
        dead: this.messages.filter((m) => m.status === "dead").length,
        deliveries: this.deliveries.length,
        effects,
        duplicates: effects - uniqueEffects,
        suppressed: this.events.filter((e) => e.kind === "deduplicated").length,
      },
    };
  }
}

export function replay(scenario: Scenario, steps: number): Simulation {
  const engine = new Simulation(scenario);
  for (let i = 0; i < Math.max(0, steps) && !engine.snapshot().complete; i++)
    engine.step();
  return engine;
}
