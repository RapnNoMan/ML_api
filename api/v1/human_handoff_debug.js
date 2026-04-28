const {
  checkHumanAgentsAppEnabled,
  getOpenHumanHandoffChat,
  checkAvailableHumanAgents,
  assignHumanHandoffChat,
  saveHumanMessageToMessages,
  saveHumanMessageToPortalFeed,
  resolveConversationStartMessageId,
  updateHumanHandoffChatMessageStart,
} = require("../../scripts/internal/humanHandoff");

function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

async function fetchDashboardWorkspaceApp({ supId, supKey, agentId }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/workspace_apps`);
  url.searchParams.set("select", "agent_id,enabled,human_agents_enabled,workspace_id,updated_at");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("limit", "1");
  try {
    const response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, status: response.status, row: null };
    const payload = await response.json();
    return { ok: true, status: 200, row: Array.isArray(payload) ? payload[0] || null : null };
  } catch (_) {
    return { ok: false, status: 502, row: null };
  }
}

async function fetchPortalShiftRows({ portalId, portalSecretKey, agentId }) {
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/human_agents_on_shift`);
  url.searchParams.set(
    "select",
    "id,agent_id,human_agent_user_id,is_on_shift,on_break,wrap_up,max_concurrent_chats,updated_at"
  );
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("order", "updated_at.desc");
  url.searchParams.set("limit", "20");
  try {
    const response = await fetch(url.toString(), {
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, status: response.status, rows: [] };
    const payload = await response.json();
    return { ok: true, status: 200, rows: Array.isArray(payload) ? payload : [] };
  } catch (_) {
    return { ok: false, status: 502, rows: [] };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const expectedDebugKey = normalize(process.env.HUMAN_HANDOFF_DEBUG_KEY);
  if (expectedDebugKey) {
    const suppliedDebugKey = normalize(req?.headers?.["x-debug-key"]);
    if (!suppliedDebugKey || suppliedDebugKey !== expectedDebugKey) {
      res.status(401).json({ error: "Invalid debug key" });
      return;
    }
  }

  const body = req.body ?? {};
  const agentId = normalize(body.agent_id);
  const chatSource = normalize(body.chat_source).toLowerCase() || "widget";
  const chatId = normalize(body.chat_id);
  const anonId = normalize(body.anon_id) || null;
  const country = normalize(body.country) || null;
  const source = normalize(body.source) || (chatSource === "widget" ? "Website" : `meta_${chatSource}`);
  const message = normalize(body.message);
  const runAssignment = body.run_assignment === true || body.run_assignment === "true";
  const runToolFlow = body.run_tool_flow === true || body.run_tool_flow === "true";

  const missing = [];
  if (!agentId) missing.push("agent_id");
  if (!chatId) missing.push("chat_id");
  if (!chatSource) missing.push("chat_source");
  if (missing.length > 0) {
    res.status(400).json({ error: "Missing required fields", missing });
    return;
  }

  const trace = [];

  const appGate = await checkHumanAgentsAppEnabled({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  const appRow = await fetchDashboardWorkspaceApp({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  trace.push({
    step: "dashboard_app_gate",
    result: appGate,
    raw_row: appRow.row,
    raw_row_fetch_ok: appRow.ok,
    raw_row_fetch_status: appRow.status,
  });

  const openChat = await getOpenHumanHandoffChat({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
    chatSource,
    chatId,
  });
  trace.push({
    step: "portal_open_handoff_chat_check",
    result: openChat,
  });

  const available = await checkAvailableHumanAgents({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
  });
  const shiftRows = await fetchPortalShiftRows({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
  });
  trace.push({
    step: "portal_shift_availability_check",
    result: available,
    raw_shift_rows_fetch_ok: shiftRows.ok,
    raw_shift_rows_fetch_status: shiftRows.status,
    raw_shift_rows: shiftRows.rows,
  });

  const appEnabled = Boolean(appGate?.ok && appGate?.enabled);
  const hasOpenChat = Boolean(openChat?.ok && openChat?.chat);
  const hasAvailableShift = Boolean(available?.ok && available?.available);
  const toolShouldBeIncluded = appEnabled && hasAvailableShift;

  let assignmentResult = null;
  if (runAssignment) {
    assignmentResult = await assignHumanHandoffChat({
      portalId: process.env.PORTAL_ID,
      portalSecretKey: process.env.PORTAL_SECRET_KEY,
      agentId,
      chatSource,
      source,
      chatId,
      anonId,
      externalUserId: anonId,
      country,
      subject: normalize(body.subject) || "Human handoff debug subject",
      summery:
        normalize(body.summery) ||
        (message
          ? `Debug request from API: ${message}`
          : "Debug request from API without additional user message."),
    });
    trace.push({
      step: "assignment_rpc",
      result: assignmentResult,
    });
  }

  let toolFlowResult = null;
  if (runToolFlow) {
    const normalizedSubject = normalize(body.subject) || "Human handoff debug subject";
    const normalizedSummery =
      normalize(body.summery) ||
      (message
        ? `Debug request from API: ${message}`
        : "Debug request from API without additional user message.");

    const assignment = await assignHumanHandoffChat({
      portalId: process.env.PORTAL_ID,
      portalSecretKey: process.env.PORTAL_SECRET_KEY,
      agentId,
      chatSource,
      source,
      chatId,
      anonId,
      externalUserId: anonId,
      country,
      subject: normalizedSubject,
      summery: normalizedSummery,
    });
    trace.push({
      step: "tool_flow_assignment",
      result: assignment,
      input: {
        subject: normalizedSubject,
        summery: normalizedSummery,
      },
    });

    if (assignment.ok) {
      const dashboardSource = chatSource === "widget" ? "widget" : `meta_${chatSource}`;
      const dashboardSave = await saveHumanMessageToMessages({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        agentId,
        anonId,
        chatId,
        country,
        source: dashboardSource,
        prompt: message || "Debug: customer asked for human support",
        result: null,
      });
      trace.push({
        step: "tool_flow_save_dashboard_message",
        result: dashboardSave,
        input: {
          source: dashboardSource,
        },
      });
      if (assignment.created && dashboardSave.ok && dashboardSave.messageId) {
        const startMessageResult = await resolveConversationStartMessageId({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          agentId,
          anonId,
          chatId,
          latestMessageId: dashboardSave.messageId,
        });
        trace.push({
          step: "tool_flow_resolve_start_message",
          result: startMessageResult,
        });
        if (startMessageResult.ok && startMessageResult.messageStartId) {
          const startMessageUpdate = await updateHumanHandoffChatMessageStart({
            portalId: process.env.PORTAL_ID,
            portalSecretKey: process.env.PORTAL_SECRET_KEY,
            handoffChatId: assignment.handoffChatId,
            messageStartId: startMessageResult.messageStartId,
          });
          trace.push({
            step: "tool_flow_update_start_message",
            result: startMessageUpdate,
          });
        }
      }

      const portalSource = chatSource === "widget" ? "Website" : `meta_${chatSource}`;
      const portalSave =
        chatSource === "widget"
          ? { ok: true, skipped: true, reason: "widget_trigger_message_not_inserted" }
          : await saveHumanMessageToPortalFeed({
              portalId: process.env.PORTAL_ID,
              portalSecretKey: process.env.PORTAL_SECRET_KEY,
              agentId,
              anonId,
              chatId,
              source: portalSource,
              senderType: "customer",
              assignedHumanAgentUserId: assignment.assignedHumanAgentUserId ?? null,
              prompt: message || "Debug: customer asked for human support",
              result: null,
            });
      trace.push({
        step: "tool_flow_save_portal_message",
        result: portalSave,
        input: {
          source: portalSource,
          assigned_human_agent_user_id: assignment.assignedHumanAgentUserId ?? null,
        },
      });

      toolFlowResult = {
        ok: Boolean(assignment.ok && dashboardSave.ok && portalSave.ok),
        assignment,
        dashboardSave,
        portalSave,
      };
    } else {
      toolFlowResult = {
        ok: false,
        assignment,
      };
    }
  }

  res.status(200).json({
    ok: true,
    computed: {
      app_enabled: appEnabled,
      has_open_handoff_chat: hasOpenChat,
      has_available_shift: hasAvailableShift,
      tool_should_be_included: toolShouldBeIncluded,
      llm_would_be_bypassed_due_to_open_chat: hasOpenChat,
      run_assignment: runAssignment,
      run_tool_flow: runToolFlow,
    },
    input: {
      agent_id: agentId,
      chat_source: chatSource,
      chat_id: chatId,
      anon_id: anonId,
      country,
      source,
      message,
    },
    tool_flow_result: toolFlowResult,
    trace,
  });
};
