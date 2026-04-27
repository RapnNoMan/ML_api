const { createHmac, timingSafeEqual } = require("node:crypto");
const {
  checkMessageCap,
  refundExtraMessageCredit,
} = require("../../scripts/internal/checkMessageCap");
const { SKIP_VECTOR_MESSAGES } = require("../../scripts/internal/skipVectorMessages");
const { getAgentInfo } = require("../../scripts/internal/getAgentInfo");
const { getAgentAllActions } = require("../../scripts/internal/getAgentAllActions");
const { getChatHistory } = require("../../scripts/internal/getChatHistory");
const { getRelevantKnowledgeChunks } = require("../../scripts/internal/getRelevantKnowledgeChunks");
const { saveMessage } = require("../../scripts/internal/saveMessage");
const { saveMessageAnalytics } = require("../../scripts/internal/saveMessageAnalytics");
const { ensureAccessToken, buildRawEmail } = require("../../scripts/internal/googleGmail");
const { ensureAccessToken: ensureCalendarAccessToken } = require("../../scripts/internal/googleCalendar");
const { createPortalTicket } = require("../../scripts/internal/ticketsPortal");
const { evaluateAnonSpamAndMaybeBan } = require("../../scripts/internal/spamGuard");
const { executeDynamicSourceQuery } = require("../../scripts/internal/queryDynamicSource");
const {
  getLatestTicketOutcome,
  buildTicketOutcomeInstruction,
} = require("../../scripts/internal/ticketOutcome");
const {
  HUMAN_HANDOFF_TOOL_NAME,
  HUMAN_HANDOFF_TOOL,
  HUMAN_HANDOFF_PROMPT_BLOCK,
  checkHumanAgentsAppEnabled,
  getOpenHumanHandoffChat,
  checkAvailableHumanAgents,
  saveHumanMessageToMessages,
  saveHumanMessageToPortalFeed,
  assignHumanHandoffChat,
} = require("../../scripts/internal/humanHandoff");

const XAI_RESPONSES_API_URL = "https://api.x.ai/v1/responses";
const PRIMARY_MODEL = process.env.XAI_PRIMARY_MODEL || "grok-4-1-fast-non-reasoning";
const FOLLOWUP_MODEL = process.env.XAI_FOLLOWUP_MODEL || PRIMARY_MODEL;
const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";
const SONIOX_API_BASE_URL = String(process.env.SONIOX_API_BASE_URL || "https://api.soniox.com").replace(/\/+$/, "");
const SONIOX_STT_MODEL = process.env.SONIOX_STT_MODEL || "stt-async-v4";
const TELEGRAM_VOICE_MAX_BYTES = Math.max(
  1,
  Number.isFinite(Number(process.env.TELEGRAM_VOICE_MAX_BYTES))
    ? Math.floor(Number(process.env.TELEGRAM_VOICE_MAX_BYTES))
    : 20 * 1024 * 1024
);
const SONIOX_TRANSCRIPTION_TIMEOUT_MS = Math.max(
  1000,
  Number.isFinite(Number(process.env.SONIOX_TRANSCRIPTION_TIMEOUT_MS))
    ? Math.floor(Number(process.env.SONIOX_TRANSCRIPTION_TIMEOUT_MS))
    : 60 * 1000
);
const META_MIN_TYPING_MS = Math.max(
  0,
  Number.isFinite(Number(process.env.META_MIN_TYPING_MS))
    ? Math.floor(Number(process.env.META_MIN_TYPING_MS))
    : 1200
);
const XAI_MODEL_FALLBACKS = [
  PRIMARY_MODEL,
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-4.1-fast-non-reasoning",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeCountry(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

function getRequestCountry(headers) {
  if (!headers || typeof headers !== "object") return null;
  return (
    normalizeCountry(headers["x-vercel-ip-country"]) ||
    normalizeCountry(headers["cf-ipcountry"]) ||
    normalizeCountry(headers["x-country-code"]) ||
    null
  );
}

function formatReplyForMetaText(text) {
  let output = String(text || "");
  if (!output.trim()) return "";

  output = output
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const maxLen = 1800;
  if (output.length > maxLen) {
    output = `${output.slice(0, maxLen - 3).trimEnd()}...`;
  }
  return output;
}

function formatReplyForWhatsAppText(text) {
  let output = String(text || "");
  if (!output.trim()) return "";

  output = output
    .replace(/\r\n/g, "\n")
    // Convert Markdown bold to WhatsApp bold.
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    // Normalize markdown list markers to plain hyphen bullets.
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const maxLen = 3500;
  if (output.length > maxLen) {
    output = `${output.slice(0, maxLen - 3).trimEnd()}...`;
  }
  return output;
}

function formatReplyForTelegramText(text) {
  let output = String(text || "");
  if (!output.trim()) return "";
  output = output
    .replace(/\r\n/g, "\n")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const maxLen = 3500;
  if (output.length > maxLen) {
    output = `${output.slice(0, maxLen - 3).trimEnd()}...`;
  }
  return output;
}

function sanitizeIncomingUserText(value) {
  const raw = String(value || "").replace(/\0/g, "");
  const trimmed = raw.trim();
  const maxLen = 800;
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(-maxLen);
}

function normalizeIncomingMessage(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,!?(){}\[\]<>-]+|[\s"'`.,!?(){}\[\]<>-]+$/g, "")
    .replace(/\s+/g, " ");
}

function extractTelegramStartIdentifier(text) {
  const value = String(text || "").trim();
  const match = value.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return "";
  return String(match[1] || "").trim();
}

function extractTelegramAudioPayload(message) {
  if (!message || typeof message !== "object") return null;
  const candidates = [
    { kind: "voice", value: message.voice },
    { kind: "audio", value: message.audio },
  ];
  for (const candidate of candidates) {
    const value = candidate.value && typeof candidate.value === "object" ? candidate.value : null;
    const fileId = String(value?.file_id || "").trim();
    if (!fileId) continue;
    return {
      kind: candidate.kind,
      fileId,
      fileUniqueId: String(value?.file_unique_id || "").trim(),
      mimeType: String(value?.mime_type || "").trim(),
      fileName: String(value?.file_name || "").trim(),
      duration: Number.isFinite(Number(value?.duration)) ? Math.floor(Number(value.duration)) : null,
      fileSize: Number.isFinite(Number(value?.file_size)) ? Math.floor(Number(value.file_size)) : null,
    };
  }
  return null;
}

function normalizeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function tailWordsByRatio(text, ratio = 0.2) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  const rawCount = Math.ceil(words.length * Number(ratio || 0));
  const count = Math.max(8, Math.min(words.length, rawCount));
  return words.slice(words.length - count).join(" ");
}

function toOpenAiInputItems(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const text = String(message?.content ?? "");
    return {
      type: "message",
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    };
  });
}

function extractResponseText(payload) {
  if (!payload) return "";
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const content = Array.isArray(payload?.content)
    ? payload.content
    : Array.isArray(payload?.output)
      ? payload.output.flatMap((item) =>
          Array.isArray(item?.content) ? item.content : []
        )
      : [];
  const textParts = [];
  for (const item of content) {
    if (
      (item?.type === "text" || item?.type === "output_text") &&
      typeof item?.text === "string" &&
      item.text.trim()
    ) {
      textParts.push(item.text);
    }
  }
  return textParts.join("");
}

function extractFunctionCalls(payload, fallbackOutputItems = []) {
  const output = Array.isArray(payload?.content)
    ? payload.content
    : Array.isArray(payload?.output)
      ? payload.output
      : (Array.isArray(fallbackOutputItems) ? fallbackOutputItems : []);
  const calls = [];
  for (const item of output) {
    if (item?.type !== "tool_use" && item?.type !== "function_call") continue;
    let variables = item?.input && typeof item.input === "object" ? item.input : {};
    if (item?.type === "function_call" && typeof item?.arguments === "string") {
      try {
        const parsed = JSON.parse(item.arguments);
        if (parsed && typeof parsed === "object") variables = parsed;
      } catch (_) {}
    }
    calls.push({
      action_key: typeof item?.name === "string" ? item.name : "",
      variables,
      call_id: item?.id ?? item?.call_id ?? null,
    });
  }
  return calls;
}

function extractAssistantBlocks(payload, fallbackOutputItems = []) {
  const output = Array.isArray(payload?.content)
    ? payload.content
    : Array.isArray(payload?.output)
      ? payload.output
      : (Array.isArray(fallbackOutputItems) ? fallbackOutputItems : []);
  const blocks = [];

  for (const item of output) {
    if (item?.type === "text" && typeof item?.text === "string") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    if (item?.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: item?.id ?? null,
        name: typeof item?.name === "string" ? item.name : "",
        input: item?.input && typeof item.input === "object" ? item.input : {},
      });
      continue;
    }
    if (item?.type === "function_call") {
      let input = {};
      if (typeof item?.arguments === "string") {
        try {
          const parsed = JSON.parse(item.arguments);
          if (parsed && typeof parsed === "object") input = parsed;
        } catch (_) {}
      }
      blocks.push({
        type: "tool_use",
        id: item?.call_id ?? null,
        name: typeof item?.name === "string" ? item.name : "",
        input,
      });
      continue;
    }
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        if (
          (part?.type === "output_text" || part?.type === "text") &&
          typeof part?.text === "string"
        ) {
          blocks.push({ type: "text", text: part.text });
        }
      }
    }
  }

  return blocks;
}
function toXAiInputItems(messages, assistantBlocks, toolResults) {
  const input = [...toOpenAiInputItems(messages)];

  for (const item of Array.isArray(assistantBlocks) ? assistantBlocks : []) {
    if (item?.type === "text") {
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: String(item.text ?? "") }],
      });
      continue;
    }
    if (item?.type === "tool_use") {
      input.push({
        type: "function_call",
        call_id: item?.id ?? null,
        name: String(item?.name ?? ""),
        arguments: JSON.stringify(item?.input && typeof item.input === "object" ? item.input : {}),
      });
    }
  }

  for (const result of Array.isArray(toolResults) ? toolResults : []) {
    input.push({
      type: "function_call_output",
      call_id: result?.call_id ?? null,
      output: JSON.stringify(result),
    });
  }

  return input;
}

function createXAiRequestBody({ model, instructions, messages, tools, inputItems }) {
  const systemRules = [
    "TOOL RULES (MUST FOLLOW):",
    "- Use provided tools when needed.",
    "- Never call a tool unless required parameters are present.",
    "- If a tool is needed, call it before user-facing final answer text.",
  ].join("\n");

  const finalInstructions = [systemRules, String(instructions || "")].filter(Boolean).join("\n\n");
  const requestBody = {
    model,
    instructions: finalInstructions,
    input: Array.isArray(inputItems) ? inputItems : toOpenAiInputItems(messages),
    text: { verbosity: "low" },
    stream: false,
  };

  if (Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = "auto";
  }

  return requestBody;
}

async function callXAiWithModel({ apiKey, model, instructions, messages, tools, inputItems }) {
  const requestBody = createXAiRequestBody({
    model,
    instructions,
    messages,
    tools,
    inputItems,
  });

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
  } catch (_) {
    return { ok: false, status: 502, error: "Network error calling xAI" };
  }

  if (!response.ok) {
    let errText = "";
    try {
      errText = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: errText || "xAI request failed",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Invalid JSON from xAI" };
  }

  const actionCalls = extractFunctionCalls(payload);
  const assistantBlocks = extractAssistantBlocks(payload);
  if (actionCalls.length > 0) {
    return {
      ok: true,
      data: { mode: "actions_needed", reply: "", action_calls: actionCalls },
      usage: payload?.usage ?? null,
      output_items: assistantBlocks,
    };
  }

  const rawText = extractResponseText(payload);
  if (!rawText) return { ok: false, status: 502, error: "Empty model output" };

  return {
    ok: true,
    data: { mode: "reply", reply: rawText, action_calls: [] },
    usage: payload?.usage ?? null,
    output_items: assistantBlocks,
  };
}

async function getXAiChatCompletion({ apiKey, model, instructions, messages, tools, inputItems }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };
  const uniqueModels = Array.from(
    new Set(
      [model, ...XAI_MODEL_FALLBACKS]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );

  let lastError = null;
  for (const modelName of uniqueModels) {
    const result = await callXAiWithModel({
      apiKey,
      model: modelName,
      instructions,
      messages,
      tools,
      inputItems,
    });
    if (result.ok) return result;

    lastError = { status: result.status, error: result.error };
    const isModelNotFound =
      result.status === 400 && /model not found/i.test(String(result.error || ""));
    if (isModelNotFound) continue;
    return result;
  }

  return {
    ok: false,
    status: lastError?.status || 502,
    error: lastError?.error || "xAI request failed",
  };
}

function parseActionBodyTemplate(bodyTemplate) {
  if (!bodyTemplate) return null;
  if (typeof bodyTemplate === "object") return bodyTemplate;
  if (typeof bodyTemplate !== "string") return null;
  const trimmed = bodyTemplate.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : trimmed;
  } catch (_) {
    return trimmed;
  }
}

function isJsonSchemaNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  return (
    Object.prototype.hasOwnProperty.call(node, "type") ||
    Object.prototype.hasOwnProperty.call(node, "properties") ||
    Object.prototype.hasOwnProperty.call(node, "items") ||
    Object.prototype.hasOwnProperty.call(node, "required") ||
    Object.prototype.hasOwnProperty.call(node, "additionalProperties")
  );
}

function getValueAtPath(source, pathParts) {
  let current = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function lookupTemplateValue(variables, pathParts) {
  if (!Array.isArray(pathParts) || pathParts.length === 0) return undefined;
  const directValue = getValueAtPath(variables, pathParts);
  if (directValue !== undefined) return directValue;

  const dottedKey = pathParts.join(".");
  if (variables && typeof variables === "object" && dottedKey in variables) {
    return variables[dottedKey];
  }

  const underscoredKey = pathParts.join("_");
  if (variables && typeof variables === "object" && underscoredKey in variables) {
    return variables[underscoredKey];
  }

  return undefined;
}

function renderTemplateValue(template, variables) {
  if (typeof template === "string") {
    const exactMatch = template.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exactMatch) {
      const value = lookupTemplateValue(
        variables,
        exactMatch[1]
          .split(".")
          .map((part) => part.trim())
          .filter(Boolean)
      );
      return value === undefined ? null : value;
    }
    return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawPath) => {
      const value = lookupTemplateValue(
        variables,
        String(rawPath)
          .split(".")
          .map((part) => part.trim())
          .filter(Boolean)
      );
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  }

  if (Array.isArray(template)) return template.map((item) => renderTemplateValue(item, variables));
  if (template && typeof template === "object") {
    const result = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = renderTemplateValue(value, variables);
    }
    return result;
  }
  return template;
}
function materializeSchemaNode(schema, source, pathParts = []) {
  if (!schema || typeof schema !== "object") return lookupTemplateValue(source, pathParts);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === "object" || schema.properties) {
    const properties =
      schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const result = {};
    for (const [key, childSchema] of Object.entries(properties)) {
      const value = materializeSchemaNode(childSchema, source, [...pathParts, key]);
      if (value !== undefined) result[key] = value;
    }
    if (Object.keys(result).length > 0) return result;
    const directObject = lookupTemplateValue(source, pathParts);
    if (directObject && typeof directObject === "object") return directObject;
    return pathParts.length === 0 ? {} : undefined;
  }

  if (type === "array" || schema.items) {
    const arrayValue = lookupTemplateValue(source, pathParts);
    if (!Array.isArray(arrayValue)) return undefined;
    if (!schema.items || typeof schema.items !== "object") return arrayValue;
    return arrayValue.map((item) => materializeSchemaNode(schema.items, item, []));
  }

  return lookupTemplateValue(source, pathParts);
}

function buildActionRequestPayload(actionDef, variables) {
  const parsedTemplate = parseActionBodyTemplate(actionDef?.body_template);
  if (!parsedTemplate) return variables;
  if (typeof parsedTemplate === "string") return renderTemplateValue(parsedTemplate, variables);

  if (isJsonSchemaNode(parsedTemplate)) {
    const materialized = materializeSchemaNode(parsedTemplate, variables, []);
    if (materialized && typeof materialized === "object" && !Array.isArray(materialized)) {
      return materialized;
    }
    return variables;
  }

  return renderTemplateValue(parsedTemplate, variables);
}

function getMissingRequiredFields(actionDef, variables) {
  const parsedTemplate = parseActionBodyTemplate(actionDef?.body_template);
  if (!parsedTemplate || !isJsonSchemaNode(parsedTemplate)) return [];
  const required = Array.isArray(parsedTemplate.required) ? parsedTemplate.required : [];
  const source = variables && typeof variables === "object" ? variables : {};
  const missing = [];
  for (const field of required) {
    if (typeof field !== "string" || !field.trim()) continue;
    const value = lookupTemplateValue(source, [field]);
    if (value === undefined || value === null || value === "") missing.push(field);
  }
  return missing;
}

function parseFixedOffsetMinutes(timeZone) {
  if (typeof timeZone !== "string") return null;
  const match = timeZone.trim().match(/^GMT([+-])(\d{2}):(\d{2})$/i);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function getTimeZoneOffsetMinutes(date, timeZone) {
  const fixedOffset = parseFixedOffsetMinutes(timeZone);
  if (fixedOffset !== null) return fixedOffset;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const map = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    const localMillis = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second)
    );
    return Math.round((localMillis - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

function parseLocalToUtcIso(value, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(value || "").trim()
  );
  if (!match) return String(value || "");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || "0");

  let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 2; i += 1) {
    const offset = getTimeZoneOffsetMinutes(new Date(utcMillis), timeZone);
    utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000;
  }
  return new Date(utcMillis).toISOString();
}

function normalizeRfc3339(value, timeZone) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (/[zZ]$/.test(trimmed)) return trimmed;
  if (/[+-]\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  if (timeZone) return parseLocalToUtcIso(trimmed, timeZone);
  return `${trimmed}Z`;
}

function addMinutesToRfc3339(value, minutes) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return value;
  return new Date(ts + Number(minutes) * 60 * 1000).toISOString();
}

function getHourInTimeZone(isoValue, timeZone) {
  const date = new Date(String(isoValue || ""));
  if (!Number.isFinite(date.getTime())) return null;
  const fixedOffset = parseFixedOffsetMinutes(timeZone);
  if (fixedOffset !== null) {
    const local = new Date(date.getTime() + fixedOffset * 60000);
    return local.getUTCHours();
  }
  try {
    const hourText = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      hour: "2-digit",
      hour12: false,
    }).format(date);
    const hour = Number(hourText);
    return Number.isFinite(hour) ? hour : null;
  } catch {
    return null;
  }
}

function getMinuteInTimeZone(isoValue, timeZone) {
  const date = new Date(String(isoValue || ""));
  if (!Number.isFinite(date.getTime())) return null;
  const fixedOffset = parseFixedOffsetMinutes(timeZone);
  if (fixedOffset !== null) {
    const local = new Date(date.getTime() + fixedOffset * 60000);
    return local.getUTCMinutes();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      minute: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isFinite(minute) ? minute : null;
  } catch {
    return null;
  }
}

function usageToTokens(usage) {
  const toFinite = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const pickMax = (values) => values.reduce((max, value) => Math.max(max, toFinite(value)), 0);
  const input = pickMax([
    usage?.input_tokens,
    usage?.prompt_tokens,
    usage?.input_text_tokens,
    usage?.prompt_token_count,
    usage?.input_token_count,
  ]);
  const output = pickMax([
    usage?.output_tokens,
    usage?.completion_tokens,
    usage?.output_text_tokens,
    usage?.completion_token_count,
    usage?.output_token_count,
  ]);
  return {
    input: Number.isFinite(input) && input > 0 ? Math.floor(input) : 0,
    output: Number.isFinite(output) && output > 0 ? Math.floor(output) : 0,
  };
}
async function executeActionCalls({
  actionCalls,
  actionMap,
  agentId,
  anonId,
  chatId,
  country,
  source,
  chatSource,
  incomingMessage,
}) {
  const toolResults = [];
  let calendarContext = null;
  let humanHandoffActivated = false;

  for (const call of actionCalls) {
    const actionDef = actionMap.get(call.action_key);
    if (!actionDef) {
      toolResults.push({ call_id: call.call_id ?? null, ok: false, error: "Unknown action" });
      continue;
    }

    if (actionDef.kind === "calendar_create" || actionDef.kind === "calendar_list") {
      if (!calendarContext) {
        calendarContext = {
          timezone: actionDef.timezone || "UTC",
          duration_mins: actionDef.duration_mins ?? null,
          open_hour: actionDef.open_hour ?? null,
          close_hour: actionDef.close_hour ?? null,
          event_type: actionDef.event_type ?? null,
        };
      }
    }

    let headers = {};
    if (actionDef.headers && typeof actionDef.headers === "object") {
      headers = { ...actionDef.headers };
    } else if (typeof actionDef.headers === "string") {
      try {
        const parsed = JSON.parse(actionDef.headers);
        if (parsed && typeof parsed === "object") headers = { ...parsed };
      } catch (_) {}
    }

    const method = String(actionDef.method || "POST").toUpperCase();
    const variables = call?.variables ?? {};
    let url = actionDef.url;
    let requestBody;
    let requestPayloadForLog = variables;

    if (actionDef.kind === "human_handoff") {
      const subject = String(variables?.subject ?? "").trim() || "Human support request";
      const summery =
        String(variables?.summery ?? variables?.summary ?? "").trim() ||
        `User requested human support. Last message: ${String(incomingMessage || "").trim()}`;
      const assignResult = await assignHumanHandoffChat({
        portalId: process.env.PORTAL_ID,
        portalSecretKey: process.env.PORTAL_SECRET_KEY,
        agentId,
        chatSource,
        source,
        chatId,
        anonId,
        externalUserId: anonId,
        country,
        subject,
        summery,
      });
      if (!assignResult.ok) {
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          tool_args: { subject, summery },
          request: { url: null, method: "LOCAL", headers: {}, body: { subject, summery } },
          response: {
            ok: false,
            status: assignResult.status || 502,
            error: assignResult.error || "Human handoff failed",
          },
        });
        continue;
      }
      const saveDashboardResult = await saveHumanMessageToMessages({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        agentId,
        anonId,
        chatId,
        country,
        source,
        prompt: String(incomingMessage),
        result: null,
      });
      if (!saveDashboardResult.ok) {
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          tool_args: { subject, summery },
          request: { url: null, method: "LOCAL", headers: {}, body: { subject, summery } },
          response: {
            ok: false,
            status: saveDashboardResult.status || 502,
            error: saveDashboardResult.error || "Message service unavailable",
          },
        });
        continue;
      }
      const savePortalResult = await saveHumanMessageToPortalFeed({
        portalId: process.env.PORTAL_ID,
        portalSecretKey: process.env.PORTAL_SECRET_KEY,
        agentId,
        anonId,
        chatId,
        source,
        senderType: "customer",
        assignedHumanAgentUserId: assignResult.assignedHumanAgentUserId,
        prompt: String(incomingMessage),
        result: null,
      });
      if (!savePortalResult.ok) {
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          tool_args: { subject, summery },
          request: { url: null, method: "LOCAL", headers: {}, body: { subject, summery } },
          response: {
            ok: false,
            status: savePortalResult.status || 502,
            error: savePortalResult.error || "Human message service unavailable",
          },
        });
        continue;
      }
      toolResults.push({
        call_id: call.call_id ?? null,
        action_key: call.action_key,
        tool_args: { subject, summery },
        request: { url: null, method: "LOCAL", headers: {}, body: { subject, summery } },
        response: {
          ok: true,
          status: 200,
          body: assignResult.created ? "Human handoff started." : "Human handoff already active.",
        },
      });
      humanHandoffActivated = true;
      break;
    }

    if (actionDef.kind === "dynamic_source_query") {
      const queryResult = executeDynamicSourceQuery(actionDef, variables);
      toolResults.push({
        call_id: call.call_id ?? null,
        action_key: call.action_key,
        tool_args: variables,
        request: {
          url: null,
          method: "LOCAL",
          headers: {},
          body: {
            filters: variables?.filters,
            sort_by: variables?.sort_by,
            sort_order: variables?.sort_order,
          },
        },
        response: queryResult.ok
          ? {
              ok: true,
              status: queryResult.status,
              body: JSON.stringify(queryResult.body),
            }
          : {
              ok: false,
              status: queryResult.status,
              error: queryResult.error || "Dynamic source query failed",
              details: queryResult.details || null,
            },
      });
      continue;
    }

    if (!url && actionDef.kind !== "ticket_create") {
      toolResults.push({
        call_id: call.call_id ?? null,
        action_key: call.action_key,
        tool_args: variables,
        request: { url: null, method, headers, body: variables },
        response: { ok: false, status: 400, error: "Unknown action" },
      });
      continue;
    }

    const missingRequiredFields =
      actionDef.kind === "custom" || actionDef.kind === "zapier" || actionDef.kind === "make"
        ? getMissingRequiredFields(actionDef, variables)
        : [];
    if (missingRequiredFields.length > 0) {
      toolResults.push({
        call_id: call.call_id ?? null,
        action_key: call.action_key,
        tool_args: variables,
        request: { url, method, headers, body: requestPayloadForLog },
        response: {
          ok: false,
          status: 400,
          error: "Missing required tool arguments",
          missing_required_fields: missingRequiredFields,
        },
      });
      continue;
    }

    if (actionDef.kind === "ticket_create") {
      const normalizedSubject = String(variables?.subject ?? "").trim();
      const normalizedSummary = String(variables?.summary ?? variables?.summery ?? "").trim();
      const normalizedCustomerName = String(variables?.customer_name ?? "").trim();
      const normalizedCustomerEmail = String(variables?.customer_email ?? variables?.email ?? "").trim();
      const normalizedCustomerPhone = String(variables?.customer_phone ?? variables?.phone ?? "").trim();
      const missingTicketFields = [];
      if (!normalizedSubject) missingTicketFields.push("subject");
      if (!normalizedSummary) missingTicketFields.push("summary");
      if (!normalizedCustomerName) missingTicketFields.push("customer_name");
      if (actionDef.ticket_email_required === true && !normalizedCustomerEmail) {
        missingTicketFields.push("customer_email");
      }
      if (actionDef.ticket_phone_required === true && !normalizedCustomerPhone) {
        missingTicketFields.push("customer_phone");
      }
      if (!normalizedCustomerEmail && !normalizedCustomerPhone) {
        missingTicketFields.push("customer_email_or_customer_phone");
      }

      const requestPayload = {
        subject: normalizedSubject,
        summary: normalizedSummary,
        customer_name: normalizedCustomerName,
        customer_email: normalizedCustomerEmail || null,
        customer_phone: normalizedCustomerPhone || null,
        anon_id: anonId,
        chat_id: chatId,
        chat_source: source,
        country: country || "UN",
        agent_id: agentId,
      };

      if (missingTicketFields.length > 0) {
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          tool_args: variables,
          request: {
            url: `https://${process.env.PORTAL_ID || "PORTAL_ID"}.supabase.co/rest/v1/tickets`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestPayload,
          },
          response: {
            ok: false,
            status: 400,
            error: "Missing required tool arguments",
            missing_required_fields: missingTicketFields,
          },
        });
        continue;
      }

      const ticketResult = await createPortalTicket({
        portalId: process.env.PORTAL_ID,
        portalSecretKey: process.env.PORTAL_SECRET_KEY,
        agentId,
        chatId,
        anonId,
        chatSource: source,
        country: country || "UN",
        subject: normalizedSubject,
        summary: normalizedSummary,
        customerName: normalizedCustomerName,
        customerEmail: normalizedCustomerEmail || null,
        customerPhone: normalizedCustomerPhone || null,
      });

      toolResults.push({
        call_id: call.call_id ?? null,
        action_key: call.action_key,
        tool_args: variables,
        request: {
          url: `https://${process.env.PORTAL_ID || "PORTAL_ID"}.supabase.co/rest/v1/tickets`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestPayload,
        },
        response: ticketResult.ok
          ? {
              ok: true,
              status: ticketResult.status,
              body: JSON.stringify({
                ticket_code: ticketResult.ticket?.ticket_code ?? null,
                status: ticketResult.ticket?.status ?? "open",
              }),
            }
          : {
              ok: false,
              status: ticketResult.status,
              error: ticketResult.error || "Ticket creation failed",
              details: ticketResult.details || null,
            },
      });
      continue;
    }

    if (actionDef.kind === "gmail_send") {
      const tokenResult = await ensureAccessToken({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        agentId,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        connection: actionDef.gmail_connection,
      });
      if (!tokenResult.ok) {
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          tool_args: variables,
          request: { url, method, headers, body: variables },
          response: { ok: false, status: 401, error: tokenResult.error || "Gmail authorization failed" },
        });
        continue;
      }
      headers.Authorization = `${tokenResult.token_type} ${tokenResult.access_token}`;
      requestPayloadForLog = {
        raw: buildRawEmail({
          to: variables?.to,
          subject: variables?.subject,
          body: variables?.body,
          cc: variables?.cc,
          bcc: variables?.bcc,
        }),
      };
      requestBody = JSON.stringify(requestPayloadForLog);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    } else if (actionDef.kind === "calendar_create" || actionDef.kind === "calendar_list") {
      const tokenResult = await ensureCalendarAccessToken({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        agentId,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        connection: actionDef.calendar_connection,
      });
      if (!tokenResult.ok) {
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          tool_args: variables,
          request: { url, method, headers, body: variables },
          response: {
            ok: false,
            status: 401,
            error: tokenResult.error || "Calendar authorization failed",
          },
        });
        continue;
      }
      headers.Authorization = `${tokenResult.token_type} ${tokenResult.access_token}`;

      if (actionDef.kind === "calendar_create") {
        const calendarTimeZone = actionDef.timezone || "UTC";
        const startTime = normalizeRfc3339(variables?.start_time, calendarTimeZone);
        const durationMins = Number(actionDef.duration_mins);
        const effectiveDuration = Number.isFinite(durationMins) && durationMins > 0 ? durationMins : 30;
        const reducedDuration = Math.max(1, Math.floor(effectiveDuration * 0.95));
        const endTime = addMinutesToRfc3339(startTime, reducedDuration);
        const startHour = getHourInTimeZone(startTime, calendarTimeZone);
        const endHour = getHourInTimeZone(endTime, calendarTimeZone);
        const startMin = getMinuteInTimeZone(startTime, calendarTimeZone);
        const endMin = getMinuteInTimeZone(endTime, calendarTimeZone);
        const openHour = Number(actionDef.open_hour);
        const closeHour = Number(actionDef.close_hour);
        const hasOpenHours =
          Number.isFinite(openHour) && Number.isFinite(closeHour) && openHour >= 0 && closeHour <= 24;
        const isAllDayOpen = hasOpenHours && openHour === 0 && closeHour === 24;

        if (
          hasOpenHours &&
          !isAllDayOpen &&
          startHour !== null &&
          endHour !== null &&
          startMin !== null &&
          endMin !== null
        ) {
          const startTotal = startHour * 60 + startMin;
          const endTotal = endHour * 60 + endMin;
          const openTotal = Math.max(0, openHour * 60 - 1);
          const closeTotal = Math.min(24 * 60, closeHour * 60 + 1);
          if (startTotal < openTotal || endTotal > closeTotal || startTotal >= closeTotal) {
            toolResults.push({
              call_id: call.call_id ?? null,
              action_key: call.action_key,
              tool_args: variables,
              request: { url, method, headers, body: variables },
              response: { ok: false, status: 409, error: "Requested time is outside of open hours" },
            });
            continue;
          }
        }

        requestPayloadForLog = {
          summary: actionDef.event_type || "Event",
          location: actionDef.location ?? undefined,
          start: { dateTime: startTime, timeZone: calendarTimeZone },
          end: { dateTime: endTime, timeZone: calendarTimeZone },
          attendees: Array.isArray(variables?.attendees)
            ? variables.attendees.map((email) => ({ email }))
            : undefined,
        };
        requestBody = JSON.stringify(requestPayloadForLog);
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      } else {
        const qs = new URLSearchParams();
        const calendarTimeZone = actionDef.timezone || "UTC";
        qs.append("timeMin", normalizeRfc3339(variables?.time_min, calendarTimeZone));
        qs.append("timeMax", normalizeRfc3339(variables?.time_max, calendarTimeZone));
        qs.append("singleEvents", "true");
        qs.append("orderBy", "startTime");
        if (Number.isFinite(Number(variables?.max_results))) {
          qs.append("maxResults", String(Number(variables.max_results)));
        }
        const qsText = qs.toString();
        if (qsText) url = `${url}${url.includes("?") ? "&" : "?"}${qsText}`;
      }
    } else if (actionDef.kind === "slack") {
      requestPayloadForLog = {
        text: typeof variables?.message === "string" ? variables.message : "",
        username: actionDef.username || "MitsoLab",
      };
      requestBody = JSON.stringify(requestPayloadForLog);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    } else if (method === "GET") {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(variables)) {
        if (value === undefined) continue;
        qs.append(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      const qsText = qs.toString();
      if (qsText) url = `${url}${url.includes("?") ? "&" : "?"}${qsText}`;
      requestPayloadForLog = null;
    } else {
      requestPayloadForLog = buildActionRequestPayload(actionDef, variables);
      requestBody = JSON.stringify(requestPayloadForLog);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }

    let actionResponse;
    try {
      const actionRes = await fetch(url, { method, headers, body: requestBody });
      const text = await actionRes.text();
      actionResponse = { ok: actionRes.ok, status: actionRes.status, body: text };
    } catch (_) {
      actionResponse = { ok: false, status: 502, error: "Action request failed" };
    }

    toolResults.push({
      call_id: call.call_id ?? null,
      action_key: call.action_key,
      tool_args: variables,
      request: { url, method, headers, body: requestPayloadForLog },
      response: actionResponse,
    });
  }

  return { toolResults, calendarContext, humanHandoffActivated };
}
function toWebhookEvents(payload) {
  const objectType = String(payload?.object || "").toLowerCase();
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const events = [];

  const hasTelegramShape =
    Number.isFinite(Number(payload?.update_id)) ||
    payload?.message ||
    payload?.edited_message ||
    payload?.callback_query;
  if (hasTelegramShape) {
    const message = payload?.message || payload?.edited_message || payload?.callback_query?.message;
    const from = payload?.message?.from || payload?.edited_message?.from || payload?.callback_query?.from;
    const chat = message?.chat;
    const telegramAudio = extractTelegramAudioPayload(message);
    const text =
      typeof payload?.message?.text === "string"
        ? payload.message.text.trim()
        : typeof payload?.edited_message?.text === "string"
          ? payload.edited_message.text.trim()
          : typeof payload?.callback_query?.data === "string"
            ? payload.callback_query.data.trim()
            : "";
    const hasAttachment =
      Array.isArray(payload?.message?.photo) ||
      Boolean(payload?.message?.document) ||
      Boolean(payload?.message?.video) ||
      Boolean(telegramAudio);

    if (chat?.id) {
      events.push({
        eventId: String(payload?.update_id || message?.message_id || "").trim(),
        object: "telegram",
        field: "message",
        channel: "telegram",
        lookupId: "", // resolved from query param in handler
        senderId: String(from?.id || "").trim(),
        recipientId: String(chat?.id || "").trim(),
        messageId: String(message?.message_id || payload?.update_id || "").trim(),
        text: text || (hasAttachment ? "[User sent an attachment]" : ""),
        telegramAudio,
        rawItem: payload,
      });
    }
    return events.filter((event) => event.text);
  }

  if (objectType === "whatsapp_business_account") {
    for (const entry of entries) {
      const entryId = String(entry?.id || "").trim();
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const field = String(change?.field || "").trim();
        if (field !== "messages") continue;
        const value = change?.value && typeof change.value === "object" ? change.value : {};
        const phoneNumberId = String(value?.metadata?.phone_number_id || "").trim();
        const messages = Array.isArray(value?.messages) ? value.messages : [];

        for (const message of messages) {
          const msgType = String(message?.type || "").trim();
          const senderId = String(message?.from || "").trim();
          if (!senderId) continue;

          const textBody =
            msgType === "text" && typeof message?.text?.body === "string"
              ? message.text.body.trim()
              : "";
          const hasAttachment = msgType && msgType !== "text";
          if (!textBody && !hasAttachment) continue;

          events.push({
            eventId: String(message?.id || value?.statuses?.[0]?.id || "").trim(),
            object: objectType,
            field,
            channel: "whatsapp",
            lookupId: phoneNumberId || entryId,
            senderId,
            recipientId: phoneNumberId || "",
            messageId: String(message?.id || "").trim(),
            text: textBody || "[User sent an attachment]",
            rawItem: change,
          });
        }
      }
    }
    return events;
  }

  for (const entry of entries) {
    const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
    const entryId = String(entry?.id || "").trim();
    const field = String(entry?.changes?.[0]?.field || "messaging").trim();
    for (const item of messaging) {
      const isEcho = Boolean(item?.message?.is_echo);
      const text = typeof item?.message?.text === "string" ? item.message.text.trim() : "";
      const hasAttachment =
        Array.isArray(item?.message?.attachments) && item.message.attachments.length > 0;
      if (!item?.message || isEcho || (!text && !hasAttachment)) continue;

      const senderId = String(item?.sender?.id || "").trim();
      if (!senderId) continue;

      events.push({
        eventId: String(item?.message?.mid || item?.timestamp || "").trim(),
        object: objectType,
        field,
        channel: objectType === "instagram" ? "instagram" : "messenger",
        lookupId: entryId || String(item?.recipient?.id || "").trim(),
        senderId,
        recipientId: String(item?.recipient?.id || "").trim(),
        messageId: String(item?.message?.mid || "").trim(),
        text: text || "[User sent an attachment]",
        rawItem: item,
      });
    }
  }
  return events;
}

async function insertMetaWebhookDebugMessage({ supId, supKey, event, raw }) {
  if (!supId || !supKey) return;
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/meta_webhook_debug_messages`;
  const payload = {
    object: String(event?.object || ""),
    field: String(event?.field || ""),
    entry_id: String(event?.lookupId || ""),
    sender_id: String(event?.senderId || ""),
    recipient_id: String(event?.recipientId || ""),
    message_id: String(event?.messageId || event?.eventId || ""),
    message_text: String(event?.text || ""),
    raw: raw && typeof raw === "object" ? raw : { note: String(raw || "") },
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
  } catch (_) {}
}

async function updateTelegramPendingRequests({ supId, supKey, agentId, pendingAccessRequests }) {
  if (!supId || !supKey || !agentId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/telegram_channel_connections`);
  url.searchParams.set("agent_id", `eq.${agentId}`);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        pending_access_requests: normalizeJsonArray(pendingAccessRequests),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Telegram channel update unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Telegram channel update unavailable" };
  }
  return { ok: true };
}

async function fetchChannelConnection({ supId, supKey, channel, lookupId }) {
  if (!supId || !supKey) return { ok: false, status: 500, error: "Server configuration error" };
  if (!lookupId) return { ok: false, status: 404, error: "Channel not found" };

  if (channel === "telegram") {
    const baseUrl = `https://${supId}.supabase.co/rest/v1`;
    const url = new URL(`${baseUrl}/telegram_channel_connections`);
    url.searchParams.set(
      "select",
      "agent_id,bot_token,bot_id,bot_username,connected,webhook_enabled,security_enabled,pending_access_requests,allowed_chat_users"
    );
    url.searchParams.set("agent_id", `eq.${lookupId}`);
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
    } catch (_) {
      return { ok: false, status: 502, error: "Telegram channel service unavailable" };
    }
    if (!response.ok) return { ok: false, status: 502, error: "Telegram channel service unavailable" };

    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      return { ok: false, status: 502, error: "Telegram channel service unavailable" };
    }
    const rows = Array.isArray(payload) ? payload : [];
    const row = rows.find((item) => Boolean(item?.connected) && Boolean(item?.webhook_enabled));
    if (!row) return { ok: false, status: 404, error: "Telegram connection not found" };
    if (!row?.bot_token) return { ok: false, status: 400, error: "Missing Telegram bot token" };

    return {
      ok: true,
      connection: {
        kind: "telegram",
        agent_id: String(row.agent_id || "").trim(),
        thread_id: String(row.bot_id || row.bot_username || row.agent_id || "").trim(),
        bot_token: String(row.bot_token || "").trim(),
        security_enabled: Boolean(row.security_enabled),
        pending_access_requests: normalizeJsonArray(row.pending_access_requests),
        allowed_chat_users: normalizeJsonArray(row.allowed_chat_users),
      },
    };
  }

  if (channel === "whatsapp") {
    const baseUrl = `https://${supId}.supabase.co/rest/v1`;
    const numbersUrl = new URL(`${baseUrl}/whatsapp_channel_numbers`);
    numbersUrl.searchParams.set("select", "agent_id,phone_number_id,waba_id,connected");
    numbersUrl.searchParams.set("phone_number_id", `eq.${lookupId}`);
    numbersUrl.searchParams.set("limit", "5");

    let numbersRes;
    try {
      numbersRes = await fetch(numbersUrl.toString(), {
        headers: {
          apikey: supKey,
          Authorization: `Bearer ${supKey}`,
          Accept: "application/json",
        },
      });
    } catch (_) {
      return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    }
    if (!numbersRes.ok) return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };

    let numbersPayload;
    try {
      numbersPayload = await numbersRes.json();
    } catch (_) {
      return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    }

    const numbers = Array.isArray(numbersPayload) ? numbersPayload : [];
    const numberRow = numbers.find((row) => Boolean(row?.connected));
    if (!numberRow) return { ok: false, status: 404, error: "WhatsApp number not connected" };

    const connectionsUrl = new URL(`${baseUrl}/whatsapp_channel_connections`);
    connectionsUrl.searchParams.set("select", "agent_id,business_access_token,connected,waba_id");
    connectionsUrl.searchParams.set("agent_id", `eq.${numberRow.agent_id}`);
    connectionsUrl.searchParams.set("limit", "1");

    let connectionsRes;
    try {
      connectionsRes = await fetch(connectionsUrl.toString(), {
        headers: {
          apikey: supKey,
          Authorization: `Bearer ${supKey}`,
          Accept: "application/json",
        },
      });
    } catch (_) {
      return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    }
    if (!connectionsRes.ok) return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };

    let connectionsPayload;
    try {
      connectionsPayload = await connectionsRes.json();
    } catch (_) {
      return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    }

    const connections = Array.isArray(connectionsPayload) ? connectionsPayload : [];
    const connectionRow = connections.find((row) => Boolean(row?.connected));
    if (!connectionRow) return { ok: false, status: 404, error: "WhatsApp connection not found" };
    if (!connectionRow?.business_access_token) {
      return { ok: false, status: 400, error: "Missing WhatsApp business access token" };
    }

    return {
      ok: true,
      connection: {
        kind: "whatsapp",
        agent_id: String(numberRow.agent_id || "").trim(),
        thread_id: String(numberRow.phone_number_id || ""),
        phone_number_id: String(numberRow.phone_number_id || "").trim(),
        access_token: String(connectionRow.business_access_token || "").trim(),
      },
    };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/meta_channel_pages`);
  url.searchParams.set(
    "select",
    "agent_id,page_id,page_access_token,instagram_business_account_id,instagram_connected,messenger_connected,supports_instagram,supports_messenger"
  );
  if (channel === "instagram") {
    url.searchParams.set(
      "or",
      `(instagram_business_account_id.eq.${lookupId},page_id.eq.${lookupId})`
    );
  } else {
    url.searchParams.set("page_id", `eq.${lookupId}`);
  }
  url.searchParams.set("limit", "5");

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Channel page service unavailable" };
  }

  if (!response.ok) return { ok: false, status: 502, error: "Channel page service unavailable" };
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Channel page service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  const row = rows.find((item) => {
    if (channel === "instagram") {
      return Boolean(item?.instagram_connected) && Boolean(item?.supports_instagram);
    }
    return Boolean(item?.messenger_connected) && Boolean(item?.supports_messenger);
  });

  if (!row) return { ok: false, status: 404, error: "Channel page not found" };
  if (!row?.agent_id) return { ok: false, status: 404, error: "Agent not found" };
  if (!row?.page_access_token) return { ok: false, status: 400, error: "Missing page access token" };

  return {
    ok: true,
    connection: {
      kind: "meta",
      agent_id: String(row.agent_id || "").trim(),
      thread_id: String(row.page_id || "").trim(),
      page_id: String(row.page_id || "").trim(),
      access_token: String(row.page_access_token || "").trim(),
    },
  };
}

async function sendMetaTextReply({ pageAccessToken, recipientId, text }) {
  const endpoint = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/messages`);
  endpoint.searchParams.set("access_token", pageAccessToken);
  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Meta send API unavailable" };
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch (_) {}
    return { ok: false, status: response.status || 502, error: body || "Meta send API error" };
  }
  return { ok: true };
}

async function sendWhatsAppTextReply({ accessToken, phoneNumberId, recipientId, text }) {
  const endpoint = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipientId,
        type: "text",
        text: { body: String(text || "") },
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "WhatsApp send API unavailable" };
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch (_) {}
    return { ok: false, status: response.status || 502, error: body || "WhatsApp send API error" };
  }
  return { ok: true };
}

async function sendWhatsAppReadStatus({ accessToken, phoneNumberId, messageId }) {
  if (!messageId) return { ok: false, status: 400, error: "missing_message_id_for_read_status" };
  const endpoint = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "WhatsApp read status API unavailable" };
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: body || "WhatsApp read status API error",
    };
  }
  return { ok: true };
}

async function getTelegramFileInfo({ botToken, fileId }) {
  if (!botToken || !fileId) return { ok: false, status: 400, error: "missing telegram file inputs" };
  const endpoint = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  let response;
  try {
    response = await fetch(endpoint);
  } catch (_) {
    return { ok: false, status: 502, error: "Telegram getFile unavailable" };
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {}
  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      status: response.status || 502,
      error: payload?.description || "Telegram getFile error",
    };
  }
  const filePath = String(payload?.result?.file_path || "").trim();
  if (!filePath) return { ok: false, status: 502, error: "Telegram file path missing" };
  const fileSize = Number.isFinite(Number(payload?.result?.file_size))
    ? Math.floor(Number(payload.result.file_size))
    : null;
  return { ok: true, filePath, fileSize };
}

async function downloadTelegramFile({ botToken, filePath, expectedSize }) {
  if (!botToken || !filePath) return { ok: false, status: 400, error: "missing telegram download inputs" };
  const size = Number(expectedSize);
  if (Number.isFinite(size) && size > TELEGRAM_VOICE_MAX_BYTES) {
    return { ok: false, status: 413, error: "Telegram voice message is too large" };
  }
  const endpoint = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  let response;
  try {
    response = await fetch(endpoint);
  } catch (_) {
    return { ok: false, status: 502, error: "Telegram file download unavailable" };
  }
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: body || "Telegram file download error",
    };
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > TELEGRAM_VOICE_MAX_BYTES) {
    return { ok: false, status: 413, error: "Telegram voice message is too large" };
  }
  let arrayBuffer;
  try {
    arrayBuffer = await response.arrayBuffer();
  } catch (_) {
    return { ok: false, status: 502, error: "Telegram file download failed" };
  }
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > TELEGRAM_VOICE_MAX_BYTES) {
    return { ok: false, status: 413, error: "Telegram voice message is too large" };
  }
  return {
    ok: true,
    buffer,
    contentType: response.headers.get("content-type") || "",
  };
}

async function sonioxApiFetch(endpoint, { method = "GET", body, headers = {} } = {}) {
  const apiKey = String(process.env.SONIOX_API_KEY || "").trim();
  if (!apiKey) return { ok: false, status: 500, error: "Missing SONIOX_API_KEY" };
  let response;
  try {
    response = await fetch(`${SONIOX_API_BASE_URL}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      body,
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Soniox API unavailable" };
  }
  if (method === "DELETE") {
    if (response.ok) return { ok: true, payload: null };
  } else if (response.ok) {
    try {
      return { ok: true, payload: await response.json() };
    } catch (_) {
      return { ok: false, status: 502, error: "Invalid Soniox API response" };
    }
  }
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (_) {}
  return {
    ok: false,
    status: response.status || 502,
    error: bodyText || "Soniox API error",
  };
}

function renderSonioxTranscriptText(transcript) {
  if (typeof transcript?.text === "string" && transcript.text.trim()) return transcript.text.trim();
  const tokens = Array.isArray(transcript?.tokens) ? transcript.tokens : [];
  return tokens
    .map((token) => String(token?.text || ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

async function transcribeAudioBufferWithSoniox({ buffer, filename, mimeType, clientReferenceId }) {
  let fileId = "";
  let transcriptionId = "";
  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });
    form.append("file", blob, filename || "telegram-voice.ogg");
    const uploadResult = await sonioxApiFetch("/v1/files", { method: "POST", body: form });
    if (!uploadResult.ok) return uploadResult;
    fileId = String(uploadResult.payload?.id || "").trim();
    if (!fileId) return { ok: false, status: 502, error: "Soniox file upload did not return an id" };

    const config = {
      model: SONIOX_STT_MODEL,
      file_id: fileId,
      client_reference_id: clientReferenceId,
    };
    const languageHints = String(process.env.SONIOX_LANGUAGE_HINTS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (languageHints.length > 0) config.language_hints = languageHints;

    const createResult = await sonioxApiFetch("/v1/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!createResult.ok) return createResult;
    transcriptionId = String(createResult.payload?.id || "").trim();
    if (!transcriptionId) {
      return { ok: false, status: 502, error: "Soniox transcription did not return an id" };
    }

    const deadline = Date.now() + SONIOX_TRANSCRIPTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const statusResult = await sonioxApiFetch(`/v1/transcriptions/${encodeURIComponent(transcriptionId)}`);
      if (!statusResult.ok) return statusResult;
      const status = String(statusResult.payload?.status || "").toLowerCase();
      if (status === "completed") {
        const transcriptResult = await sonioxApiFetch(
          `/v1/transcriptions/${encodeURIComponent(transcriptionId)}/transcript`
        );
        if (!transcriptResult.ok) return transcriptResult;
        const text = renderSonioxTranscriptText(transcriptResult.payload);
        if (!text) return { ok: false, status: 422, error: "Soniox returned an empty transcript" };
        return { ok: true, text };
      }
      if (status === "error") {
        return {
          ok: false,
          status: 502,
          error: statusResult.payload?.error_message || "Soniox transcription failed",
        };
      }
      await sleep(1000);
    }
    return { ok: false, status: 504, error: "Soniox transcription timed out" };
  } finally {
    if (transcriptionId) {
      await sonioxApiFetch(`/v1/transcriptions/${encodeURIComponent(transcriptionId)}`, { method: "DELETE" });
    }
    if (fileId) {
      await sonioxApiFetch(`/v1/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    }
  }
}

async function transcribeTelegramAudioMessage({ botToken, audio, event }) {
  const fileInfo = await getTelegramFileInfo({ botToken, fileId: audio?.fileId });
  if (!fileInfo.ok) return fileInfo;
  const download = await downloadTelegramFile({
    botToken,
    filePath: fileInfo.filePath,
    expectedSize: audio?.fileSize || fileInfo.fileSize,
  });
  if (!download.ok) return download;
  const fallbackName = fileInfo.filePath.split("/").pop() || `${audio?.kind || "telegram-audio"}.ogg`;
  return transcribeAudioBufferWithSoniox({
    buffer: download.buffer,
    filename: audio?.fileName || fallbackName,
    mimeType: audio?.mimeType || download.contentType,
    clientReferenceId: `telegram:${event?.messageId || event?.eventId || Date.now()}`,
  });
}

async function sendTelegramChatAction({ botToken, chatId, action = "typing" }) {
  if (!botToken || !chatId) return { ok: false, status: 400, error: "missing telegram action inputs" };
  const endpoint = `https://api.telegram.org/bot${botToken}/sendChatAction`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Telegram sendChatAction unavailable" };
  }
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: body || "Telegram sendChatAction error",
    };
  }
  return { ok: true };
}

async function sendTelegramTextReply({ botToken, chatId, text }) {
  if (!botToken || !chatId) return { ok: false, status: 400, error: "missing telegram send inputs" };
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || ""),
        parse_mode: "Markdown",
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Telegram sendMessage unavailable" };
  }
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: body || "Telegram sendMessage error",
    };
  }
  return { ok: true };
}

async function sendMetaSenderAction({ pageAccessToken, recipientId, action }) {
  const endpoint = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/messages`);
  endpoint.searchParams.set("access_token", pageAccessToken);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action }),
    });
    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch (_) {}
      return {
        ok: false,
        status: response.status || 502,
        error: body || "Meta sender action API error",
      };
    }
  } catch (_) {
    return { ok: false, status: 502, error: "Meta sender action API unavailable" };
  }
  return { ok: true };
}

function startTypingHeartbeat({ pageAccessToken, recipientId, intervalMs = 3500 }) {
  let closed = false;
  const tick = async () => {
    if (closed) return;
    await sendMetaSenderAction({ pageAccessToken, recipientId, action: "typing_on" });
  };
  void tick();
  const timer = setInterval(() => void tick(), Math.max(1000, Number(intervalMs) || 3500));

  return async function stop() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await sendMetaSenderAction({ pageAccessToken, recipientId, action: "typing_off" });
  };
}

function buildChannelPrompt({ systemRole, chunks, nowIso, channel, extraRules }) {
  const sections = [];
  if (typeof systemRole === "string" && systemRole.trim()) {
    sections.push(systemRole.trim());
  }
  const isWhatsApp = channel === "whatsapp";
  const isTelegram = channel === "telegram";
  sections.push(
    [
      "SYSTEM RULES",
      isWhatsApp
        ? "You are replying inside WhatsApp chat."
        : isTelegram
          ? "You are replying inside Telegram chat."
        : "You are replying inside Instagram/Messenger chat.",
      isWhatsApp || isTelegram ? "Use concise chat style." : "Use plain text only.",
      ...(isWhatsApp || isTelegram
        ? []
        : [
            "Do not use Markdown symbols like **, *, _, #, or code fences.",
            "Use short direct sentences.",
            "If list needed, use '-' bullets only.",
          ]),
      "Do not claim capabilities or actions you cannot execute.",
      "Treat abusive or hateful language safely and professionally; do not mirror abusive tone.",
    ].join("\n")
  );
  sections.push(["CURRENT DATE", nowIso].join("\n"));
  if (Array.isArray(chunks) && chunks.length > 0) {
    sections.push(["KNOWLEDGE CHUNKS", ...chunks].join("\n"));
  }
  if (typeof extraRules === "string" && extraRules.trim()) {
    sections.push(extraRules.trim());
  }
  return sections.join("\n\n");
}

function calendarContextNote(calendarContext) {
  if (!calendarContext) return "";
  return [
    "CALENDAR SETTINGS",
    `Timezone: ${calendarContext.timezone}`,
    calendarContext.duration_mins !== null
      ? `Duration: ${calendarContext.duration_mins} minutes`
      : "Duration: default",
    Number.isFinite(Number(calendarContext.open_hour)) &&
    Number.isFinite(Number(calendarContext.close_hour))
      ? `Open hours: ${calendarContext.open_hour}:00-${calendarContext.close_hour}:00`
      : "Open hours: not set",
    calendarContext.event_type ? `Event type: ${calendarContext.event_type}` : "Event type: not set",
    "Speak as business availability, not as user's personal calendar.",
  ].join("\n");
}

async function verifyMetaWebhookSignature(req) {
  const appSecret = String(process.env.META_APP_SECRET || "");
  if (!appSecret) return { ok: true, reason: "skipped_no_secret" };

  const signatureHeader = String(req?.headers?.["x-hub-signature-256"] || "");
  if (!signatureHeader.startsWith("sha256=")) {
    return { ok: false, reason: "missing_signature" };
  }
  const expectedHex = signatureHeader.slice("sha256=".length).trim();
  if (!/^[a-f0-9]{64}$/i.test(expectedHex)) {
    return { ok: false, reason: "invalid_signature_format" };
  }

  const candidates = [];
  if (typeof req?.rawBody === "string" || Buffer.isBuffer(req?.rawBody)) {
    candidates.push(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody));
  }
  if (typeof req?.body === "string") {
    candidates.push(Buffer.from(req.body));
  } else if (req?.body && typeof req.body === "object") {
    candidates.push(Buffer.from(JSON.stringify(req.body)));
  }
  if (candidates.length === 0) return { ok: false, reason: "missing_raw_body" };

  const expected = Buffer.from(expectedHex, "hex");
  for (const bodyBuffer of candidates) {
    const digest = createHmac("sha256", appSecret).update(bodyBuffer).digest();
    if (digest.length === expected.length && timingSafeEqual(digest, expected)) {
      return { ok: true, reason: "verified" };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}
async function processIncomingMessage({ event, connection, headers }) {
  const requestStartedAt = Date.now();
  const agentId = connection.agent_id;
  const anonId = `${event.channel}:${event.senderId}`;
  const chatId = `${event.channel}:${connection.thread_id}:${event.senderId}`;
  const requestCountry = getRequestCountry(headers);
  const incomingText = sanitizeIncomingUserText(event.text);
  const normalizedMessage = normalizeIncomingMessage(incomingText);
  let consumedExtraCreditRowId = null;
  let requestSucceeded = false;
  try {
  const spamGuardResult = await evaluateAnonSpamAndMaybeBan({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    xaiApiKey: process.env.XAI_API_KEY,
    xaiModel: process.env.XAI_SPAM_MODEL || process.env.XAI_PRIMARY_MODEL,
    agentId,
    anonId,
    incomingMessage: incomingText,
  });
  if (!spamGuardResult.ok) {
    return { ok: false, status: spamGuardResult.status || 502, error: spamGuardResult.error || "Spam guard failed" };
  }
  if (spamGuardResult.banned) {
    return { ok: false, status: 403, error: "User is banned" };
  }

  const usageCheck = await checkMessageCap({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  if (!usageCheck.ok) return { ok: false, status: usageCheck.status, error: usageCheck.error };
  const usageCheckExtraCreditRowId = Number(usageCheck?.extraCreditRowId);
  if (Number.isFinite(usageCheckExtraCreditRowId) && usageCheckExtraCreditRowId > 0) {
    consumedExtraCreditRowId = Math.floor(usageCheckExtraCreditRowId);
  }

  const handoffAppResult = await checkHumanAgentsAppEnabled({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  const humanHandoffAppEnabled = Boolean(handoffAppResult?.ok && handoffAppResult?.enabled);
  let humanHandoffToolEnabled = false;
  if (humanHandoffAppEnabled) {
    const [openHandoffChatResult, availableHumanAgentsResult] = await Promise.all([
      getOpenHumanHandoffChat({
        portalId: process.env.PORTAL_ID,
        portalSecretKey: process.env.PORTAL_SECRET_KEY,
        agentId,
        chatSource: event.channel,
        chatId,
      }),
      checkAvailableHumanAgents({
        portalId: process.env.PORTAL_ID,
        portalSecretKey: process.env.PORTAL_SECRET_KEY,
        agentId,
      }),
    ]);
    if (openHandoffChatResult?.ok && openHandoffChatResult.chat) {
      const assignedHumanAgentUserId =
        openHandoffChatResult.chat?.assigned_human_agent_user_id ?? null;
      const saveDashboardResult = await saveHumanMessageToMessages({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        agentId,
        anonId,
        chatId,
        country: requestCountry,
        source: `meta_${event.channel}`,
        prompt: incomingText,
        result: null,
      });
      if (!saveDashboardResult.ok) {
        return {
          ok: false,
          status: saveDashboardResult.status,
          error: saveDashboardResult.error,
        };
      }
      const savePortalResult = await saveHumanMessageToPortalFeed({
        portalId: process.env.PORTAL_ID,
        portalSecretKey: process.env.PORTAL_SECRET_KEY,
        agentId,
        anonId,
        chatId,
        source: `meta_${event.channel}`,
        senderType: "customer",
        assignedHumanAgentUserId,
        prompt: incomingText,
        result: null,
      });
      if (!savePortalResult.ok) {
        return {
          ok: false,
          status: savePortalResult.status,
          error: savePortalResult.error,
        };
      }
      requestSucceeded = true;
      return { ok: true, humanHandoff: true, actionUsed: false, actionCount: 0 };
    }
    humanHandoffToolEnabled = Boolean(
      availableHumanAgentsResult?.ok && availableHumanAgentsResult?.available
    );
  }

  const historyPromise = getChatHistory({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    anonId,
    chatId,
    maxRows: 2,
  });
  const ragPromise =
    normalizedMessage && !SKIP_VECTOR_MESSAGES.has(normalizedMessage)
      ? getRelevantKnowledgeChunks({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          voyageApiKey: process.env.VOYAGE_API_KEY,
          outputDimension: process.env.VOYAGE_OUTPUT_DIMENSION,
          agentId,
          anonId,
          chatId,
          message: incomingText,
        })
      : Promise.resolve({ ok: true, chunks: [] });
  const agentInfoPromise = getAgentInfo({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  const toolsResultPromise = getAgentAllActions({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    includePortalTickets: true,
  });

  let latencyMiniMs = null;
  let latencyNanoMs = null;
  let latencyToolsMs = null;

  const [historyResult, ragResult, agentInfo, toolsResult] = await Promise.all([
    historyPromise,
    ragPromise,
    agentInfoPromise,
    toolsResultPromise,
  ]);

  if (!historyResult.ok) return { ok: false, status: historyResult.status, error: historyResult.error };
  if (!ragResult.ok) return { ok: false, status: ragResult.status, error: ragResult.error };
  if (!agentInfo.ok) return { ok: false, status: agentInfo.status, error: agentInfo.error };
  if (!toolsResult.ok) return { ok: false, status: toolsResult.status, error: toolsResult.error };

  const effectiveTools = Array.isArray(toolsResult.tools) ? [...toolsResult.tools] : [];
  const effectiveActionMap = new Map(toolsResult.actionMap || []);
  if (
    humanHandoffToolEnabled &&
    !effectiveTools.some((tool) => String(tool?.name || "").trim() === HUMAN_HANDOFF_TOOL_NAME)
  ) {
    effectiveTools.push(HUMAN_HANDOFF_TOOL);
    effectiveActionMap.set(HUMAN_HANDOFF_TOOL_NAME, {
      tool_name: HUMAN_HANDOFF_TOOL_NAME,
      kind: "human_handoff",
      id: null,
      method: "LOCAL",
      url: null,
      headers: {},
      body_template: null,
    });
  }

  const prompt = buildChannelPrompt({
    systemRole: agentInfo.role,
    chunks: ragResult.chunks,
    nowIso: new Date().toISOString(),
    channel: event.channel,
    extraRules: humanHandoffToolEnabled ? HUMAN_HANDOFF_PROMPT_BLOCK : "",
  });

  const historyMessages = Array.isArray(historyResult.messages) ? historyResult.messages : [];
  const userHistoryMessages = historyMessages.filter((m) => m?.role === "user");
  const lastAssistantMessage = [...historyMessages]
    .reverse()
    .find((m) => m?.role === "assistant" && typeof m?.content === "string" && m.content.trim());
  const assistantTail = tailWordsByRatio(lastAssistantMessage?.content || "", 0.2);
  const messages = [
    ...userHistoryMessages,
    ...(assistantTail ? [{ role: "assistant", content: `Recent reply: ${assistantTail}` }] : []),
    { role: "user", content: incomingText },
  ];

  const completionStartedAt = Date.now();
  const completion = await getXAiChatCompletion({
    apiKey: process.env.XAI_API_KEY,
    model: PRIMARY_MODEL,
    instructions: prompt,
    messages,
    tools: effectiveTools,
  });
  latencyMiniMs = Date.now() - completionStartedAt;
  if (!completion.ok) return { ok: false, status: completion.status, error: completion.error };

  let replyRaw = completion.data?.reply ?? "";
  let actionCount = 0;

  if (completion.data?.mode === "actions_needed") {
    const actionCalls = Array.isArray(completion.data?.action_calls) ? completion.data.action_calls : [];
    actionCount = actionCalls.length;

    const toolsStartedAt = Date.now();
    const { toolResults, calendarContext, humanHandoffActivated } =
      await executeActionCalls({
      actionCalls,
      actionMap: effectiveActionMap,
      agentId,
      anonId,
      chatId,
      country: requestCountry,
      source: `meta_${event.channel}`,
      chatSource: event.channel,
      incomingMessage: incomingText,
    });
    latencyToolsMs = Date.now() - toolsStartedAt;

    const assistantBlocks = Array.isArray(completion.output_items) ? completion.output_items : [];
    const followupInputItems = toXAiInputItems(messages, assistantBlocks, toolResults);
    const ticketOutcome = getLatestTicketOutcome({
      toolResults,
      actionMap: effectiveActionMap,
    });
    const followupPrompt = [
      prompt,
      calendarContext ? calendarContextNote(calendarContext) : null,
      buildTicketOutcomeInstruction(ticketOutcome),
      humanHandoffActivated
        ? [
            "HUMAN HANDOFF CONFIRMATION",
            "A human handoff request has been successfully created.",
            "Tell the customer they are now in queue for a human agent.",
            "Invite them to share additional details in the meantime so the human agent has context.",
            "Keep the response concise and clear.",
          ].join("\n")
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const followupStartedAt = Date.now();
    const followup = await getXAiChatCompletion({
      apiKey: process.env.XAI_API_KEY,
      model: FOLLOWUP_MODEL,
      instructions: followupPrompt,
      messages,
      inputItems: followupInputItems,
    });
    latencyNanoMs = Date.now() - followupStartedAt;
    if (!followup.ok) return { ok: false, status: followup.status, error: followup.error };

    replyRaw = followup.data?.reply ?? "";

    const finalReply =
      event.channel === "whatsapp"
        ? formatReplyForWhatsAppText(replyRaw)
        : event.channel === "telegram"
          ? formatReplyForTelegramText(replyRaw)
        : formatReplyForMetaText(replyRaw);
    if (!finalReply) return { ok: false, status: 502, error: "Empty model output" };

    const saveResult = humanHandoffActivated
      ? await saveHumanMessageToMessages({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          agentId,
          anonId,
          chatId,
          country: requestCountry,
          source: `meta_${event.channel}`,
          prompt: null,
          result: finalReply,
        })
      : await saveMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          agentId,
          workspaceId: agentInfo.workspace_id,
          anonId,
          chatId,
          country: requestCountry,
          prompt: incomingText,
          result: finalReply,
          source: `meta_${event.channel}`,
          action: true,
        });
    if (!saveResult.ok) return { ok: false, status: saveResult.status, error: saveResult.error };

    const miniTokens = usageToTokens(completion.usage);
    const nanoTokens = usageToTokens(followup.usage);
    void saveMessageAnalytics({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      agentId,
      workspaceId: agentInfo.workspace_id,
      endpoint: "channels",
      source: `meta_${event.channel}`,
      country: requestCountry,
      anonId,
      chatId,
      modelMini: PRIMARY_MODEL,
      modelNano: FOLLOWUP_MODEL,
      miniInputTokens: miniTokens.input,
      miniOutputTokens: miniTokens.output,
      nanoInputTokens: nanoTokens.input,
      nanoOutputTokens: nanoTokens.output,
      actionUsed: true,
      actionCount,
      ragUsed: Array.isArray(ragResult.chunks) && ragResult.chunks.length > 0,
      ragChunkCount: Array.isArray(ragResult.chunks) ? ragResult.chunks.length : 0,
      statusCode: 200,
      latencyTotalMs: Date.now() - requestStartedAt,
      latencyMiniMs,
      latencyNanoMs,
      latencyToolsMs,
      errorCode: null,
    }).catch(() => {});

    requestSucceeded = true;
    return { ok: true, reply: finalReply, humanHandoff: humanHandoffActivated, actionUsed: true, actionCount };
  }

  const reply =
    event.channel === "whatsapp"
      ? formatReplyForWhatsAppText(replyRaw)
      : event.channel === "telegram"
        ? formatReplyForTelegramText(replyRaw)
      : formatReplyForMetaText(replyRaw);
  if (!reply) return { ok: false, status: 502, error: "Empty model output" };

  const saveResult = await saveMessage({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    workspaceId: agentInfo.workspace_id,
    anonId,
    chatId,
    country: requestCountry,
    prompt: incomingText,
    result: reply,
    source: `meta_${event.channel}`,
    action: false,
  });
  if (!saveResult.ok) return { ok: false, status: saveResult.status, error: saveResult.error };

  const miniTokens = usageToTokens(completion.usage);
  void saveMessageAnalytics({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    workspaceId: agentInfo.workspace_id,
    endpoint: "channels",
    source: `meta_${event.channel}`,
    country: requestCountry,
    anonId,
    chatId,
    modelMini: PRIMARY_MODEL,
    modelNano: FOLLOWUP_MODEL,
    miniInputTokens: miniTokens.input,
    miniOutputTokens: miniTokens.output,
    nanoInputTokens: 0,
    nanoOutputTokens: 0,
    actionUsed: false,
    actionCount: 0,
    ragUsed: Array.isArray(ragResult.chunks) && ragResult.chunks.length > 0,
    ragChunkCount: Array.isArray(ragResult.chunks) ? ragResult.chunks.length : 0,
    statusCode: 200,
    latencyTotalMs: Date.now() - requestStartedAt,
    latencyMiniMs,
    latencyNanoMs: null,
    latencyToolsMs: null,
    errorCode: null,
  }).catch(() => {});

  requestSucceeded = true;
  return { ok: true, reply, actionUsed: false, actionCount: 0 };
  } finally {
    if (consumedExtraCreditRowId !== null && !requestSucceeded) {
      await refundExtraMessageCredit({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        rowId: consumedExtraCreditRowId,
      }).catch(() => {});
    }
  }
}
module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const mode = String(req.query["hub.mode"] || "");
      const token = String(req.query["hub.verify_token"] || "");
      const challenge = req.query["hub.challenge"];
      const expectedToken = String(process.env.META_WEBHOOK_VERIFY_TOKEN || "");
      if (mode === "subscribe" && expectedToken && token === expectedToken) {
        res.status(200).send(String(challenge || ""));
        return;
      }
      res.status(403).json({ error: "Invalid verify token" });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const payload = req.body ?? {};
    const objectType = String(payload?.object || "").toLowerCase();
    const isTelegramPayload =
      Number.isFinite(Number(payload?.update_id)) ||
      payload?.message ||
      payload?.edited_message ||
      payload?.callback_query;
    if (isTelegramPayload) {
      const expectedTelegramSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
      if (expectedTelegramSecret) {
        const actualTelegramSecret = String(
          req?.headers?.["x-telegram-bot-api-secret-token"] || ""
        ).trim();
        if (!actualTelegramSecret || actualTelegramSecret !== expectedTelegramSecret) {
          await insertMetaWebhookDebugMessage({
            supId: process.env.SUP_ID,
            supKey: process.env.SUP_KEY,
            event: {
              object: "telegram",
              field: "",
              lookupId: "",
              senderId: "",
              recipientId: "",
              messageId: "",
              text: "",
            },
            raw: { stage: "telegram_secret_failed" },
          });
          res.status(403).json({ error: "Invalid telegram secret" });
          return;
        }
      }
    }
    const shouldVerifyMetaSignature =
      objectType === "page" || objectType === "instagram" || objectType === "whatsapp_business_account";
    if (shouldVerifyMetaSignature) {
      const signature = await verifyMetaWebhookSignature(req);
      if (!signature.ok) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event: {
            object: String(req?.body?.object || ""),
            field: "",
            lookupId: "",
            senderId: "",
            recipientId: "",
            messageId: "",
            text: "",
          },
          raw: { stage: "signature_failed", reason: signature.reason },
        });
        res.status(403).json({ error: "Invalid webhook signature" });
        return;
      }
    }

    const events = toWebhookEvents(payload);
    if (events.length === 0) {
      res.status(200).json({ ok: true, processed: 0 });
      return;
    }

    const connectionCache = new Map();
    const processedEventIds = new Set();
    let processedCount = 0;

    for (const event of events) {
      if (event.eventId && processedEventIds.has(event.eventId)) continue;
      if (event.eventId) processedEventIds.add(event.eventId);

      if (isTelegramPayload) {
        const queryAgentIdRaw =
          req?.query?.telegram_agent_id ?? req?.query?.agent_id ?? req?.query?.telegramAgentId;
        const queryAgentId = Array.isArray(queryAgentIdRaw)
          ? String(queryAgentIdRaw[0] || "").trim()
          : String(queryAgentIdRaw || "").trim();
        event.lookupId = queryAgentId;
      }

      await insertMetaWebhookDebugMessage({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        event,
        raw: {
          stage: "received",
          channel: event.channel,
          lookup_id: event.lookupId,
          webhook_object: payload?.object ?? null,
          raw_item: event.rawItem ?? null,
        },
      });

      const cacheKey = `${event.channel}:${event.lookupId}`;
      let connectionResult = connectionCache.get(cacheKey);
      if (!connectionResult) {
        connectionResult = await fetchChannelConnection({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          channel: event.channel,
          lookupId: event.lookupId,
        });
        connectionCache.set(cacheKey, connectionResult);
      }
      if (!connectionResult?.ok) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "page_lookup_failed",
            channel: event.channel,
            lookup_id: event.lookupId,
            status: connectionResult?.status ?? null,
            error: connectionResult?.error ?? "Unknown page lookup error",
          },
        });
        continue;
      }
      await insertMetaWebhookDebugMessage({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        event,
        raw: {
          stage: "page_lookup_ok",
          channel: event.channel,
          lookup_id: event.lookupId,
          agent_id: connectionResult.connection?.agent_id ?? null,
          connection_kind: connectionResult.connection?.kind ?? null,
          thread_id: connectionResult.connection?.thread_id ?? null,
        },
      });

      if (connectionResult.connection?.kind === "telegram") {
        const securityEnabled = Boolean(connectionResult.connection.security_enabled);
        if (securityEnabled) {
          const chatIdStr = String(event.recipientId || "").trim();
          const allowedUsers = normalizeJsonArray(connectionResult.connection.allowed_chat_users);
          const pendingRequests = normalizeJsonArray(connectionResult.connection.pending_access_requests);
          const isAllowed = allowedUsers.some(
            (item) => String(item?.chat_id || "").trim() === chatIdStr
          );
          const startIdentifier = extractTelegramStartIdentifier(event.text);
          const isStartCommand = /^\/start(?:@\w+)?(?:\s+.+)?$/i.test(String(event.text || "").trim());

          if (isStartCommand && !isAllowed) {
            const telegramFrom =
              event?.rawItem?.message?.from ||
              event?.rawItem?.edited_message?.from ||
              event?.rawItem?.callback_query?.from ||
              {};
            const requestItem = {
              chat_id: chatIdStr,
              identifier: startIdentifier,
              username: String(telegramFrom?.username || ""),
              first_name: String(telegramFrom?.first_name || ""),
              last_name: String(telegramFrom?.last_name || ""),
              requested_at: new Date().toISOString(),
            };
            const nextPending = [
              ...pendingRequests.filter(
                (item) => String(item?.chat_id || "").trim() !== chatIdStr
              ),
              requestItem,
            ];
            await updateTelegramPendingRequests({
              supId: process.env.SUP_ID,
              supKey: process.env.SUP_KEY,
              agentId: connectionResult.connection.agent_id,
              pendingAccessRequests: nextPending,
            });
            connectionResult.connection.pending_access_requests = nextPending;
          }

          let securityReply = "";
          if (isStartCommand) {
            securityReply = isAllowed
              ? "You are already approved. Your Telegram connection is active."
              : "Access request submitted. Please wait for approval from the admin.";
          } else if (!isAllowed) {
            securityReply = "You are not approved yet. Send /start YourName to request access.";
          }

          if (securityReply) {
            const tgSecuritySend = await sendTelegramTextReply({
              botToken: connectionResult.connection.bot_token,
              chatId: chatIdStr,
              text: securityReply,
            });
            await insertMetaWebhookDebugMessage({
              supId: process.env.SUP_ID,
              supKey: process.env.SUP_KEY,
              event,
              raw: tgSecuritySend.ok
                ? {
                    stage: "telegram_security_reply_sent",
                    channel: event.channel,
                    recipient_id: chatIdStr,
                    security_enabled: true,
                    allowed: isAllowed,
                  }
                : {
                    stage: "telegram_security_reply_failed",
                    channel: event.channel,
                    recipient_id: chatIdStr,
                    security_enabled: true,
                    allowed: isAllowed,
                    status: tgSecuritySend?.status ?? null,
                    error: tgSecuritySend?.error ?? "Unknown telegram security send error",
                  },
            });
            if (tgSecuritySend.ok) processedCount += 1;
            continue;
          }
        }
      }

      const typingStartedAt = Date.now();
      const shouldUseTelegramTyping = connectionResult.connection?.kind === "telegram";
      if (shouldUseTelegramTyping) {
        const tgTypingResult = await sendTelegramChatAction({
          botToken: connectionResult.connection.bot_token,
          chatId: event.recipientId,
          action: "typing",
        });
        if (!tgTypingResult.ok) {
          await insertMetaWebhookDebugMessage({
            supId: process.env.SUP_ID,
            supKey: process.env.SUP_KEY,
            event,
            raw: {
              stage: "telegram_typing_failed",
              channel: event.channel,
              recipient_id: event.recipientId,
              status: tgTypingResult?.status ?? null,
              error: tgTypingResult?.error ?? "Unknown telegram typing error",
            },
          });
        }
      }
      if (connectionResult.connection?.kind === "telegram" && event.telegramAudio?.fileId) {
        const transcriptionResult = await transcribeTelegramAudioMessage({
          botToken: connectionResult.connection.bot_token,
          audio: event.telegramAudio,
          event,
        });
        if (transcriptionResult.ok) {
          event.text = transcriptionResult.text;
          await insertMetaWebhookDebugMessage({
            supId: process.env.SUP_ID,
            supKey: process.env.SUP_KEY,
            event,
            raw: {
              stage: "telegram_voice_transcribed",
              channel: event.channel,
              audio_kind: event.telegramAudio.kind,
              duration: event.telegramAudio.duration,
              file_size: event.telegramAudio.fileSize,
              transcript_length: String(transcriptionResult.text || "").length,
            },
          });
        } else {
          await insertMetaWebhookDebugMessage({
            supId: process.env.SUP_ID,
            supKey: process.env.SUP_KEY,
            event,
            raw: {
              stage: "telegram_voice_transcription_failed",
              channel: event.channel,
              audio_kind: event.telegramAudio.kind,
              duration: event.telegramAudio.duration,
              file_size: event.telegramAudio.fileSize,
              status: transcriptionResult?.status ?? null,
              error: transcriptionResult?.error ?? "Unknown Telegram voice transcription error",
            },
          });
          const tgVoiceFailureSend = await sendTelegramTextReply({
            botToken: connectionResult.connection.bot_token,
            chatId: event.recipientId,
            text: "I couldn't transcribe that voice message. Please send it as text.",
          });
          if (tgVoiceFailureSend.ok) processedCount += 1;
          continue;
        }
      }
      if (connectionResult.connection?.kind === "whatsapp") {
        const readStatusResult = await sendWhatsAppReadStatus({
          accessToken: connectionResult.connection.access_token,
          phoneNumberId: connectionResult.connection.phone_number_id,
          messageId: event.messageId,
        });
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: readStatusResult.ok
            ? {
                stage: "whatsapp_read_ok",
                channel: event.channel,
                message_id: event.messageId,
              }
            : {
                stage: "whatsapp_read_failed",
                channel: event.channel,
                message_id: event.messageId,
                status: readStatusResult?.status ?? null,
                error: readStatusResult?.error ?? "Unknown WhatsApp read status error",
              },
        });
      }

      const shouldUseMetaTyping = connectionResult.connection?.kind === "meta";
      const typingOnResult = shouldUseMetaTyping
        ? await sendMetaSenderAction({
            pageAccessToken: connectionResult.connection.access_token,
            recipientId: event.senderId,
            action: "typing_on",
          })
        : { ok: false, status: null, error: "typing_not_supported_for_channel" };
      if (shouldUseMetaTyping && !typingOnResult.ok) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "typing_on_failed",
            channel: event.channel,
            recipient_id: event.senderId,
            status: typingOnResult?.status ?? null,
            error: typingOnResult?.error ?? "Unknown typing_on error",
          },
        });
      }
      const typingOnOk = Boolean(typingOnResult.ok);
      const stopTypingHeartbeat = typingOnOk
        ? startTypingHeartbeat({
            pageAccessToken: connectionResult.connection.access_token,
            recipientId: event.senderId,
          })
        : null;

      const handled = await processIncomingMessage({
        event,
        connection: connectionResult.connection,
        headers: req.headers,
      });
      if (!handled.ok) {
        if (typingOnOk && META_MIN_TYPING_MS > 0) {
          const elapsed = Date.now() - typingStartedAt;
          const waitMs = META_MIN_TYPING_MS - elapsed;
          if (waitMs > 0) await sleep(waitMs);
        }
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "handle_failed",
            channel: event.channel,
            status: handled?.status ?? null,
            error: handled?.error ?? "Unknown processing error",
          },
        });
        if (typeof stopTypingHeartbeat === "function") {
          await stopTypingHeartbeat();
        } else if (shouldUseMetaTyping) {
          const typingOffResult = await sendMetaSenderAction({
            pageAccessToken: connectionResult.connection.access_token,
            recipientId: event.senderId,
            action: "typing_off",
          });
          if (!typingOffResult.ok) {
            await insertMetaWebhookDebugMessage({
              supId: process.env.SUP_ID,
              supKey: process.env.SUP_KEY,
              event,
              raw: {
                stage: "typing_off_failed",
                channel: event.channel,
                recipient_id: event.senderId,
                status: typingOffResult?.status ?? null,
                error: typingOffResult?.error ?? "Unknown typing_off error",
              },
            });
          }
        }
        continue;
      }
      if (handled.humanHandoff && !handled.reply) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "human_handoff_active",
            channel: event.channel,
            chat_id: `${event.channel}:${connectionResult.connection.thread_id}:${event.senderId}`,
          },
        });
        if (typeof stopTypingHeartbeat === "function") {
          await stopTypingHeartbeat();
        } else if (shouldUseMetaTyping) {
          const typingOffResult = await sendMetaSenderAction({
            pageAccessToken: connectionResult.connection.access_token,
            recipientId: event.senderId,
            action: "typing_off",
          });
          if (!typingOffResult.ok) {
            await insertMetaWebhookDebugMessage({
              supId: process.env.SUP_ID,
              supKey: process.env.SUP_KEY,
              event,
              raw: {
                stage: "typing_off_failed",
                channel: event.channel,
                recipient_id: event.senderId,
                status: typingOffResult?.status ?? null,
                error: typingOffResult?.error ?? "Unknown typing_off error",
              },
            });
          }
        }
        processedCount += 1;
        continue;
      }

      await insertMetaWebhookDebugMessage({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        event,
        raw: {
          stage: "reply_generated",
          channel: event.channel,
          reply: handled.reply ?? "",
          action_used: Boolean(handled.actionUsed),
          action_count: Number(handled.actionCount || 0),
        },
      });

      if (typingOnOk && META_MIN_TYPING_MS > 0) {
        const elapsed = Date.now() - typingStartedAt;
        const waitMs = META_MIN_TYPING_MS - elapsed;
        if (waitMs > 0) await sleep(waitMs);
      }

      const sendResult =
        connectionResult.connection?.kind === "whatsapp"
          ? await sendWhatsAppTextReply({
              accessToken: connectionResult.connection.access_token,
              phoneNumberId: connectionResult.connection.phone_number_id,
              recipientId: event.senderId,
              text: handled.reply,
            })
          : connectionResult.connection?.kind === "telegram"
            ? await sendTelegramTextReply({
                botToken: connectionResult.connection.bot_token,
                chatId: event.recipientId,
                text: handled.reply,
              })
          : await sendMetaTextReply({
              pageAccessToken: connectionResult.connection.access_token,
              recipientId: event.senderId,
              text: handled.reply,
            });
      if (sendResult.ok) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "send_ok",
            channel: event.channel,
            recipient_id: event.senderId,
            action_used: Boolean(handled.actionUsed),
            action_count: Number(handled.actionCount || 0),
          },
        });
        processedCount += 1;
      } else {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "send_failed",
            channel: event.channel,
            recipient_id: event.senderId,
            status: sendResult?.status ?? null,
            error: sendResult?.error ?? "Unknown send error",
          },
        });
      }

      if (typeof stopTypingHeartbeat === "function") {
        await stopTypingHeartbeat();
      } else if (shouldUseMetaTyping) {
        const typingOffResult = await sendMetaSenderAction({
          pageAccessToken: connectionResult.connection.access_token,
          recipientId: event.senderId,
          action: "typing_off",
        });
        if (!typingOffResult.ok) {
          await insertMetaWebhookDebugMessage({
            supId: process.env.SUP_ID,
            supKey: process.env.SUP_KEY,
            event,
            raw: {
              stage: "typing_off_failed",
              channel: event.channel,
              recipient_id: event.senderId,
              status: typingOffResult?.status ?? null,
              error: typingOffResult?.error ?? "Unknown typing_off error",
            },
          });
        }
      }
    }

    res.status(200).json({ ok: true, processed: processedCount });
  } catch (error) {
    await insertMetaWebhookDebugMessage({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      event: {
        object: String(req?.body?.object || ""),
        field: "",
        lookupId: "",
        senderId: "",
        recipientId: "",
        messageId: "",
        text: "",
      },
      raw: {
        stage: "handler_exception",
        error: String(error?.message || error || "Unknown error"),
      },
    });
    res.status(200).json({
      ok: true,
      processed: 0,
      error: String(error?.message || error || "Unknown error"),
    });
  }
};
