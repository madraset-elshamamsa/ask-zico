import type { AssistantCallerRole, Env } from "./types";

export type QuotaReservationReason =
  | "actor_daily_quota"
  | "network_daily_quota"
  | "global_daily_quota"
  | "evaluation_daily_quota"
  | "quota_identity_unavailable"
  | "quota_storage_unavailable";

export type QuotaReservationResult =
  | { action: "allow"; reservation: QuotaReservation }
  | { action: "fallback"; reason: QuotaReservationReason };

export type QuotaReservation = {
  periodKey: string;
  rows: Array<{ scope: "global" | "device" | "user"; usageKey: string }>;
};

const DEFAULT_ACTOR_LIMIT = 50;
const DEFAULT_NETWORK_LIMIT = 150;
const DEFAULT_PUBLIC_GLOBAL_LIMIT = 650;
const DEFAULT_EVAL_LIMIT = 250;

export async function reserveAssistantQuota(
  env: Env,
  input: {
    role: AssistantCallerRole;
    actorId?: string;
    networkId?: string;
    now?: Date;
  },
): Promise<QuotaReservationResult> {
  if (!env.ASSISTANT_FEEDBACK_DB) {
    return { action: "fallback", reason: "quota_storage_unavailable" };
  }

  const periodKey = (input.now ?? new Date()).toISOString().slice(0, 10);
  const requested = input.role === "eval"
    ? [{
      scope: "global" as const,
      usageKey: "evaluation",
      limit: parseLimit(env.ASSISTANT_EVAL_DAILY_MODEL_LIMIT, DEFAULT_EVAL_LIMIT),
      reason: "evaluation_daily_quota" as const,
    }]
    : publicReservations(env, input.actorId, input.networkId);

  if (!requested) {
    return { action: "fallback", reason: "quota_identity_unavailable" };
  }

  const reserved: QuotaReservation["rows"] = [];
  try {
    for (const item of requested) {
      const accepted = await conditionalReserve(
        env,
        periodKey,
        item.scope,
        item.usageKey,
        item.limit,
      );
      if (!accepted) {
        await rollbackReservations(env, periodKey, reserved);
        return { action: "fallback", reason: item.reason };
      }
      reserved.push({ scope: item.scope, usageKey: item.usageKey });
    }
  } catch {
    await rollbackReservations(env, periodKey, reserved);
    return { action: "fallback", reason: "quota_storage_unavailable" };
  }

  return {
    action: "allow",
    reservation: { periodKey, rows: reserved },
  };
}

function publicReservations(env: Env, actorId?: string, networkId?: string) {
  if (!actorId || !networkId) {
    return null;
  }
  return [
    {
      scope: "user" as const,
      usageKey: "public:" + actorId,
      limit: parseLimit(
        env.ASSISTANT_ACTOR_DAILY_MODEL_LIMIT ?? env.ASSISTANT_DEVICE_DAILY_MODEL_LIMIT,
        DEFAULT_ACTOR_LIMIT,
      ),
      reason: "actor_daily_quota" as const,
    },
    {
      scope: "device" as const,
      usageKey: "public:" + networkId,
      limit: parseLimit(env.ASSISTANT_NETWORK_DAILY_MODEL_LIMIT, DEFAULT_NETWORK_LIMIT),
      reason: "network_daily_quota" as const,
    },
    {
      scope: "global" as const,
      usageKey: "public",
      limit: parseLimit(env.ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT, DEFAULT_PUBLIC_GLOBAL_LIMIT),
      reason: "global_daily_quota" as const,
    },
  ];
}

async function conditionalReserve(
  env: Env,
  periodKey: string,
  scope: "global" | "device" | "user",
  usageKey: string,
  limit: number,
): Promise<boolean> {
  const result = await env.ASSISTANT_FEEDBACK_DB!.prepare(
    `INSERT INTO assistant_usage_counters (
      period_type, period_key, scope, usage_key, quota_attempts, updated_at
    )
    SELECT 'day', ?, ?, ?, 1, ?
    WHERE ? > 0
    ON CONFLICT(period_type, period_key, scope, usage_key) DO UPDATE SET
      quota_attempts = quota_attempts + 1,
      updated_at = excluded.updated_at
    WHERE quota_attempts < ?`,
  ).bind(periodKey, scope, usageKey, new Date().toISOString(), limit, limit).run();
  if (result?.success === false) {
    throw new Error("quota reservation failed");
  }
  return result?.meta?.changes === 1;
}

async function rollbackReservations(
  env: Env,
  periodKey: string,
  rows: QuotaReservation["rows"],
): Promise<void> {
  for (const row of rows.reverse()) {
    try {
      await env.ASSISTANT_FEEDBACK_DB!.prepare(
        `UPDATE assistant_usage_counters
         SET quota_attempts = MAX(0, quota_attempts - 1), updated_at = ?
         WHERE period_type = 'day' AND period_key = ? AND scope = ? AND usage_key = ?`,
      ).bind(new Date().toISOString(), periodKey, row.scope, row.usageKey).run();
    } catch {
      // A leaked reservation is safer than an unaccounted model call.
    }
  }
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function inspectAssistantQuota(
  env: Env,
  input: {
    role: AssistantCallerRole;
    actorId?: string;
    networkId?: string;
    now?: Date;
  },
): Promise<{
  action: "allow" | "fallback";
  reason?: QuotaReservationReason;
  quota?: import("./types").AssistantQuotaMetadata;
}> {
  if (!env.ASSISTANT_FEEDBACK_DB) {
    return { action: "fallback", reason: "quota_storage_unavailable" };
  }
  const periodKey = (input.now ?? new Date()).toISOString().slice(0, 10);
  if (input.role === "eval") {
    try {
      const limit = parseLimit(env.ASSISTANT_EVAL_DAILY_MODEL_LIMIT, DEFAULT_EVAL_LIMIT);
      const used = await readQuotaAttempts(env, periodKey, "global", "evaluation");
      return used >= limit
        ? { action: "fallback", reason: "evaluation_daily_quota", quota: { evaluation_daily: quotaWindow(used, limit), block_reason: "evaluation_daily_quota" } }
        : { action: "allow", quota: { evaluation_daily: quotaWindow(used, limit) } };
    } catch {
      return { action: "fallback", reason: "quota_storage_unavailable" };
    }
  }
  if (!input.actorId || !input.networkId) {
    return { action: "fallback", reason: "quota_identity_unavailable" };
  }
  try {
    const actorLimit = parseLimit(env.ASSISTANT_ACTOR_DAILY_MODEL_LIMIT ?? env.ASSISTANT_DEVICE_DAILY_MODEL_LIMIT, DEFAULT_ACTOR_LIMIT);
    const networkLimit = parseLimit(env.ASSISTANT_NETWORK_DAILY_MODEL_LIMIT, DEFAULT_NETWORK_LIMIT);
    const globalLimit = parseLimit(env.ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT, DEFAULT_PUBLIC_GLOBAL_LIMIT);
    const [actorUsed, networkUsed, globalUsed] = await Promise.all([
      readQuotaAttempts(env, periodKey, "user", "public:" + input.actorId),
      readQuotaAttempts(env, periodKey, "device", "public:" + input.networkId),
      readQuotaAttempts(env, periodKey, "global", "public"),
    ]);
    const quota = {
      device_daily: quotaWindow(actorUsed, actorLimit),
      network_daily: quotaWindow(networkUsed, networkLimit),
      global_daily: quotaWindow(globalUsed, globalLimit),
    };
    const reason = actorUsed >= actorLimit
      ? "actor_daily_quota"
      : networkUsed >= networkLimit
        ? "network_daily_quota"
        : globalUsed >= globalLimit
          ? "global_daily_quota"
          : undefined;
    return reason
      ? { action: "fallback", reason, quota: { ...quota, block_reason: reason } }
      : { action: "allow", quota };
  } catch {
    return { action: "fallback", reason: "quota_storage_unavailable" };
  }
}

async function readQuotaAttempts(
  env: Env,
  periodKey: string,
  scope: "global" | "device" | "user",
  usageKey: string,
): Promise<number> {
  const result = await env.ASSISTANT_FEEDBACK_DB!.prepare(
    `SELECT quota_attempts FROM assistant_usage_counters
     WHERE period_type = 'day' AND period_key = ? AND scope = ? AND usage_key = ?
     LIMIT 1`,
  ).bind(periodKey, scope, usageKey).all<{ quota_attempts?: number }>();
  if (result?.success === false) {
    throw new Error("quota read failed");
  }
  return Number(result?.results?.[0]?.quota_attempts ?? 0);
}

function quotaWindow(used: number, limit: number) {
  return { used, limit, remaining: Math.max(0, limit - used) };
}
