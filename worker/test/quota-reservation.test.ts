import { describe, expect, test } from "vitest";
import { reserveAssistantQuota } from "../src/quota-reservation";
import type { Env } from "../src/types";

function createQuotaEnv(initial: Record<string, number> = {}, fail = false): Env & { counters: Map<string, number> } {
  const counters = new Map(Object.entries(initial));
  return {
    ASSISTANT_ACTOR_DAILY_MODEL_LIMIT: "50",
    ASSISTANT_NETWORK_DAILY_MODEL_LIMIT: "150",
    ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT: "650",
    ASSISTANT_EVAL_DAILY_MODEL_LIMIT: "250",
    counters,
    ASSISTANT_FEEDBACK_DB: {
      prepare: (query) => ({
        bind: (...values) => ({
          run: async () => {
            if (fail) throw new Error("d1 unavailable");
            const rollback = query.includes("quota_attempts = MAX");
            const scope = String(values[rollback ? 2 : 1]);
            const key = String(values[rollback ? 3 : 2]);
            const counterKey = scope + ":" + key;
            if (rollback) {
              counters.set(counterKey, Math.max(0, (counters.get(counterKey) ?? 0) - 1));
              return { success: true, meta: { changes: 1 } };
            }
            const limit = Number(values[values.length - 1]);
            const current = counters.get(counterKey) ?? 0;
            if (current >= limit) return { success: true, meta: { changes: 0 } };
            counters.set(counterKey, current + 1);
            return { success: true, meta: { changes: 1 } };
          },
          all: async () => ({ success: true, results: [] }),
        }),
      }),
    },
  };
}

describe("reserveAssistantQuota", () => {
  test("blocks the 51st actor attempt", async () => {
    const env = createQuotaEnv({ "user:public:actor-1": 50 });
    const result = await reserveAssistantQuota(env, { role: "proxy", actorId: "actor-1", networkId: "network-1" });
    expect(result).toMatchObject({ action: "fallback", reason: "actor_daily_quota" });
    expect(env.counters.get("device:public:network-1") ?? 0).toBe(0);
  });

  test("blocks the 151st network and rolls back actor", async () => {
    const env = createQuotaEnv({ "device:public:network-1": 150 });
    const result = await reserveAssistantQuota(env, { role: "proxy", actorId: "actor-1", networkId: "network-1" });
    expect(result).toMatchObject({ action: "fallback", reason: "network_daily_quota" });
    expect(env.counters.get("user:public:actor-1")).toBe(0);
  });

  test("blocks the 651st public and 251st evaluation attempts", async () => {
    const publicEnv = createQuotaEnv({ "global:public": 650 });
    expect(await reserveAssistantQuota(publicEnv, { role: "proxy", actorId: "actor-1", networkId: "network-1" }))
      .toMatchObject({ action: "fallback", reason: "global_daily_quota" });
    expect(publicEnv.counters.get("user:public:actor-1")).toBe(0);
    expect(publicEnv.counters.get("device:public:network-1")).toBe(0);

    const evalEnv = createQuotaEnv({ "global:evaluation": 250 });
    expect(await reserveAssistantQuota(evalEnv, { role: "eval" }))
      .toMatchObject({ action: "fallback", reason: "evaluation_daily_quota" });
  });

  test("fails closed when quota storage is unavailable", async () => {
    expect(await reserveAssistantQuota(createQuotaEnv({}, true), {
      role: "proxy",
      actorId: "actor-1",
      networkId: "network-1",
    })).toEqual({ action: "fallback", reason: "quota_storage_unavailable" });
  });

  test("conditional writes prevent concurrent reservations above limit", async () => {
    const env = createQuotaEnv();
    env.ASSISTANT_ACTOR_DAILY_MODEL_LIMIT = "1";
    const results = await Promise.all([
      reserveAssistantQuota(env, { role: "proxy", actorId: "actor-1", networkId: "network-1" }),
      reserveAssistantQuota(env, { role: "proxy", actorId: "actor-1", networkId: "network-1" }),
    ]);
    expect(results.filter((result) => result.action === "allow")).toHaveLength(1);
    expect(env.counters.get("user:public:actor-1")).toBe(1);
  });
});
