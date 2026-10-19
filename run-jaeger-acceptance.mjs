/**
 * Synthetic acceptance proof for SpaceApp #61.
 * Uses the production workflow, API observability and worker interceptors.
 * The only application substitute is runCodexAppServerTurn, which performs no
 * provider/database work, fails once, and then returns a synthetic completion.
 * Requires Node 22 with the checkout's tsx loader and a local Jaeger collector.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(process.env.SPACEAPP_REPO ?? join(evidenceDir, "../spaceapp-bounty"));
const endpoint = process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
const jaeger = process.env.SPACEAPP_JAEGER_URL ?? "http://127.0.0.1:16686";
for (const target of [endpoint, jaeger]) {
  const url = new URL(target);
  assert.equal(url.hostname, "127.0.0.1", "This acceptance script only uses local collectors.");
}
const require = createRequire(join(repo, "package.json"));
const dependency = (name) => import(pathToFileURL(require.resolve(name)).href);
const source = (name) => import(pathToFileURL(join(repo, name)).href);
const [{ default: Fastify }, { Context }, { ApplicationFailure }, { Client },
  { TestWorkflowEnvironment }, { bundleWorkflowCode, DefaultLogger, Runtime, Worker },
  { createOtlpSpanExporter }, { createHttpObservability },
  { requestTraceContexts, traceContextForRawRequest, withTurnTraceparent, workflowCorrelationMemo },
  { createWorkerTracing }, { dummyTurnInputSchema, turnWorkflowResultSchema, buildCodexAppServerTurnWorkflowId }
] = await Promise.all([
  dependency("fastify"), dependency("@temporalio/activity"), dependency("@temporalio/common"),
  dependency("@temporalio/client"), dependency("@temporalio/testing"), dependency("@temporalio/worker"),
  source("packages/runtime/src/otlp-span-exporter.ts"), source("apps/api/src/observability.ts"),
  source("apps/api/src/trace-context.ts"), source("apps/worker/src/worker-tracing.ts"),
  source("packages/contracts/src/index.ts")
]);

await mkdir(evidenceDir, { recursive: true });
const startedAt = new Date().toISOString();
const requestId = `req:${randomUUID()}`;
const taskQueue = `synthetic-jaeger-${randomUUID()}`;
const workflowType = "codexAppServerTurnWorkflow";
const workflowInterceptorModule = join(repo, "apps/worker/src/workflow-tracing.ts");
const privatePrompt = "SYNTHETIC_PROMPT_SHOULD_NOT_BE_EXPORTED";
const privateError = "SYNTHETIC_ERROR_MESSAGE_SHOULD_NOT_BE_EXPORTED";
const privateOutput = "SYNTHETIC_OUTPUT_SHOULD_NOT_BE_EXPORTED";
Runtime.install({ logger: new DefaultLogger("ERROR") });
const env = await TestWorkflowEnvironment.createTimeSkipping();
// A standard Client deliberately avoids the test client's automatic time skip.
// The production one-second retry backoff therefore elapses in actual wall time.
const client = new Client({ connection: env.connection, namespace: env.namespace });
const apiSpans = createOtlpSpanExporter({ endpoint, serviceName: "space-api", flushIntervalMs: 60_000 });
const workerSpans = createOtlpSpanExporter({ endpoint, serviceName: "space-worker", flushIntervalMs: 60_000 });
const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiSpans });
const app = Fastify({ genReqId: () => requestId });
let traceId;
let workflowId;
let temporalRunId;
const activityAttempts = [];

try {
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: join(repo, "apps/worker/src/workflows.ts"),
    workflowInterceptorModules: [workflowInterceptorModule],
    logger: new DefaultLogger("ERROR"),
    webpackConfigHook: (config) => ({
      ...config,
      resolve: { ...config.resolve, alias: { ...config.resolve?.alias,
        "@space/contracts$": join(repo, "packages/contracts/src/index.ts")
      } }
    })
  });
  const tracing = createWorkerTracing(workerSpans, { workflowInterceptorModule });
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    workflowBundle,
    ...tracing,
    // Interceptor already compiled into the production-source bundle above.
    interceptors: { ...tracing.interceptors, workflowModules: [] },
    activities: {
      runCodexAppServerTurn: async (input) => {
        const info = Context.current().info;
        activityAttempts.push({ attempt: info.attempt, activityId: info.activityId, runId: info.workflowExecution.runId });
        temporalRunId = info.workflowExecution.runId;
        if (info.attempt === 1) {
          throw ApplicationFailure.create({ message: privateError, type: "TOOL_UNAVAILABLE" });
        }
        return turnWorkflowResultSchema.parse({
          workflowId: info.workflowExecution.workflowId,
          roomId: input.roomId, paneId: input.paneId, traceId: input.traceId,
          status: "COMPLETED", message: privateOutput
        });
      }
    },
    shutdownForceTime: "10 seconds"
  });
  app.addHook("onRequest", async (request) => {
    const context = traceContextForRawRequest(request.raw);
    requestTraceContexts.remember(request.id, context);
    traceId = context.w3cTraceId;
    observability.onRequest(request);
  });
  app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
  app.post("/api/synthetic-acceptance/turns/:roomId", async (request) => {
    const input = withTurnTraceparent(dummyTurnInputSchema.parse({
      roomId: "room:synthetic-jaeger", paneId: "pane:synthetic-jaeger", traceId: request.id,
      agentRunId: "agent_run:synthetic-jaeger", roomAgentMissionId: "mission:synthetic-jaeger",
      prompt: privatePrompt, providerId: null
    }));
    workflowId = buildCodexAppServerTurnWorkflowId(input);
    return client.workflow.execute(workflowType, {
      workflowId, taskQueue, args: [input], memo: workflowCorrelationMemo(input)
    });
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await worker.runUntil(async () => {
    const received = await fetch(`${address}/api/synthetic-acceptance/turns/synthetic-room`, { method: "POST" });
    return { status: received.status, body: await received.json() };
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "COMPLETED");
  assert.deepEqual(activityAttempts.map(({ attempt }) => attempt), [1, 2]);
  await Promise.all([apiSpans.flush(), workerSpans.flush()]);
  assert.deepEqual(apiSpans.stats(), { exported: 1, dropped: 0, failed: 0 });
  assert.deepEqual(workerSpans.stats(), { exported: 3, dropped: 0, failed: 0 });

  let rawTrace;
  let trace;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const fetched = await fetch(`${jaeger}/api/traces/${traceId}`);
    rawTrace = await fetched.text();
    if (fetched.ok) {
      trace = JSON.parse(rawTrace).data?.[0];
      if (trace?.spans?.length === 4) break;
    }
    await delay(250);
  }
  assert.equal(trace?.spans?.length, 4, "Jaeger must return the API span, workflow and both activity attempts.");
  const tags = (span) => Object.fromEntries(span.tags.map(({ key, value }) => [key, value]));
  const parent = (span) => span.references.find(({ refType }) => refType === "CHILD_OF")?.spanID;
  const api = trace.spans.find(({ operationName }) => operationName === "POST /api/synthetic-acceptance/turns/:roomId");
  const workflow = trace.spans.find(({ operationName }) => operationName === `workflow ${workflowType}`);
  const attempts = trace.spans.filter(({ operationName }) => operationName === "activity runCodexAppServerTurn")
    .sort((a, b) => tags(a)["space.attempt"] - tags(b)["space.attempt"]);
  assert.ok(api && workflow);
  assert.equal(parent(api), undefined);
  assert.equal(parent(workflow), api.spanID);
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) assert.equal(parent(attempt), workflow.spanID);
  assert.equal(tags(attempts[0])["space.outcome"], "FAILED");
  assert.equal(tags(attempts[0])["space.reason_code"], "TOOL_UNAVAILABLE");
  assert.equal(tags(attempts[0])["space.failure_category"], "TOOL_UNAVAILABLE");
  assert.equal(tags(attempts[0]).error, true);
  assert.equal(tags(attempts[1])["space.outcome"], "COMPLETED");
  assert.equal(tags(attempts[1]).error, undefined);
  assert.equal(new Set(trace.spans.map(({ traceID }) => traceID)).size, 1);
  assert.equal(new Set(trace.spans.map(({ spanID }) => spanID)).size, 4);
  for (const secret of [privatePrompt, privateError, privateOutput, "synthetic-room"]) {
    assert.ok(!rawTrace.includes(secret), `Synthetic private field was exported: ${secret}`);
  }
  await writeFile(join(evidenceDir, "jaeger-trace.json"), rawTrace);
  await writeFile(join(evidenceDir, "trace-id.txt"), `${traceId}\n`);
  const sourceFiles = ["apps/api/src/observability.ts", "apps/api/src/trace-context.ts", "apps/worker/src/workflows.ts",
    "apps/worker/src/workflow-tracing.ts", "apps/worker/src/temporal-trace-context.ts", "apps/worker/src/worker-tracing.ts",
    "apps/worker/src/activity-observability.ts", "packages/runtime/src/otlp-span-exporter.ts"];
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) =>
    [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
  const evidence = {
    kind: "synthetic acceptance: production workflow plus retry-once activity stub",
    startedAt, completedAt: new Date().toISOString(), nodeVersion: process.version,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    sourceSha256, repository: repo,
    temporal: { server: "Temporal SDK test server", sdkVersion: "1.24.0", timeSkipping: false,
      timeSkippingExplanation: "Standard Temporal Client used; no test-client time-skipping interceptor.",
      address: env.address, namespace: env.namespace, workflowType, workflowId, temporalRunId, taskQueue },
    environment: { SPACEAPP_REPO: repo, SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, SPACEAPP_JAEGER_URL: jaeger },
    reproductionCommand: ["env", `SPACEAPP_REPO=${repo}`, `SPACE_OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
      `SPACEAPP_JAEGER_URL=${jaeger}`, process.execPath, "--import", join(repo, "node_modules/tsx/dist/loader.mjs"),
      fileURLToPath(import.meta.url)].map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join(" "),
    traceId, jaegerUrl: `${jaeger}/trace/${traceId}`, apiResponseStatus: response.status,
    activityAttempts, exporterStats: { api: apiSpans.stats(), worker: workerSpans.stats() },
    spans: trace.spans.map((span) => ({ traceId: span.traceID, spanId: span.spanID, parentSpanId: parent(span) ?? null,
      name: span.operationName, service: trace.processes[span.processID].serviceName,
      startTime: span.startTime, duration: span.duration, tags: tags(span) })),
    assertions: { connectedApiWorkflowAndBothAttempts: true, firstAttemptToolUnavailable: true,
      secondAttemptCompleted: true, uniqueSpanIds: true, syntheticPrivateFieldsOmitted: true },
    dataProvenance: "jaeger-trace.json is the unchanged response body from local Jaeger /api/traces/{traceId}; IDs and timestamps were not edited."
  };
  await writeFile(join(evidenceDir, "acceptance-metadata.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ traceId, jaegerUrl: evidence.jaegerUrl, spans: evidence.spans,
    assertions: evidence.assertions, exporterStats: evidence.exporterStats }, null, 2));
} finally {
  await app.close();
  observability.close();
  await Promise.all([apiSpans.close(), workerSpans.close()]);
  await env.teardown();
}
