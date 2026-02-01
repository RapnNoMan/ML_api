/**
 * getChatCompletion.js
 * Responses API + Structured Outputs (JSON Schema) for GPT-5-mini
 *
 * ✅ Fixes:
 * - Uses correct Responses API structured output format: text.format.{type,name,strict,schema}
 * - Removes forbidden JSON Schema keywords (no allOf/anyOf/oneOf/if/then/else)
 * - Allows action variables (not forced to {})
 * - Adds server-side validation enforcing mode rules (since schema can't)
 * - Better error messages from OpenAI
 *
 * Drop-in replacement for: ../../scripts/internal/getChatCompletion.js
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

// ✅ Structured Outputs schema (restricted subset; NO allOf/if/then/etc.)
const RESPONSE_SCHEMA = {
  name: "agent_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["reply", "clarify", "actions_needed"] },

      // optional per mode, enforced by server-side validator below
      reply: { type: "string" },
      clarification_question: { type: "string" },

      action_calls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: { type: "string" },

            // ✅ allow any keys for now; you'll validate per action_key server-side later
            variables: { type: "object" },
          },
          required: ["action_key", "variables"],
        },
      },

      used_chunks: { type: "array", items: { type: "string" } },
    },
    required: ["mode"],
  },
};

function toInputItems(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    type: "message",
    role: message.role,
    content: [
      {
        type: "input_text",
        text: String(message.content ?? ""),
      },
    ],
  }));
}

// Enforce conditional rules not supported by Structured Outputs schema subset
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

async function getChatCompletion({ apiKey, model, reasoning, instructions, messages }) {
  if (!apiKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  // Strong system rules to reduce bad outputs even further
  const systemRules = `
OUTPUT RULES (MUST FOLLOW):
- Output must be valid JSON matching the provided schema.
- Set mode to exactly one of: reply, clarify, actions_needed.
- If mode="reply": include "reply" (non-empty). Do NOT include action_calls or clarification_question.
- If mode="clarify": include "clarification_question" (non-empty). Do NOT include action_calls or reply.
- If mode="actions_needed": include "action_calls" with at least 1 item. Do NOT include reply or clarification_question.
- action_calls[].action_key MUST be one of the action_key values provided in the ACTIONS list.
- action_calls[].variables MUST be an object (can be empty only if truly no variables are needed).
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

        // ✅ Correct for /v1/responses (and matches your server's requirement for text.format.name)
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
    } catch (_) {
      errText = "";
    }

    // Keep the raw error for debugging
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
  if (!rawText) {
    return { ok: false, status: 502, error: "Empty model output" };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, status: 502, error: "Model output not valid JSON", raw: rawText };
  }

  // Server-side enforcement of conditional rules
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

  const usage = payload?.usage ?? null;

  return { ok: true, data, usage, raw: rawText };
}

module.exports = {
  getChatCompletion,
};
