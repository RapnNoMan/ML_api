const XAI_RESPONSES_API_URL = "https://api.x.ai/v1/responses";
const PRIMARY_MODEL = process.env.XAI_PRIMARY_MODEL || "grok-4-1-fast-non-reasoning";

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function toInputMessage(text) {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: String(text || ""),
      },
    ],
  };
}

function extractFunctionCalls(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
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

function extractResponseText(payload) {
  if (!payload) return "";
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const textParts = [];
  for (const item of output) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        if (
          (part?.type === "output_text" || part?.type === "text") &&
          typeof part?.text === "string" &&
          part.text.trim()
        ) {
          textParts.push(part.text);
        }
      }
      continue;
    }
    if ((item?.type === "output_text" || item?.type === "text") && typeof item?.text === "string") {
      textParts.push(item.text);
    }
  }

  return textParts.join("\n").trim();
}

async function callXAi({ apiKey, body }) {
  let response;
  try {
    response = await fetch(XAI_RESPONSES_API_URL, {
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

  const responseText = await response.text();
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch (_) {}

  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 502,
      error: responseText || "xAI request failed",
      payload,
    };
  }

  return { ok: true, payload };
}

function fakeToolRunner(call) {
  const args = call?.variables && typeof call.variables === "object" ? call.variables : {};
  const plan = String(args.plan || "growth").toLowerCase();
  const region = String(args.region || "global").toUpperCase();
  const currency = String(args.currency || "USD").toUpperCase();

  return {
    call_id: call?.call_id ?? null,
    action_key: call?.action_key || "",
    ok: true,
    source: "fabricated_pricing_store",
    pricing: {
      currency,
      region,
      plans: [
        { name: "free", monthly: 0, notes: "basic usage" },
        { name: "hobby", monthly: 29, notes: "small projects" },
        { name: "growth", monthly: 119, notes: "growing teams" },
        { name: "pro", monthly: 299, notes: "advanced teams" },
      ],
      requested_plan: plan,
    },
  };
}

module.exports = async function handler(req, res) {
  try {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const xaiApiKey = process.env.XAI_API_KEY;
    if (!xaiApiKey) {
      res.status(500).json({ error: "Server configuration error", detail: "Missing XAI_API_KEY" });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const userPrompt = String(body.user_prompt || "what is your pricing");

    const tools = [
      {
        type: "function",
        name: "check_pricing",
        description: "Returns current plan pricing and limits from billing catalog.",
        parameters: {
          type: "object",
          properties: {
            plan: { type: "string", enum: ["free", "hobby", "growth", "pro"] },
            region: { type: "string", description: "pricing region, e.g. global or us" },
            currency: { type: "string", description: "requested currency code" },
          },
          required: ["plan"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "check_message_quota",
        description: "Returns monthly message quota for a named plan.",
        parameters: {
          type: "object",
          properties: {
            plan: { type: "string", enum: ["free", "hobby", "growth", "pro"] },
          },
          required: ["plan"],
          additionalProperties: false,
        },
      },
    ];

    const instructions = [
      "You are a billing assistant in a test sandbox.",
      "You must call at least one tool before giving any user-facing answer.",
      "For pricing questions, call check_pricing first.",
      "After tool output is available, answer concisely.",
    ].join("\n");

    const firstRequestBody = {
      model: PRIMARY_MODEL,
      instructions,
      input: [toInputMessage(userPrompt)],
      tools,
      tool_choice: "auto",
      text: { verbosity: "low" },
      stream: false,
    };

    const firstCall = await callXAi({
      apiKey: xaiApiKey,
      body: firstRequestBody,
    });

    if (!firstCall.ok) {
      res.status(firstCall.status).json({
        error: firstCall.error,
        first_request: firstRequestBody,
        first_payload: firstCall.payload || null,
      });
      return;
    }

    const firstPayload = firstCall.payload || {};
    const actionCalls = extractFunctionCalls(firstPayload);
    const toolResults = actionCalls.map(fakeToolRunner);

    const followupInput = [toInputMessage(userPrompt)];
    for (const call of actionCalls) {
      followupInput.push({
        type: "function_call",
        call_id: call.call_id ?? null,
        name: String(call.action_key || ""),
        arguments: JSON.stringify(
          call.variables && typeof call.variables === "object" ? call.variables : {}
        ),
      });
    }
    for (const result of toolResults) {
      followupInput.push({
        type: "function_call_output",
        call_id: result.call_id ?? null,
        output: JSON.stringify(result),
      });
    }

    let secondPayload = null;
    if (actionCalls.length > 0) {
      const secondRequestBody = {
        model: PRIMARY_MODEL,
        instructions,
        input: followupInput,
        tools,
        tool_choice: "auto",
        text: { verbosity: "low" },
        stream: false,
      };

      const secondCall = await callXAi({
        apiKey: xaiApiKey,
        body: secondRequestBody,
      });
      if (!secondCall.ok) {
        res.status(secondCall.status).json({
          error: secondCall.error,
          first_request: firstRequestBody,
          first_payload: firstPayload,
          action_calls: actionCalls,
          fabricated_tool_results: toolResults,
          second_request: secondRequestBody,
          second_payload: secondCall.payload || null,
        });
        return;
      }
      secondPayload = secondCall.payload || {};
    }

    res.status(200).json({
      model: PRIMARY_MODEL,
      user_prompt: userPrompt,
      used_tool: actionCalls.length > 0,
      action_calls: actionCalls,
      fabricated_tool_results: toolResults,
      first_model_text: extractResponseText(firstPayload),
      followup_model_text: extractResponseText(secondPayload),
      first_payload: firstPayload,
      followup_payload: secondPayload,
    });
  } catch (error) {
    res.status(500).json({
      error: "Server error",
      detail: String(error?.message || error || "Unknown error"),
      stack: typeof error?.stack === "string" ? error.stack : null,
    });
  }
};
