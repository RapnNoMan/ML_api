function toNonEmptyText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function parseJsonObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMissingFields(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toNonEmptyText(item))
    .filter(Boolean);
}

function getLatestTicketOutcome({ toolResults, actionMap }) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  const map = actionMap instanceof Map ? actionMap : new Map();
  let latest = null;

  for (const result of results) {
    const actionKey = toNonEmptyText(result?.action_key);
    const actionDef = actionKey ? map.get(actionKey) : null;
    if (actionDef?.kind !== "ticket_create") continue;

    const response = result?.response && typeof result.response === "object" ? result.response : {};
    if (response.ok === true) {
      const body = parseJsonObject(response.body);
      latest = {
        ok: true,
        status: response.status ?? null,
        ticketCode: toNonEmptyText(body?.ticket_code),
        ticketId: body?.ticket_id ?? null,
        ticketStatus: toNonEmptyText(body?.status) || "open",
      };
      continue;
    }

    latest = {
      ok: false,
      status: response.status ?? null,
      error: toNonEmptyText(response.error) || "Ticket creation failed",
      missingFields: normalizeMissingFields(response.missing_required_fields),
    };
  }

  return latest;
}

function buildTicketOutcomeInstruction(ticketOutcome) {
  if (!ticketOutcome) return null;

  if (ticketOutcome.ok) {
    return [
      "TICKET RESULT (SOURCE OF TRUTH)",
      "ticket_created: true",
      `ticket_code: ${ticketOutcome.ticketCode || "null"}`,
      `ticket_id: ${ticketOutcome.ticketId ?? "null"}`,
      `ticket_status: ${ticketOutcome.ticketStatus || "open"}`,
      "RULES:",
      "- You may say the ticket is created.",
      "- If ticket_code is not null, echo it exactly as-is (no reformatting, no prefix changes).",
      "- If ticket_code is null, do not invent a ticket number.",
    ].join("\n");
  }

  return [
    "TICKET RESULT (SOURCE OF TRUTH)",
    "ticket_created: false",
    `ticket_error: ${ticketOutcome.error || "Ticket creation failed"}`,
    `missing_fields: ${
      ticketOutcome.missingFields.length > 0
        ? ticketOutcome.missingFields.join(", ")
        : "none"
    }`,
    "RULES:",
    "- Do not say the ticket was created.",
    "- Ask only for missing_fields if any; otherwise apologize briefly and ask the user to retry.",
    "- Do not invent any ticket number.",
  ].join("\n");
}

module.exports = {
  getLatestTicketOutcome,
  buildTicketOutcomeInstruction,
};
