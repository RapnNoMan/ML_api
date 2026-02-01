function extractResponseText(payload) {
  if (!payload) return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") {
        return part.text;
      }
    }
  }
  return "";
}

const RESPONSE_SCHEMA = {
  name: "agent_response",
  description: "Structured assistant response with optional actions.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      assistant_text: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: { type: "string" },
            vars: { type: "object" },
          },
          required: ["action_key", "vars"],
        },
      },
    },
    required: ["assistant_text", "actions"],
  },
  strict: true,
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
            json_schema: RESPONSE_SCHEMA,
          },
        },
      }),
    });
  } catch (error) {
    return { ok: false, status: 502, error: "LLM service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "LLM service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, status: 502, error: "LLM service unavailable" };
  }

  const text = extractResponseText(payload);
  if (!text) {
    return { ok: false, status: 502, error: "LLM service unavailable" };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, status: 502, error: "LLM service unavailable" };
  }

  const usage = payload?.usage ?? null;

  return { ok: true, data, usage };
}

module.exports = {
  getChatCompletion,
};
