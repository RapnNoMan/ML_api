const {
  checkMessageCap,
  refundExtraMessageCredit,
} = require("../../scripts/internal/checkMessageCap");
const { checkWidgetEmbedEnabled } = require("../../scripts/internal/checkWidgetEmbedEnabled");
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

const XAI_RESPONSES_API_URL = "https://api.x.ai/v1/responses";
const PRIMARY_MODEL = process.env.XAI_PRIMARY_MODEL || "grok-4-1-fast-non-reasoning";
const FOLLOWUP_MODEL = process.env.XAI_FOLLOWUP_MODEL || PRIMARY_MODEL;

function toTextBlocks(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item?.type === "text" && typeof item?.text === "string") {
          return { type: "text", text: item.text };
        }
        if (typeof item === "string") {
          return { type: "text", text: item };
        }
        return null;
      })
      .filter(Boolean);
  }

  const text = String(content ?? "");
  return [{ type: "text", text }];
}

function toAnthropicMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    return {
      role,
      content: toTextBlocks(message?.content),
    };
  });
}

function toOpenAiInputItems(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const text = String(message?.content ?? "");
    return {
      type: "message",
      role,
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        },
      ],
    };
  });
}

function parseFixedOffsetMinutes(timeZone) {
  if (typeof timeZone !== "string") return null;
  const match = timeZone.trim().match(/^GMT([+-])(\d{2}):(\d{2})$/i);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return sign * (hours * 60 + minutes);
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
  if (timeZone) {
    return parseLocalToUtcIso(trimmed, timeZone);
  }
  return `${trimmed}Z`;
}

function addMinutesToRfc3339(value, minutes) {
  if (typeof value !== "string") return value;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  const ms = Number(minutes) * 60 * 1000;
  const next = new Date(ts + ms);
  return next.toISOString();
}

function getHourInTimeZone(isoValue, timeZone) {
  if (typeof isoValue !== "string") return null;
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return null;
  const fixedOffset = parseFixedOffsetMinutes(timeZone);
  if (fixedOffset !== null) {
    const local = new Date(date.getTime() + fixedOffset * 60000);
    return local.getUTCHours();
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      hour: "2-digit",
      hour12: false,
    });
    const hourText = formatter.format(date);
    const hour = Number(hourText);
    return Number.isFinite(hour) ? hour : null;
  } catch {
    return null;
  }
}

function getMinuteInTimeZone(isoValue, timeZone) {
  if (typeof isoValue !== "string") return null;
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return null;
  const fixedOffset = parseFixedOffsetMinutes(timeZone);
  if (fixedOffset !== null) {
    const local = new Date(date.getTime() + fixedOffset * 60000);
    return local.getUTCMinutes();
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      minute: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const minutePart = parts.find((p) => p.type === "minute");
    const minute = Number(minutePart?.value);
    return Number.isFinite(minute) ? minute : null;
  } catch {
    return null;
  }
}

function normalizeIdValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text;
}

function sanitizeIncomingUserText(value) {
  const raw = String(value || "").replace(/\0/g, "");
  const trimmed = raw.trim();
  const maxLen = 800;
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(-maxLen);
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
    Object.prototype.hasOwnProperty.call(node, "additionalProperties") ||
    Object.prototype.hasOwnProperty.call(node, "oneOf") ||
    Object.prototype.hasOwnProperty.call(node, "anyOf") ||
    Object.prototype.hasOwnProperty.call(node, "allOf")
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

  if (pathParts.length === 1 && variables && typeof variables === "object") {
    const leafKey = pathParts[0];
    if (leafKey in variables) return variables[leafKey];
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

  if (Array.isArray(template)) {
    return template.map((item) => renderTemplateValue(item, variables));
  }

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
  if (!schema || typeof schema !== "object") {
    return lookupTemplateValue(source, pathParts);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === "object" || schema.properties) {
    const properties =
      schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const result = {};

    for (const [key, childSchema] of Object.entries(properties)) {
      const value = materializeSchemaNode(childSchema, source, [...pathParts, key]);
      if (value !== undefined) {
        result[key] = value;
      }
    }

    if (Object.keys(result).length > 0) return result;

    const directObject = lookupTemplateValue(source, pathParts);
    if (directObject && typeof directObject === "object") {
      return directObject;
    }

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

  if (typeof parsedTemplate === "string") {
    return renderTemplateValue(parsedTemplate, variables);
  }

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
    if (value === undefined || value === null || value === "") {
      missing.push(field);
    }
  }

  return missing;
}

function sanitizeToolName(rawName, id, usedNames) {
  let name = String(rawName || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!name) name = `action_${id}`;
  if (/^[0-9]/.test(name)) name = `action_${name}`;

  if (name.length > 64) name = name.slice(0, 64);

  if (usedNames.has(name)) {
    const suffix = `_${id}`;
    const base = name.slice(0, Math.max(1, 64 - suffix.length));
    name = `${base}${suffix}`;
  }

  usedNames.add(name);
  return name;
}

async function fetchCustomButtonActionRows({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/custom_button_actions?select=id,title,description,url,label,button_color,text_color&agent_id=eq.${agentId}`;

  try {
    const response = await fetch(url, {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return { ok: false, status: 502, error: "Actions service unavailable" };
    }

    const payload = await response.json();
    return { ok: true, rows: Array.isArray(payload) ? payload : [] };
  } catch (_) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }
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

function parseAgentIdFromRequest(req) {
  const value = req?.query?.agent_id;
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

function getOriginHost(headers) {
  const originRaw = headers?.origin;
  if (!originRaw || typeof originRaw !== "string") return "";
  try {
    return String(new URL(originRaw).hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function isAllowedWidgetOriginHost(host) {
  return host === "app.mitsolab.com" || host === "www.app.mitsolab.com";
}

function setWidgetCorsHeaders(req, res) {
  const originRaw = typeof req?.headers?.origin === "string" ? req.headers.origin : "";
  const originHost = getOriginHost(req?.headers);
  if (originRaw && isAllowedWidgetOriginHost(originHost)) {
    res.setHeader("Access-Control-Allow-Origin", originRaw);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

  return originAllowed || refererAllowed;
}

function usageToTokens(usage) {
  const toFinite = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const pickMax = (values) => values.reduce((max, value) => Math.max(max, toFinite(value)), 0);

  const directInput = pickMax([
    usage?.input_tokens,
    usage?.prompt_tokens,
    usage?.input_text_tokens,
    usage?.prompt_token_count,
    usage?.input_token_count,
  ]);
  const directOutput = pickMax([
    usage?.output_tokens,
    usage?.completion_tokens,
    usage?.output_text_tokens,
    usage?.completion_token_count,
    usage?.output_token_count,
  ]);
  const cachedInput = pickMax([
    usage?.cache_read_input_tokens,
    usage?.cached_input_tokens,
    usage?.input_cached_tokens,
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.input_tokens_details?.cached_tokens,
  ]);
  const reasoningOutput = pickMax([
    usage?.reasoning_tokens,
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.reasoning_tokens,
  ]);

  const input = directInput + cachedInput;
  const output = directOutput + reasoningOutput;
  return {
    input: Number.isFinite(input) && input > 0 ? Math.floor(input) : 0,
    output: Number.isFinite(output) && output > 0 ? Math.floor(output) : 0,
  };
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
    }
  }
  return blocks;
}

function normalizeAnthropicInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const normalized = {};
  const rawType = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (typeof rawType === "string" && rawType) {
    normalized.type = rawType;
  }
  if (typeof schema.description === "string" && schema.description.trim()) {
    normalized.description = schema.description.trim();
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    normalized.enum = [...schema.enum];
  }

  const isObjectLike = normalized.type === "object" || schema.properties;
  if (isObjectLike) {
    normalized.type = "object";
    normalized.additionalProperties = false;
    const rawProperties =
      schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const properties = {};
    for (const [key, value] of Object.entries(rawProperties)) {
      properties[key] = normalizeAnthropicInputSchema(value);
    }
    normalized.properties = properties;
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      normalized.required = schema.required.filter(
        (item) => typeof item === "string" && item.trim()
      );
    }
    return normalized;
  }

  const isArrayLike = normalized.type === "array" || schema.items;
  if (isArrayLike) {
    normalized.type = "array";
    normalized.items = normalizeAnthropicInputSchema(
      schema.items && typeof schema.items === "object" ? schema.items : { type: "string" }
    );
    return normalized;
  }

  if (!normalized.type) {
    normalized.type = "string";
  }

  return normalized;
}

function toAnthropicTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool?.name ?? "",
    description: tool?.description ?? "",
    strict: true,
    input_schema: normalizeAnthropicInputSchema(tool?.parameters),
  }));
}

function buildAnthropicMessages({ messages, assistantBlocks, toolResults }) {
  const finalMessages = [...toAnthropicMessages(messages)];

  if (Array.isArray(assistantBlocks) && assistantBlocks.length > 0) {
    finalMessages.push({
      role: "assistant",
      content: assistantBlocks,
    });
  }

  if (Array.isArray(toolResults) && toolResults.length > 0) {
    finalMessages.push({
      role: "user",
      content: toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.call_id,
        content: JSON.stringify(result),
      })),
    });
  }

  return finalMessages;
}

function createCompletionRequestBody({
  model,
  instructions,
  messages,
  tools,
  assistantBlocks,
  toolResults,
  maxTokens = 1024,
}) {
  const systemRules = `
TOOL RULES (MUST FOLLOW):
- Use the provided tools when needed.
- Never make the tool call without having the full info from the user.
- Never call a tool unless every required parameter is present in the tool input.
- If a tool is needed, call it before any user-facing answer text.
`.trim();

  const finalInstructions = [systemRules, String(instructions || "")].filter(Boolean).join("\n\n");
  const requestBody = {
    model,
    system: finalInstructions,
    messages: buildAnthropicMessages({
      messages,
      assistantBlocks,
      toolResults,
    }),
    max_tokens: maxTokens,
    stream: true,
  };

  if (Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = toAnthropicTools(tools);
    requestBody.tool_choice = { type: "auto" };
  }

  return requestBody;
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
        arguments: JSON.stringify(
          item?.input && typeof item.input === "object" ? item.input : {}
        ),
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

async function getChatCompletionStream({
  apiKey,
  model,
  instructions,
  messages,
  tools,
  assistantBlocks,
  toolResults,
  signal,
  onTextDelta,
}) {
  return getXAiChatCompletionStream({
    apiKey,
    model,
    instructions,
    tools,
    inputItems: toXAiInputItems(messages, assistantBlocks, toolResults),
    signal,
    onTextDelta,
  });
}

async function getChatCompletion({
  apiKey,
  model,
  instructions,
  messages,
  tools,
  assistantBlocks,
  toolResults,
}) {
  return getXAiChatCompletion({
    apiKey,
    model,
    instructions,
    tools,
    inputItems: toXAiInputItems(messages, assistantBlocks, toolResults),
  });
}

function createOpenAiCompletionRequestBody({
  model,
  reasoning,
  instructions,
  messages,
  tools,
  inputItems,
}) {
  const systemRules = `
TOOL RULES (MUST FOLLOW):
- Use the provided tools when needed.
- Never make the tool call without having the full info from the user.
- If a tool is needed, call it before any user-facing answer text.
`.trim();

  const finalInstructions = [systemRules, String(instructions || "")].filter(Boolean).join("\n\n");
  const requestBody = {
    model,
    reasoning,
    instructions: finalInstructions,
    input: Array.isArray(inputItems) ? inputItems : toOpenAiInputItems(messages),
    text: { verbosity: "low" },
    stream: true,
  };

  if (Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = "auto";
  }

  return requestBody;
}

function parseOpenAiSseEventBlock(block) {
  const lines = String(block || "").split("\n");
  const dataLines = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { done: true };
  try {
    return { done: false, payload: JSON.parse(dataText) };
  } catch (_) {
    return null;
  }
}

async function getXAiChatCompletionStream({
  apiKey,
  model,
  reasoning,
  instructions,
  messages,
  tools,
  inputItems,
  signal,
  onTextDelta,
}) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const requestBody = createOpenAiCompletionRequestBody({
    model,
    reasoning,
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
      signal,
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

  if (!response.body) {
    return { ok: false, status: 502, error: "Missing stream body from xAI" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembledText = "";
  let finalResponse = null;
  const outputItems = [];
  let upstreamError = null;
  let done = false;

  while (!done) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (_) {
      return { ok: false, status: 502, error: "Stream read error from xAI" };
    }
    done = Boolean(chunk?.done);
    if (chunk?.value) {
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let delimiterIdx = buffer.indexOf("\n\n");
      while (delimiterIdx !== -1) {
        const block = buffer.slice(0, delimiterIdx);
        buffer = buffer.slice(delimiterIdx + 2);
        const evt = parseOpenAiSseEventBlock(block);
        if (evt?.done) {
          done = true;
          break;
        }
        if (!evt?.payload) {
          delimiterIdx = buffer.indexOf("\n\n");
          continue;
        }

        const payload = evt.payload;
        if (payload?.type === "response.output_text.delta" && typeof payload?.delta === "string") {
          assembledText += payload.delta;
          if (typeof onTextDelta === "function") {
            await onTextDelta(payload.delta);
          }
        } else if (payload?.type === "response.output_item.done" && payload?.item) {
          outputItems.push(payload.item);
        } else if (payload?.type === "response.completed" && payload?.response) {
          finalResponse = payload.response;
        } else if (payload?.type === "response.failed") {
          upstreamError =
            payload?.response?.error?.message ||
            payload?.error?.message ||
            "xAI streaming failed";
        }

        delimiterIdx = buffer.indexOf("\n\n");
      }
    }
  }

  if (upstreamError) {
    return { ok: false, status: 502, error: upstreamError };
  }

  const payload = finalResponse || { output: outputItems };
  const finalOutputItems = Array.isArray(payload?.output) ? payload.output : outputItems;
  const toolCalls = extractFunctionCalls(payload, finalOutputItems);
  const assistantBlocks = extractAssistantBlocks(payload, finalOutputItems);
  const rawText =
    typeof payload?.output_text === "string" && payload.output_text.trim()
      ? payload.output_text
      : (extractResponseText(payload) || assembledText);

  if (toolCalls.length > 0) {
    return {
      ok: true,
      data: {
        mode: "actions_needed",
        reply: "",
        action_calls: toolCalls,
      },
      usage: payload?.usage ?? null,
      raw: "",
      output_items: assistantBlocks,
    };
  }

  if (!rawText) {
    return { ok: false, status: 502, error: "Empty model output" };
  }

  return {
    ok: true,
    data: {
      mode: "reply",
      reply: rawText,
      action_calls: [],
    },
    usage: payload?.usage ?? null,
    raw: rawText,
    output_items: assistantBlocks,
  };
}

async function getXAiChatCompletion({
  apiKey,
  model,
  reasoning,
  instructions,
  messages,
  tools,
  inputItems,
}) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const requestBody = createOpenAiCompletionRequestBody({
    model,
    reasoning,
    instructions,
    messages,
    tools,
    inputItems,
  });
  requestBody.stream = false;

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

  const toolCalls = extractFunctionCalls(payload);
  const assistantBlocks = extractAssistantBlocks(payload);
  if (toolCalls.length > 0) {
    return {
      ok: true,
      data: {
        mode: "actions_needed",
        reply: "",
        action_calls: toolCalls,
      },
      usage: payload?.usage ?? null,
      raw: "",
      output_items: assistantBlocks,
    };
  }

  const rawText = extractResponseText(payload);
  if (!rawText) return { ok: false, status: 502, error: "Empty model output" };

  return {
    ok: true,
    data: {
      mode: "reply",
      reply: rawText,
      action_calls: [],
    },
    usage: payload?.usage ?? null,
    raw: rawText,
    output_items: assistantBlocks,
  };
}

function sendSseEvent(res, event, payload) {
  if (res.writableEnded) return false;
  try {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  let consumedExtraCreditRowId = null;
  let requestSucceeded = false;
  try {
    setWidgetCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      const originHost = getOriginHost(req.headers);
      if (!isAllowedWidgetOriginHost(originHost)) {
        res.status(403).json({ error: "Forbidden origin" });
        return;
      }
      res.status(204).end();
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

  const requestStartedAt = Date.now();
  let latencyMiniMs = null;
  let latencyNanoMs = null;
  let latencyToolsMs = null;

  const body = req.body ?? {};
  const incomingMessage = sanitizeIncomingUserText(body.message);
  const acceptHeader = String(req?.headers?.accept || "").toLowerCase();
  const hasExplicitStreamFlag =
    body && Object.prototype.hasOwnProperty.call(body, "stream");
  const wantsStream =
    body?.stream === true ||
    body?.stream === "true" ||
    (!hasExplicitStreamFlag && acceptHeader.includes("text/event-stream"));
  const requestCountry = getRequestCountry(req.headers);
  const agentId = parseAgentIdFromRequest(req);
  const missing = [];
  if (!agentId) missing.push("agent_id (path)");
  if (!body.message) missing.push("message");
  if (!normalizeIdValue(body.anon_id)) missing.push("anon_id");
  if (!normalizeIdValue(body.chat_id)) missing.push("chat_id");

  if (missing.length > 0) {
    res.status(400).json({
      error: "Missing required fields",
      missing,
    });
    return;
  }

  const widgetEnabled = await checkWidgetEmbedEnabled({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  if (!widgetEnabled.ok) {
    res.status(widgetEnabled.status).json({ error: widgetEnabled.error });
    return;
  }

  if (!isAllowedWidgetCaller(req.headers)) {
    res.status(403).json({ error: "Forbidden origin" });
    return;
  }

  const anonId = normalizeIdValue(body.anon_id);
  const chatId = normalizeIdValue(body.chat_id);

  const spamGuardResult = await evaluateAnonSpamAndMaybeBan({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    xaiApiKey: process.env.XAI_API_KEY,
    xaiModel: process.env.XAI_SPAM_MODEL || process.env.XAI_PRIMARY_MODEL,
    agentId,
    anonId,
    incomingMessage,
  });
  if (!spamGuardResult.ok) {
    res.status(spamGuardResult.status || 502).json({ error: spamGuardResult.error || "Spam guard failed" });
    return;
  }
  if (spamGuardResult.banned) {
    res.status(403).json({ error: "User is banned" });
    return;
  }

  const usageCheck = await checkMessageCap({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  if (!usageCheck.ok) {
    res.status(usageCheck.status).json({ error: usageCheck.error });
    return;
  }
  const usageCheckExtraCreditRowId = Number(usageCheck?.extraCreditRowId);
  if (Number.isFinite(usageCheckExtraCreditRowId) && usageCheckExtraCreditRowId > 0) {
    consumedExtraCreditRowId = Math.floor(usageCheckExtraCreditRowId);
  }

  const normalizedMessage = String(incomingMessage)
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,!?(){}\[\]<>-]+|[\s"'`.,!?(){}\[\]<>-]+$/g, "")
    .replace(/\s+/g, " ");
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
          message: incomingMessage,
        })
      : Promise.resolve({ ok: true, chunks: [] });

  const historyPromise =
    anonId && chatId
      ? getChatHistory({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          agentId,
          anonId,
          chatId,
          maxRows: 3,
        })
      : Promise.resolve({ ok: true, messages: [] });

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
  const customButtonRowsPromise = fetchCustomButtonActionRows({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });

  const [vectorResult, historyResult, agentInfo, toolsResult, customButtonRowsResult] = await Promise.all([
    ragPromise,
    historyPromise,
    agentInfoPromise,
    toolsResultPromise,
    customButtonRowsPromise,
  ]);
  if (!vectorResult.ok) {
    res.status(vectorResult.status).json({ error: vectorResult.error });
    return;
  }
  if (!historyResult.ok) {
    res.status(historyResult.status).json({ error: historyResult.error });
    return;
  }
  if (!agentInfo.ok) {
    res.status(agentInfo.status).json({ error: agentInfo.error });
    return;
  }
  if (!toolsResult.ok) {
    res.status(toolsResult.status).json({ error: toolsResult.error });
    return;
  }
  if (!customButtonRowsResult.ok) {
    res.status(customButtonRowsResult.status).json({ error: customButtonRowsResult.error });
    return;
  }

  const effectiveTools = Array.isArray(toolsResult.tools) ? [...toolsResult.tools] : [];
  const effectiveActionMap = new Map(toolsResult.actionMap || []);
  const usedToolNames = new Set(
    effectiveTools
      .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
      .filter(Boolean)
  );
  const customButtonRows = Array.isArray(customButtonRowsResult.rows)
    ? customButtonRowsResult.rows
    : [];
  for (const row of customButtonRows) {
    const toolName = sanitizeToolName(row?.title, row?.id, usedToolNames);
    const rawTitle = typeof row?.title === "string" ? row.title.trim() : "";
    const rawDescription = typeof row?.description === "string" ? row.description.trim() : "";
    const description =
      [rawTitle, rawDescription].filter(Boolean).join(" - ") ||
      "Show a custom button to the user.";

    effectiveTools.push({
      type: "function",
      name: toolName,
      description,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });

    effectiveActionMap.set(toolName, {
      tool_name: toolName,
      id: row?.id ?? null,
      title: row?.title ?? "",
      description,
      url: row?.url ?? "",
      method: "LOCAL",
      headers: {},
      body_template: null,
      kind: "custom_button",
      button_payload: {
        url: row?.url ?? "",
        label: row?.label ?? "",
        title: row?.title ?? "",
        button_color: row?.button_color ?? "#111827",
        text_color: row?.text_color ?? "#ffffff",
      },
    });
  }

  const systemPrompt = typeof agentInfo.role === "string" ? agentInfo.role.trim() : "";
  const promptSections = [];
  if (systemPrompt) promptSections.push(systemPrompt);
  promptSections.push(
    [
      "SYSTEM RULES",
      "Do not claim to perform actions you cannot execute; only offer actions available in the tool list.",
      "Do not invent, assume, or promise capabilities, automations, or future actions that are not explicitly available and executed.",
    ].join("\n")
  );
  const now = new Date();
  promptSections.push(["CURRENT DATE", now.toISOString()].join("\n"));
  if (Array.isArray(vectorResult.chunks) && vectorResult.chunks.length > 0) {
    promptSections.push(["KNOWLEDGE CHUNKS", ...vectorResult.chunks].join("\n"));
  }

  const prompt = promptSections.join("\n\n");
  const promptNoChunks = promptSections
    .filter((section) => !section.startsWith("KNOWLEDGE CHUNKS"))
    .join("\n\n");

  const historyMessages = Array.isArray(historyResult.messages) ? historyResult.messages : [];

  const messages = [
    ...historyMessages,
    { role: "user", content: String(incomingMessage) },
  ];

  let streamReady = false;
  let streamClosed = false;
  let streamHeartbeat = null;
  let streamAbortController = null;
  const miniStreamChunks = [];
  const nanoStreamChunks = [];
  const closeStream = () => {
    if (streamHeartbeat) {
      clearInterval(streamHeartbeat);
      streamHeartbeat = null;
    }
    if (!res.writableEnded) res.end();
  };

  if (wantsStream) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    streamReady = true;
    streamAbortController = new AbortController();
    req.on("close", () => {
      streamClosed = true;
      if (streamAbortController) {
        try {
          streamAbortController.abort();
        } catch (_) {}
      }
    });
    streamHeartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(streamHeartbeat);
        streamHeartbeat = null;
        return;
      }
      res.write(": ping\n\n");
    }, 15000);
  }

  const completionStartedAt = Date.now();
  const completion = wantsStream
    ? await getChatCompletionStream({
        apiKey: process.env.XAI_API_KEY,
        model: PRIMARY_MODEL,
        instructions: prompt,
        messages,
        tools: effectiveTools,
        signal: streamAbortController?.signal,
        onTextDelta: async (delta) => {
          miniStreamChunks.push(delta);
        },
      })
    : await getChatCompletion({
        apiKey: process.env.XAI_API_KEY,
        model: PRIMARY_MODEL,
        instructions: prompt,
        messages,
        tools: effectiveTools,
      });
  latencyMiniMs = Date.now() - completionStartedAt;
  if (!completion.ok) {
    if (streamReady) {
      sendSseEvent(res, "error", { error: completion.error });
      closeStream();
      return;
    }
    res.status(completion.status).json({ error: completion.error });
    return;
  }

  const hasToolCalls =
    completion.data?.mode === "action" || completion.data?.mode === "actions_needed";

  if (hasToolCalls) {
    if (streamReady && streamClosed) {
      closeStream();
      return;
    }

    const actionCalls = Array.isArray(completion.data?.action_calls)
      ? completion.data.action_calls
      : [];

    const toolResults = [];
    let calendarContext = null;
    let customButtonPayload = null;
    const toolsStartedAt = Date.now();
    for (const call of actionCalls) {
      const actionDef = effectiveActionMap.get(call.action_key);
      if (!actionDef) {
        toolResults.push({
          call_id: call.call_id ?? null,
          ok: false,
          error: "Unknown action",
        });
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

      if (actionDef.kind === "custom_button") {
        customButtonPayload = actionDef.button_payload || null;
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          request: {
            url: null,
            method: "LOCAL",
            headers: {},
            body: null,
          },
          response: {
            ok: true,
            status: 200,
            body: "Button sent to the user in the chat. You can reference it as button below.",
          },
        });
        continue;
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

      if (!url) {
        toolResults.push({
          call_id: call.call_id ?? null,
          action_key: call.action_key,
          tool_args: variables,
          request: {
            url: null,
            method,
            headers,
            body: variables,
          },
          response: {
            ok: false,
            status: 400,
            error: "Unknown action",
          },
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
          request: {
            url,
            method,
            headers,
            body: requestPayloadForLog,
          },
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
        const normalizedSummary = String(
          variables?.summary ?? variables?.summery ?? ""
        ).trim();
        const normalizedCustomerName = String(variables?.customer_name ?? "").trim();
        const normalizedCustomerEmail = String(
          variables?.customer_email ?? variables?.email ?? ""
        ).trim();
        const normalizedCustomerPhone = String(
          variables?.customer_phone ?? variables?.phone ?? ""
        ).trim();
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
          chat_source: "widget",
          country: requestCountry || "UN",
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
          chatSource: "widget",
          country: requestCountry || "UN",
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
                  ticket_id: ticketResult.ticket?.id ?? null,
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
            request: {
              url,
              method,
              headers,
              body: variables,
            },
            response: {
              ok: false,
              status: 401,
              error: tokenResult.error || "Gmail authorization failed",
            },
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
            request: {
              url,
              method,
              headers,
              body: variables,
            },
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
          const endTimeForCheck = addMinutesToRfc3339(startTime, reducedDuration);
          const openHour = Number(actionDef.open_hour);
          const closeHour = Number(actionDef.close_hour);
          const startHour = getHourInTimeZone(startTime, calendarTimeZone);
          const endHour = getHourInTimeZone(endTime, calendarTimeZone);
          const startMin = getMinuteInTimeZone(startTime, calendarTimeZone);
          const endMin = getMinuteInTimeZone(endTime, calendarTimeZone);
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
                request: {
                  url,
                  method,
                  headers,
                  body: variables,
                },
                response: {
                  ok: false,
                  status: 409,
                  error: "Requested time is outside of open hours",
                },
              });
              continue;
            }
          } else if (
            hasOpenHours &&
            !isAllDayOpen &&
            (startHour === null || endHour === null || startMin === null || endMin === null)
          ) {
              toolResults.push({
                call_id: call.call_id ?? null,
                action_key: call.action_key,
                tool_args: variables,
                request: {
                  url,
                  method,
                headers,
                body: variables,
              },
              response: {
                ok: false,
                status: 409,
                error: "Requested time is outside of open hours",
              },
            });
            continue;
          }

          const availabilityParams = new URLSearchParams();
          availabilityParams.append("timeMin", startTime);
          availabilityParams.append("timeMax", endTimeForCheck);
          availabilityParams.append("singleEvents", "true");
          availabilityParams.append("orderBy", "startTime");
          const availabilityUrl = `${url}?${availabilityParams.toString()}`;

          let availabilityItems = [];
          try {
            const availabilityRes = await fetch(availabilityUrl, {
              method: "GET",
              headers,
            });
            if (!availabilityRes.ok) {
              const errText = await availabilityRes.text();
              toolResults.push({
                call_id: call.call_id ?? null,
                action_key: call.action_key,
                tool_args: variables,
                request: {
                  url: availabilityUrl,
                  method: "GET",
                  headers,
                  body: null,
                },
                response: {
                  ok: false,
                  status: availabilityRes.status,
                  body: errText,
                },
              });
              continue;
            }
            const availabilityPayload = await availabilityRes.json();
            availabilityItems = Array.isArray(availabilityPayload?.items)
              ? availabilityPayload.items
              : [];
          } catch (error) {
            toolResults.push({
              call_id: call.call_id ?? null,
              action_key: call.action_key,
              tool_args: variables,
              request: {
                url: availabilityUrl,
                method: "GET",
                headers,
                body: null,
              },
              response: {
                ok: false,
                status: 502,
                error: "Calendar availability check failed",
              },
            });
            continue;
          }

          if (availabilityItems.length > 0) {
            const busy = availabilityItems.map((item) => ({
              start: item?.start?.dateTime || item?.start?.date || null,
              end: item?.end?.dateTime || item?.end?.date || null,
            }));
            toolResults.push({
              call_id: call.call_id ?? null,
              action_key: call.action_key,
              tool_args: variables,
              request: {
                url: availabilityUrl,
                method: "GET",
                headers,
                body: null,
              },
              response: {
                ok: false,
                status: 409,
                body: JSON.stringify({ busy }),
              },
            });
            continue;
          }

          const attendees = Array.isArray(variables?.attendees)
            ? variables.attendees.map((email) => ({ email }))
            : undefined;
          requestPayloadForLog = {
            summary: actionDef.event_type || "Event",
            location: actionDef.location ?? undefined,
            start: {
              dateTime: startTime,
              timeZone: calendarTimeZone,
            },
            end: {
              dateTime: endTime,
              timeZone: calendarTimeZone,
            },
            attendees,
          };
          requestBody = JSON.stringify(requestPayloadForLog);
          if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
        } else if (actionDef.kind === "calendar_list") {
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
        const actionRes = await fetch(url, {
          method,
          headers,
          body: requestBody,
        });
        const text = await actionRes.text();
        let responseBody = text;
        if (actionDef.kind === "calendar_list" && actionRes.ok) {
          try {
            const parsed = JSON.parse(text);
            const items = Array.isArray(parsed?.items) ? parsed.items : [];
            const busy = items.map((item) => ({
              start: item?.start?.dateTime || item?.start?.date || null,
              end: item?.end?.dateTime || item?.end?.date || null,
            }));
            responseBody = JSON.stringify({ busy });
          } catch (_) {}
        }
        actionResponse = {
          ok: actionRes.ok,
          status: actionRes.status,
          body: responseBody,
        };
      } catch (error) {
        actionResponse = {
          ok: false,
          status: 502,
          error: "Action request failed",
        };
      }

      toolResults.push({
        call_id: call.call_id ?? null,
        action_key: call.action_key,
        tool_args: variables,
        request: {
          url,
          method,
          headers,
          body:
            actionDef.kind === "gmail_send"
              ? { to: variables?.to, subject: variables?.subject, body: variables?.body, cc: variables?.cc, bcc: variables?.bcc }
              : actionDef.kind === "calendar_create"
              ? {
                  start_time: variables?.start_time,
                  attendees: variables?.attendees,
                }
              : actionDef.kind === "calendar_list"
              ? {
                  time_min: variables?.time_min,
                  time_max: variables?.time_max,
                  max_results: variables?.max_results,
                }
              : actionDef.kind === "slack"
              ? { text: variables?.message ?? "", username: actionDef.username || "MitsoLab" }
              : method === "GET"
                ? null
                : requestPayloadForLog,
        },
        response: actionResponse,
      });
    }
    latencyToolsMs = Date.now() - toolsStartedAt;

    const assistantBlocks =
      completion.output_items && Array.isArray(completion.output_items)
        ? completion.output_items
        : [];
    const followupInputItems = [
      ...toOpenAiInputItems(messages),
      ...assistantBlocks.map((item) => {
        if (item?.type === "text") {
          return {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: String(item.text ?? "") }],
          };
        }
        if (item?.type === "tool_use") {
          return {
            type: "function_call",
            call_id: item?.id ?? null,
            name: String(item?.name ?? ""),
            arguments: JSON.stringify(
              item?.input && typeof item.input === "object" ? item.input : {}
            ),
          };
        }
        return null;
      }).filter(Boolean),
      ...toolResults.map((result) => ({
        type: "function_call_output",
        call_id: result.call_id,
        output: JSON.stringify(result),
      })),
    ];

    const calendarNote = calendarContext
      ? [
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
          "You are speaking to a customer about the business schedule.",
          "Refer to the business schedule in neutral terms (e.g., 'our schedule' or 'our availability').",
          "Do not imply this is the customer's personal calendar.",
          "Do not ask for timezone or duration; use the settings above.",
          "If availability is checked, do not reveal event details.",
        ].join("\n")
      : null;
    const ticketOutcome = getLatestTicketOutcome({
      toolResults,
      actionMap: toolsResult.actionMap,
    });
    const ticketOutcomeNote = buildTicketOutcomeInstruction(ticketOutcome);

    const followupInstructions = [prompt, calendarNote, ticketOutcomeNote]
      .filter(Boolean)
      .join("\n\n");

    if (streamReady && streamClosed) {
      closeStream();
      return;
    }

    const followupStartedAt = Date.now();
    const followup = wantsStream
      ? await getXAiChatCompletionStream({
          apiKey: process.env.XAI_API_KEY,
          model: FOLLOWUP_MODEL,
          instructions: followupInstructions,
          messages,
          inputItems: followupInputItems,
          signal: streamAbortController?.signal,
          onTextDelta: async (delta) => {
            nanoStreamChunks.push(delta);
            if (streamReady && !streamClosed) {
              sendSseEvent(res, "token", { text: delta });
            }
          },
        })
      : await getXAiChatCompletion({
          apiKey: process.env.XAI_API_KEY,
          model: FOLLOWUP_MODEL,
          instructions: followupInstructions,
          messages,
          inputItems: followupInputItems,
        });
    latencyNanoMs = Date.now() - followupStartedAt;
    if (!followup.ok) {
      if (streamReady) {
        sendSseEvent(res, "error", { error: followup.error });
        closeStream();
        return;
      }
      res.status(followup.status).json({ error: followup.error });
      return;
    }

    const followupReply =
      wantsStream && nanoStreamChunks.length > 0
        ? nanoStreamChunks.join("")
        : (followup.data?.reply ?? "");
    const saveResult = await saveMessage({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      agentId,
      workspaceId: agentInfo.workspace_id,
      anonId,
      chatId,
      country: requestCountry,
      prompt: String(incomingMessage),
      result: followupReply,
      source: "widget",
      action: true,
    });
    if (!saveResult.ok) {
      res.status(saveResult.status).json({ error: saveResult.error });
      return;
    }

    const miniTokens = usageToTokens(completion.usage);
    const nanoTokens = usageToTokens(followup.usage);
    void saveMessageAnalytics({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      agentId,
      workspaceId: agentInfo.workspace_id,
      endpoint: "widget",
      source: "api",
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
      actionCount: actionCalls.length,
      ragUsed: Array.isArray(vectorResult.chunks) && vectorResult.chunks.length > 0,
      ragChunkCount: Array.isArray(vectorResult.chunks) ? vectorResult.chunks.length : 0,
      statusCode: 200,
      latencyTotalMs: Date.now() - requestStartedAt,
      latencyMiniMs,
      latencyNanoMs,
      latencyToolsMs,
      errorCode: null,
    }).catch(() => {});

    if (streamReady) {
      sendSseEvent(
        res,
        "done",
        customButtonPayload ? { done: true, custom_button: customButtonPayload } : { done: true }
      );
      closeStream();
      requestSucceeded = true;
      return;
    }

    res.status(200).json(
      customButtonPayload
        ? {
            reply: followupReply,
            custom_button: customButtonPayload,
          }
        : {
            reply: followupReply,
          }
    );
    requestSucceeded = true;
    return;
  }

  const completionReply = completion.data?.reply ?? "";
  const finalReply =
    wantsStream && miniStreamChunks.length > 0 ? miniStreamChunks.join("") : completionReply;
  if (streamReady) {
    for (const delta of miniStreamChunks) {
      if (streamClosed || res.writableEnded) break;
      sendSseEvent(res, "token", { text: delta });
    }
  }

  const saveResult = await saveMessage({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    workspaceId: agentInfo.workspace_id,
    anonId,
    chatId,
    country: requestCountry,
    prompt: String(incomingMessage),
    result: finalReply,
    source: "widget",
    action: false,
  });
  if (!saveResult.ok) {
    res.status(saveResult.status).json({ error: saveResult.error });
    return;
  }

  const completionMiniTokens = usageToTokens(completion.usage);
  void saveMessageAnalytics({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    workspaceId: agentInfo.workspace_id,
    endpoint: "widget",
    source: "api",
    country: requestCountry,
    anonId,
    chatId,
    modelMini: PRIMARY_MODEL,
    modelNano: FOLLOWUP_MODEL,
    miniInputTokens: completionMiniTokens.input,
    miniOutputTokens: completionMiniTokens.output,
    nanoInputTokens: 0,
    nanoOutputTokens: 0,
    actionUsed: false,
    actionCount: 0,
    ragUsed: Array.isArray(vectorResult.chunks) && vectorResult.chunks.length > 0,
    ragChunkCount: Array.isArray(vectorResult.chunks) ? vectorResult.chunks.length : 0,
    statusCode: 200,
    latencyTotalMs: Date.now() - requestStartedAt,
    latencyMiniMs,
    latencyNanoMs: null,
    latencyToolsMs: null,
    errorCode: null,
  }).catch(() => {});

    if (streamReady) {
      sendSseEvent(res, "done", { done: true });
      closeStream();
      requestSucceeded = true;
      return;
    }

    res.status(200).json({
      reply: finalReply,
    });
    requestSucceeded = true;
  } catch (error) {
    const contentType = String(res.getHeader("Content-Type") || "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      sendSseEvent(res, "error", {
        error: "Server error",
        detail: String(error?.message || error || "Unknown error"),
      });
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(500).json({
      error: "Server error",
      detail: String(error?.message || error || "Unknown error"),
      stack: typeof error?.stack === "string" ? error.stack : null,
    });
  } finally {
    if (consumedExtraCreditRowId !== null && !requestSucceeded) {
      await refundExtraMessageCredit({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        rowId: consumedExtraCreditRowId,
      }).catch(() => {});
    }
  }
};
