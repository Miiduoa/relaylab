# Scenario and report formats

Scenario imports are strict. All fields are required; unknown keys, non-finite values, unsupported versions, and out-of-range inputs are rejected. Browser imports are limited to 16 KB. No imported value is executed.

```json
{
  "version": 1,
  "seed": 4201,
  "messageCount": 12,
  "arrivalInterval": 350,
  "workers": 3,
  "processingTime": 900,
  "jitter": 200,
  "visibilityTimeout": 2000,
  "backoff": 350,
  "maxAttempts": 4,
  "failureRate": 0,
  "ackLossRate": 0,
  "crashRate": 0,
  "recoveryTime": 1500,
  "idempotent": false,
  "firstAckLost": true
}
```

All durations are integer milliseconds. `seed` is an unsigned 32-bit integer. The browser inputs and the engine share the bounds declared in `src/core/scenario.ts`.

`processingTime ± jitter` is uniformly sampled, rounded, and clamped to a minimum of 1 ms. `firstAckLost` deliberately drops M01's first delivery ACK if that delivery reaches a successful write. It does not force a failed or crashed delivery to succeed. Probability fields are independent Bernoulli decisions for their respective stages, not a promised percentage of observed events.

The report format contains a scenario and an immutable-at-export snapshot:

```text
{
  format: "relaylab-report",
  version: 1,
  scenario: Scenario,
  result: {
    now, steps, complete,
    messages, workers, deliveries, events, metrics
  }
}
```

The browser exports the **current** state, including partial runs; the CLI always runs to completion. `steps` is the number of scheduled transitions executed, not the length of the event log. One transition can record several semantic events, such as write then ACK loss. A ready-timer transition can dispatch work without adding a separate “timer fired” log record.

Replay is keyed by the full scenario and `steps`. There is no wall-clock timestamp in the report, so identical runs are directly comparable. Reports from different future engine versions may not replay identically; the current report version is 1, and semantic changes should update the version.
