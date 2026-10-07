export interface Scenario {
  version: 1;
  seed: number;
  messageCount: number;
  arrivalInterval: number;
  workers: number;
  processingTime: number;
  jitter: number;
  visibilityTimeout: number;
  backoff: number;
  maxAttempts: number;
  failureRate: number;
  ackLossRate: number;
  crashRate: number;
  recoveryTime: number;
  idempotent: boolean;
  firstAckLost: boolean;
}

export const defaults: Scenario = {
  version: 1,
  seed: 4201,
  messageCount: 12,
  arrivalInterval: 350,
  workers: 3,
  processingTime: 900,
  jitter: 200,
  visibilityTimeout: 2000,
  backoff: 350,
  maxAttempts: 4,
  failureRate: 0,
  ackLossRate: 0,
  crashRate: 0,
  recoveryTime: 1500,
  idempotent: false,
  firstAckLost: true,
};

export const presets = [
  {
    id: "lost-ack",
    number: "01",
    name: "寫入成功，確認遺失",
    label: "THE LOST ACK",
    description:
      "M01 已經寫入，但第一份 ACK 在途中遺失。等租約到期後，另一個 worker 會再次處理同一則訊息。",
    scenario: { ...defaults },
  },
  {
    id: "retries",
    number: "02",
    name: "失敗會如何堆積",
    label: "RETRY PRESSURE",
    description:
      "一半的處理嘗試會失敗。觀察指數退避如何拉開重試間隔，以及耗盡次數的訊息如何進入死信佇列。",
    scenario: {
      ...defaults,
      firstAckLost: false,
      failureRate: 0.5,
      messageCount: 18,
      maxAttempts: 3,
      idempotent: true,
    },
  },
  {
    id: "short-lease",
    number: "03",
    name: "租約比工作更早到期",
    label: "OVERLAPPING DELIVERY",
    description:
      "處理需要 1.8 秒，但租約只保留 1 秒。舊工作還沒完成，新一輪投遞已經開始。ACK 只能確認當前租約。",
    scenario: {
      ...defaults,
      messageCount: 8,
      firstAckLost: false,
      processingTime: 1800,
      jitter: 0,
      visibilityTimeout: 1000,
      backoff: 100,
      idempotent: true,
    },
  },
  {
    id: "crashes",
    number: "04",
    name: "Worker 中斷與復原",
    label: "WORKER RECOVERY",
    description:
      "Worker 可能在處理途中中斷。未確認的訊息留在佇列，等可見期限到期後重新投遞。",
    scenario: {
      ...defaults,
      firstAckLost: false,
      crashRate: 0.3,
      recoveryTime: 2000,
      idempotent: true,
    },
  },
] as const;

type NumericKey = {
  [K in keyof Scenario]: Scenario[K] extends number ? K : never;
}[keyof Scenario];
export const ranges: Record<
  Exclude<NumericKey, "version">,
  [number, number, boolean]
> = {
  seed: [0, 4294967295, true],
  messageCount: [1, 60, true],
  arrivalInterval: [0, 5000, true],
  workers: [1, 6, true],
  processingTime: [50, 10000, true],
  jitter: [0, 5000, true],
  visibilityTimeout: [100, 20000, true],
  backoff: [0, 5000, true],
  maxAttempts: [1, 8, true],
  failureRate: [0, 1, false],
  ackLossRate: [0, 1, false],
  crashRate: [0, 1, false],
  recoveryTime: [100, 10000, true],
};

export function parseScenario(input: unknown): Scenario {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("情境必須是 JSON 物件。");
  const value = input as Record<string, unknown>;
  if (value.version !== 1)
    throw new Error("不支援這個情境版本，請使用 version: 1。");
  const allowed = new Set(Object.keys(defaults));
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`未知欄位：${key}`);
  for (const [key, [min, max, integer]] of Object.entries(ranges)) {
    const n = value[key];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (integer && !Number.isInteger(n))
    ) {
      throw new Error(
        `${key} 必須是 ${min} 到 ${max} 之間的${integer ? "整數" : "數字"}。`,
      );
    }
  }
  if (
    typeof value.idempotent !== "boolean" ||
    typeof value.firstAckLost !== "boolean"
  )
    throw new Error("idempotent 與 firstAckLost 必須是布林值。");
  return { ...value } as unknown as Scenario;
}
