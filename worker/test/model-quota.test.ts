import { describe, expect, test } from "vitest";
import {
  parseGeminiModelQuotas,
  reserveGeminiModelQuota,
} from "../src/model-quota";
import type { Env } from "../src/types";

type WindowRow = {
  provider: string;
  model_name: string;
  period_type: string;
  period_key: string;
  request_count: number;
  estimated_tokens: number;
  updated_at?: string;
};

type RecordedQuery = {
  query: string;
  values: unknown[];
};

function createEnv(rows: WindowRow[] = [], overrides: Partial<Env> = {}) {
  const queries: RecordedQuery[] = [];
  const env: Env & { rows: WindowRow[]; queries: RecordedQuery[] } = {
    ASSISTANT_FEEDBACK_DB: {
      prepare: (query) => ({
        bind: (...values) => ({
          all: async <T = Record<string, unknown>>() => {
            queries.push({ query, values });
            if (query.includes("FROM assistant_model_quota_windows")) {
              const [provider, modelName, periodType, periodKey] = values.map(String);
              const row = rows.find((item) =>
                item.provider === provider &&
                item.model_name === modelName &&
                item.period_type === periodType &&
                item.period_key === periodKey,
              );
              return { success: true, results: (row ? [row] : []) as T[] };
            }
            return { success: true, results: [] };
          },
          run: async () => {
            queries.push({ query, values });
            if (query.includes("INSERT INTO assistant_model_quota_windows") && query.includes("'rpm', 'leaky'")) {
              const [provider, modelName, estimatedTokens, updatedAt, threshold] = values;
              const existing = findRow(rows, String(provider), String(modelName), "rpm", "leaky");
              if (existing) {
                if (existing.updated_at && Date.parse(existing.updated_at) > Date.parse(String(threshold))) {
                  return { success: true, meta: { changes: 0 } };
                }
                existing.request_count += 1;
                existing.estimated_tokens += Number(estimatedTokens);
                existing.updated_at = String(updatedAt);
                return { success: true, meta: { changes: 1 } };
              }
              rows.push({
                provider: String(provider),
                model_name: String(modelName),
                period_type: "rpm",
                period_key: "leaky",
                request_count: 1,
                estimated_tokens: Number(estimatedTokens),
                updated_at: String(updatedAt),
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (query.includes("INSERT INTO assistant_model_quota_windows")) {
              const [provider, modelName, periodType, periodKey, estimatedTokens, updatedAt, requestLimit] = values;
              const existing = findRow(rows, String(provider), String(modelName), String(periodType), String(periodKey));
              if (existing) {
                if (existing.request_count >= Number(requestLimit)) {
                  return { success: true, meta: { changes: 0 } };
                }
                existing.request_count += 1;
                existing.estimated_tokens += Number(estimatedTokens);
                existing.updated_at = String(updatedAt);
                return { success: true, meta: { changes: 1 } };
              }
              rows.push({
                provider: String(provider),
                model_name: String(modelName),
                period_type: String(periodType),
                period_key: String(periodKey),
                request_count: 1,
                estimated_tokens: Number(estimatedTokens),
                updated_at: String(updatedAt),
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (query.includes("UPDATE assistant_model_quota_windows")) {
              const [estimatedTokens, updatedAt, provider, modelName, periodType, periodKey] = values;
              const existing = findRow(rows, String(provider), String(modelName), String(periodType), String(periodKey));
              if (existing) {
                existing.request_count = Math.max(0, existing.request_count - 1);
                existing.estimated_tokens = Math.max(0, existing.estimated_tokens - Number(estimatedTokens));
                existing.updated_at = String(updatedAt);
              }
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true };
          },
        }),
      }),
    },
    rows,
    queries,
    ...overrides,
  };
  return env;
}

function findRow(rows: WindowRow[], provider: string, modelName: string, periodType: string, periodKey: string): WindowRow | undefined {
  return rows.find((item) =>
    item.provider === provider &&
    item.model_name === modelName &&
    item.period_type === periodType &&
    item.period_key === periodKey,
  );
}

describe("Gemini model quota routing", () => {
  test("uses configured Gemini quotas in daily-capacity order", () => {
    expect(parseGeminiModelQuotas({}).map((quota) => [quota.model, quota.rpm, quota.rpd])).toEqual([
      ["gemini-3.1-flash-lite", 15, 500],
      ["gemini-2.5-flash-lite", 10, 20],
      ["gemini-3-flash-preview", 5, 20],
      ["gemini-3.5-flash", 5, 20],
      ["gemini-2.5-flash", 5, 20],
    ]);
  });

  test("reserves the highest-capacity available Gemini model", async () => {
    const env = createEnv();
    const reservation = await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T10:05:30.000Z"),
      estimatedTokens: 3000,
    });

    expect(reservation?.model).toBe("gemini-3.1-flash-lite");
    expect(reservation?.quotaStorageAvailable).toBe(true);
    expect(env.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ model_name: "gemini-3.1-flash-lite", period_type: "rpm", period_key: "leaky", request_count: 1 }),
      expect.objectContaining({ model_name: "gemini-3.1-flash-lite", period_type: "day", period_key: "2026-06-30", request_count: 1 }),
    ]));
  });

  test("skips models whose minute or daily quota is exhausted", async () => {
    const env = createEnv([
      {
        provider: "gemini",
        model_name: "gemini-3.1-flash-lite",
        period_type: "rpm",
        period_key: "leaky",
        request_count: 15,
        estimated_tokens: 0,
        updated_at: "2026-06-30T10:05:28.000Z",
      },
      { provider: "gemini", model_name: "gemini-2.5-flash-lite", period_type: "day", period_key: "2026-06-30", request_count: 20, estimated_tokens: 0 },
    ]);

    const reservation = await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T10:05:30.000Z"),
      estimatedTokens: 3000,
    });

    expect(reservation?.model).toBe("gemini-3-flash-preview");
  });

  test("returns null when every Gemini model is at daily capacity", async () => {
    const rows = parseGeminiModelQuotas({}).map((quota) => ({
      provider: "gemini",
      model_name: quota.model,
      period_type: "day",
      period_key: "2026-06-30",
      request_count: quota.rpd,
      estimated_tokens: 0,
    }));
    const env = createEnv(rows);

    const reservation = await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T10:05:30.000Z"),
      estimatedTokens: 3000,
    });

    expect(reservation).toBeNull();
  });

  test("keys daily quota windows by Pacific date", async () => {
    const env = createEnv();
    const reservation = await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T06:30:00.000Z"),
      estimatedTokens: 3000,
    });

    expect(reservation?.dayKey).toBe("2026-06-29");
    expect(env.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ period_type: "day", period_key: "2026-06-29" }),
    ]));
  });

  test("uses a leaky RPM throttle instead of fixed UTC minute buckets", async () => {
    const env = createEnv([
      {
        provider: "gemini",
        model_name: "gemini-3.1-flash-lite",
        period_type: "rpm",
        period_key: "leaky",
        request_count: 1,
        estimated_tokens: 0,
        updated_at: "2026-06-30T10:05:58.000Z",
      },
    ]);

    const reservation = await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T10:06:00.000Z"),
      estimatedTokens: 3000,
    });

    expect(reservation?.model).toBe("gemini-2.5-flash-lite");
  });

  test("does not bind non-finite token limits into D1", async () => {
    const env = createEnv();
    await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T10:05:30.000Z"),
      estimatedTokens: 3000,
    });

    expect(env.queries.flatMap((query) => query.values).some((value) => value === Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("isolates evaluation Gemini quota windows from public provider capacity", async () => {
    const env = createEnv([], { ASSISTANT_MODEL_QUOTA_SCOPE: "evaluation" });

    const reservation = await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T10:05:30.000Z"),
      estimatedTokens: 3000,
    });

    expect(reservation?.model).toBe("gemini-3.1-flash-lite");
    expect(env.rows).toHaveLength(2);
    expect(env.rows.every((row) => row.provider === "gemini:evaluation")).toBe(true);
  });
  test("fails closed when quota storage is missing", async () => {
    const env = createEnv([], {
      ASSISTANT_FEEDBACK_DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error("missing table");
            },
            run: async () => {
              throw new Error("missing table");
            },
          }),
        }),
      },
    });

    const reservation = await reserveGeminiModelQuota(env, {
      now: new Date("2026-06-30T10:05:30.000Z"),
      estimatedTokens: 3000,
    });

    expect(reservation).toBeNull();
  });
});
