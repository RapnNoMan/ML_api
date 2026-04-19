const { checkWidgetEmbedEnabled } = require("../../scripts/internal/checkWidgetEmbedEnabled");
const { SKIP_VECTOR_MESSAGES } = require("../../scripts/internal/skipVectorMessages");
const { getRelevantKnowledgeChunks } = require("../../scripts/internal/getRelevantKnowledgeChunks");
const { getChatHistory } = require("../../scripts/internal/getChatHistory");
const { getAgentInfo } = require("../../scripts/internal/getAgentInfo");
const { getAgentAllActions } = require("../../scripts/internal/getAgentAllActions");

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function normalizeIdValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function sanitizeIncomingUserText(value) {
  const raw = String(value || "").replace(/\0/g, "");
  const trimmed = raw.trim();
  const maxLen = 800;
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(-maxLen);
}

function parseAgentIdFromRequest(req) {
  const queryValue = req?.query?.agent_id;
  const bodyValue = req?.body?.agent_id;
  const value = queryValue || bodyValue;
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function parseHeaderUrlHostPath(value) {
  if (!value || typeof value !== "string") return { host: "", path: "" };
  try {
    const parsed = new URL(value);
    return {
      host: String(parsed.hostname || "").toLowerCase(),
      path: String(parsed.pathname || ""),
    };
  } catch {
    return { host: "", path: "" };
  }
}

function isAllowedWidgetCaller(headers) {
  const allowedHosts = new Set(["app.mitsolab.com", "www.app.mitsolab.com"]);
  const originRaw = headers?.origin;
  const refererRaw = headers?.referer;

  const originInfo = parseHeaderUrlHostPath(originRaw);
  const refererInfo = parseHeaderUrlHostPath(refererRaw);

  const originAllowed = allowedHosts.has(originInfo.host);
  const refererAllowed =
    allowedHosts.has(refererInfo.host) && refererInfo.path.startsWith("/widget");

  return {
    allowed: originAllowed || refererAllowed,
    originHost: originInfo.host || null,
    refererHost: refererInfo.host || null,
    refererPath: refererInfo.path || null,
  };
}

function getServiceHeaders(supKey) {
  return {
    apikey: supKey,
    Authorization: `Bearer ${supKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function fetchUsageReadOnly({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  let response;
  try {
    response = await fetch(`${baseUrl}/rpc/get_message_usage_service`, {
      method: "POST",
      headers: getServiceHeaders(supKey),
      body: JSON.stringify({ p_agent_id: agentId }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Usage service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Usage service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Usage service unavailable" };
  }

  const usage = Array.isArray(payload) ? payload[0] : payload;
  return {
    ok: true,
    usage: {
      messages: Number(usage?.messages ?? 0),
      cap: Number(usage?.cap ?? 0),
      extra_credits: Number(usage?.extra_credits ?? 0),
    },
  };
}

async function fetchCustomButtonActionRows({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/custom_button_actions?select=id&agent_id=eq.${agentId}&limit=1`;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  return { ok: true, count: rows.length };
}

async function pingXAi({ apiKey, model }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const body = {
    model: model || process.env.XAI_PRIMARY_MODEL || "grok-4-1-fast-non-reasoning",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ping" }],
      },
    ],
    max_output_tokens: 8,
    temperature: 0,
    stream: false,
  };

  let response;
  try {
    response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Network error calling xAI" };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch (_) {}
    return { ok: false, status: response.status || 502, error: text || "xAI request failed" };
  }

  return { ok: true };
}

function statusFromResult(result) {
  return result?.ok ? "ok" : "failed";
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const startedAt = Date.now();
  const body = req.body ?? {};
  const incomingMessage = sanitizeIncomingUserText(body.message);
  const agentId = parseAgentIdFromRequest(req);
  const anonId = normalizeIdValue(body.anon_id);
  const chatId = normalizeIdValue(body.chat_id);
  const runXAiPing = body?.run_xai_ping !== false;
  const runRag = body?.run_rag !== false;

  const missing = [];
  if (!agentId) missing.push("agent_id (path or body)");
  if (!body.message) missing.push("message");
  if (!anonId) missing.push("anon_id");
  if (!chatId) missing.push("chat_id");

  if (missing.length > 0) {
    res.status(400).json({
      error: "Missing required fields",
      missing,
      hint: "POST body needs message, anon_id, chat_id; agent_id can be query/body/path rewrite.",
    });
    return;
  }

  const env = {
    SUP_ID: Boolean(process.env.SUP_ID),
    SUP_KEY: Boolean(process.env.SUP_KEY),
    XAI_API_KEY: Boolean(process.env.XAI_API_KEY),
    VOYAGE_API_KEY: Boolean(process.env.VOYAGE_API_KEY),
    PORTAL_ID: Boolean(process.env.PORTAL_ID),
    PORTAL_SECRET_KEY: Boolean(process.env.PORTAL_SECRET_KEY),
  };

  const steps = [];
  let failedStep = null;

  const caller = isAllowedWidgetCaller(req.headers);
  steps.push({
    step: "origin_guard",
    status: caller.allowed ? "ok" : "failed",
    details: caller,
    expected: "origin host app.mitsolab.com|www.app.mitsolab.com OR referer host same + path /widget*",
  });
  if (!caller.allowed) failedStep = failedStep || "origin_guard";

  const widgetEnabled = await checkWidgetEmbedEnabled({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  steps.push({
    step: "widget_embed_enabled",
    status: statusFromResult(widgetEnabled),
    code: widgetEnabled.status ?? null,
    error: widgetEnabled.error ?? null,
  });
  if (!widgetEnabled.ok) failedStep = failedStep || "widget_embed_enabled";

  const usage = await fetchUsageReadOnly({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  steps.push({
    step: "usage_check_readonly",
    status: statusFromResult(usage),
    code: usage.status ?? null,
    error: usage.error ?? null,
    usage: usage.ok ? usage.usage : null,
    note: "This checker does not consume extra credits.",
  });
  if (!usage.ok) failedStep = failedStep || "usage_check_readonly";

  const history = await getChatHistory({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    anonId,
    chatId,
    maxRows: 3,
  });
  steps.push({
    step: "chat_history",
    status: statusFromResult(history),
    code: history.status ?? null,
    error: history.error ?? null,
    rows: history.ok && Array.isArray(history.messages) ? history.messages.length : null,
  });
  if (!history.ok) failedStep = failedStep || "chat_history";

  const agentInfo = await getAgentInfo({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  steps.push({
    step: "agent_info",
    status: statusFromResult(agentInfo),
    code: agentInfo.status ?? null,
    error: agentInfo.error ?? null,
    workspace_id: agentInfo.ok ? agentInfo.workspace_id : null,
  });
  if (!agentInfo.ok) failedStep = failedStep || "agent_info";

  const tools = await getAgentAllActions({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    includePortalTickets: true,
  });
  steps.push({
    step: "agent_actions",
    status: statusFromResult(tools),
    code: tools.status ?? null,
    error: tools.error ?? null,
    tool_count: tools.ok && Array.isArray(tools.tools) ? tools.tools.length : null,
    note: "If tickets are enabled and PORTAL_ID/PORTAL_SECRET_KEY are missing, this step fails with 500 config error.",
  });
  if (!tools.ok) failedStep = failedStep || "agent_actions";

  const customButtons = await fetchCustomButtonActionRows({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  steps.push({
    step: "custom_button_actions",
    status: statusFromResult(customButtons),
    code: customButtons.status ?? null,
    error: customButtons.error ?? null,
    count: customButtons.ok ? customButtons.count : null,
  });
  if (!customButtons.ok) failedStep = failedStep || "custom_button_actions";

  const normalizedMessage = String(incomingMessage)
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,!?(){}\[\]<>-]+|[\s"'`.,!?(){}\[\]<>-]+$/g, "")
    .replace(/\s+/g, " ");
  const shouldSkipRag = !normalizedMessage || SKIP_VECTOR_MESSAGES.has(normalizedMessage);

  if (!runRag) {
    steps.push({
      step: "rag",
      status: "skipped",
      note: "Disabled by run_rag=false",
    });
  } else if (shouldSkipRag) {
    steps.push({
      step: "rag",
      status: "skipped",
      note: "Message matches skip-vector phrases.",
    });
  } else {
    const rag = await getRelevantKnowledgeChunks({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      voyageApiKey: process.env.VOYAGE_API_KEY,
      outputDimension: process.env.VOYAGE_OUTPUT_DIMENSION,
      agentId,
      anonId,
      chatId,
      message: incomingMessage,
    });
    steps.push({
      step: "rag",
      status: statusFromResult(rag),
      code: rag.status ?? null,
      error: rag.error ?? null,
      chunks: rag.ok && Array.isArray(rag.chunks) ? rag.chunks.length : null,
    });
    if (!rag.ok) failedStep = failedStep || "rag";
  }

  if (!runXAiPing) {
    steps.push({
      step: "xai_ping",
      status: "skipped",
      note: "Disabled by run_xai_ping=false",
    });
  } else {
    const xai = await pingXAi({
      apiKey: process.env.XAI_API_KEY,
      model: process.env.XAI_PRIMARY_MODEL || "grok-4-1-fast-non-reasoning",
    });
    steps.push({
      step: "xai_ping",
      status: statusFromResult(xai),
      code: xai.status ?? null,
      error: xai.error ?? null,
    });
    if (!xai.ok) failedStep = failedStep || "xai_ping";
  }

  const ok = !failedStep;
  res.status(ok ? 200 : 500).json({
    ok,
    failed_step: failedStep,
    total_ms: Date.now() - startedAt,
    agent_id: agentId,
    env_present: env,
    steps,
  });
};

