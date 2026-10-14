import { mkdir } from "node:fs/promises";
import { OpenCodeWorker } from "../src/workers/opencode.js";

async function main() {
  const dir = "/tmp/orch-smoke";
  await mkdir(dir, { recursive: true });
  const w = new OpenCodeWorker(dir);
  await w.start();
  console.log("started ok");
  try {
    const r = await w.run("Reply with exactly: pong. Do not edit files.");
    console.log("summary:", r.summary.slice(0, 500));
  } finally {
    await w.dispose();
    console.log("disposed");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
