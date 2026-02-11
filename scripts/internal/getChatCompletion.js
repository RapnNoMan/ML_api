/**
 * getChatCompletion.js
 * Responses API + tool calling for GPT-5-mini
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

function toInputItems(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    type: "message",
    role: message.role,
    content: [{ type: "input_text", text: String(message.content ?? "") }],
  }));
}

function extractFunctionCalls(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const calls = [];
  for (const item of output) {
    if (item?.type !== "function_call") continue;
    const name = typeof item?.name === "string" ? item.name : "";
    let args = {};
    if (typeof item?.arguments === "string" && item.arguments.trim()) {
      try {
        const parsed = JSON.parse(item.arguments);
        if (parsed && typeof parsed === "object") args = parsed;
      } catch (_) {}
    }
    calls.push({
      action_key: name,
      variables: args,
      call_id: item?.call_id ?? null,
    });
  }
  return calls;
}

async function getChatCompletion({ apiKey, model, reasoning, instructions, messages, tools }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const systemRules = `
TOOL RULES (MUST FOLLOW):
- Use the provided tools when needed.
- If you call a tool, include only the arguments required by its schema.
`.trim();

  const finalInstructions = [systemRules, String(instructions || "")].filter(Boolean).join("\n\n");

  const requestBody = {
    model,
    reasoning,
    instructions: finalInstructions,
    input: toInputItems(messages),
    text: { verbosity: "low" },
  };

  if (Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = "auto";
  }

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
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

  const toolCalls = extractFunctionCalls(payload);
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
      openai_request: requestBody,
      openai_response: payload,
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
    openai_request: requestBody,
    openai_response: payload,
  };
}

module.exports = {
  getChatCompletion,
};
