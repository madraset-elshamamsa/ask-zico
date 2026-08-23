import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { handleContractRequest } from "../tools/contract-stub.mjs";

const contractDir = path.dirname(fileURLToPath(import.meta.url));
const spec = YAML.parse(await readFile(path.join(contractDir, "openapi.yaml"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(spec, "ask-zico-openapi");

const fixtures = [
  ["HealthResponse", "health-response.json"],
  ["AssistantMessageRequest", "message-request.json"],
  ["AssistantMessageResponse", "message-response.json"],
  ["AssistantFeedbackRequest", "feedback-request.json"],
  ["QuotaStatusRequest", "quota-request.json"],
  ["QuotaStatusResponse", "quota-response.json"],
  ["ErrorResponse", "error-response.json"],
];

test("OpenAPI contract exposes the stable v1.1 multilingual integration endpoints", () => {
  assert.equal(spec.info.version, "1.1.0");
  assert.deepEqual(Object.keys(spec.paths).sort(), [
    "/api/assistant/feedback",
    "/api/assistant/message",
    "/api/assistant/quota-status",
    "/health",
  ]);
  assert.equal(
    spec.components.schemas.AssistantMessageRequest.properties.page_context.$ref,
    "#/components/schemas/PageContext",
  );
  assert.deepEqual(
    spec.components.schemas.AssistantMessageResponse.required.includes("detected_language"),
    true,
  );
  assert.deepEqual(
    spec.components.schemas.AssistantMessageResponse.required.includes("answer_language"),
    true,
  );
  assert.deepEqual(
    spec.components.schemas.AssistantMessageResponse.properties.detected_language.enum,
    ["ar", "en", "unsupported"],
  );
  assert.deepEqual(
    spec.components.schemas.AssistantMessageResponse.properties.answer_language.enum,
    ["ar", "en"],
  );
});

for (const [schemaName, fixtureName] of fixtures) {
  test(`${fixtureName} satisfies ${schemaName}`, async () => {
    const fixture = JSON.parse(
      await readFile(path.join(contractDir, "fixtures", fixtureName), "utf8"),
    );
    const validate = ajv.compile({
      $ref: `ask-zico-openapi#/components/schemas/${schemaName}`,
    });
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors, null, 2));
  });
}

test("contract stub enforces the proxy token and returns v1 fixtures", async () => {
  const unauthorized = await handleContractRequest(new Request(
    "http://stub.test/api/assistant/message",
    { method: "POST", body: JSON.stringify({ message: "test" }) },
  ));
  assert.equal(unauthorized.status, 401);

  const response = await handleContractRequest(new Request(
    "http://stub.test/api/assistant/message",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-assistant-proxy-token": "stub-proxy-token",
      },
      body: JSON.stringify({ message: "test", conversation_id: "contract-test" }),
    },
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ask-zico-contract-version"), "1.1.0");
  assert.equal((await response.json()).conversation_id, "contract-test");
});
