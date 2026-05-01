const XAI_RESPONSES_API_URL = "https://api.x.ai/v1/responses";
const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
const DEEPSEEK_CHAT_COMPLETIONS_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_SPAM_MODEL = "grok-4-1-fast-non-reasoning";
const DEFAULT_OPENAI_SPAM_MODEL = "gpt-4o-mini";
const DEFAULT_DEEPSEEK_SPAM_MODEL = "deepseek-v4-flash";

function parseContentRangeTotal(contentRange) {
  const value = String(contentRange || "").trim();
  if (!value) return null;
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex < 0) return null;
  const tail = value.slice(slashIndex + 1).trim();
  const total = Number(tail);
  if (!Number.isFinite(total) || total < 0) return null;
  return Math.floor(total);
}

function extractResponseText(payload) {
  if (!payload) return "";
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  const textParts = [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (
        (block?.type === "output_text" || block?.type === "text") &&
        typeof block?.text === "string" &&
        block.text.trim()
      ) {
        textParts.push(block.text.trim());
      }
    }
  }

  return textParts.join("\n").trim();
}

function parseSpamLabelFromModelText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const direct = text.toLowerCase();
  if (direct === "spam" || direct === "normal" || direct === "uncertain") return direct;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : text;
  try {
    const parsed = JSON.parse(candidate);
    const label = String(parsed?.label || "").trim().toLowerCase();
    if (label === "spam" || label === "normal" || label === "uncertain") return label;
  } catch (_) {}

  return null;
}

function buildUserMessagesList(rows, incomingMessage) {
  const userMessages = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const prompt = String(row?.prompt || "").trim();
    if (prompt) userMessages.push(prompt);
  }

  const incoming = String(incomingMessage || "").trim();
  if (incoming) userMessages.push(incoming);

  return userMessages
    .map((message, index) => `${index + 1}. ${message}`)
    .join("\n");
}

async function isAnonBanned({ supId, supKey, agentId, anonId }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/banned_agent_users`);
  url.searchParams.set("select", "id");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("anon_id", `eq.${anonId}`);
  url.searchParams.set("limit", "1");

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  return { ok: true, banned: rows.length > 0 };
}

async function getAnonMessageCount({ supId, supKey, agentId, anonId }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/messages`);
  url.searchParams.set("select", "id");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("limit", "1");

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
        Prefer: "count=exact",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  const total = parseContentRangeTotal(response.headers.get("content-range"));
  return { ok: true, count: total ?? 0 };
}

async function getRecentAnonMessages({ supId, supKey, agentId, anonId, limit }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/messages`);
  url.searchParams.set("select", "prompt,result,created_at");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", String(Math.max(1, Math.floor(Number(limit) || 1))));

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  return { ok: true, rows };
}

async function classifyConversationWithXAi({ apiKey, model, conversation }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const prompt = [
    "Classify whether this user is spamming or just having a normal support conversation.",
    "",
    "Rules:",
    '- "normal" = genuine support intent, even if frustrated, repetitive, or rude',
    '- "spam" = trolling, nonsense, abuse, repeated junk, meaningless repeated messages, or obvious messing around',
    '- "uncertain" = not enough evidence',
    "",
    'If unsure, return "uncertain".',
    "",
    "User messages:",
    conversation,
    "",
    "Return JSON only:",
    '{"label":"normal|spam|uncertain"}',
  ].join("\n");

  const requestBody = {
    model: model || DEFAULT_SPAM_MODEL,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    max_output_tokens: 80,
    temperature: 0,
  };

  let response;
  try {
    response = await fetch(XAI_RESPONSES_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    return { ok: false, status: 502, error: "Network error calling xAI" };
  }

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, status: response.status || 502, error: text || "xAI request failed" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Invalid JSON from xAI" };
  }

  const rawText = extractResponseText(payload);
  const label = parseSpamLabelFromModelText(rawText);
  if (!label) {
    return { ok: false, status: 502, error: "Invalid spam classification output" };
  }

  return { ok: true, label, rawText };
}

async function classifyConversationWithOpenAi({ apiKey, model, conversation, reasoning }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const prompt = [
    "Classify whether this user is spamming or just having a normal support conversation.",
    "",
    "Rules:",
    '- "normal" = genuine support intent, even if frustrated, repetitive, or rude',
    '- "spam" = trolling, nonsense, abuse, repeated junk, meaningless repeated messages, or obvious messing around',
    '- "uncertain" = not enough evidence',
    "",
    'If unsure, return "uncertain".',
    "",
    "User messages:",
    conversation,
    "",
    "Return JSON only:",
    '{"label":"normal|spam|uncertain"}',
  ].join("\n");

  const requestBody = {
    model: model || DEFAULT_OPENAI_SPAM_MODEL,
    reasoning,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    max_output_tokens: 80,
    text: { verbosity: "low" },
  };

  let response;
  try {
    response = await fetch(OPENAI_RESPONSES_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    return { ok: false, status: 502, error: "Network error calling OpenAI" };
  }

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, status: response.status || 502, error: text || "OpenAI request failed" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Invalid JSON from OpenAI" };
  }

  const rawText = extractResponseText(payload);
  const label = parseSpamLabelFromModelText(rawText);
  if (!label) {
    return { ok: false, status: 502, error: "Invalid spam classification output" };
  }

  return { ok: true, label, rawText };
}

async function classifyConversationWithDeepSeek({ apiKey, model, conversation }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const prompt = [
    "Classify whether this user is spamming or just having a normal support conversation.",
    "",
    "Rules:",
    '- "normal" = genuine support intent, even if frustrated, repetitive, or rude',
    '- "spam" = trolling, nonsense, abuse, repeated junk, meaningless repeated messages, or obvious messing around',
    '- "uncertain" = not enough evidence',
    "",
    'If unsure, return "uncertain".',
    "",
    "User messages:",
    conversation,
    "",
    "Return JSON only:",
    '{"label":"normal|spam|uncertain"}',
  ].join("\n");

  const requestBody = {
    model: model || DEFAULT_DEEPSEEK_SPAM_MODEL,
    messages: [{ role: "user", content: prompt }],
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    max_tokens: 80,
  };

  let response;
  try {
    response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    return { ok: false, status: 502, error: "Network error calling DeepSeek" };
  }

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, status: response.status || 502, error: text || "DeepSeek request failed" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Invalid JSON from DeepSeek" };
  }

  const rawText = String(payload?.choices?.[0]?.message?.content || "").trim();
  const label = parseSpamLabelFromModelText(rawText);
  if (!label) {
    return { ok: false, status: 502, error: "Invalid spam classification output" };
  }

  return { ok: true, label, rawText };
}

async function upsertAnonBan({ supId, supKey, agentId, anonId, reason, evidence }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/banned_agent_users?on_conflict=agent_id,anon_id`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([
        {
          agent_id: agentId,
          anon_id: anonId,
          reason: String(reason || "spam_detected").trim() || "spam_detected",
          evidence: typeof evidence === "string" ? evidence.slice(0, 2000) : null,
        },
      ]),
    });
  } catch {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Spam guard service unavailable" };
  }

  return { ok: true };
}

async function evaluateAnonSpamAndMaybeBan({
  supId,
  supKey,
  xaiApiKey,
  xaiModel,
  openAiApiKey,
  openAiModel,
  openAiReasoning,
  deepSeekApiKey,
  deepSeekModel,
  agentId,
  anonId,
  incomingMessage,
}) {
  const normalizedAnonId = String(anonId || "").trim();
  if (!normalizedAnonId) {
    return { ok: true, banned: false, skipped: true, reason: "anon_id_empty" };
  }

  const banCheck = await isAnonBanned({
    supId,
    supKey,
    agentId,
    anonId: normalizedAnonId,
  });
  if (!banCheck.ok) return banCheck;
  if (banCheck.banned) {
    return { ok: true, banned: true, reason: "already_banned" };
  }

  const countResult = await getAnonMessageCount({
    supId,
    supKey,
    agentId,
    anonId: normalizedAnonId,
  });
  if (!countResult.ok) return countResult;

  const projectedCount = Number(countResult.count || 0) + 1;
  if (projectedCount < 10 || projectedCount % 10 !== 0) {
    return { ok: true, banned: false, skipped: true, reason: "cadence_not_met", projectedCount };
  }

  const recentResult = await getRecentAnonMessages({
    supId,
    supKey,
    agentId,
    anonId: normalizedAnonId,
    limit: 9,
  });
  if (!recentResult.ok) return recentResult;

  const rowsDesc = Array.isArray(recentResult.rows) ? recentResult.rows : [];
  if (rowsDesc.length < 9) {
    return { ok: true, banned: false, skipped: true, reason: "not_enough_messages" };
  }

  const rowsAsc = [...rowsDesc].reverse();
  const oldestCreatedAt = Date.parse(String(rowsAsc[0]?.created_at || ""));
  const now = Date.now();
  if (!Number.isFinite(oldestCreatedAt)) {
    return { ok: true, banned: false, skipped: true, reason: "invalid_timestamp" };
  }
  const intervalMinutes = (now - oldestCreatedAt) / 60000;
  if (!Number.isFinite(intervalMinutes) || intervalMinutes > 4) {
    return { ok: true, banned: false, skipped: true, reason: "interval_not_met", intervalMinutes };
  }

  const conversation = buildUserMessagesList(rowsAsc, incomingMessage);
  const classifyResult = deepSeekApiKey
    ? await classifyConversationWithDeepSeek({
        apiKey: deepSeekApiKey,
        model: deepSeekModel,
        conversation,
      })
    : openAiApiKey
      ? await classifyConversationWithOpenAi({
        apiKey: openAiApiKey,
        model: openAiModel,
        reasoning: openAiReasoning,
        conversation,
      })
      : await classifyConversationWithXAi({
          apiKey: xaiApiKey,
          model: xaiModel,
          conversation,
        });
  if (!classifyResult.ok) return classifyResult;

  if (classifyResult.label !== "spam") {
    return { ok: true, banned: false, label: classifyResult.label };
  }

  const banInsert = await upsertAnonBan({
    supId,
    supKey,
    agentId,
    anonId: normalizedAnonId,
    reason: "spam_detected_by_grok",
    evidence: conversation,
  });
  if (!banInsert.ok) return banInsert;

  return { ok: true, banned: true, reason: "spam_detected" };
}

module.exports = {
  evaluateAnonSpamAndMaybeBan,
};
