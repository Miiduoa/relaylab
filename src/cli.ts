import { readFileSync, writeFileSync } from "node:fs";
import { Simulation } from "./core/engine.ts";
import { parseScenario, presets } from "./core/scenario.ts";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return args[index + 1];
}
try {
  if (args.includes("--help")) {
    console.log(
      "Relaylab\n\n  npm run simulate -- [--preset lost-ack|retries|short-lease|crashes]\n    [--scenario file.json] [--idempotent] [--seed integer] [--out report.json]\n\nEmits a deterministic JSON report. --scenario overrides --preset.",
    );
  } else {
    const allowed = new Set([
      "--preset",
      "--scenario",
      "--idempotent",
      "--seed",
      "--out",
    ]);
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i]))
        throw new Error(`Unknown argument: ${args[i]}`);
      if (args[i] !== "--idempotent") i++;
    }
    const presetName = option("--preset") ?? "lost-ack";
    const preset = presets.find((p) => p.id === presetName);
    if (!preset) throw new Error(`Unknown preset: ${presetName}`);
    const file = option("--scenario");
    let scenario = file
      ? parseScenario(JSON.parse(readFileSync(file, "utf8")))
      : { ...preset.scenario };
    if (args.includes("--idempotent")) scenario.idempotent = true;
    if (option("--seed") !== undefined)
      scenario.seed = Number(option("--seed"));
    scenario = parseScenario(scenario);
    const result = new Simulation(scenario).run();
    const report =
      JSON.stringify(
        { format: "relaylab-report", version: 1, scenario, result },
        null,
        2,
      ) + "\n";
    const output = option("--out");
    if (output) {
      writeFileSync(output, report, { flag: "wx" });
      console.error(`Saved ${output}`);
    } else process.stdout.write(report);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
