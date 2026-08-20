import type {
  AssistantMessageRequest,
  AssistantMessageResponse,
  AssistantObservabilityAnswerState,
  AssistantObservabilityFeedback,
  AssistantObservabilityFilters,
  AssistantObservabilityRange,
  AssistantObservabilitySummary,
  AssistantObservabilityTotals,
  AssistantTranslationMetadata,
  Env,
  RetrievedChunk,
  AssistantWorkerCpuTiming,
} from "./types";
import { estimateModelCostUsd } from "./economics";

const ADMIN_TOKEN_HEADER = "x-assistant-admin-token";
const ANSWER_PREVIEW_CHARACTERS = 1200;
const ANSWER_PREVIEW_RETENTION_DAYS = 90;
const RANGE_DAYS: Record<AssistantObservabilityRange, number> = { "24h": 1, "7d": 7, "30d": 30 };

type QueryFilters = { range: AssistantObservabilityRange; filters: AssistantObservabilityFilters };
type QueryParts = { where: string; values: unknown[] };

export type AssistantObservabilityEventInput = {
  request: AssistantMessageRequest;
  response: AssistantMessageResponse;
  normalizedQuery: string;
  chunks: RetrievedChunk[];
  startedAt: number;
  createdAt?: string;
  workerCpu?: AssistantWorkerCpuTiming;
  translation?: AssistantTranslationMetadata;
};

export type AdminAccessResult = { ok: true } | { ok: false; status: 401; error: "invalid_admin_token" };

export function assertAdminAccess(request: Request, env: Env): AdminAccessResult {
  const configuredToken = env.ASSISTANT_ADMIN_TOKEN;
  const urlToken = new URL(request.url).searchParams.get("token");
  const requestToken = request.headers.get(ADMIN_TOKEN_HEADER) ?? urlToken;
  if (!configuredToken || !requestToken || requestToken !== configuredToken) {
    return { ok: false, status: 401, error: "invalid_admin_token" };
  }
  return { ok: true };
}

export function parseObservabilityQuery(input: {
  range: string | null;
  topic?: string | null;
  answerState?: string | null;
  feedback?: string | null;
}): QueryFilters {
  return {
    range: parseRange(input.range),
    filters: {
      topic: normalizeTopic(input.topic),
      answer_state: parseAnswerState(input.answerState),
      feedback: parseFeedback(input.feedback),
    },
  };
}

export async function storeAssistantQueryEvent(env: Env, input: AssistantObservabilityEventInput): Promise<"ok" | "missing_binding" | "write_failed"> {
  if (!env.ASSISTANT_FEEDBACK_DB) return "missing_binding";

  const createdAt = input.createdAt ?? new Date().toISOString();
  const answerDebug = input.response.debug?.answer;
  const answerMode = answerDebug?.mode ?? null;
  const answerFailureReason = answerDebug?.mode === "handoff" ? answerDebug.reason : null;
  const answered = answerDebug?.mode === "grounded" && input.response.answer.trim().length > 0;
  const preview = answered ? answerPreview(input.response.answer) : { value: null, truncated: 0 };
  const retrievedReferences = input.chunks.length > 0;
  const citedReferences = input.response.citations.length > 0;
  const latencyMs = Math.max(0, Math.round(Date.now() - input.startedAt));
  const responseKind = answerDebug?.mode === "grounded" ? "model" : "fallback";
  const fallbackReason = answerDebug?.mode === "fallback" ? answerDebug.reason : null;
  const quotaBlockReason = fallbackReason && fallbackReason !== "model_provider_error" && fallbackReason !== "retrieval_error" ? fallbackReason : null;
  const compactContext = answerDebug?.mode === "grounded" && answerDebug.compact_context === true;
  const estimatedModelCostUsd = (
    answerDebug?.mode === "grounded"
      ? answerDebug.estimated_model_cost_usd ?? estimateModelCostUsd(env)
      : 0
  ) + (input.translation?.estimated_model_cost_usd ?? 0);
  const modelProvider = answerDebug?.mode === "grounded" ? answerDebug.model_provider ?? null : null;
  const modelName = answerDebug?.mode === "grounded" ? answerDebug.model_name ?? null : null;
  const providerFallbackReason = answerDebug?.mode === "grounded" || answerDebug?.mode === "handoff" ? answerDebug.provider_fallback_reason ?? null : null;
  const answerProviderAttempts = answerDebug?.mode === "grounded" || answerDebug?.mode === "handoff"
    ? answerDebug.provider_attempts ?? []
    : [];
  const providerAttemptsJson = JSON.stringify([
    ...(input.translation?.provider_attempts ?? []),
    ...answerProviderAttempts,
  ]);
  const workerCpu = input.workerCpu ?? input.response.debug?.worker_cpu ?? null;

  try {
    const result = await env.ASSISTANT_FEEDBACK_DB.prepare(
      `INSERT INTO assistant_query_events (
        message_id, session_id, conversation_id, user_id, created_at, page_url, page_title, locale,
        ui_locale, detected_language, answer_language, translation_status, translation_latency_ms,
        query_text, normalized_query, answered, retrieved_references, cited_references, confidence,
        answer_mode, answer_failure_reason, retrieval_mode, latency_ms, semantic_domains_json,
        doc_ids_json, chunk_ids_json, citation_urls_json, is_follow_up, parent_message_id,
        follow_up_cited_chunk_ids_json, response_kind, quota_block_reason, estimated_model_cost_usd,
        compact_context, fallback_reason, model_provider, model_name, provider_fallback_reason,
        provider_attempts_json, worker_cpu_ms, worker_cpu_over_budget, worker_cpu_phases_json,
        answer_preview, answer_preview_truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.response.message_id, input.request.session_id ?? null, input.response.conversation_id ?? input.request.conversation_id ?? null,
      input.request.user_id ?? null, createdAt, input.request.page_context?.url ?? null, input.request.page_context?.title ?? null,
      input.request.locale ?? null, input.request.locale ?? null, input.response.detected_language, input.response.answer_language,
      input.translation?.status ?? (input.response.detected_language === "ar" ? "not_needed" : null),
      input.translation?.latency_ms ?? null, input.request.message, input.normalizedQuery, answered ? 1 : 0,
      retrievedReferences ? 1 : 0, citedReferences ? 1 : 0, input.response.confidence, answerMode, answerFailureReason,
      input.response.debug?.retrieval_mode ?? "controlled_hybrid", latencyMs,
      JSON.stringify(uniqueStrings(input.chunks.map((chunk) => chunk.semanticDomain))),
      JSON.stringify(uniqueStrings(input.chunks.map((chunk) => chunk.doc_id))),
      JSON.stringify(uniqueStrings(input.chunks.map((chunk) => chunk.chunk_id))),
      JSON.stringify(uniqueStrings(input.response.citations.map((citation) => citation.url))),
      input.request.follow_up ? 1 : 0, input.request.follow_up?.parent_message_id ?? null,
      JSON.stringify(input.request.follow_up?.previous_cited_chunk_ids ?? []), responseKind, quotaBlockReason,
      estimatedModelCostUsd, compactContext ? 1 : 0, fallbackReason, modelProvider, modelName, providerFallbackReason,
      providerAttemptsJson, workerCpu?.cpu_ms ?? null, workerCpu?.over_budget ? 1 : 0,
      JSON.stringify(workerCpu?.phases ?? {}), preview.value, preview.truncated,
    ).run();
    return result.success === false ? "write_failed" : "ok";
  } catch {
    return "write_failed";
  }
}

export async function mirrorAssistantFeedbackRating(env: Env, input: { messageId: string; rating: "up" | "down"; createdAt: string }): Promise<void> {
  if (!env.ASSISTANT_FEEDBACK_DB) return;
  try {
    await env.ASSISTANT_FEEDBACK_DB.prepare(`UPDATE assistant_query_events SET rating = ?, feedback_created_at = ? WHERE message_id = ?`)
      .bind(input.rating, input.createdAt, input.messageId).run();
  } catch {
    // Feedback persistence remains independent from observability availability.
  }
}

export async function cleanupExpiredAssistantAnswerPreviews(env: Env, now = new Date()): Promise<void> {
  if (!env.ASSISTANT_FEEDBACK_DB) return;
  const cutoff = new Date(now.getTime() - ANSWER_PREVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    await env.ASSISTANT_FEEDBACK_DB.prepare(
      `UPDATE assistant_query_events
       SET answer_preview = NULL, answer_preview_truncated = 0
       WHERE created_at < ? AND answer_preview IS NOT NULL`,
    ).bind(cutoff).run();
  } catch {
    // Retention must not make scheduled Worker invocations fail noisily.
  }
}

export async function getAssistantObservabilitySummary(env: Env, query: QueryFilters): Promise<AssistantObservabilitySummary | null> {
  if (!env.ASSISTANT_FEEDBACK_DB) return null;
  const since = sinceForRange(query.range);
  const parts = queryParts(since, query.filters);
  const aggregate = await env.ASSISTANT_FEEDBACK_DB.prepare(
    `SELECT COUNT(*) AS total_queries, COALESCE(SUM(answered), 0) AS answered_queries,
      COALESCE(SUM(retrieved_references), 0) AS retrieved_references, COALESCE(SUM(cited_references), 0) AS cited_references,
      COALESCE(SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END), 0) AS likes,
      COALESCE(SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END), 0) AS dislikes,
      COALESCE(SUM(CASE WHEN rating IS NULL THEN 1 ELSE 0 END), 0) AS neutral,
      COALESCE(SUM(worker_cpu_over_budget), 0) AS worker_cpu_over_budget
     FROM assistant_query_events WHERE ${parts.where}`,
  ).bind(...parts.values).all<Partial<AssistantObservabilityTotals>>();

  const recent = await env.ASSISTANT_FEEDBACK_DB.prepare(
    `SELECT created_at, user_id, query_text, answered, retrieved_references, cited_references, confidence,
      answer_mode, answer_failure_reason, rating, semantic_domains_json, answer_preview, answer_preview_truncated,
      worker_cpu_ms, worker_cpu_over_budget, worker_cpu_phases_json
     FROM assistant_query_events WHERE ${parts.where} ORDER BY created_at DESC LIMIT 50`,
  ).bind(...parts.values).all<AssistantObservabilitySummary["recent_events"][number]>();

  const domains = await env.ASSISTANT_FEEDBACK_DB.prepare(
    `SELECT semantic_domains_json, COUNT(*) AS total_queries, COALESCE(SUM(answered), 0) AS answered_queries,
      COALESCE(SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END), 0) AS dislikes
     FROM assistant_query_events WHERE ${parts.where} GROUP BY semantic_domains_json ORDER BY total_queries DESC LIMIT 20`,
  ).bind(...parts.values).all<AssistantObservabilitySummary["domains"][number]>();

  const failures = await env.ASSISTANT_FEEDBACK_DB.prepare(
    `SELECT query_text, answer_failure_reason, COUNT(*) AS total_queries
     FROM assistant_query_events WHERE ${parts.where} AND answered = 0
     GROUP BY query_text, answer_failure_reason ORDER BY total_queries DESC, query_text ASC LIMIT 25`,
  ).bind(...parts.values).all<AssistantObservabilitySummary["failures"][number]>();

  const sources = await env.ASSISTANT_FEEDBACK_DB.prepare(
    `SELECT doc_ids_json, COUNT(*) AS total_queries, COALESCE(SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END), 0) AS dislikes
     FROM assistant_query_events WHERE ${parts.where} AND doc_ids_json != '[]'
     GROUP BY doc_ids_json ORDER BY dislikes DESC, total_queries DESC LIMIT 25`,
  ).bind(...parts.values).all<AssistantObservabilitySummary["sources"][number]>();

  const cpu = await env.ASSISTANT_FEEDBACK_DB.prepare(
    `SELECT created_at, user_id, query_text, worker_cpu_ms, worker_cpu_phases_json
     FROM assistant_query_events WHERE ${parts.where} AND worker_cpu_over_budget = 1
     ORDER BY worker_cpu_ms DESC, created_at DESC LIMIT 25`,
  ).bind(...parts.values).all<AssistantObservabilitySummary["cpu_over_budget"][number]>();

  return {
    range: query.range,
    since,
    filters: query.filters,
    available_topics: collectTopics(domains.results ?? []),
    totals: normalizeTotals(aggregate.results?.[0]),
    cpu: normalizeCpuSummary(aggregate.results?.[0]),
    recent_events: recent.results ?? [], domains: domains.results ?? [], failures: failures.results ?? [],
    sources: sources.results ?? [], cpu_over_budget: cpu.results ?? [],
  };
}

export function renderAssistantObservabilityDashboard(summary: AssistantObservabilitySummary, adminToken?: string): string {
  const active = summary.filters;
  const base = (changes: Record<string, string | null> = {}) => dashboardUrl(summary, adminToken, changes);
  const metric = (label: string, value: string | number) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Assistant observability</title>
<style>
:root{color-scheme:light;--ink:#1f3550;--muted:#5d6e7f;--line:#cbd6e1;--panel:#fff;--bg:#f3f7fb;--blue:#4673a2;--navy:#243a51;--bad:#a33142;--bad-bg:#fff1f3;--good:#196a54;--good-bg:#e9f6f0}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Cairo,Arial,sans-serif}main{width:min(1220px,calc(100% - 32px));margin:28px auto 48px}header{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:18px}h1{margin:0;font-size:1.75rem}h2{margin:0;font-size:1.05rem}.muted{color:var(--muted)}.toolbar,.panel,.event,.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px}.toolbar{padding:14px;display:grid;gap:12px}.quick{display:flex;gap:8px;flex-wrap:wrap}.chip,.submit{appearance:none;display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--ink);padding:7px 11px;text-decoration:none;font:inherit;font-weight:700}.chip:hover,.chip:focus-visible,.submit{border-color:var(--blue);background:#edf4fb}.filter-sheet summary{cursor:pointer;font-weight:700}.filter-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:12px}.filter-grid label{display:grid;gap:5px;font-weight:700;font-size:.85rem}select{min-height:40px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:0 8px;color:var(--ink);font:inherit}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:16px 0}.metric{padding:13px}.metric span{display:block;color:var(--muted);font-size:.82rem}.metric strong{display:block;font-size:1.35rem;margin-top:2px}.events{display:grid;gap:10px}.event{padding:14px}.event summary{cursor:pointer;list-style:none}.event summary::-webkit-details-marker{display:none}.event-top{display:grid;grid-template-columns:minmax(0,2fr) auto auto;gap:10px;align-items:start}.query{font-weight:700;overflow-wrap:anywhere}.meta{display:flex;flex-wrap:wrap;gap:7px;margin-top:7px}.pill{display:inline-flex;border-radius:999px;padding:2px 8px;background:#edf4fb;color:var(--navy);font-size:.78rem;font-weight:700}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.good{background:var(--good-bg);color:var(--good)}.detail{display:grid;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.answer{white-space:pre-wrap;overflow-wrap:anywhere;background:#f8fafc;border:1px solid #dce5ee;border-radius:6px;padding:12px}.answer p{margin:0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}.panel{padding:15px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{padding:8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:.76rem}@media(max-width:780px){main{width:min(100% - 20px,680px);margin-top:16px}header{display:block}.filter-grid{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.filter-sheet:not([open]) .filter-grid{display:none}.event-top{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.desktop-note{display:none}}@media(min-width:781px){.filter-sheet summary{display:none}.filter-sheet{display:block}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto;transition:none!important}}
</style></head><body><main>
<header><div><h1>Assistant observability</h1><div class="muted">${escapeHtml(summary.range)} view · since ${escapeHtml(summary.since)}</div></div><div class="muted desktop-note">Protected D1 review</div></header>
<section class="toolbar"><nav class="quick" aria-label="Quick views"><a class="chip" href="${base()}">All</a><a class="chip" href="${base({ answer_state: "unanswered" })}">Unanswered</a><a class="chip" href="${base({ feedback: "down" })}">Thumbs down</a><a class="chip" href="${base({ feedback: "unrated" })}">Unrated</a></nav>
<details class="filter-sheet" open><summary>Filters</summary><form method="get" class="filter-grid"><input type="hidden" name="token" value="${escapeHtml(adminToken ?? "")}"><label>Duration<select name="range">${option("24h", summary.range, "Last 24 hours")}${option("7d", summary.range, "Last 7 days")}${option("30d", summary.range, "Last 30 days")}</select></label><label>Topic<select name="topic"><option value="">All topics</option>${summary.available_topics.map((topic) => option(topic, active.topic ?? "", topic)).join("")}</select></label><label>Answer<select name="answer_state">${option("all", active.answer_state, "All answers")}${option("answered", active.answer_state, "Answered")}${option("unanswered", active.answer_state, "Unanswered")}</select></label><label>Feedback<select name="feedback">${option("all", active.feedback, "All feedback")}${option("up", active.feedback, "Thumbs up")}${option("down", active.feedback, "Thumbs down")}${option("unrated", active.feedback, "Unrated")}</select></label><button class="submit" type="submit">Apply filters</button></form></details></section>
<section class="metrics">${metric("Queries", summary.totals.total_queries)}${metric("Answered", `${summary.totals.answered_queries} (${percentage(summary.totals.answered_queries, summary.totals.total_queries)})`)}${metric("Likes", summary.totals.likes)}${metric("Dislikes", summary.totals.dislikes)}${metric("CPU > 8ms", `${summary.cpu.over_budget_queries} (${summary.cpu.over_budget_percent})`)}</section>
<section class="events" aria-label="Recent events"><h2>Recent events</h2>${events(summary.recent_events)}</section>
<section class="grid"><div class="panel"><h2>Unanswered queries</h2>${simpleTable(["Query", "Reason", "Count"], summary.failures.map((row) => [row.query_text, row.answer_failure_reason ?? "unknown", String(row.total_queries)]))}</div><div class="panel"><h2>Topics</h2>${simpleTable(["Topic", "Queries", "Downvotes"], summary.domains.map((row) => [row.semantic_domains_json, String(row.total_queries), String(row.dislikes)]))}</div></section>
</main></body></html>`;
}

function queryParts(since: string, filters: AssistantObservabilityFilters): QueryParts {
  const clauses = ["created_at >= ?"]; const values: unknown[] = [since];
  if (filters.answer_state !== "all") clauses.push(`answered = ${filters.answer_state === "answered" ? 1 : 0}`);
  if (filters.feedback === "up" || filters.feedback === "down") { clauses.push("rating = ?"); values.push(filters.feedback); }
  if (filters.feedback === "unrated") clauses.push("rating IS NULL");
  if (filters.topic) { clauses.push("semantic_domains_json LIKE ? ESCAPE '\\'"); values.push(`%${escapeLike(filters.topic)}%`); }
  return { where: clauses.join(" AND "), values };
}
function answerPreview(answer: string): { value: string; truncated: number } { const chars = Array.from(answer.trim()); return { value: chars.slice(0, ANSWER_PREVIEW_CHARACTERS).join(""), truncated: chars.length > ANSWER_PREVIEW_CHARACTERS ? 1 : 0 }; }
function parseRange(value: string | null): AssistantObservabilityRange { return value === "24h" || value === "30d" ? value : "7d"; }
function parseAnswerState(value: string | null | undefined): AssistantObservabilityAnswerState { return value === "answered" || value === "unanswered" ? value : "all"; }
function parseFeedback(value: string | null | undefined): AssistantObservabilityFeedback { return value === "up" || value === "down" || value === "unrated" ? value : "all"; }
function normalizeTopic(value: string | null | undefined): string | null { const topic = value?.trim() ?? ""; return /^[a-zA-Z0-9_-]{1,80}$/.test(topic) ? topic : null; }
function sinceForRange(range: AssistantObservabilityRange): string { return new Date(Date.now() - RANGE_DAYS[range] * 86400000).toISOString(); }
function normalizeTotals(row: Partial<AssistantObservabilityTotals> | undefined): AssistantObservabilityTotals { return { total_queries: numberValue(row?.total_queries), answered_queries: numberValue(row?.answered_queries), retrieved_references: numberValue(row?.retrieved_references), cited_references: numberValue(row?.cited_references), likes: numberValue(row?.likes), dislikes: numberValue(row?.dislikes), neutral: numberValue(row?.neutral) }; }
function normalizeCpuSummary(row: Record<string, unknown> | undefined): AssistantObservabilitySummary["cpu"] { const over = numberValue(row?.worker_cpu_over_budget); return { over_budget_queries: over, over_budget_percent: percentage(over, numberValue(row?.total_queries)) }; }
function numberValue(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function uniqueStrings(values: Array<string | undefined>): string[] { return Array.from(new Set(values.filter((value): value is string => Boolean(value)))); }
function collectTopics(rows: AssistantObservabilitySummary["domains"]): string[] { return uniqueStrings(rows.flatMap((row) => { try { const values = JSON.parse(row.semantic_domains_json); return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : []; } catch { return []; } })).sort(); }
function percentage(part: number, total: number): string { return total ? `${Math.round((part / total) * 100)}%` : "0%"; }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, "\\$&"); }
function option(value: string, selected: string, label: string): string { return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`; }
function dashboardUrl(summary: AssistantObservabilitySummary, token: string | undefined, changes: Record<string, string | null>): string { const params = new URLSearchParams({ range: summary.range, answer_state: summary.filters.answer_state, feedback: summary.filters.feedback }); if (summary.filters.topic) params.set("topic", summary.filters.topic); if (token) params.set("token", token); for (const [key, value] of Object.entries(changes)) { if (value) params.set(key, value); else params.delete(key); } return `?${params.toString()}`; }
function events(rows: AssistantObservabilitySummary["recent_events"]): string { if (!rows.length) return `<div class="panel muted">No events match these filters.</div>`; return rows.map((row) => `<details class="event"><summary><div class="event-top"><div><div class="query">${escapeHtml(row.query_text)}</div><div class="meta"><span class="pill ${row.answered ? "good" : "bad"}">${row.answered ? "Answered" : "Unanswered"}</span><span class="pill">${escapeHtml(row.rating ?? "No rating")}</span><span class="pill">${escapeHtml(row.semantic_domains_json)}</span></div></div><span class="muted">${escapeHtml(row.created_at)}</span><span class="muted">${escapeHtml(row.user_id ?? "N/A")}</span></div></summary><div class="detail"><div><strong>Reason:</strong> ${escapeHtml(row.answer_failure_reason ?? row.answer_mode ?? "—")}</div><div><strong>Answer preview</strong><div class="answer"><p>${row.answer_preview ? escapeHtml(row.answer_preview) : "No stored answer preview."}${row.answer_preview_truncated ? "…" : ""}</p></div></div></div></details>`).join(""); }
function simpleTable(headers: string[], rows: string[][]): string { if (!rows.length) return `<p class="muted">No rows for this filter.</p>`; return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`; }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
