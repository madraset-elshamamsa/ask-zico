import { Hono } from "hono";
import type { Context } from "hono";
import { normalizeArabicForSearch } from "./arabic";
import { createGroundedAnswer, createHandoffAnswer } from "./answer";
import {
  checkAssistantEconomicsGate,
  estimateModelCostUsd,
  quotaAfterQuotaConsumption,
  quotaFallbackMode,
  recordAssistantUsage,
} from "./economics";
import { assertAssistantAccess } from "./auth";
import { enforceAssistantBurstLimits } from "./burst-limit";
import {
  parseAssistantFeedbackRequest,
  storeAssistantFeedback,
} from "./feedback";
import {
  assertAdminAccess,
  cleanupExpiredAssistantAnswerPreviews,
  getAssistantObservabilitySummary,
  parseObservabilityQuery,
  renderAssistantObservabilityDashboard,
  storeAssistantQueryEvent,
} from "./observability";
import { parseAssistantMessageRequest } from "./request";
import { inspectAssistantQuota, reserveAssistantQuota } from "./quota-reservation";
import { debugRetrieveChunks, hydrateChunksByIds, retrieveChunks } from "./retrieval";
import {
  createFallbackAnswerResponse,
  createGroundedAnswerResponse,
  createRetrievalOnlyResponse,
} from "./response";
import type { AssistantMessageRequest, AssistantMessageResponse, AssistantWorkerCpuTiming, AssistantWorkerProfileTiming, Env, RetrievedChunk } from "./types";

const WORKER_CPU_BUDGET_MS = 8;

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "assistant",
  }),
);

app.post("/api/assistant/quota-status", async (c) => {
  const access = assertAssistantAccess(c.req.raw, c.env);
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const request = parseQuotaStatusRequest(body);
  if (!request) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const gate = access.legacy
    ? await checkAssistantEconomicsGate(c.env, {
      deviceId: request.assistant_device_id,
      sessionId: request.session_id,
      userId: request.user_id,
    })
    : await inspectAssistantQuota(c.env, {
      role: access.role,
      actorId: request.actor_id,
      networkId: request.network_id,
    });
  const quota = gate.quota;
  return c.json({
    ok: true,
    assistant_available: gate.action === "allow",
    fallback_reason: gate.action === "fallback" ? gate.reason : undefined,
    quota,
    suggested_actions: gate.action === "fallback"
      ? [
        { type: "navigate_to_url", label: "بحث في الموقع", url: "https://madraset-elshamamsa.com/search.php" },
        { type: "navigate_to_url", label: "مكتبات الموقع", url: "https://madraset-elshamamsa.com/#categoriesSection" },
      ]
      : [],
  });
});

app.post("/api/assistant/message", async (c) => {
  const access = assertAssistantAccess(c.req.raw, c.env);
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }

  const startedAt = Date.now();
  const cpu = createCpuTimer();
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const request = cpu.measure("parse_validation", () => parseAssistantMessageRequest(body));
  if (!request) {
    return c.json({ error: "invalid_request" }, 400);
  }

  if (
    access.role === "proxy" &&
    !access.legacy &&
    (request.retrieval_only ||
      request.debug ||
      request.normalized_query !== undefined ||
      request.retrieval_query !== undefined)
  ) {
    return c.json({ error: "caller_capability_forbidden" }, 403);
  }

  if (access.role === "proxy" && !access.legacy) {
    const burst = await enforceAssistantBurstLimits(c.env, {
      actorId: request.actor_id,
      networkId: request.network_id,
      challengeVerified: request.challenge_verified,
    });
    if (burst.action === "deny") {
      if (burst.reason === "network_burst_limit") {
        return c.json({ error: "turnstile_required", challenge: true }, 429);
      }
      return c.json({ error: burst.reason }, burst.reason === "actor_burst_limit" ? 429 : 503);
    }
  }

  const retrievalQuery = request.retrieval_query ?? buildRetrievalQuery(request);
  const normalizedQuery = request.normalized_query ?? cpu.measure("normalization_routing", () => normalizeArabicForSearch(retrievalQuery));

  if (!access.legacy && !request.retrieval_only) {
    const reservation = await reserveAssistantQuota(c.env, {
      role: access.role,
      actorId: request.actor_id,
      networkId: request.network_id,
    });
    if (reservation.action === "fallback") {
      const response = createFallbackAnswerResponse({
        conversationId: request.conversation_id,
        query: request.message,
        normalizedQuery,
        chunks: [],
        fallbackReason: reservation.reason,
        fallbackMode: quotaFallbackMode(c.env),
        siteUrl: c.env.ASSISTANT_PUBLIC_SITE_URL,
      });
      finalizeResponseCpu(response, cpu);
      return c.json(response);
    }
  }
  const retrievedChunks = await retrieveChunks(c.env, normalizedQuery, cpu);
  const chunks = request.follow_up
    ? mergeChunks(
      await hydrateChunksByIds(c.env, request.follow_up.previous_cited_chunk_ids),
      retrievedChunks,
    )
    : retrievedChunks;
  if (request.retrieval_only) {
    const response = cpu.measure("response_build", () => createRetrievalOnlyResponse({
      conversationId: request.conversation_id,
      query: request.message,
      normalizedQuery,
      chunks,
      includeFullRetrievedChunks: request.debug === true,
    }));
    finalizeResponseCpu(response, cpu);

    return c.json(response);
  }

  const gate = access.legacy
    ? await checkAssistantEconomicsGate(c.env, {
      deviceId: request.assistant_device_id,
      sessionId: request.session_id,
      userId: request.user_id,
    })
    : { action: "allow" as const };

  if (gate.action === "fallback") {
    const response = cpu.measure("response_build", () => createFallbackAnswerResponse({
      conversationId: request.conversation_id,
      query: request.message,
      normalizedQuery,
      chunks,
      fallbackReason: gate.reason,
      fallbackMode: quotaFallbackMode(c.env),
        siteUrl: c.env.ASSISTANT_PUBLIC_SITE_URL,
      quota: gate.quota,
      includeFullRetrievedChunks: request.debug === true,
    }));
    finalizeResponseCpu(response, cpu);

    await cpu.measureAsync("observability_scheduling", () => scheduleAssistantQueryEvent(c, {
      request,
      response,
      normalizedQuery,
      chunks,
      startedAt,
      workerCpu: snapshotCpu(cpu),
    }));
    finalizeResponseCpu(response, cpu);
    await scheduleAssistantUsage(c, {
      request,
      responseKind: "fallback",
      quotaConsumed: false,
      estimatedUsd: 0,
    });

    return c.json(response);
  }

  const answerResult = await createGroundedAnswer(modelEnvForCaller(c.env, access.role), {
    query: request.message,
    chunks,
    followUp: request.follow_up,
  });

  if (!answerResult.ok && isProviderFailure(answerResult.debug)) {
    const response = cpu.measure("response_build", () => createFallbackAnswerResponse({
      conversationId: request.conversation_id,
      query: request.message,
      normalizedQuery,
      chunks,
      fallbackReason: "model_provider_error",
      fallbackMode: quotaFallbackMode(c.env),
        siteUrl: c.env.ASSISTANT_PUBLIC_SITE_URL,
      quota: quotaAfterQuotaConsumption(gate.quota),
      includeFullRetrievedChunks: request.debug === true,
    }));
    finalizeResponseCpu(response, cpu);

    await cpu.measureAsync("observability_scheduling", () => scheduleAssistantQueryEvent(c, {
      request,
      response,
      normalizedQuery,
      chunks,
      startedAt,
      workerCpu: snapshotCpu(cpu),
    }));
    finalizeResponseCpu(response, cpu);
    await scheduleAssistantUsage(c, {
      request,
      responseKind: "fallback",
      quotaConsumed: access.legacy === true,
      estimatedUsd: undefined,
    });

    return c.json(response);
  }

  const groundedAnswer = answerResult.ok ? answerResult.answer : createHandoffAnswer();

  const response = cpu.measure("response_build", () => createGroundedAnswerResponse({
    conversationId: request.conversation_id,
    query: request.message,
    normalizedQuery,
    chunks,
    groundedAnswer,
    answerDebug: answerResult.debug,
    quota: quotaAfterQuotaConsumption(gate.quota),
    includeFullRetrievedChunks: request.debug === true,
  }));
  finalizeResponseCpu(response, cpu);

  await cpu.measureAsync("observability_scheduling", () => scheduleAssistantQueryEvent(c, {
    request,
    response,
    normalizedQuery,
    chunks,
    startedAt,
    workerCpu: snapshotCpu(cpu),
  }));
  finalizeResponseCpu(response, cpu);
  await scheduleAssistantUsage(c, {
    request,
    responseKind: answerResult.ok ? "model" : "fallback",
    quotaConsumed: access.legacy === true,
    estimatedUsd: answerResult.ok && answerResult.debug.mode === "grounded"
      ? answerResult.debug.estimated_model_cost_usd ?? estimateModelCostUsd(c.env)
      : undefined,
  });

  return c.json(response);
});

type QuotaStatusRequest = Pick<AssistantMessageRequest, "assistant_device_id" | "session_id" | "user_id" | "actor_id" | "network_id">;

function parseQuotaStatusRequest(body: unknown): QuotaStatusRequest | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  return {
    assistant_device_id: cleanStatusId(candidate.assistant_device_id),
    session_id: cleanStatusId(candidate.session_id),
    user_id: cleanStatusId(candidate.user_id),
    actor_id: cleanStatusId(candidate.actor_id),
    network_id: cleanStatusId(candidate.network_id),
  };
}

function cleanStatusId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type CpuTimer = {
  addPhase: (name: string, ms: number) => void;
  addWallPhase: (name: string, ms: number) => void;
  measure: <T>(name: string, fn: () => T) => T;
  measureAsync: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  phases: Record<string, number>;
  wallPhases: Record<string, number>;
};

function createCpuTimer(): CpuTimer {
  const phases: Record<string, number> = {};
  const wallPhases: Record<string, number> = {};
  const addPhase = (name: string, ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) return;
    phases[name] = roundCpuMs((phases[name] ?? 0) + ms);
  };
  const addWallPhase = (name: string, ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) return;
    wallPhases[name] = roundCpuMs((wallPhases[name] ?? 0) + ms);
  };
  return {
    phases,
    wallPhases,
    addPhase,
    addWallPhase,
    measure: (name, fn) => {
      const startedAt = performance.now();
      try {
        return fn();
      } finally {
        addPhase(name, performance.now() - startedAt);
      }
    },
    measureAsync: async (name, fn) => {
      const startedAt = performance.now();
      try {
        return await fn();
      } finally {
        addPhase(name, performance.now() - startedAt);
      }
    },
  };
}

function snapshotCpu(cpu: CpuTimer): AssistantWorkerCpuTiming {
  const phases = { ...cpu.phases };
  const cpuMs = roundCpuMs(Object.values(phases).reduce((total, value) => total + value, 0));
  return {
    cpu_ms: cpuMs,
    over_budget: cpuMs > WORKER_CPU_BUDGET_MS,
    phases,
  };
}

function snapshotProfile(cpu: CpuTimer): AssistantWorkerProfileTiming {
  const phases = { ...cpu.wallPhases };
  const wallMs = roundCpuMs(Object.values(phases).reduce((total, value) => total + value, 0));
  return {
    wall_ms: wallMs,
    phases,
  };
}

function finalizeResponseCpu(response: AssistantMessageResponse, cpu: CpuTimer): void {
  response.debug ??= {
    query: "",
    normalized_query: "",
    retrieval_mode: "controlled_hybrid",
  };
  response.debug.worker_cpu = snapshotCpu(cpu);
  response.debug.worker_profile = snapshotProfile(cpu);
}

function roundCpuMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildRetrievalQuery(request: AssistantMessageRequest): string {
  if (!request.follow_up) {
    return request.message;
  }

  return [request.follow_up.previous_user_message, request.message].join("\n");
}

function mergeChunks(primary: RetrievedChunk[], secondary: RetrievedChunk[]): RetrievedChunk[] {
  const chunks: RetrievedChunk[] = [];
  const seen = new Set<string>();

  for (const chunk of [...primary, ...secondary]) {
    if (seen.has(chunk.chunk_id)) {
      continue;
    }
    seen.add(chunk.chunk_id);
    chunks.push(chunk);
  }

  return chunks;
}

type AssistantContext = Context<{ Bindings: Env }>;

async function scheduleAssistantQueryEvent(
  c: AssistantContext,
  input: {
    request: AssistantMessageRequest;
    response: AssistantMessageResponse;
    normalizedQuery: string;
    chunks: RetrievedChunk[];
    startedAt: number;
    workerCpu?: AssistantWorkerCpuTiming;
  },
): Promise<void> {
  const write = storeAssistantQueryEvent(c.env, input);
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    await write;
  }
}


async function scheduleAssistantUsage(
  c: AssistantContext,
  input: {
    request: AssistantMessageRequest;
    responseKind: "model" | "fallback" | "retrieval_only";
    quotaConsumed?: boolean;
    estimatedUsd?: number;
  },
): Promise<void> {
  const write = recordAssistantUsage(c.env, {
    deviceId: input.request.assistant_device_id,
    sessionId: input.request.session_id,
    userId: input.request.user_id,
    responseKind: input.responseKind,
    quotaConsumed: input.quotaConsumed,
    estimatedUsd: input.estimatedUsd,
  });
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    await write;
  }
}

function modelEnvForCaller(env: Env, role: "proxy" | "eval"): Env {
  if (role !== "eval") {
    return env;
  }
  return {
    ...env,
    ASSISTANT_GEMINI_API_KEY: env.ASSISTANT_EVAL_GEMINI_API_KEY,
    ASSISTANT_LLM_API_KEY: env.ASSISTANT_EVAL_LLM_API_KEY,
    OPENROUTER_API_KEY: env.ASSISTANT_EVAL_OPENROUTER_API_KEY,
    ASSISTANT_MODEL_QUOTA_SCOPE: "evaluation",
  };
}
function isProviderFailure(debug: { mode: string; reason?: string; status?: number } | undefined): boolean {
  if (!debug || debug.mode !== "handoff") return false;
  return debug.reason === "llm_http_error" || debug.reason === "llm_fetch_error";
}

app.post("/api/assistant/feedback", async (c) => {
  const access = assertAssistantAccess(c.req.raw, c.env);
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const request = parseAssistantFeedbackRequest(body);
  if (!request) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const result = await storeAssistantFeedback(c.env, request);
  if (result === "missing_binding") {
    return c.json({ error: "feedback_not_configured" }, 500);
  }
  if (result === "write_failed") {
    return c.json({ error: "feedback_write_failed" }, 500);
  }

  return c.json({ ok: true });
});

app.get("/api/assistant/observability/summary", async (c) => {
  const access = assertAdminAccess(c.req.raw, c.env);
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }

  const summary = await getAssistantObservabilitySummary(c.env, parseObservabilityQuery({
    range: c.req.query("range") ?? null,
    topic: c.req.query("topic") ?? null,
    answerState: c.req.query("answer_state") ?? null,
    feedback: c.req.query("feedback") ?? null,
  }));
  if (!summary) {
    return c.json({ error: "observability_not_configured" }, 500);
  }

  return c.json(summary);
});

app.get("/admin/assistant/observability", async (c) => {
  const access = assertAdminAccess(c.req.raw, c.env);
  if (!access.ok) {
    return c.html("Missing or invalid assistant admin token.", access.status);
  }

  const summary = await getAssistantObservabilitySummary(c.env, parseObservabilityQuery({
    range: c.req.query("range") ?? null,
    topic: c.req.query("topic") ?? null,
    answerState: c.req.query("answer_state") ?? null,
    feedback: c.req.query("feedback") ?? null,
  }));
  if (!summary) {
    return c.html("Assistant observability is not configured.", 500);
  }

  return c.html(renderAssistantObservabilityDashboard(summary, c.req.query("token") ?? undefined));
});

app.post("/debug/retrieval", async (c) => {
  const access = assertAssistantAccess(c.req.raw, c.env);
  if (!access.ok) {
    return c.json({ error: access.error }, access.status);
  }

  if (access.role !== "eval" && !access.legacy) {
    return c.json({ error: "caller_capability_forbidden" }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const request = parseAssistantMessageRequest(body);
  if (!request) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const normalizedQuery = normalizeArabicForSearch(request.message);
  return c.json(await debugRetrieveChunks(c.env, normalizedQuery));
});

const worker = Object.assign(app, {
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(cleanupExpiredAssistantAnswerPreviews(env));
  },
});

export default worker;
