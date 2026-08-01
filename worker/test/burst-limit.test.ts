import { describe, expect, test } from "vitest";
import { enforceAssistantBurstLimits } from "../src/burst-limit";
import type { Env } from "../src/types";

describe("enforceAssistantBurstLimits", () => {
  test("applies actor and network burst limits before retrieval", async () => {
    const calls: string[] = [];
    const env: Env = {
      ASSISTANT_ACTOR_RATE_LIMITER: { limit: async ({ key }) => { calls.push("actor:" + key); return { success: true }; } },
      ASSISTANT_NETWORK_RATE_LIMITER: { limit: async ({ key }) => { calls.push("network:" + key); return { success: true }; } },
    };
    expect(await enforceAssistantBurstLimits(env, { actorId: "a", networkId: "n" })).toEqual({ action: "allow" });
    expect(calls).toEqual(["actor:a", "network:n"]);
  });

  test("uses verified Turnstile only to skip the shared network burst check", async () => {
    let networkCalls = 0;
    const env: Env = {
      ASSISTANT_ACTOR_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ASSISTANT_NETWORK_RATE_LIMITER: { limit: async () => { networkCalls += 1; return { success: false }; } },
    };
    expect(await enforceAssistantBurstLimits(env, {
      actorId: "a",
      networkId: "n",
      challengeVerified: true,
    })).toEqual({ action: "allow" });
    expect(networkCalls).toBe(0);
  });

  test("fails closed when identities or bindings are missing", async () => {
    expect(await enforceAssistantBurstLimits({}, { actorId: "a" })).toEqual({
      action: "deny",
      reason: "burst_limit_unavailable",
    });
  });
});
