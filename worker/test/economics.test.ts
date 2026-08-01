import { describe, expect, test } from "vitest";
import {
  checkAssistantEconomicsGate,
  estimateModelCostUsd,
  recordAssistantUsage,
} from "../src/economics";
import type { Env } from "../src/types";

type RecordedQuery = {
  query: string;
  values: unknown[];
};

function createEnv(overrides: Partial<Env> = {}) {
  const rows: Record<string, unknown>[] = [];
  const alerts = new Set<string>();
  const queries: RecordedQuery[] = [];
  const env: Env & { rows: typeof rows; queries: typeof queries; alerts: typeof alerts } = {
    ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "1",
    ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT: "2",
    ASSISTANT_GLOBAL_MONTHLY_MODEL_LIMIT: "10",
    ASSISTANT_MONTHLY_BUDGET_USD: "5",
    ASSISTANT_ESTIMATED_MODEL_COST_USD: "0.001",
    ASSISTANT_ALERT_THRESHOLDS: "80,90,100",
    ASSISTANT_FEEDBACK_DB: {
      prepare: (query) => ({
        bind: (...values) => ({
          run: async () => {
            queries.push({ query, values });
            if (query.includes("INSERT INTO assistant_usage_counters")) {
              const [periodType, periodKey, scope, usageKey] = values.map(String);
              const existing = rows.find((row) =>
                row.period_type === periodType &&
                row.period_key === periodKey &&
                row.scope === scope &&
                row.usage_key === usageKey,
              );
              if (existing) {
                existing.model_calls = Number(existing.model_calls ?? 0) + Number(values[4] ?? 0);
                existing.quota_attempts = Number(existing.quota_attempts ?? 0) + Number(values[5] ?? 0);
                existing.fallback_calls = Number(existing.fallback_calls ?? 0) + Number(values[6] ?? 0);
                existing.retrieval_calls = Number(existing.retrieval_calls ?? 0) + Number(values[7] ?? 0);
                existing.estimated_usd = Number(existing.estimated_usd ?? 0) + Number(values[12] ?? 0);
              } else {
                rows.push({
                  period_type: periodType,
                  period_key: periodKey,
                  scope,
                  usage_key: usageKey,
                  model_calls: Number(values[4] ?? 0),
                  quota_attempts: Number(values[5] ?? 0),
                  fallback_calls: Number(values[6] ?? 0),
                  retrieval_calls: Number(values[7] ?? 0),
                  estimated_usd: Number(values[12] ?? 0),
                });
              }
            }
            if (query.includes("INSERT INTO assistant_budget_alerts")) {
              const key = values.slice(0, 4).join(":");
              if (alerts.has(key)) {
                return { success: true };
              }
              alerts.add(key);
            }
            return { success: true };
          },
          all: async <T = Record<string, unknown>>() => {
            queries.push({ query, values });
            if (query.includes("FROM assistant_usage_counters")) {
              const [periodType, periodKey, scope, usageKey] = values.map(String);
              const row = rows.find((item) =>
                item.period_type === periodType &&
                item.period_key === periodKey &&
                item.scope === scope &&
                item.usage_key === usageKey,
              );
              return { success: true, results: (row ? [row] : []) as T[] };
            }
            if (query.includes("FROM assistant_budget_alerts")) {
              const key = values.slice(0, 4).join(":");
              return { success: true, results: (alerts.has(key) ? [{ id: 1 }] : []) as T[] };
            }
            return { success: true, results: [] };
          },
        }),
      }),
    },
    rows,
    queries,
    alerts,
    ...overrides,
  };
  return env;
}

describe("assistant economics", () => {
  test("does not gate model calls when quota configuration is absent", async () => {
    const env = createEnv({
      ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: undefined,
      ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT: undefined,
      ASSISTANT_GLOBAL_MONTHLY_MODEL_LIMIT: undefined,
      ASSISTANT_MONTHLY_BUDGET_USD: undefined,
    });

    const gate = await checkAssistantEconomicsGate(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      userId: undefined,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    expect(gate.action).toBe("allow");
    expect(env.queries).toHaveLength(0);
  });

  test("returns quota metadata before blocking", async () => {
    const env = createEnv({ ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "5" });
    await recordAssistantUsage(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      responseKind: "model",
      estimatedUsd: 0.001,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    const gate = await checkAssistantEconomicsGate(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      userId: undefined,
      now: new Date("2026-06-25T12:01:00.000Z"),
    });

    expect(gate).toMatchObject({
      action: "allow",
      quota: {
        device_daily: {
          used: 1,
          limit: 5,
          remaining: 4,
        },
      },
    });
  });


  test("prefers assistant device id over user id for daily quota identity", async () => {
    const env = createEnv({ ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "1" });
    await recordAssistantUsage(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      userId: "user-1",
      responseKind: "model",
      estimatedUsd: 0.001,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    const gate = await checkAssistantEconomicsGate(env, {
      deviceId: "device-2",
      sessionId: "session-2",
      userId: "user-1",
      now: new Date("2026-06-25T12:01:00.000Z"),
    });

    expect(gate).toMatchObject({
      action: "allow",
      quota: {
        device_daily: { used: 0, limit: 1, remaining: 1 },
      },
    });
  });

  test("does not exempt caller-provided admin user ids from rate limits", async () => {
    const env = createEnv({ ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "0" });

    const gate = await checkAssistantEconomicsGate(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      userId: "1",
      now: new Date("2026-06-25T12:01:00.000Z"),
    });

    expect(gate).toMatchObject({
      action: "fallback",
      reason: "device_daily_quota",
      quota: {
        device_daily: { used: 0, limit: 0, remaining: 0 },
      },
    });
  });


  test("counts handled fallback attempts against quota without counting them as model calls", async () => {
    const env = createEnv({ ASSISTANT_DEVICE_DAILY_MODEL_LIMIT: "1" });

    await recordAssistantUsage(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      responseKind: "fallback",
      quotaConsumed: true,
      estimatedUsd: 0,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    const row = env.rows.find((item) =>
      item.period_type === "day" && item.scope === "device" && item.usage_key === "device-1",
    );
    expect(row).toMatchObject({
      model_calls: 0,
      quota_attempts: 1,
    });

    const gate = await checkAssistantEconomicsGate(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      now: new Date("2026-06-25T12:01:00.000Z"),
    });

    expect(gate).toMatchObject({
      action: "fallback",
      reason: "device_daily_quota",
      quota: {
        device_daily: { used: 1, limit: 1, remaining: 0 },
      },
    });
  });

  test("blocks a device after its daily model-call quota is reached", async () => {
    const env = createEnv();
    await recordAssistantUsage(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      responseKind: "model",
      estimatedUsd: 0.001,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    const gate = await checkAssistantEconomicsGate(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      userId: undefined,
      now: new Date("2026-06-25T12:01:00.000Z"),
    });

    expect(gate).toMatchObject({
      action: "fallback",
      reason: "device_daily_quota",
    });
  });

  test("blocks globally when the monthly model-call cap is reached", async () => {
    const env = createEnv({ ASSISTANT_GLOBAL_MONTHLY_MODEL_LIMIT: "1" });
    await recordAssistantUsage(env, {
      deviceId: "device-1",
      sessionId: "session-1",
      responseKind: "model",
      estimatedUsd: 0.001,
      now: new Date("2026-06-25T12:00:00.000Z"),
    });

    const gate = await checkAssistantEconomicsGate(env, {
      deviceId: "device-2",
      sessionId: "session-2",
      userId: undefined,
      now: new Date("2026-06-25T12:01:00.000Z"),
    });

    expect(gate).toMatchObject({
      action: "fallback",
      reason: "global_monthly_quota",
    });
  });

  test("records threshold alerts once per period and threshold", async () => {
    const env = createEnv({
      ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT: "10",
      ASSISTANT_ALERT_WEBHOOK_URL: "https://example.test/alert",
      ASSISTANT_ALERT_WEBHOOK_SECRET: "secret",
      ASSISTANT_ALERT_EMAIL_TO: "admin@example.test",
      ASSISTANT_ALERT_FETCH: async () => new Response("ok", { status: 200 }),
    });

    for (let i = 0; i < 8; i += 1) {
      await recordAssistantUsage(env, {
        deviceId: `device-${i}`,
        sessionId: `session-${i}`,
        responseKind: "model",
        estimatedUsd: 0.001,
        now: new Date("2026-06-25T12:00:00.000Z"),
      });
    }
    await recordAssistantUsage(env, {
      deviceId: "device-final",
      sessionId: "session-final",
      responseKind: "model",
      estimatedUsd: 0.001,
      now: new Date("2026-06-25T12:01:00.000Z"),
    });

    const alertInserts = env.queries.filter((item) =>
      item.query.includes("INSERT INTO assistant_budget_alerts"),
    );
    const alertKeys = alertInserts.map((item) => item.values.slice(0, 4).join(":"));
    expect(new Set(alertKeys).size).toBe(alertKeys.length);
    expect(alertKeys).toContain("day:2026-06-25:quota_attempts:80");
    expect(alertKeys).toContain("month:2026-06:quota_attempts:80");
  });

  test("uses a fixed per-answer estimate unless an override is configured", () => {
    expect(estimateModelCostUsd({})).toBeGreaterThan(0);
    expect(estimateModelCostUsd({ ASSISTANT_ESTIMATED_MODEL_COST_USD: "0.123" })).toBe(0.123);
  });
});
