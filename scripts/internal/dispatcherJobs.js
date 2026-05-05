const INITIAL_FIRST_DELAY_SECONDS = Math.max(
  1,
  Number.isFinite(Number(process.env.DISPATCHER_INITIAL_FIRST_DELAY_SECONDS))
    ? Math.floor(Number(process.env.DISPATCHER_INITIAL_FIRST_DELAY_SECONDS))
    : 60
);
const INITIAL_RESET_DELAY_SECONDS = Math.max(
  1,
  Number.isFinite(Number(process.env.DISPATCHER_INITIAL_RESET_DELAY_SECONDS))
    ? Math.floor(Number(process.env.DISPATCHER_INITIAL_RESET_DELAY_SECONDS))
    : 30
);
const UNANSWERED_DELAY_SECONDS = Math.max(
  60,
  Number.isFinite(Number(process.env.DISPATCHER_UNANSWERED_DELAY_SECONDS))
    ? Math.floor(Number(process.env.DISPATCHER_UNANSWERED_DELAY_SECONDS))
    : 60 * 60
);

function authHeaders(secret, extra = {}) {
  return {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    ...extra,
  };
}

function addSeconds(seconds) {
  return new Date(Date.now() + Math.max(1, Number(seconds) || 1) * 1000).toISOString();
}

async function fetchJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function getInitialJobStatus({
  supId,
  supKey,
  workspaceId,
  dispatcherAgentId,
  chatId,
  anonId,
  dispatcherChatDay,
  portalChatId,
}) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/dispatcher_scheduled_jobs`);
  url.searchParams.set("select", "id,status");
  url.searchParams.set("workspace_id", `eq.${workspaceId}`);
  url.searchParams.set("dispatcher_agent_id", `eq.${dispatcherAgentId}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("dispatcher_chat_day", `eq.${dispatcherChatDay}`);
  url.searchParams.set("portal_chat_id", `eq.${portalChatId}`);
  url.searchParams.set("job_type", "eq.initial_dispatcher_reply");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    headers: authHeaders(supKey, { Accept: "application/json" }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Dispatcher job service unavailable" };
  const rows = await fetchJson(response);
  return { ok: true, job: Array.isArray(rows) ? rows[0] || null : null };
}

async function scheduleInitialDispatcherReply({
  supId,
  supKey,
  workspaceId,
  dispatcherAgentId,
  chatId,
  anonId,
  dispatcherChatDay,
  portalChatId,
  portalCustomerMessageId = null,
  event,
  connection,
}) {
  if (
    !supId ||
    !supKey ||
    !workspaceId ||
    !dispatcherAgentId ||
    !chatId ||
    !anonId ||
    !dispatcherChatDay ||
    portalChatId === null ||
    portalChatId === undefined ||
    String(portalChatId).trim() === ""
  ) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const existing = await getInitialJobStatus({
    supId,
    supKey,
    workspaceId,
    dispatcherAgentId,
    chatId,
    anonId,
    dispatcherChatDay,
    portalChatId,
  });
  if (!existing.ok) return existing;
  if (existing.job?.status === "running") {
    return { ok: true, delayed: true, alreadyRunning: true };
  }

  const delaySeconds = existing.job?.status === "pending"
    ? INITIAL_RESET_DELAY_SECONDS
    : INITIAL_FIRST_DELAY_SECONDS;

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/dispatcher_scheduled_jobs`);
  url.searchParams.set(
    "on_conflict",
    "workspace_id,dispatcher_agent_id,chat_id,annon,dispatcher_chat_day,portal_chat_id,job_type"
  );
  const payload = {
    workspace_id: workspaceId,
    dispatcher_agent_id: dispatcherAgentId,
    chat_id: chatId,
    annon: anonId,
    dispatcher_chat_day: dispatcherChatDay,
    portal_chat_id: portalChatId,
    job_type: "initial_dispatcher_reply",
    run_at: addSeconds(delaySeconds),
    status: "pending",
    portal_customer_message_id: portalCustomerMessageId,
    raw_event: event && typeof event === "object" ? event : {},
    raw_connection: connection && typeof connection === "object" ? connection : {},
    updated_at: new Date().toISOString(),
  };

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: authHeaders(supKey, {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Dispatcher job schedule failed" };
  const rows = await fetchJson(response);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { ok: true, delayed: true, job: row || null };
}

async function scheduleUnansweredDispatcherCheck({
  supId,
  supKey,
  workspaceId,
  dispatcherAgentId,
  chatId,
  anonId,
  dispatcherChatDay,
  portalChatId,
  portalCustomerMessageId = null,
  event,
  connection,
}) {
  if (
    !supId ||
    !supKey ||
    !workspaceId ||
    !dispatcherAgentId ||
    !chatId ||
    !anonId ||
    !dispatcherChatDay ||
    portalChatId === null ||
    portalChatId === undefined ||
    String(portalChatId).trim() === ""
  ) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/dispatcher_scheduled_jobs`);
  url.searchParams.set(
    "on_conflict",
    "workspace_id,dispatcher_agent_id,chat_id,annon,dispatcher_chat_day,portal_chat_id,job_type"
  );
  const payload = {
    workspace_id: workspaceId,
    dispatcher_agent_id: dispatcherAgentId,
    chat_id: chatId,
    annon: anonId,
    dispatcher_chat_day: dispatcherChatDay,
    portal_chat_id: portalChatId,
    job_type: "unanswered_followup",
    run_at: addSeconds(UNANSWERED_DELAY_SECONDS),
    status: "pending",
    portal_customer_message_id: portalCustomerMessageId,
    raw_event: event && typeof event === "object" ? event : {},
    raw_connection: connection && typeof connection === "object" ? connection : {},
    updated_at: new Date().toISOString(),
  };
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: authHeaders(supKey, {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Dispatcher unanswered schedule failed" };
  const rows = await fetchJson(response);
  return { ok: true, job: Array.isArray(rows) ? rows[0] || null : rows || null };
}

async function cancelDispatcherJobs({
  supId,
  supKey,
  workspaceId,
  dispatcherAgentId,
  chatId,
  anonId,
  dispatcherChatDay,
  portalChatId,
  jobTypes = ["initial_dispatcher_reply", "unanswered_followup"],
}) {
  if (!supId || !supKey || !workspaceId || !dispatcherAgentId || !chatId || !anonId || !dispatcherChatDay || !portalChatId) {
    return { ok: true, skipped: true };
  }
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/dispatcher_scheduled_jobs`);
  url.searchParams.set("workspace_id", `eq.${workspaceId}`);
  url.searchParams.set("dispatcher_agent_id", `eq.${dispatcherAgentId}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("dispatcher_chat_day", `eq.${dispatcherChatDay}`);
  url.searchParams.set("portal_chat_id", `eq.${portalChatId}`);
  url.searchParams.set("job_type", `in.(${jobTypes.map((type) => `"${type}"`).join(",")})`);
  url.searchParams.set("status", "eq.pending");
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: authHeaders(supKey, {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Dispatcher job cancel failed" };
  return { ok: true };
}

module.exports = {
  scheduleInitialDispatcherReply,
  scheduleUnansweredDispatcherCheck,
  cancelDispatcherJobs,
};
