import { describe, expect, it } from "vitest";
import { Simulation, replay } from "../src/core/engine.ts";
import { defaults, parseScenario, presets } from "../src/core/scenario.ts";
import type { Scenario } from "../src/core/scenario.ts";

function run(overrides: Partial<Scenario> = {}) {
  return new Simulation({ ...defaults, ...overrides }).run();
}

describe("delivery semantics", () => {
  it("retries a committed effect when its ACK is lost", () => {
    const result = run();
    expect(result.metrics).toMatchObject({
      produced: 12,
      acknowledged: 12,
      deliveries: 13,
      effects: 13,
      duplicates: 1,
    });
    const first = result.events.filter((e) => e.message === "M01");
    expect(first.map((e) => e.kind)).toEqual([
      "produced",
      "delivered",
      "effect",
      "ack-lost",
      "expired",
      "retry",
      "delivered",
      "effect",
      "ack",
    ]);
    expect(
      first.filter((e) => e.kind === "delivered").map((e) => e.time),
    ).toEqual([0, 2350]);
  });

  it("idempotency suppresses the effect, not the duplicate delivery", () => {
    const result = run({ idempotent: true });
    expect(result.metrics).toMatchObject({
      acknowledged: 12,
      deliveries: 13,
      effects: 12,
      duplicates: 0,
      suppressed: 1,
    });
  });

  it("uses exponential backoff and caps attempts on repeated processing failures", () => {
    const result = run({
      messageCount: 1,
      failureRate: 1,
      processingTime: 100,
      jitter: 0,
      backoff: 50,
      firstAckLost: false,
      maxAttempts: 4,
    });
    expect(
      result.events.filter((e) => e.kind === "delivered").map((e) => e.time),
    ).toEqual([0, 150, 350, 650]);
    expect(result.metrics).toMatchObject({
      dead: 1,
      deliveries: 4,
      effects: 0,
      acknowledged: 0,
    });
    expect(result.now).toBe(750);
  });

  it("ignores ACKs from expired leases while allowing already-running work to finish", () => {
    const result = run({
      messageCount: 1,
      processingTime: 1000,
      jitter: 0,
      visibilityTimeout: 200,
      backoff: 0,
      workers: 2,
      firstAckLost: false,
      maxAttempts: 2,
    });
    expect(result.metrics).toMatchObject({
      dead: 1,
      acknowledged: 0,
      effects: 2,
      duplicates: 1,
      deliveries: 2,
    });
    expect(result.events.filter((e) => e.kind === "stale-ack")).toHaveLength(2);
    const deadAt = result.events.find((e) => e.kind === "dead-letter")!.time;
    expect(
      result.events
        .filter((e) => e.kind === "effect")
        .every((e) => e.time > deadAt),
    ).toBe(true);
    expect(result.messages[0].lease).toBeNull();
  });

  it("keeps the newer lease when an older attempt fails", () => {
    const result = run({
      messageCount: 1,
      processingTime: 500,
      jitter: 0,
      visibilityTimeout: 300,
      backoff: 0,
      workers: 2,
      failureRate: 1,
      firstAckLost: false,
      maxAttempts: 2,
    });
    expect(
      result.events.filter((e) => e.kind === "expired").map((e) => e.time),
    ).toEqual([300, 600]);
    expect(result.events.find((e) => e.kind === "dead-letter")!.time).toBe(600);
    expect(result.metrics.effects).toBe(0);
  });

  it("does not redeliver after a successful ACK", () => {
    const result = run({
      messageCount: 1,
      firstAckLost: false,
      processingTime: 100,
      jitter: 0,
      visibilityTimeout: 20000,
    });
    expect(result.metrics.deliveries).toBe(1);
    expect(result.now).toBe(100); // Obsolete visibility timers do not extend the clock.
    expect(result.events.some((e) => e.kind === "expired")).toBe(false);
  });

  it("uses stable insertion order when completion and expiry share a timestamp", () => {
    const result = run({
      messageCount: 1,
      firstAckLost: false,
      processingTime: 100,
      jitter: 0,
      visibilityTimeout: 100,
    });
    expect(result.metrics.acknowledged).toBe(1);
    expect(result.events.some((e) => e.kind === "expired")).toBe(false);
  });

  it("worker crashes leave unconfirmed messages leased until visibility expires", () => {
    const result = run({
      messageCount: 1,
      workers: 1,
      crashRate: 1,
      recoveryTime: 100,
      visibilityTimeout: 500,
      processingTime: 100,
      jitter: 0,
      maxAttempts: 2,
      backoff: 0,
    });
    expect(
      result.events.filter((e) => e.kind === "crashed").map((e) => e.time),
    ).toEqual([50, 550]);
    expect(
      result.events.filter((e) => e.kind === "recovered").map((e) => e.time),
    ).toEqual([150, 650]);
    expect(
      result.events.filter((e) => e.kind === "delivered").map((e) => e.time),
    ).toEqual([0, 500]);
    expect(result.metrics).toMatchObject({
      effects: 0,
      dead: 1,
      deliveries: 2,
    });
    expect(result.workers.every((w) => w.state === "idle")).toBe(true);
  });
});

describe("reproducibility and invariants", () => {
  it.each(presets)(
    "replays $id exactly at every transition",
    ({ scenario }) => {
      const engine = new Simulation(scenario);
      const states = [engine.snapshot()];
      while (!engine.snapshot().complete) states.push(engine.step());
      expect(states.length).toBeGreaterThan(1);
      for (const index of [
        0,
        1,
        Math.floor(states.length / 2),
        states.length - 1,
      ]) {
        expect(replay(scenario, index).snapshot()).toEqual(states[index]);
      }
    },
  );

  it("holds conservation and at-most-one idempotent effect across varied seeds and faults", () => {
    for (let seed = 0; seed < 100; seed++) {
      const scenario = {
        ...defaults,
        seed,
        messageCount: 1 + (seed % 17),
        workers: 1 + (seed % 6),
        visibilityTimeout: 100 + (seed % 9) * 200,
        processingTime: 100 + (seed % 7) * 130,
        failureRate: (seed % 5) / 5,
        crashRate: (seed % 4) / 4,
        ackLossRate: (seed % 3) / 3,
        idempotent: true,
      };
      const engine = new Simulation(scenario);
      let prior = 0;
      while (!engine.snapshot().complete) {
        const state = engine.step();
        const m = state.metrics;
        expect(m.queued + m.inFlight + m.acknowledged + m.dead).toBe(
          m.produced,
        );
        expect(state.now).toBeGreaterThanOrEqual(prior);
        prior = state.now;
        expect(
          state.messages.every(
            (message) =>
              message.effects <= 1 && message.attempts <= scenario.maxAttempts,
          ),
        ).toBe(true);
        expect(
          state.workers
            .filter((w) => w.state === "busy")
            .every((w) => w.delivery !== null),
        ).toBe(true);
      }
      const end = engine.snapshot();
      expect(end.metrics.acknowledged + end.metrics.dead).toBe(
        scenario.messageCount,
      );
      expect(end.metrics.duplicates).toBe(0);
      expect(end).toEqual(new Simulation(scenario).run());
    }
  });

  it("returns detached snapshots so consumers cannot mutate the engine", () => {
    const engine = new Simulation(defaults);
    const state = engine.step();
    state.messages[0].status = "dead";
    state.workers[0].state = "down";
    state.events.length = 0;
    expect(engine.snapshot().messages[0].status).toBe("leased");
    expect(engine.snapshot().workers[0].state).toBe("busy");
    expect(engine.snapshot().events.length).toBe(2);
  });
});

describe("scenario validation", () => {
  it.each([
    null,
    [],
    {},
    { ...defaults, version: 2 },
    { ...defaults, seed: NaN },
    { ...defaults, workers: 1.5 },
    { ...defaults, messageCount: 61 },
    { ...defaults, idempotent: "true" },
    { ...defaults, surprise: 1 },
  ])("rejects malformed input %#", (input) => {
    expect(() => parseScenario(input)).toThrow();
  });
  it("round trips the exported scenario", () =>
    expect(parseScenario(JSON.parse(JSON.stringify(defaults)))).toEqual(
      defaults,
    ));
});
