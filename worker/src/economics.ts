import type { AssistantQuotaMetadata, AssistantQuotaWindow, Env } from "./types";

export type AssistantResponseKind = "model" | "fallback" | "retrieval_only";

export type AssistantQuotaBlockReason =
  | "fallback_only_mode"
  | "device_daily_quota"
  | "global_daily_quota"
  | "global_monthly_quota"
  | "monthly_budget";

export type AssistantEconomicsGate =
  | { action: "allow"; quota?: AssistantQuotaMetadata }
  | { action: "fallback"; reason: AssistantQuotaBlockReason; quota?: AssistantQuotaMetadata };

export type AssistantEconomicsInput = {
  deviceId?: string;
  sessionId?: string;
  userId?: string;
  now?: Date;
};

export type AssistantUsageInput = AssistantEconomicsInput & {
  responseKind: AssistantResponseKind;
  estimatedUsd?: number;
  quotaConsumed?: boolean;
  modelCalls?: number;
  retrievalPerformed?: boolean;
};

const DEFAULT_ESTIMATED_MODEL_COST_USD = 0.001;
const DEFAULT_ALERT_THRESHOLDS = [80, 90, 100];
export function estimateModelCostUsd(env: Pick<Env, "ASSISTANT_ESTIMATED_MODEL_COST_USD">): number {
  const parsed = Number(env.ASSISTANT_ESTIMATED_MODEL_COST_USD);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ESTIMATED_MODEL_COST_USD;
}

export async function checkAssistantEconomicsGate(
  env: Env,
  input: AssistantEconomicsInput,
): Promise<AssistantEconomicsGate> {
  if (env.ASSISTANT_FALLBACK_ONLY_MODE === "true") {
    return { action: "fallback", reason: "fallback_only_mode", quota: { block_reason: "fallback_only_mode" } };
  }

  if (!economicsConfigured(env)) {
    return { action: "allow" };
  }

  if (!env.ASSISTANT_FEEDBACK_DB) {
    return { action: "allow" };
  }

  const now = input.now ?? new Date();
  const identity = usageIdentity(input);
  const day = dayKey(now);
  const month = monthKey(now);
  const quota: AssistantQuotaMetadata = {};
  let blockReason: AssistantQuotaBlockReason | null = null;

  const deviceLimit = parseLimit(env.ASSISTANT_DEVICE_DAILY_MODEL_LIMIT);
  if (deviceLimit !== null && identity) {
    const used = await readCounter(env, "day", day, "device", identity);
    quota.device_daily = quotaWindow(used.quota_attempts, deviceLimit);
    if (used.quota_attempts >= deviceLimit) {
      blockReason ??= "device_daily_quota";
    }
  }

  const globalDailyLimit = parseLimit(env.ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT);
  if (globalDailyLimit !== null) {
    const used = await readCounter(env, "day", day, "global", "all");
    quota.global_daily = quotaWindow(used.quota_attempts, globalDailyLimit);
    if (used.quota_attempts >= globalDailyLimit) {
      blockReason ??= "global_daily_quota";
    }
  }

  const globalMonthlyLimit = parseLimit(env.ASSISTANT_GLOBAL_MONTHLY_MODEL_LIMIT);
  if (globalMonthlyLimit !== null) {
    const used = await readCounter(env, "month", month, "global", "all");
    quota.global_monthly = quotaWindow(used.quota_attempts, globalMonthlyLimit);
    if (used.quota_attempts >= globalMonthlyLimit) {
      blockReason ??= "global_monthly_quota";
    }
  }

  const monthlyBudget = parseMoney(env.ASSISTANT_MONTHLY_BUDGET_USD);
  if (monthlyBudget !== null) {
    const used = await readCounter(env, "month", month, "global", "all");
    quota.monthly_budget = quotaWindow(used.estimated_usd, monthlyBudget);
    if (used.estimated_usd >= monthlyBudget) {
      blockReason ??= "monthly_budget";
    }
  }

  if (blockReason) {
    return { action: "fallback", reason: blockReason, quota: { ...quota, block_reason: blockReason } };
  }

  return Object.keys(quota).length ? { action: "allow", quota } : { action: "allow" };
}

export async function recordAssistantUsage(
  env: Env,
  input: AssistantUsageInput,
): Promise<void> {
  if (!env.ASSISTANT_FEEDBACK_DB) {
    return;
  }

  const now = input.now ?? new Date();
  const day = dayKey(now);
  const month = monthKey(now);
  const identity = usageIdentity(input);
  const modelCalls = input.modelCalls ?? (input.responseKind === "model" ? 1 : 0);
  const quotaAttempts = (input.quotaConsumed ?? input.responseKind === "model") ? 1 : 0;
  const fallbackCalls = input.responseKind === "fallback" ? 1 : 0;
  const retrievalCalls = input.retrievalPerformed === false ? 0 : 1;
  const estimatedUsd = input.estimatedUsd ?? (quotaAttempts ? estimateModelCostUsd(env) : 0);

  await safeIncrement(env, "day", day, "global", "all", {
    modelCalls,
    quotaAttempts,
    fallbackCalls,
    retrievalCalls,
    vectorizeQueries: retrievalCalls,
    vectorizeDimensions: retrievalCalls * 1024,
    kvReadsEstimated: retrievalCalls * 8,
    d1WritesEstimated: 1,
    estimatedUsd,
  });
  await safeIncrement(env, "month", month, "global", "all", {
    modelCalls,
    quotaAttempts,
    fallbackCalls,
    retrievalCalls,
    vectorizeQueries: retrievalCalls,
    vectorizeDimensions: retrievalCalls * 1024,
    kvReadsEstimated: retrievalCalls * 8,
    d1WritesEstimated: 1,
    estimatedUsd,
  });

  if (identity) {
    await safeIncrement(env, "day", day, "device", identity, {
      modelCalls,
      quotaAttempts,
      fallbackCalls,
      retrievalCalls,
      vectorizeQueries: 0,
      vectorizeDimensions: 0,
      kvReadsEstimated: 0,
      d1WritesEstimated: 1,
      estimatedUsd,
    });
  }

  await maybeSendBudgetAlerts(env, { day, month, quotaAttempts, estimatedUsd });
}

async function maybeSendBudgetAlerts(
  env: Env,
  input: { day: string; month: string; quotaAttempts: number; estimatedUsd: number },
): Promise<void> {
  if (input.quotaAttempts <= 0 && input.estimatedUsd <= 0) return;
  const thresholds = parseThresholds(env.ASSISTANT_ALERT_THRESHOLDS);
  const checks = [
    {
      periodType: "day",
      periodKey: input.day,
      metric: "quota_attempts",
      limit: parseLimit(env.ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT),
    },
    {
      periodType: "month",
      periodKey: input.month,
      metric: "quota_attempts",
      limit: parseLimit(env.ASSISTANT_GLOBAL_MONTHLY_MODEL_LIMIT),
    },
    {
      periodType: "month",
      periodKey: input.month,
      metric: "estimated_usd",
      limit: parseMoney(env.ASSISTANT_MONTHLY_BUDGET_USD),
    },
  ] as const;

  for (const check of checks) {
    if (!check.limit || check.limit <= 0) continue;
    const counter = await readCounter(env, check.periodType, check.periodKey, "global", "all");
    const value = check.metric === "estimated_usd" ? counter.estimated_usd : counter.quota_attempts;
    const delta = check.metric === "estimated_usd" ? input.estimatedUsd : input.quotaAttempts;
    const previousValue = Math.max(0, value - delta);
    const percent = (value / check.limit) * 100;
    const previousPercent = (previousValue / check.limit) * 100;
    for (const threshold of thresholds) {
      if (percent < threshold || previousPercent >= threshold) continue;
      await sendAlertOnce(env, {
        periodType: check.periodType,
        periodKey: check.periodKey,
        metric: check.metric,
        threshold,
        value,
        limit: check.limit,
      });
    }
  }
}

async function sendAlertOnce(
  env: Env,
  alert: {
    periodType: string;
    periodKey: string;
    metric: string;
    threshold: number;
    value: number;
    limit: number;
  },
): Promise<void> {
  if (!env.ASSISTANT_FEEDBACK_DB) return;
  const existing = await env.ASSISTANT_FEEDBACK_DB.prepare(
    `SELECT id FROM assistant_budget_alerts
      WHERE period_type = ? AND period_key = ? AND metric = ? AND threshold = ?
      LIMIT 1`,
  ).bind(alert.periodType, alert.periodKey, alert.metric, alert.threshold).all();
  if (existing.results?.length) return;

  const sentAt = new Date().toISOString();
  let status = "recorded";
  let error = null;
  try {
    if (env.ASSISTANT_ALERT_WEBHOOK_URL) {
      const fetchImpl = env.ASSISTANT_ALERT_FETCH ?? fetch;
      const response = await fetchImpl(env.ASSISTANT_ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-alert-secret": env.ASSISTANT_ALERT_WEBHOOK_SECRET ?? "",
        },
        body: JSON.stringify({
          to: env.ASSISTANT_ALERT_EMAIL_TO,
          subject: `Assistant budget alert: ${alert.metric} ${alert.threshold}%`,
          alert,
        }),
      });
      status = response.ok ? "sent" : "send_failed";
      error = response.ok ? null : `HTTP ${response.status}`;
    }
  } catch (caught) {
    status = "send_failed";
    error = caught instanceof Error ? caught.message : String(caught);
  }

  await env.ASSISTANT_FEEDBACK_DB.prepare(
    `INSERT INTO assistant_budget_alerts (
      period_type, period_key, metric, threshold, sent_at, status, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    alert.periodType,
    alert.periodKey,
    alert.metric,
    alert.threshold,
    sentAt,
    status,
    error,
  ).run();
}

async function readCounter(
  env: Env,
  periodType: "day" | "month" | string,
  periodKey: string,
  scope: string,
  usageKey: string,
): Promise<{ model_calls: number; quota_attempts: number; estimated_usd: number }> {
  if (!env.ASSISTANT_FEEDBACK_DB) {
    return { model_calls: 0, quota_attempts: 0, estimated_usd: 0 };
  }
  try {
    const result = await env.ASSISTANT_FEEDBACK_DB.prepare(
      `SELECT model_calls, quota_attempts, estimated_usd
        FROM assistant_usage_counters
        WHERE period_type = ? AND period_key = ? AND scope = ? AND usage_key = ?
        LIMIT 1`,
    ).bind(periodType, periodKey, scope, usageKey).all<{
      model_calls?: number;
      quota_attempts?: number;
      estimated_usd?: number;
    }>();
    const row = result.results?.[0];
    return {
      model_calls: numberValue(row?.model_calls),
      quota_attempts: numberValue(row?.quota_attempts ?? row?.model_calls),
      estimated_usd: numberValue(row?.estimated_usd),
    };
  } catch {
    return await readLegacyCounter(env, periodType, periodKey, scope, usageKey);
  }
}

async function readLegacyCounter(
  env: Env,
  periodType: "day" | "month" | string,
  periodKey: string,
  scope: string,
  usageKey: string,
): Promise<{ model_calls: number; quota_attempts: number; estimated_usd: number }> {
  try {
    const result = await env.ASSISTANT_FEEDBACK_DB?.prepare(
      `SELECT model_calls, estimated_usd
        FROM assistant_usage_counters
        WHERE period_type = ? AND period_key = ? AND scope = ? AND usage_key = ?
        LIMIT 1`,
    ).bind(periodType, periodKey, scope, usageKey).all<{
      model_calls?: number;
      estimated_usd?: number;
    }>();
    const row = result?.results?.[0];
    const modelCalls = numberValue(row?.model_calls);
    return {
      model_calls: modelCalls,
      quota_attempts: modelCalls,
      estimated_usd: numberValue(row?.estimated_usd),
    };
  } catch {
    return { model_calls: 0, quota_attempts: 0, estimated_usd: 0 };
  }
}

async function safeIncrement(
  env: Env,
  periodType: string,
  periodKey: string,
  scope: string,
  usageKey: string,
  values: {
    modelCalls: number;
    quotaAttempts: number;
    fallbackCalls: number;
    retrievalCalls: number;
    vectorizeQueries: number;
    vectorizeDimensions: number;
    kvReadsEstimated: number;
    d1WritesEstimated: number;
    estimatedUsd: number;
  },
): Promise<void> {
  try {
    await env.ASSISTANT_FEEDBACK_DB?.prepare(
      `INSERT INTO assistant_usage_counters (
        period_type,
        period_key,
        scope,
        usage_key,
        model_calls,
        quota_attempts,
        fallback_calls,
        retrieval_calls,
        vectorize_queries,
        vectorize_dimensions,
        kv_reads_estimated,
        d1_writes_estimated,
        estimated_usd,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_type, period_key, scope, usage_key) DO UPDATE SET
        model_calls = model_calls + excluded.model_calls,
        quota_attempts = quota_attempts + excluded.quota_attempts,
        fallback_calls = fallback_calls + excluded.fallback_calls,
        retrieval_calls = retrieval_calls + excluded.retrieval_calls,
        vectorize_queries = vectorize_queries + excluded.vectorize_queries,
        vectorize_dimensions = vectorize_dimensions + excluded.vectorize_dimensions,
        kv_reads_estimated = kv_reads_estimated + excluded.kv_reads_estimated,
        d1_writes_estimated = d1_writes_estimated + excluded.d1_writes_estimated,
        estimated_usd = estimated_usd + excluded.estimated_usd,
        updated_at = excluded.updated_at`,
    ).bind(
      periodType,
      periodKey,
      scope,
      usageKey,
      values.modelCalls,
      values.quotaAttempts,
      values.fallbackCalls,
      values.retrievalCalls,
      values.vectorizeQueries,
      values.vectorizeDimensions,
      values.kvReadsEstimated,
      values.d1WritesEstimated,
      values.estimatedUsd,
      new Date().toISOString(),
    ).run();
  } catch {
    // Economics observability must not break user-facing assistant responses.
  }
}

export function quotaAfterQuotaConsumption(quota: AssistantQuotaMetadata | undefined): AssistantQuotaMetadata | undefined {
  if (!quota) return undefined;
  return {
    ...quota,
    device_daily: incrementQuotaWindow(quota.device_daily),
    global_daily: incrementQuotaWindow(quota.global_daily),
    global_monthly: incrementQuotaWindow(quota.global_monthly),
  };
}

export type AssistantQuotaFallbackMode = "search_only" | "sources_with_search";

export function quotaFallbackMode(env: Pick<Env, "ASSISTANT_QUOTA_FALLBACK_MODE">): AssistantQuotaFallbackMode {
  return env.ASSISTANT_QUOTA_FALLBACK_MODE === "sources_with_search"
    ? "sources_with_search"
    : "search_only";
}

function quotaWindow(used: number, limit: number): AssistantQuotaWindow {
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

function incrementQuotaWindow(value: AssistantQuotaWindow | undefined): AssistantQuotaWindow | undefined {
  if (!value) return undefined;
  const used = value.used + 1;
  return {
    used,
    limit: value.limit,
    remaining: Math.max(0, value.limit - used),
  };
}

function economicsConfigured(env: Env): boolean {
  return Boolean(
    env.ASSISTANT_DEVICE_DAILY_MODEL_LIMIT ||
      env.ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT ||
      env.ASSISTANT_GLOBAL_MONTHLY_MODEL_LIMIT ||
      env.ASSISTANT_MONTHLY_BUDGET_USD,
  );
}

function usageIdentity(input: AssistantEconomicsInput): string | null {
  return input.deviceId ?? input.sessionId ?? input.userId ?? null;
}

function parseLimit(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseMoney(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseThresholds(value: string | undefined): number[] {
  const parsed = (value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0 && item <= 100);
  return parsed.length ? parsed : DEFAULT_ALERT_THRESHOLDS;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
