import type { Env } from "./types";

export type GeminiModelQuota = {
  model: string;
  rpm: number;
  rpd: number;
  tpm: number;
};

export type GeminiModelReservation = {
  model: string;
  quota: GeminiModelQuota;
  rpmKey: string;
  dayKey: string;
  quotaStorageAvailable: boolean;
};

const DEFAULT_GEMINI_MODEL_QUOTAS: GeminiModelQuota[] = [
  { model: "gemini-3.1-flash-lite", rpm: 15, rpd: 500, tpm: 250000 },
  { model: "gemini-2.5-flash-lite", rpm: 10, rpd: 20, tpm: 250000 },
  { model: "gemini-3-flash-preview", rpm: 5, rpd: 20, tpm: 250000 },
  { model: "gemini-3.5-flash", rpm: 5, rpd: 20, tpm: 250000 },
  { model: "gemini-2.5-flash", rpm: 5, rpd: 20, tpm: 250000 },
];

export function parseGeminiModelQuotas(env: Pick<Env, "ASSISTANT_GEMINI_MODEL_QUOTAS" | "ASSISTANT_GEMINI_MODEL_LADDER">): GeminiModelQuota[] {
  const configured = parseQuotaConfig(env.ASSISTANT_GEMINI_MODEL_QUOTAS);
  const source = configured.length ? configured : DEFAULT_GEMINI_MODEL_QUOTAS;
  const ladder = parseLadder(env.ASSISTANT_GEMINI_MODEL_LADDER);
  if (!ladder.length) {
    return source;
  }

  const quotasByModel = new Map(source.map((quota) => [quota.model, quota]));
  const ordered = ladder
    .map((model) => quotasByModel.get(model) ?? { model, rpm: 1, rpd: 1, tpm: 250000 })
    .filter((quota, index, values) => values.findIndex((item) => item.model === quota.model) === index);
  const remaining = source.filter((quota) => !ordered.some((item) => item.model === quota.model));
  return [...ordered, ...remaining];
}

export async function reserveGeminiModelQuota(
  env: Env,
  input: {
    now?: Date;
    excludedModels?: string[];
    estimatedTokens?: number;
  } = {},
): Promise<GeminiModelReservation | null> {
  const now = input.now ?? new Date();
  const rpmKey = "leaky";
  const dayKey = dayPeriodKey(now);
  const excluded = new Set(input.excludedModels ?? []);
  const estimatedTokens = Math.max(0, Math.ceil(input.estimatedTokens ?? 0));
  const quotas = parseGeminiModelQuotas(env).filter((quota) => !excluded.has(quota.model));
  const failOpenQuota = quotas[0];

  if (!failOpenQuota) {
    return null;
  }

  if (!env.ASSISTANT_FEEDBACK_DB) {
    return null;
  }

  try {
    for (const quota of quotas) {
      if (!(await hasRequestCapacity(env, quota.model, "day", dayKey, quota.rpd))) {
        continue;
      }
      if (!(await hasRpmCapacity(env, quota.model, quota.rpm, now))) {
        continue;
      }

      const dayReserved = await incrementRequestWindow(env, quota.model, "day", dayKey, quota.rpd, estimatedTokens, now);
      if (!dayReserved) {
        continue;
      }

      const rpmReserved = await reserveRpmWindow(env, quota.model, quota.rpm, estimatedTokens, now);
      if (!rpmReserved) {
        await decrementWindow(env, quota.model, "day", dayKey, estimatedTokens, now);
        continue;
      }

      return { model: quota.model, quota, rpmKey, dayKey, quotaStorageAvailable: true };
    }
  } catch {
    return null;
  }

  return null;
}

async function hasRequestCapacity(
  env: Env,
  model: string,
  periodType: "day",
  periodKey: string,
  requestLimit: number,
): Promise<boolean> {
  const row = await readWindow(env, model, periodType, periodKey);
  const requestCount = Number(row?.request_count ?? 0);
  return requestCount < requestLimit;
}

async function hasRpmCapacity(
  env: Env,
  model: string,
  rpm: number,
  now: Date,
): Promise<boolean> {
  const row = await readWindow(env, model, "rpm", "leaky");
  if (!row?.updated_at) {
    return true;
  }

  const updatedAt = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAt)) {
    return true;
  }

  return now.getTime() - updatedAt >= rpmIntervalMs(rpm);
}

async function readWindow(
  env: Env,
  model: string,
  periodType: "rpm" | "day",
  periodKey: string,
): Promise<{ request_count?: number; estimated_tokens?: number; updated_at?: string } | null> {
  const result = await env.ASSISTANT_FEEDBACK_DB?.prepare(
    `SELECT request_count, estimated_tokens, updated_at
        FROM assistant_model_quota_windows
        WHERE provider = ? AND model_name = ? AND period_type = ? AND period_key = ?
        LIMIT 1`,
  ).bind(quotaProvider(env), model, periodType, periodKey).all<{ request_count?: number; estimated_tokens?: number; updated_at?: string }>();
  return result?.results?.[0] ?? null;
}

async function incrementRequestWindow(
  env: Env,
  model: string,
  periodType: "day",
  periodKey: string,
  requestLimit: number,
  estimatedTokens: number,
  now: Date,
): Promise<boolean> {
  const result = await env.ASSISTANT_FEEDBACK_DB?.prepare(
    `INSERT INTO assistant_model_quota_windows (
        provider,
        model_name,
        period_type,
        period_key,
        request_count,
        estimated_tokens,
        updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(provider, model_name, period_type, period_key) DO UPDATE SET
        request_count = request_count + 1,
        estimated_tokens = estimated_tokens + excluded.estimated_tokens,
        updated_at = excluded.updated_at
      WHERE request_count < ?`,
  ).bind(
    quotaProvider(env),
    model,
    periodType,
    periodKey,
    estimatedTokens,
    now.toISOString(),
    requestLimit,
  ).run();
  return result?.success !== false && result?.meta?.changes !== 0;
}

async function reserveRpmWindow(
  env: Env,
  model: string,
  rpm: number,
  estimatedTokens: number,
  now: Date,
): Promise<boolean> {
  const threshold = new Date(now.getTime() - rpmIntervalMs(rpm)).toISOString();
  const result = await env.ASSISTANT_FEEDBACK_DB?.prepare(
    `INSERT INTO assistant_model_quota_windows (
        provider,
        model_name,
        period_type,
        period_key,
        request_count,
        estimated_tokens,
        updated_at
      ) VALUES (?, ?, 'rpm', 'leaky', 1, ?, ?)
      ON CONFLICT(provider, model_name, period_type, period_key) DO UPDATE SET
        request_count = request_count + 1,
        estimated_tokens = estimated_tokens + excluded.estimated_tokens,
        updated_at = excluded.updated_at
      WHERE updated_at <= ?`,
  ).bind(quotaProvider(env), model, estimatedTokens, now.toISOString(), threshold).run();
  return result?.success !== false && result?.meta?.changes !== 0;
}

async function decrementWindow(
  env: Env,
  model: string,
  periodType: "rpm" | "day",
  periodKey: string,
  estimatedTokens: number,
  now: Date,
): Promise<void> {
  try {
    await env.ASSISTANT_FEEDBACK_DB?.prepare(
      `UPDATE assistant_model_quota_windows
        SET request_count = MAX(0, request_count - 1),
            estimated_tokens = MAX(0, estimated_tokens - ?),
            updated_at = ?
        WHERE provider = ? AND model_name = ? AND period_type = ? AND period_key = ?`,
    ).bind(estimatedTokens, now.toISOString(), quotaProvider(env), model, periodType, periodKey).run();
  } catch {
    // Best-effort rollback for a rare two-window reservation race.
  }
}

function parseQuotaConfig(value: string | undefined): GeminiModelQuota[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [model, rpm, rpd, tpm] = entry.split(":").map((part) => part.trim());
      return {
        model,
        rpm: parsePositiveInt(rpm, 1),
        rpd: parsePositiveInt(rpd, 1),
        tpm: parsePositiveInt(tpm, 250000),
      };
    })
    .filter((quota) => Boolean(quota.model));
}

function parseLadder(value: string | undefined): string[] {
  return Array.from(new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rpmIntervalMs(rpm: number): number {
  return Math.ceil(60_000 / Math.max(1, rpm));
}

function dayPeriodKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function quotaProvider(env: Pick<Env, "ASSISTANT_MODEL_QUOTA_SCOPE">): string {
  return env.ASSISTANT_MODEL_QUOTA_SCOPE === "evaluation" ? "gemini:evaluation" : "gemini";
}

export async function reserveOpenRouterQuota(
  env: Env,
  input: { now?: Date } = {},
): Promise<boolean> {
  if (!env.ASSISTANT_FEEDBACK_DB) {
    return false;
  }
  const now = input.now ?? new Date();
  const periodKey = now.toISOString().slice(0, 10);
  const evaluation = env.ASSISTANT_MODEL_QUOTA_SCOPE === "evaluation";
  const limit = parsePositiveInt(
    evaluation ? env.ASSISTANT_EVAL_OPENROUTER_DAILY_LIMIT : env.ASSISTANT_OPENROUTER_DAILY_LIMIT,
    evaluation ? 250 : 650,
  );
  try {
    const result = await env.ASSISTANT_FEEDBACK_DB.prepare(
      `INSERT INTO assistant_model_quota_windows (
        provider, model_name, period_type, period_key, request_count, estimated_tokens, updated_at
      ) VALUES (?, ?, 'day', ?, 1, 0, ?)
      ON CONFLICT(provider, model_name, period_type, period_key) DO UPDATE SET
        request_count = request_count + 1,
        updated_at = excluded.updated_at
      WHERE request_count < ?`,
    ).bind(
      evaluation ? "openrouter:evaluation" : "openrouter",
      env.ASSISTANT_OPENROUTER_MODEL ?? "default",
      periodKey,
      now.toISOString(),
      limit,
    ).run();
    return result?.success !== false && result?.meta?.changes === 1;
  } catch {
    return false;
  }
}
