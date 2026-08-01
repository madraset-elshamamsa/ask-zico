import type {
  AssistantAccessEnv,
  AssistantAccessResult,
  BetaAccessEnv,
  BetaAccessResult,
} from "./types";

const PROXY_TOKEN_HEADER = "x-assistant-proxy-token";
const EVAL_TOKEN_HEADER = "x-assistant-eval-token";
const BETA_TOKEN_HEADER = "x-assistant-beta-token";

function timingSafeEqual(left: string | null, right: string | undefined): boolean {
  if (!left || !right) return false;

  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export function assertAssistantAccess(
  request: Request,
  env: AssistantAccessEnv,
): AssistantAccessResult {
  const matches = [
    {
      role: "proxy" as const,
      legacy: false,
      valid: timingSafeEqual(
        request.headers.get(PROXY_TOKEN_HEADER),
        env.ASSISTANT_PROXY_TOKEN,
      ),
    },
    {
      role: "eval" as const,
      legacy: false,
      valid: timingSafeEqual(
        request.headers.get(EVAL_TOKEN_HEADER),
        env.ASSISTANT_EVAL_TOKEN,
      ),
    },
    {
      role: "proxy" as const,
      legacy: true,
      valid: timingSafeEqual(
        request.headers.get(BETA_TOKEN_HEADER),
        env.BETA_ACCESS_TOKEN,
      ),
    },
  ].filter((candidate) => candidate.valid);

  if (matches.length !== 1) {
    return {
      ok: false,
      status: 401,
      error: "invalid_assistant_token",
    };
  }

  const [match] = matches;
  return match.legacy
    ? { ok: true, role: match.role, legacy: true }
    : { ok: true, role: match.role };
}

export function assertBetaAccess(
  request: Request,
  env: BetaAccessEnv,
): BetaAccessResult {
  const configuredToken = env.BETA_ACCESS_TOKEN;
  const requestToken = request.headers.get(BETA_TOKEN_HEADER);

  if (!timingSafeEqual(requestToken, configuredToken)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_beta_token",
    };
  }

  return { ok: true };
}
