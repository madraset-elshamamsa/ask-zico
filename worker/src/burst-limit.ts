import type { Env } from "./types";

export type BurstLimitResult =
  | { action: "allow" }
  | { action: "deny"; reason: "actor_burst_limit" | "network_burst_limit" | "burst_limit_unavailable" };

export async function enforceAssistantBurstLimits(
  env: Env,
  input: {
    actorId?: string;
    networkId?: string;
    challengeVerified?: boolean;
  },
): Promise<BurstLimitResult> {
  if (!input.actorId || !input.networkId) {
    return { action: "deny", reason: "burst_limit_unavailable" };
  }
  if (!env.ASSISTANT_ACTOR_RATE_LIMITER || !env.ASSISTANT_NETWORK_RATE_LIMITER) {
    return { action: "deny", reason: "burst_limit_unavailable" };
  }
  try {
    const actor = await env.ASSISTANT_ACTOR_RATE_LIMITER.limit({ key: input.actorId });
    if (!actor.success) {
      return { action: "deny", reason: "actor_burst_limit" };
    }
    if (!input.challengeVerified) {
      const network = await env.ASSISTANT_NETWORK_RATE_LIMITER.limit({ key: input.networkId });
      if (!network.success) {
        return { action: "deny", reason: "network_burst_limit" };
      }
    }
    return { action: "allow" };
  } catch {
    return { action: "deny", reason: "burst_limit_unavailable" };
  }
}
