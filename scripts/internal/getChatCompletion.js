/**
 * getChatCompletion.js
 * Responses API + Structured Outputs (JSON Schema) for GPT-5-mini
 *
 * ✅ Fixes:
 * - Correct Responses API structured output format: text.format.{type,name,strict,schema}
 * - Avoids forbidden JSON Schema keywords (no allOf/if/then/oneOf/etc.)
 * - STRICT mode compatible: every object includes additionalProperties:false
 * - variables are represented as a KV array (strict-compatible, flexible)
 * - Server-side validation enforces mode rules
 * - Converts KV array -> variables object for your app to consume
 */

function extractResponseText(payload) {
  if (!payload) return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }
  return "";
}

/**
 * STRICT Structured Outputs schema (restricted subset)
 * - NO allOf / oneOf / anyOf / if / then / else
 * - ALL objects must include additionalProperties:false
 * - variables cannot be an open object in strict mode => use KV array
 */
const RESPONSE_SCHEMA = {
  name: "agent_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["reply", "clarify", "action"] },

      reply: { type: "string" },
      clarification_question: { type: "string" },

      action_calls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: { type: "string" },

            // ✅ KV array: flexible + strict-safe
            variables: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  key: { type: "string" },
                  value_type: {
                    type: "string",
                    enum: ["string", "number", "boolean", "json", "null"],
                  },
                  value: { type: "string" }, // store everything as string; parse later
                },
                required: ["key", "value_type", "value"],
              },
            },
          },
          required: ["action_key", "variables"],
        },
      },

      used_chunks: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["mode", "reply", "clarification_question", "action_calls", "used_chunks"],
  },
};

function toInputItems(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    type: "message",
    role: message.role,
    content: [{ type: "input_text", text: String(message.content ?? "") }],
  }));
}

// Conditional rules not supported by strict schema subset
function validateAgentOutput(obj) {
  if (!obj || typeof obj !== "object") return "Output is not an object.";
  if (!["reply", "clarify", "actions_needed"].includes(obj.mode)) return "Invalid mode.";

  const hasActions = Array.isArray(obj.action_calls) && obj.action_calls.length > 0;
  const hasReply = typeof obj.reply === "string" && obj.reply.trim().length > 0;
  const hasClarify =
    typeof obj.clarification_question === "string" &&
    obj.clarification_question.trim().length > 0;

  if (obj.mode === "reply") {
    if (!hasReply) return 'mode="reply" requires non-empty "reply".';
    if (hasActions) return 'mode="reply" must not include "action_calls".';
    if (hasClarify) return 'mode="reply" must not include "clarification_question".';
  }

  if (obj.mode === "clarify") {
    if (!hasClarify) return 'mode="clarify" requires non-empty "clarification_question".';
    if (hasActions) return 'mode="clarify" must not include "action_calls".';
    if (hasReply) return 'mode="clarify" must not include "reply".';
  }

  if (obj.mode === "actions_needed") {
    if (!hasActions) return 'mode="actions_needed" requires non-empty "action_calls".';
    if (hasReply) return 'mode="actions_needed" must not include "reply".';
    if (hasClarify) return 'mode="actions_needed" must not include "clarification_question".';
  }

  return null;
}

// Convert KV array -> plain object for your backend convenience
function kvArrayToObject(kvArr) {
  const out = {};
  if (!Array.isArray(kvArr)) return out;

  for (const item of kvArr) {
    const key = item?.key;
    const valueType = item?.value_type;
    const valueStr = item?.value;

    if (typeof key !== "string" || !key) continue;

    if (valueType === "null") {
      out[key] = null;
      continue;
    }

    if (valueType === "boolean") {
      // accept "true"/"false"
      out[key] = String(valueStr).toLowerCase() === "true";
      continue;
    }

    if (valueType === "number") {
      const n = Number(valueStr);
      out[key] = Number.isFinite(n) ? n : null;
      continue;
    }

    if (valueType === "json") {
      try {
        out[key] = JSON.parse(String(valueStr));
      } catch {
        out[key] = null;
      }
      continue;
    }

    // default string
    out[key] = String(valueStr);
  }

  return out;
}

async function getChatCompletion({ apiKey, model, reasoning, instructions, messages }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const systemRules = `
OUTPUT RULES (MUST FOLLOW):
- Output must be valid JSON matching the provided schema exactly.
- mode must be one of: reply, clarify, actions_needed.
- If mode="reply": include "reply" (non-empty). Do NOT include action_calls or clarification_question.
- If mode="clarify": include "clarification_question" (non-empty). Do NOT include action_calls or reply.
- If mode="actions_needed": include action_calls with at least 1 item. Do NOT include reply or clarification_question.
- action_calls[].action_key MUST be one of the action_key values provided in the ACTIONS list.
- variables are a list of key/value entries:
  - key: variable name
  - value_type: one of string|number|boolean|json|null
  - value: always a string (for json, value must be JSON text)
`.trim();

  const finalInstructions = [systemRules, String(instructions || "")].filter(Boolean).join("\n\n");

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning,
        instructions: finalInstructions,
        input: toInputItems(messages),

        // ✅ Correct strict Structured Outputs shape for /v1/responses
        text: {
          format: {
            type: "json_schema",
            name: RESPONSE_SCHEMA.name,
            strict: RESPONSE_SCHEMA.strict,
            schema: RESPONSE_SCHEMA.schema,
          },
        },
      }),
    });
  } catch (error) {
    return { ok: false, status: 502, error: "Network error calling OpenAI" };
  }

  if (!response.ok) {
    let errText = "";
    try {
      errText = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: errText || "OpenAI request failed",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, status: 502, error: "Invalid JSON from OpenAI" };
  }

  const rawText = extractResponseText(payload);
  if (!rawText) return { ok: false, status: 502, error: "Empty model output" };

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, status: 502, error: "Model output not valid JSON", raw: rawText };
  }

  const validationError = validateAgentOutput(data);
  if (validationError) {
    return {
      ok: false,
      status: 502,
      error: `Model output failed validation: ${validationError}`,
      raw: rawText,
      data,
    };
  }

  // ✅ Convert variables KV arrays into objects for downstream usage
  if (Array.isArray(data.action_calls)) {
    data.action_calls = data.action_calls.map((c) => ({
      ...c,
      variables: kvArrayToObject(c.variables),
    }));
  }

  return { ok: true, data, usage: payload?.usage ?? null, raw: rawText };
}

module.exports = {
  getChatCompletion,
};
