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

const RESPONSE_SCHEMA = {
  name: "agent_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["reply", "clarify", "actions_needed"] },
      reply: { type: "string" },
      clarification_question: { type: "string" },
      action_calls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: { type: "string" },
            variables: { type: "object" },
          },
          required: ["action_key", "variables"],
        },
      },
      used_chunks: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["mode"],
    allOf: [
      {
        if: { properties: { mode: { const: "reply" } } },
        then: { required: ["reply"] },
      },
      {
        if: { properties: { mode: { const: "clarify" } } },
        then: { required: ["clarification_question"] },
      },
      {
        if: { properties: { mode: { const: "actions_needed" } } },
        then: { required: ["action_calls"] },
      },
    ],
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

async function getChatCompletion({ apiKey, model, reasoning, instructions, messages }) {
  if (!apiKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

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
        instructions,
        input: toInputItems(messages),
        text: {
          format: {
            type: "json_schema",
            json_schema: {
              name: RESPONSE_SCHEMA.name,
              strict: RESPONSE_SCHEMA.strict,
              schema: RESPONSE_SCHEMA.schema,
            },
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
    return { ok: false, status: response.status, error: errText || "OpenAI request failed" };
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

  const usage = payload?.usage ?? null;

  return { ok: true, data, usage, raw: rawText };
}

module.exports = {
  getChatCompletion,
};
