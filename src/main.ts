import "./style.css";
import { Simulation, replay } from "./core/engine.ts";
import type { Snapshot, EventKind, TraceEvent } from "./core/engine.ts";
import { defaults, parseScenario, presets, ranges } from "./core/scenario.ts";
import type { Scenario } from "./core/scenario.ts";

let scenario: Scenario = { ...defaults };
let engine = new Simulation(scenario);
let full = new Simulation(scenario).run();
let selected = "M01";
let selectedPreset = "lost-ack";
let timer: ReturnType<typeof setInterval> | undefined;
let speed = 1;
let filter = "all";
let statusNotice = "";
let importRevision = 0;
const $ = <T extends HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
const seconds = (n: number) => (n / 1000).toFixed(2);
const labels: Record<EventKind, string> = {
  produced: "進入佇列",
  delivered: "投遞",
  effect: "寫入",
  deduplicated: "略過重複",
  ack: "已確認",
  "ack-lost": "ACK 遺失",
  "stale-ack": "舊 ACK",
  failed: "處理失敗",
  expired: "租約到期",
  retry: "等待重試",
  "dead-letter": "死信",
  crashed: "Worker 中斷",
  recovered: "Worker 恢復",
};
const statusLabels = {
  waiting: "等待重試",
  ready: "待處理",
  leased: "處理中",
  done: "已確認",
  dead: "死信",
};

$("#app").innerHTML = `
<header class="masthead"><a class="brand" href="./" aria-label="Relaylab 首頁"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 7h17v5h9M3 16h9v9h17M20 7v18"/></svg>relaylab<span> / </span><small>delivery observatory</small></a><nav><button id="model-open" class="text-button">模型說明 <span>↗</span></button><a href="https://github.com/Miiduoa/relaylab" id="source-link" target="_blank" rel="noreferrer">Source <span>↗</span></a></nav></header>
<main>
<section class="intro"><div><div class="eyebrow"><span class="dot"></span> DISTRIBUTED SYSTEMS / EXPERIMENT 001</div><h1>送達，不代表<br/>只發生一次<span class="accent">。</span></h1><p>把投遞、重試和確認之間的空隙，攤開來看。</p></div><div class="intro-note"><span class="folio">R / 01</span><p>一個可重現的訊息佇列實驗室。<br/>調整條件，追蹤每次投遞，<br/>看見副作用真正發生的時刻。</p><span class="local-badge">LOCAL SIMULATION <span>•</span> NO SERVER</span></div></section>
<div class="workspace"><aside class="controls"><div class="section-heading"><span>01 / 實驗條件</span><span class="muted">SCENARIO</span></div><label class="field-label" for="preset">選擇一個問題</label><select id="preset">${presets.map((p) => `<option value="${p.id}">${p.number}　${p.name}</option>`).join("")}<option value="custom" disabled>自訂情境</option></select><p id="preset-description" class="scenario-description"></p>
<button id="control-reveal" class="control-reveal" aria-expanded="false">調整條件 <span>＋</span></button><form id="scenario-form"><div class="control-block"><span class="block-label">DELIVERY</span><div class="field-row"><label for="messageCount">訊息數量</label><input id="messageCount" name="messageCount" type="number" min="1" max="60" required /></div><div class="field-row"><label for="workers">Workers</label><input id="workers" name="workers" type="number" min="1" max="6" required /></div><div class="field-row"><label for="processingTime">處理時間 <small>ms</small></label><input id="processingTime" name="processingTime" type="number" min="50" max="10000" step="1" required /></div><div class="field-row"><label for="visibilityTimeout">可見期限 <small>ms</small></label><input id="visibilityTimeout" name="visibilityTimeout" type="number" min="100" max="20000" step="1" required /></div><div class="field-row"><label for="maxAttempts">最多投遞</label><input id="maxAttempts" name="maxAttempts" type="number" min="1" max="8" required /></div></div>
<label class="toggle-row"><span><strong>冪等寫入</strong><small>相同 message key 只寫入一次</small></span><input id="idempotent" name="idempotent" type="checkbox" role="switch"/><span class="switch" aria-hidden="true"></span></label>
<details class="advanced"><summary>更多條件 <span>＋</span></summary><div class="field-row"><label for="seed">Seed</label><input id="seed" name="seed" type="number" min="0" max="4294967295" required /></div><div class="field-row"><label for="arrivalInterval">抵達間隔 <small>ms</small></label><input id="arrivalInterval" name="arrivalInterval" type="number" min="0" max="5000" required /></div><div class="field-row"><label for="jitter">處理抖動 <small>±ms</small></label><input id="jitter" name="jitter" type="number" min="0" max="5000" required /></div><div class="field-row"><label for="backoff">退避基底 <small>ms</small></label><input id="backoff" name="backoff" type="number" min="0" max="5000" required /></div><div class="field-row"><label for="failureRate">失敗機率</label><input id="failureRate" name="failureRate" type="number" min="0" max="1" step="any" required /></div><div class="field-row"><label for="ackLossRate">ACK 遺失機率</label><input id="ackLossRate" name="ackLossRate" type="number" min="0" max="1" step="any" required /></div><div class="field-row"><label for="crashRate">中斷機率</label><input id="crashRate" name="crashRate" type="number" min="0" max="1" step="any" required /></div><div class="field-row"><label for="recoveryTime">復原時間 <small>ms</small></label><input id="recoveryTime" name="recoveryTime" type="number" min="100" max="10000" required /></div><label class="check-row"><input type="checkbox" id="firstAckLost" name="firstAckLost"/>刻意遺失 M01 的第一份 ACK</label></details>
<button class="apply-button" type="submit">套用並重新開始 <span>↗</span></button><p id="form-status" class="form-status" aria-live="polite"></p></form>
<div class="file-actions"><button id="export-scenario">匯出情境 ↓</button><button id="import-scenario">匯入 JSON ↑</button><input id="import-file" type="file" accept="application/json,.json" hidden/></div><p class="small-note">同一組條件與 seed，會得到相同結果。<br/>所有運算都在這個瀏覽器中完成。</p></aside>
<section class="instrument" aria-label="模擬觀察區"><div class="transport"><div class="clock"><span class="clock-label">SIMULATED TIME</span><span id="clock-value">00.000<span>s</span></span></div><div class="transport-controls"><select id="speed" aria-label="播放速度"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select><button id="reset" class="icon-button" title="重新開始" aria-label="重新開始">↺</button><button id="step" class="secondary-button">單步 <span>→|</span></button><button id="play" class="play-button">▶ <span>播放</span></button></div></div>
<div class="metrics" id="metrics"></div>
<div class="section-heading topology-title"><span>02 / 訊息路徑</span><span id="run-status" class="live-status">PAUSED</span></div><div id="topology" class="topology"></div><p class="scroll-hint">← 左右滑動查看完整圖表 →</p><div class="signal-key"><span><i class="cyan"></i>有效寫入 / ACK</span><span><i class="amber"></i>重試 / 未確認</span><span><i class="red"></i>失敗 / 死信</span></div>
<section class="timeline-section"><div class="section-heading"><span>03 / 投遞時間線</span><span class="muted">WORKER LANES</span></div><p class="chart-note">點選投遞區段，追蹤同一則訊息的所有嘗試。</p><div id="timeline" class="timeline"></div><p class="scroll-hint">← 左右滑動查看完整圖表 →</p><div class="scrubber"><span id="scrub-start">0.00s</span><input id="scrub" type="range" min="0" value="0" step="1" aria-label="模擬步驟回放"/><span id="scrub-end"></span></div><div class="timeline-caption"><span id="step-count"></span><span>拖曳回放，或逐步前進</span></div></section>
<div class="inspection"><section class="message-inspector"><div class="section-heading"><span>04 / 訊息檢視</span><select id="message-select" aria-label="選擇訊息"></select></div><div id="message-detail"></div></section><section class="event-stream"><div class="section-heading"><span>事件記錄</span><select id="event-filter" aria-label="事件篩選"><option value="all">全部事件</option><option value="selected">目前訊息</option><option value="faults">異常事件</option></select></div><div id="events" class="events" role="log" aria-label="投遞事件記錄"></div></section></div>
<div class="instrument-footer"><span id="seed-label"></span><button id="export-report">匯出目前報告 ↓</button></div></section></div>
<section class="takeaway"><span class="eyebrow">OBSERVATION NOTES</span><div><h2>重試保證了再試一次。<br/>它沒有保證只做一次。</h2><p>訊息的確認，與下游的寫入是兩件事。開啟冪等寫入，再跑一次相同情境：投遞仍可能重複，副作用可以被控制。</p></div><span class="takeaway-symbol" aria-hidden="true">↻</span></section>
</main><footer class="page-footer"><span>RELAYLAB / A STUDY IN DELIVERY SEMANTICS</span><span>教學模型，非真實 broker 或效能測試。</span></footer>
<dialog id="model-dialog"><div class="dialog-heading"><span class="eyebrow">MODEL / BOUNDARIES</span><button id="model-close" class="icon-button" aria-label="關閉模型說明">×</button></div><h2>每一步，都有明確的假設。</h2><p>Relaylab 使用單一虛擬時鐘與固定 seed。事件依時間排序；同時發生的事件，依建立順序處理。播放速度只影響畫面更新，不影響模擬結果。</p><dl><dt>投遞與租約</dt><dd>Worker 取得訊息後，佇列暫時隱藏它。到期仍未確認，就依指數退避重試；舊工作可能仍在執行，只有當前租約的 ACK 有效。</dd><dt>副作用與確認</dt><dd>成功處理先產生寫入，再傳送 ACK。ACK 遺失不會撤回寫入。冪等模式以 message ID 做原子去重，假設去重記錄與副作用一起提交，且永不到期。</dd><dt>失敗與中斷</dt><dd>失敗、中斷都發生在寫入之前。失敗立即結束當前租約並退避；中斷等待可見期限到期。復原只讓 worker 重新接收工作。</dd><dt>模型的邊界</dt><dd>沒有網路拓樸、儲存故障、交易隔離、吞吐量限制或實際 I/O。FIFO 僅用於選擇已準備的訊息，不保證完成順序。死信訊息仍可能被尚未完成的舊 delivery 寫入。本工具不宣稱模擬任何特定產品。</dd></dl><a href="https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html" target="_blank" rel="noreferrer">延伸閱讀：Visibility timeout ↗</a></dialog>`;

function syncForm() {
  for (const [key, value] of Object.entries(scenario)) {
    if (key === "version") continue;
    const input = $<HTMLInputElement>(`#${key}`);
    if (typeof value === "boolean") input.checked = value;
    else input.value = String(value);
  }
  $<HTMLSelectElement>("#preset").value = selectedPreset;
  $("#preset-description").textContent =
    presets.find((p) => p.id === selectedPreset)?.description ??
    "已載入自訂條件。調整參數後，按下套用即可重現或比較。";
}

function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
function reset(next = scenario) {
  importRevision++;
  stop();
  scenario = parseScenario(next);
  engine = new Simulation(scenario);
  full = new Simulation(scenario).run();
  selected = "M01";
  syncForm();
  render();
}
function render() {
  const state = engine.snapshot();
  if (state.complete) stop();
  $("#clock-value").innerHTML =
    `${(state.now / 1000).toFixed(3).padStart(6, "0")}<span>s</span>`;
  $("#play").innerHTML = timer
    ? "Ⅱ <span>暫停</span>"
    : `▶ <span>${state.complete ? "重播" : "播放"}</span>`;
  $("#run-status").textContent = state.complete
    ? "COMPLETE"
    : timer
      ? "RUNNING"
      : "PAUSED";
  $("#run-status").classList.toggle("running", !!timer);
  $<HTMLButtonElement>("#step").disabled = state.complete;
  $("#metrics").innerHTML = [
    [state.metrics.produced, "已進入", "MESSAGES"],
    [state.metrics.deliveries, "投遞次數", "DELIVERIES"],
    [state.metrics.effects, "實際寫入", "EFFECTS"],
    [state.metrics.duplicates, "重複寫入", "DUPLICATES"],
  ]
    .map(
      ([value, label, en], i) =>
        `<div class="metric ${i === 3 && Number(value) > 0 ? "warning" : ""}"><span>${en}</span><strong>${String(value).padStart(2, "0")}</strong><small>${label}</small></div>`,
    )
    .join("");
  renderTopology(state);
  renderTimeline(state);
  renderInspector(state);
  renderEvents(state);
  $<HTMLInputElement>("#scrub").max = String(full.steps);
  $<HTMLInputElement>("#scrub").value = String(state.steps);
  $("#scrub-end").textContent = `${seconds(full.now)}s`;
  $("#step-count").textContent =
    `STEP ${String(state.steps).padStart(3, "0")} / ${String(full.steps).padStart(3, "0")}`;
  $("#seed-label").textContent =
    `SEED ${scenario.seed} / ${scenario.idempotent ? "IDEMPOTENCY ON" : "IDEMPOTENCY OFF"}`;
  $("#form-status").textContent = statusNotice;
}

function renderTopology(state: Snapshot) {
  const workerNodes = state.workers
    .map((w, i) => {
      const y = 36 + i * 42;
      const delivery = state.deliveries.find((d) => d.id === w.delivery);
      const cls =
        w.state === "down"
          ? "red-stroke"
          : w.state === "busy"
            ? "amber-stroke"
            : "dim-stroke";
      return `<path d="M278 104H322V${y + 15}H357" class="connection"/><path d="M459 ${y + 15}H497V104H548" class="connection"/><g class="worker-node ${cls}"><rect x="357" y="${y}" width="102" height="30" rx="2"/><circle cx="371" cy="${y + 15}" r="3"/><text x="384" y="${y + 19}">W${w.id}</text><text class="worker-message" x="419" y="${y + 19}">${w.state === "down" ? "DOWN" : (delivery?.message ?? "IDLE")}</text></g>`;
    })
    .join("");
  const height = Math.max(215, 57 + state.workers.length * 42);
  $("#topology").innerHTML =
    `<svg viewBox="0 0 700 ${height}" role="img" aria-label="訊息路徑：${state.metrics.queued} 則等待、${state.metrics.inFlight} 則處理中、${state.metrics.acknowledged} 則確認、${state.metrics.dead} 則死信"><defs><pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.6" fill="#293436"/></pattern></defs><rect width="700" height="${height}" fill="url(#grid)"/><path d="M127 104H180" class="connection"/><path d="M232 137V184H548" class="connection dashed"/><text x="47" y="48" class="node-heading">PRODUCER</text><g class="source-node"><rect x="40" y="74" width="87" height="61" rx="3"/><path d="M63 94h24m-24 10h34m-34 10h19"/></g><text x="83" y="158" class="node-caption">${state.metrics.produced} / ${scenario.messageCount} produced</text><text x="183" y="48" class="node-heading">QUEUE</text><g class="queue-node"><rect x="180" y="74" width="98" height="63" rx="3"/><text x="201" y="112" class="node-number">${String(state.metrics.queued + state.metrics.inFlight).padStart(2, "0")}</text><path d="M252 92v25m7-25v25m7-25v25"/></g><text x="229" y="158" class="node-caption">${state.metrics.inFlight} in flight</text>${workerNodes}<text x="551" y="48" class="node-heading">SINK / EFFECTS</text><g class="sink-node"><rect x="548" y="74" width="104" height="63" rx="3"/><text x="568" y="113" class="node-number">${String(state.metrics.effects).padStart(2, "0")}</text><path d="m616 105 7 7 13-17"/></g><text x="600" y="158" class="node-caption">${state.metrics.acknowledged} acknowledged</text><rect x="548" y="172" width="104" height="25" class="dead-node" rx="2"/><text x="558" y="188" class="dead-caption">DLQ <tspan x="631">${state.metrics.dead}</tspan></text></svg>`;
}

function renderTimeline(state: Snapshot) {
  const width = 720;
  const left = 52;
  const right = 14;
  const top = 28;
  const row = 42;
  const height = top + scenario.workers * row + 20;
  const duration = Math.max(full.now, 1);
  const x = (time: number) => left + (time / duration) * (width - left - right);
  const grid = Array.from(
    { length: 6 },
    (_, i) =>
      `<line x1="${x((duration * i) / 5)}" x2="${x((duration * i) / 5)}" y1="20" y2="${height - 12}" class="timeline-grid"/><text x="${x((duration * i) / 5)}" y="12" class="axis-text">${seconds((duration * i) / 5)}s</text>`,
  ).join("");
  const lanes = state.workers
    .map(
      (w, i) =>
        `<text x="0" y="${top + i * row + 19}" class="lane-text">W${w.id}</text><line x1="${left}" x2="${width - right}" y1="${top + i * row + 30}" y2="${top + i * row + 30}" class="lane-line"/>`,
    )
    .join("");
  const bars = state.deliveries
    .map((d) => {
      const end = Math.min(state.now, d.end);
      const w = Math.max(3, x(end) - x(d.start));
      const failed =
        d.outcome === "failed" ||
        (d.outcome === "crashed" && state.now >= d.end);
      const cls = failed
        ? "fault"
        : !d.valid
          ? "expired"
          : d.outcome === "success"
            ? "success"
            : "active";
      return `<g class="delivery-bar ${cls} ${selected === d.message ? "selected" : ""}" data-message="${d.message}" role="button" tabindex="0" aria-label="${d.message} 第 ${d.attempt} 次投遞，W${d.worker}，${seconds(d.start)} 秒開始"><title>${d.message} · attempt ${d.attempt} · ${seconds(d.start)}–${seconds(end)}s</title><rect x="${x(d.start)}" y="${top + (d.worker - 1) * row}" width="${w}" height="27" rx="2"/>${w > 34 ? `<text x="${x(d.start) + 6}" y="${top + (d.worker - 1) * row + 18}">${d.message}${w > 62 ? ` · ${d.attempt}` : ""}</text>` : ""}</g>`;
    })
    .join("");
  $("#timeline").innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" aria-label="依 Worker 分列的投遞時間線">${grid}${lanes}${bars}<line x1="${x(state.now)}" x2="${x(state.now)}" y1="18" y2="${height - 10}" class="playhead"/><path d="M${x(state.now) - 4} 16h8l-4 5z" fill="#eac27a"/></svg>`;
  document.querySelectorAll<SVGGElement>(".delivery-bar").forEach((bar) => {
    const select = () => {
      selected = bar.dataset.message!;
      render();
    };
    bar.addEventListener("click", select);
    bar.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  });
}

function renderInspector(state: Snapshot) {
  const choices = state.messages.length ? state.messages : [{ id: "M01" }];
  $("#message-select").innerHTML = choices
    .map(
      (m) => `<option ${selected === m.id ? "selected" : ""}>${m.id}</option>`,
    )
    .join("");
  const message = state.messages.find((m) => m.id === selected);
  const history = state.events.filter((e) => e.message === selected);
  $("#message-detail").innerHTML = message
    ? `<div class="message-id"><strong>${message.id}</strong><span class="status-tag ${message.status}">${statusLabels[message.status]}</span></div><div class="message-facts"><div><span>投遞次數</span><strong>${message.attempts}</strong></div><div><span>實際寫入</span><strong class="${message.effects > 1 ? "amber-text" : ""}">${message.effects}</strong></div><div><span>重複攔截</span><strong>${history.filter((e) => e.kind === "deduplicated").length}</strong></div></div><div class="receipt"><span>RECEIPT / ${message.lease ? `D${message.lease}` : "—"}</span><p>${history.at(-1)?.detail ?? "等待下一個事件。"}</p></div><div class="message-history">${history.map((e) => `<div><span class="history-dot kind-${e.kind}"></span><time>${seconds(e.time)}s</time><span>${labels[e.kind]}</span>${e.worker ? `<small>W${e.worker}</small>` : ""}</div>`).join("")}</div>`
    : `<div class="empty-state"><span>WAITING FOR FIRST MESSAGE</span><p>按下播放或單步，讓第一則訊息進入佇列。</p></div>`;
}

function isFault(e: TraceEvent) {
  return [
    "ack-lost",
    "stale-ack",
    "failed",
    "expired",
    "dead-letter",
    "crashed",
  ].includes(e.kind);
}
function renderEvents(state: Snapshot) {
  const events = state.events
    .filter((e) =>
      filter === "selected"
        ? e.message === selected
        : filter === "faults"
          ? isFault(e)
          : true,
    )
    .slice(-80)
    .reverse();
  $("#events").innerHTML = events.length
    ? events
        .map(
          (e) =>
            `<button class="event-row ${isFault(e) ? "event-fault" : ""} ${e.message === selected ? "event-selected" : ""}" data-message="${e.message ?? ""}" ${!e.message ? "disabled" : ""}><time>${seconds(e.time)}</time><span class="event-message">${e.message ?? `W${e.worker}`}</span><span>${labels[e.kind]}</span><span class="event-attempt">${e.attempt ? `#${e.attempt}` : "—"}</span></button>`,
        )
        .join("")
    : '<div class="empty-state"><span>NO EVENTS YET</span><p>符合條件的事件會出現在這裡。</p></div>';
  document
    .querySelectorAll<HTMLButtonElement>(".event-row[data-message]")
    .forEach((row) =>
      row.addEventListener("click", () => {
        if (row.dataset.message) {
          selected = row.dataset.message;
          render();
        }
      }),
    );
}

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function start() {
  if (engine.snapshot().complete) engine = new Simulation(scenario);
  timer = setInterval(() => {
    engine.step();
    render();
  }, 420 / speed);
  render();
}
$("#control-reveal").addEventListener("click", () => {
  const expanded = $(".controls").classList.toggle("expanded");
  $("#control-reveal").setAttribute("aria-expanded", String(expanded));
  $("#control-reveal").innerHTML = expanded
    ? "收合條件 <span>−</span>"
    : "調整條件 <span>＋</span>";
});
$("#play").addEventListener("click", () => {
  if (timer) {
    stop();
    render();
  } else start();
});
$("#step").addEventListener("click", () => {
  stop();
  engine.step();
  render();
});
$("#reset").addEventListener("click", () => reset());
$("#speed").addEventListener("change", (event) => {
  speed = Number((event.target as HTMLSelectElement).value);
  if (timer) {
    stop();
    start();
  }
});
$("#scrub").addEventListener("input", (event) => {
  stop();
  engine = replay(scenario, Number((event.target as HTMLInputElement).value));
  render();
});
$("#message-select").addEventListener("change", (event) => {
  selected = (event.target as HTMLSelectElement).value;
  render();
});
$("#event-filter").addEventListener("change", (event) => {
  filter = (event.target as HTMLSelectElement).value;
  renderEvents(engine.snapshot());
});
$("#preset").addEventListener("change", (event) => {
  const preset = presets.find(
    (p) => p.id === (event.target as HTMLSelectElement).value,
  );
  if (preset) {
    selectedPreset = preset.id;
    statusNotice = "";
    reset({ ...preset.scenario });
  }
});
$("#scenario-form").addEventListener("submit", (event) => {
  event.preventDefault();
  importRevision++;
  try {
    const next = { ...scenario };
    for (const key of Object.keys(ranges) as (keyof typeof ranges)[])
      next[key] = Number($<HTMLInputElement>(`#${key}`).value);
    next.idempotent = $<HTMLInputElement>("#idempotent").checked;
    next.firstAckLost = $<HTMLInputElement>("#firstAckLost").checked;
    parseScenario(next);
    selectedPreset = "custom";
    statusNotice = "已套用，從第 0 步開始。";
    reset(next);
  } catch (error) {
    $("#form-status").textContent =
      error instanceof Error ? error.message : "條件不正確。";
  }
});
$("#scenario-form").addEventListener("input", () => {
  statusNotice = "條件尚未套用。";
  $("#form-status").textContent = statusNotice;
});
$("#export-scenario").addEventListener("click", () =>
  download(`relaylab-scenario-${scenario.seed}.json`, scenario),
);
$("#export-report").addEventListener("click", () =>
  download(`relaylab-report-${scenario.seed}.json`, {
    format: "relaylab-report",
    version: 1,
    scenario,
    result: engine.snapshot(),
  }),
);
$("#import-scenario").addEventListener("click", () =>
  $<HTMLInputElement>("#import-file").click(),
);
$("#import-file").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const revision = ++importRevision;
  // Clear the current selection before awaiting so selecting the same file works.
  // No older completion may clear a later file selection or replace newer state.
  input.value = "";
  try {
    if (file.size > 16000) throw new Error("情境檔案不能超過 16 KB。");
    const contents = await file.text();
    if (revision !== importRevision) return;
    const next = parseScenario(JSON.parse(contents));
    selectedPreset = "custom";
    statusNotice = `已載入 ${file.name}`;
    reset(next);
  } catch (error) {
    if (revision !== importRevision) return;
    stop();
    statusNotice = `匯入失敗：${error instanceof Error ? error.message : String(error)}`;
    render();
  }
});
$("#model-open").addEventListener("click", () =>
  $<HTMLDialogElement>("#model-dialog").showModal(),
);
$("#model-close").addEventListener("click", () =>
  $<HTMLDialogElement>("#model-dialog").close(),
);
$("#model-dialog").addEventListener("click", (event) => {
  if (event.target === $("#model-dialog"))
    $<HTMLDialogElement>("#model-dialog").close();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stop();
    render();
  }
});
// Start at the first lost ACK, making the central race inspectable on arrival.
while (
  !engine.snapshot().events.some((e) => e.kind === "ack-lost") &&
  !engine.snapshot().complete
)
  engine.step();
syncForm();
render();
