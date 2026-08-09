import type {
  AssistantAccessEnv,
  AssistantAccessResult,
} from "./types";

const PROXY_TOKEN_HEADER = "x-assistant-proxy-token";
const EVAL_TOKEN_HEADER = "x-assistant-eval-token";

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
      valid: timingSafeEqual(
        request.headers.get(PROXY_TOKEN_HEADER),
        env.ASSISTANT_PROXY_TOKEN,
      ),
    },
    {
      role: "eval" as const,
      valid: timingSafeEqual(
        request.headers.get(EVAL_TOKEN_HEADER),
        env.ASSISTANT_EVAL_TOKEN,
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

  return { ok: true, role: matches[0].role };
}
