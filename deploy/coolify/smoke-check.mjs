/**
 * CI smoke checks, run inside the containers of the compose stack:
 *
 *   docker compose exec -T web node --input-type=module - http < deploy/coolify/smoke-check.mjs
 *   docker compose exec -T web node --input-type=module - ocr  < deploy/coolify/smoke-check.mjs
 *
 * `http`: liveness, readiness (summary and token-gated details: database
 * reachable, migrations current) and that the dev sign-in is not served.
 * `ocr`: the packages copied into the standalone server (OCR worker, WASM
 * core, English data, native canvas) load and recognise text.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const mode = process.argv[2];
const base = `http://127.0.0.1:${process.env.PORT || 3000}`;

function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) process.exitCode = 1;
}

if (mode === "http") {
  const health = await fetch(`${base}/api/health`);
  check(health.status === 200 && (await health.json()).status === "ok", `/api/health ${health.status}`);

  const summary = await fetch(`${base}/api/ready`);
  const summaryBody = await summary.json();
  check(summary.status === 200 && summaryBody.status === "ready" && !("checks" in summaryBody), `/api/ready summary ${summary.status} ${JSON.stringify(summaryBody)}`);

  const detail = await fetch(`${base}/api/ready`, { headers: { authorization: `Bearer ${process.env.READINESS_TOKEN}` } });
  const body = await detail.json();
  check(detail.status === 200 && body.ready === true, `/api/ready details ${detail.status}`);
  check(body.checks?.database?.ok === true, "database reachable");
  check(body.checks?.migrations?.ok === true && body.checks.migrations.pending.length === 0, `migrations current (${body.checks?.migrations?.applied}/${body.checks?.migrations?.expected})`);

  const devSignIn = await fetch(`${base}/dev/sign-in`, { redirect: "manual" });
  check(devSignIn.status !== 200, `dev sign-in not served in production (${devSignIn.status})`);
} else if (mode === "ocr") {
  const require = createRequire(join(process.cwd(), "apps/web/server.js"));
  const { createCanvas } = require("@napi-rs/canvas");
  const tesseract = require("tesseract.js");
  const eng = require("@tesseract.js-data/eng");
  const canvas = createCanvas(640, 120);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 640, 120);
  g.fillStyle = "#000";
  g.font = "48px sans-serif";
  g.fillText("Cerebro smoke test", 20, 80);
  const worker = await tesseract.createWorker(["eng"], 1, {
    langPath: join(dirname(eng.langPath), "4.0.0_best_int"),
    cacheMethod: "none",
    gzip: true,
  });
  const { data } = await worker.recognize(canvas.toBuffer("image/png"));
  await worker.terminate();
  check(/smoke/i.test(data.text), `OCR in the web image read "${data.text.trim()}"`);
} else {
  console.error("Usage: node --input-type=module - <http|ocr>");
  process.exitCode = 2;
}
