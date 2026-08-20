import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = path.join(repositoryRoot, "contract", "fixtures");
const contractVersion = "1.1.0";

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtureDirectory, name), "utf8"));
}

export async function handleContractRequest(request, options = {}) {
  const url = new URL(request.url);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "x-ask-zico-contract-version": contractVersion,
  };
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json(await fixture("health-response.json"), { headers });
  }

  const expectedToken = options.proxyToken ?? process.env.ASK_ZICO_STUB_PROXY_TOKEN ?? "stub-proxy-token";
  if (request.headers.get("x-assistant-proxy-token") !== expectedToken) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  }

  if (url.pathname === "/api/assistant/message") {
    if (typeof body?.message !== "string" || !body.message.trim()) {
      return Response.json({ error: "invalid_request" }, { status: 400, headers });
    }
    const response = await fixture("message-response.json");
    response.conversation_id = body.conversation_id ?? response.conversation_id;
    return Response.json(response, { headers });
  }
  if (url.pathname === "/api/assistant/quota-status") {
    return Response.json(await fixture("quota-response.json"), { headers });
  }
  if (url.pathname === "/api/assistant/feedback") {
    return Response.json({ ok: true }, { headers });
  }
  return Response.json({ error: "not_found" }, { status: 404, headers });
}

export function startContractStub(options = {}) {
  const host = options.host ?? process.env.ASK_ZICO_STUB_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.ASK_ZICO_STUB_PORT ?? 8790);
  const server = createServer(async (incoming, outgoing) => {
    const requestUrl = `http://${incoming.headers.host ?? `${host}:${port}`}${incoming.url ?? "/"}`;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(requestUrl, {
      method: incoming.method,
      headers: incoming.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await handleContractRequest(request, options);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(port, host, () => {
    process.stdout.write(`Ask Zico contract stub listening at http://${host}:${port}\n`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startContractStub();
}
