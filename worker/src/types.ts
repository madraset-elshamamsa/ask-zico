export type Confidence = "retrieval_only" | "low" | "medium" | "high";
export type RetrievalMode = "controlled_hybrid" | "controlled_vector" | "controlled_lexical";

export type AssistantFollowUpContext = {
  parent_message_id: string;
  previous_user_message: string;
  previous_assistant_answer: string;
  previous_cited_chunk_ids: string[];
};

export type AssistantMessageRequest = {
  session_id?: string;
  conversation_id?: string;
  assistant_device_id?: string;
  user_id?: string;
  actor_id?: string;
  network_id?: string;
  actor_type?: "anonymous" | "authenticated";
  challenge_verified?: boolean;
  message: string;
  normalized_query?: string;
  retrieval_query?: string;
  page_context?: {
    url?: string;
    title?: string;
  };
  locale?: string;
  retrieval_only?: boolean;
  debug?: boolean;
  follow_up?: AssistantFollowUpContext;
};

export type RetrievedChunk = {
  doc_id: string;
  chunk_id: string;
  title: string;
  url: string;
  text: string;
  score: number;
  content_type?: string;
  library?: string;
  source_library?: string;
  section?: string;
  language?: string;
  semanticDomain?: string;
  facets?: string[];
};

export type AssistantResponseChunk = Omit<RetrievedChunk, "text" | "score"> & {
  text?: string;
  score?: number;
};

export type StoredChunk = Omit<RetrievedChunk, "score"> & {
  score?: number;
  search_text?: string;
  source_ref?: string;
  summary?: string;
  categories?: string[];
  authors?: string[];
  keywords?: string[];
  entities?: string[];
  events?: string[];
  places?: string[];
  symbols?: string[];
  themes?: string[];
  aliases?: string[];
  enriched_terms?: string[];
};

export type Citation = {
  title: string;
  url: string;
  snippet: string;
};

export type SuggestedAction = {
  type: "navigate_to_url";
  label: string;
  url: string;
};

export type AssistantWorkerCpuTiming = {
  cpu_ms: number;
  over_budget: boolean;
  phases: Record<string, number>;
};

export type AssistantWorkerProfileTiming = {
  wall_ms: number;
  phases: Record<string, number>;
};

export type AssistantCpuPhaseRecorder = {
  addPhase: (name: string, ms: number) => void;
  addWallPhase?: (name: string, ms: number) => void;
};


export type AssistantQuotaWindow = {
  used: number;
  limit: number;
  remaining: number;
};

export type AssistantQuotaMetadata = {
  device_daily?: AssistantQuotaWindow;
  network_daily?: AssistantQuotaWindow;
  evaluation_daily?: AssistantQuotaWindow;
  global_daily?: AssistantQuotaWindow;
  global_monthly?: AssistantQuotaWindow;
  monthly_budget?: AssistantQuotaWindow;
  exempt?: boolean;
  block_reason?:
    | "actor_daily_quota"
    | "network_daily_quota"
    | "evaluation_daily_quota"
    | "quota_identity_unavailable"
    | "quota_storage_unavailable"
    | "fallback_only_mode"
    | "device_daily_quota"
    | "global_daily_quota"
    | "global_monthly_quota"
    | "monthly_budget";
};

export type AssistantMessageResponse = {
  message_id: string;
  conversation_id?: string;
  answer: string;
  citations: Citation[];
  suggested_actions: SuggestedAction[];
  confidence: Confidence;
  trace_id?: string;
  retrieved_chunks: AssistantResponseChunk[];
  quota?: AssistantQuotaMetadata;
  debug?: {
    query: string;
    normalized_query: string;
    retrieval_mode: RetrievalMode;
    answer?: AssistantAnswerDebug;
    worker_cpu?: AssistantWorkerCpuTiming;
    worker_profile?: AssistantWorkerProfileTiming;
  };
};

export type AssistantFeedbackRating = "up" | "down";

export type AssistantFeedbackRequest = {
  session_id: string;
  message_id: string;
  rating: AssistantFeedbackRating;
  created_at: string;
  conversation_id?: string;
  confidence?: Confidence;
  doc_ids?: string[];
  chunk_ids?: string[];
  citation_urls?: string[];
};

export type AssistantFeedbackResponse =
  | {
    ok: true;
  }
  | {
    error: "invalid_request" | "feedback_not_configured" | "feedback_write_failed";
  };

export type AssistantObservabilityRange = "24h" | "7d" | "30d";
export type AssistantObservabilityAnswerState = "all" | "answered" | "unanswered";
export type AssistantObservabilityFeedback = "all" | "up" | "down" | "unrated";

export type AssistantObservabilityFilters = {
  topic: string | null;
  answer_state: AssistantObservabilityAnswerState;
  feedback: AssistantObservabilityFeedback;
};
export type AssistantObservabilityTotals = {
  total_queries: number;
  answered_queries: number;
  retrieved_references: number;
  cited_references: number;
  likes: number;
  dislikes: number;
  neutral: number;
};

export type AssistantObservabilitySummary = {
  range: AssistantObservabilityRange;
  since: string;
  filters: AssistantObservabilityFilters;
  available_topics: string[];
  totals: AssistantObservabilityTotals;
  cpu: {
    over_budget_queries: number;
    over_budget_percent: string;
  };
  recent_events: Array<{
    created_at: string;
    user_id: string | null;
    query_text: string;
    answered: number;
    retrieved_references: number;
    cited_references: number;
    confidence: string | null;
    answer_mode: string | null;
    answer_failure_reason: string | null;
    rating: string | null;
    semantic_domains_json: string;
    answer_preview: string | null;
    answer_preview_truncated: number;
    worker_cpu_ms?: number | null;
    worker_cpu_over_budget?: number | null;
    worker_cpu_phases_json?: string | null;
  }>;
  domains: Array<{
    semantic_domains_json: string;
    total_queries: number;
    answered_queries: number;
    dislikes: number;
  }>;
  failures: Array<{
    query_text: string;
    answer_failure_reason: string | null;
    total_queries: number;
  }>;
  sources: Array<{
    doc_ids_json: string;
    total_queries: number;
    dislikes: number;
  }>;
  cpu_over_budget: Array<{
    created_at: string;
    user_id: string | null;
    query_text: string;
    worker_cpu_ms: number | null;
    worker_cpu_phases_json: string | null;
  }>;
};

export type AssistantAnswerFailureReason =
  | "weak_retrieval"
  | "missing_config"
  | "llm_http_error"
  | "llm_fetch_error"
  | "empty_content"
  | "invalid_json"
  | "incomplete_answer"
  | "no_valid_citations"
  | "not_found_in_context";

export type AssistantModelProvider = "gemini" | "openrouter";

export type AssistantProviderAttempt = {
  provider: AssistantModelProvider;
  model: string;
  ok: boolean;
  reason?: AssistantAnswerFailureReason;
  status?: number;
  fallback_reason?: string;
};

export type AssistantAnswerDebug =
  | {
    mode: "grounded";
    attempts?: number;
    batch_attempts?: number;
    compact_context?: boolean;
    context_chunks?: number;
    context_excerpt_chars?: number;
    input_chunk_chars?: number;
    model_context_chars?: number;
    model_provider?: AssistantModelProvider;
    model_name?: string;
    provider_fallback_reason?: string;
    provider_attempts?: AssistantProviderAttempt[];
    estimated_model_cost_usd?: number;
  }
  | {
    mode: "handoff";
    reason: AssistantAnswerFailureReason;
    status?: number;
    attempts?: number;
    batch_attempts?: number;
    provider_fallback_reason?: string;
    provider_attempts?: AssistantProviderAttempt[];
  }
  | {
    mode: "fallback";
    reason:
    | "actor_daily_quota"
    | "network_daily_quota"
    | "evaluation_daily_quota"
    | "quota_identity_unavailable"
    | "quota_storage_unavailable"
    | "fallback_only_mode"
    | "device_daily_quota"
    | "global_daily_quota"
    | "global_monthly_quota"
    | "monthly_budget"
    | "model_provider_error"
    | "retrieval_error";
  };
export type AssistantAccessEnv = {
  ASSISTANT_PROXY_TOKEN?: string;
  ASSISTANT_EVAL_TOKEN?: string;
  BETA_ACCESS_TOKEN?: string;
};

export type BetaAccessEnv = Pick<AssistantAccessEnv, "BETA_ACCESS_TOKEN">;

export type AssistantLlmFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AssistantLlmEnv = {
  ASSISTANT_CHAT_MODEL?: string;
  ASSISTANT_LLM_API_KEY?: string;
  ASSISTANT_GEMINI_API_KEY?: string;
  ASSISTANT_EVAL_GEMINI_API_KEY?: string;
  ASSISTANT_EVAL_LLM_API_KEY?: string;
  ASSISTANT_EVAL_OPENROUTER_API_KEY?: string;
  ASSISTANT_MODEL_QUOTA_SCOPE?: "public" | "evaluation";
  ASSISTANT_GEMINI_MODEL?: string;
  ASSISTANT_GEMINI_MODEL_LADDER?: string;
  ASSISTANT_GEMINI_MODEL_QUOTAS?: string;
  ASSISTANT_GEMINI_QUOTA_ROUTING_ENABLED?: string;
  ASSISTANT_PROVIDER_QUOTA_ROUTING_ENABLED?: string;
  ASSISTANT_GEMINI_BASE_URL?: string;
  ASSISTANT_GEMINI_MAX_ATTEMPTS?: string;
  ASSISTANT_OPENROUTER_MODEL?: string;
  ASSISTANT_OPENROUTER_DAILY_LIMIT?: string;
  ASSISTANT_EVAL_OPENROUTER_DAILY_LIMIT?: string;
  ASSISTANT_LLM_BASE_URL?: string;
  ASSISTANT_LLM_PROVIDER_SORT?: "price" | "throughput" | "latency";
  ASSISTANT_COMPACT_CONTEXT_ENABLED?: string;
  ASSISTANT_CONTEXT_TOP_K?: string;
  ASSISTANT_CONTEXT_EXCERPT_CHARS?: string;
  ASSISTANT_CONTEXT_MAX_EXCERPT_CHARS?: string;
  ASSISTANT_CONTEXT_MAX_OUTPUT_TOKENS?: string;
  ASSISTANT_PROGRESSIVE_CONTEXT_ENABLED?: string;
  ASSISTANT_CONTEXT_BATCHES?: string;
  ASSISTANT_FALLBACK_ONLY_MODE?: string;
  ASSISTANT_QUOTA_FALLBACK_MODE?: string;
  ASSISTANT_ACTOR_DAILY_MODEL_LIMIT?: string;
  ASSISTANT_NETWORK_DAILY_MODEL_LIMIT?: string;
  ASSISTANT_EVAL_DAILY_MODEL_LIMIT?: string;
  ASSISTANT_DEVICE_DAILY_MODEL_LIMIT?: string;
  ASSISTANT_GLOBAL_DAILY_MODEL_LIMIT?: string;
  ASSISTANT_GLOBAL_MONTHLY_MODEL_LIMIT?: string;
  ASSISTANT_MONTHLY_BUDGET_USD?: string;
  ASSISTANT_ESTIMATED_MODEL_COST_USD?: string;
  ASSISTANT_ALERT_THRESHOLDS?: string;
  ASSISTANT_ALERT_WEBHOOK_URL?: string;
  ASSISTANT_ALERT_WEBHOOK_SECRET?: string;
  ASSISTANT_ALERT_EMAIL_TO?: string;
  ASSISTANT_ALERT_FETCH?: AssistantLlmFetch;
  OPENROUTER_API_KEY?: string;
  ASSISTANT_LLM_FETCH?: AssistantLlmFetch;
};

export type AssistantAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
};

export type VectorizeMatch = {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type VectorizeBinding = {
  query: (
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: boolean;
      filter?: Record<string, unknown>;
    },
  ) => Promise<{
    matches?: VectorizeMatch[];
  }>;
};

export type ChunkLookupBinding = {
  get: (key: string, options?: { type: "json" }) => Promise<unknown | null>;
};

export type D1FeedbackBinding = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      run: () => Promise<{ success?: boolean; meta?: { changes?: number } }>;
      all: <T = Record<string, unknown>>() => Promise<{
        success?: boolean;
        results?: T[];
      }>;
    };
  };
};

export type RetrievalDebugReport = {
  normalized_query: string;
  kv: {
    lexical_type: "array" | "object" | "string" | "null" | "other";
    lexical_count: number;
    sample_key: string;
    sample_type: "array" | "object" | "string" | "null" | "other";
  };
  lexical: {
    candidate_count: number;
    top_ids: string[];
  };
  vector: {
    candidate_count: number;
    top_ids: string[];
    embedding_length: number;
    error?: string;
  };
  hydration: {
    requested_ids: string[];
    hydrated_count: number;
    missing_ids: string[];
  };
};

export type RateLimitBinding = {
  limit: (input: { key: string }) => Promise<{ success: boolean }>;
};

export type Env = AssistantAccessEnv &
  AssistantLlmEnv & {
    ASSISTANT_ENV?: string;
    ASSISTANT_PUBLIC_SITE_URL?: string;
    ASSISTANT_ADMIN_TOKEN?: string;
    ASSISTANT_EMBEDDING_MODEL?: string;
    ASSISTANT_LEXICAL_KEYS?: string;
    ASSISTANT_AL7AN_ENABLED?: string;
    ASSISTANT_AQWAL_ENABLED?: string;
    ASSISTANT_COPTIC_ENABLED?: string;
    ASSISTANT_ABOUT_ENABLED?: string;
    ASSISTANT_CARTOON_ENABLED?: string;
    ASSISTANT_SENEKSAR_ENABLED?: string;
    RETRIEVAL_TOP_K?: string;
    RETRIEVAL_CANDIDATE_K?: string;
    ASSISTANT_AI?: AssistantAiBinding;
    ASSISTANT_VECTORIZE?: VectorizeBinding;
    ASSISTANT_CHUNKS?: ChunkLookupBinding;
    ASSISTANT_FEEDBACK_DB?: D1FeedbackBinding;
    ASSISTANT_ACTOR_RATE_LIMITER?: RateLimitBinding;
    ASSISTANT_NETWORK_RATE_LIMITER?: RateLimitBinding;
  };

export type AssistantCallerRole = "proxy" | "eval";

export type AssistantAccessResult =
  | {
    ok: true;
    role: AssistantCallerRole;
    legacy?: true;
  }
  | {
    ok: false;
    status: 401;
    error: "invalid_assistant_token";
  };

export type BetaAccessResult =
  | {
    ok: true;
  }
  | {
    ok: false;
    status: 401;
    error: "invalid_beta_token";
  };
