var crypto = require("crypto");

var MAX_TASKS_PER_BATCH = 20;

var DEFAULT_PLANNER_TEMPLATE = [
  "You are planning a single ticket from {{project}} version {{version}}.",
  "",
  "Ticket: {{task.key}} — {{task.title}}",
  "Link: {{task.url}}",
  "",
  "Description:",
  "{{task.description}}",
  "",
  "Produce a concise implementation plan for this ticket:",
  "1. Read the most relevant files in this repository to understand current behavior.",
  "2. Outline the smallest set of changes that would deliver the ticket.",
  "3. Call out risks, open questions, and any follow-up tickets you would recommend.",
  "",
  "Do NOT make code changes. Stop after the plan.",
].join("\n");

function getByPath(obj, dotted) {
  var parts = dotted.split(".");
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return "";
    cur = cur[parts[i]];
  }
  if (cur == null) return "";
  return String(cur);
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{([\w.]+)\}\}/g, function (_m, key) {
    return getByPath(vars, key);
  });
}

function newBatchId() {
  return "tb_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
}

function normalizeTask(raw, idx) {
  if (!raw || typeof raw !== "object") return null;
  var key = raw.key || raw.id || ("TASK-" + (idx + 1));
  var title = raw.title || raw.summary || "";
  var description = raw.description || raw.body || "";
  var url = raw.url || "";
  var labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 32).map(String) : [];
  return {
    key: String(key),
    title: String(title),
    description: String(description),
    url: String(url),
    labels: labels,
  };
}

/**
 * Attach task launcher: spawns one planner session per task in a batch.
 *
 * ctx fields:
 *   sm, sdk, send, sendTo, sendToSession,
 *   onProcessingChanged, getLinuxUserForSession,
 *   usersModule, defaultVendor (function returning current default vendor or null)
 */
function attachTaskLauncher(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var usersModule = ctx.usersModule;
  var getDefaultVendor = ctx.getDefaultVendor || function () { return null; };

  /**
   * Core launch function. Used by both the WS handler and the HTTP endpoint.
   *
   * opts:
   *   tasks            (required) array of raw task objects
   *   project          (optional) Jira project key (for {{project}})
   *   version          (optional) Jira fix version (for {{version}})
   *   batchTitle       (optional) human-readable batch title
   *   source           (optional) "jira" | "manual" | "pm-session" | other
   *   parentSessionId  (optional) session that produced the task list
   *   promptMode       (optional) "default" | "append" | "replace"  (default "default")
   *   promptText       (optional) text appended to or replacing the default planner prompt
   *   vendor           (optional) vendor for spawned sessions (defaults to project default)
   *   ownerId          (optional) user id to own spawned sessions (multi-user mode)
   *   sessionVisibility (optional) "shared" | "private"
   *
   * Returns: { batchId, sessionIds, errors }
   */
  function launchBatch(opts) {
    opts = opts || {};
    var rawTasks = Array.isArray(opts.tasks) ? opts.tasks : [];
    if (rawTasks.length === 0) {
      return { error: "tasks must be a non-empty array" };
    }
    if (rawTasks.length > MAX_TASKS_PER_BATCH) {
      return { error: "too many tasks (max " + MAX_TASKS_PER_BATCH + ")" };
    }

    var promptMode = opts.promptMode || "default";
    if (promptMode !== "default" && promptMode !== "append" && promptMode !== "replace") {
      return { error: "promptMode must be one of: default, append, replace" };
    }
    if (promptMode === "replace" && !(opts.promptText && String(opts.promptText).trim())) {
      return { error: "promptText is required when promptMode is 'replace'" };
    }

    var batchId = newBatchId();
    var batchTitle = opts.batchTitle ? String(opts.batchTitle).slice(0, 200) : "";
    var source = opts.source ? String(opts.source).slice(0, 64) : "manual";
    var project = opts.project ? String(opts.project) : "";
    var version = opts.version ? String(opts.version) : "";
    var parentSessionId = (typeof opts.parentSessionId === "number") ? opts.parentSessionId : null;
    var vendor = opts.vendor || getDefaultVendor() || null;
    var ownerId = opts.ownerId || null;
    var sessionVisibility = opts.sessionVisibility || "shared";

    if (usersModule && usersModule.isMultiUser && usersModule.isMultiUser() && !ownerId) {
      return { error: "ownerId required in multi-user mode" };
    }

    var createdAt = Date.now();
    var sessionIds = [];
    var errors = [];

    for (var i = 0; i < rawTasks.length; i++) {
      var task = normalizeTask(rawTasks[i], i);
      if (!task) {
        errors.push({ index: i, error: "invalid task" });
        continue;
      }
      try {
        var session = sm.createSessionRaw({
          vendor: vendor,
          ownerId: ownerId,
          sessionVisibility: sessionVisibility,
        });
        session.title = (task.key ? task.key + " — " : "") + (task.title || "Plan");
        session.title = session.title.slice(0, 160);
        session.taskBatch = {
          batchId: batchId,
          batchTitle: batchTitle,
          source: source,
          project: project,
          version: version,
          parentSessionId: parentSessionId,
          task: task,
          role: "planner",
          createdAt: createdAt,
          batchIndex: i,
          batchSize: rawTasks.length,
        };

        var prompt = buildPrompt(task, project, version, promptMode, opts.promptText);

        sm.saveSessionFile(session);

        var userMsg = { type: "user_message", text: prompt };
        session.history.push(userMsg);
        sm.appendToSessionFile(session, userMsg);

        session.isProcessing = true;
        session.sentToolResults = {};
        if (sendToSession) {
          sendToSession(session.localId, { type: "status", status: "processing" });
        }

        sdk.startQuery(session, prompt, undefined, getLinuxUserForSession ? getLinuxUserForSession(session) : null);

        sessionIds.push(session.localId);
      } catch (e) {
        errors.push({ index: i, error: (e && e.message) || String(e) });
      }
    }

    if (sessionIds.length > 0) {
      if (onProcessingChanged) onProcessingChanged();
      sm.broadcastSessionList();
      send({
        type: "task_batch_launched",
        batchId: batchId,
        batchTitle: batchTitle,
        source: source,
        project: project,
        version: version,
        parentSessionId: parentSessionId,
        sessionIds: sessionIds,
        errors: errors,
      });
    }

    return { batchId: batchId, sessionIds: sessionIds, errors: errors };
  }

  function buildPrompt(task, project, version, promptMode, userText) {
    var vars = { project: project || "", version: version || "", task: task };
    if (promptMode === "replace") {
      return renderTemplate(String(userText || ""), vars);
    }
    var rendered = renderTemplate(DEFAULT_PLANNER_TEMPLATE, vars);
    if (promptMode === "append" && userText && String(userText).trim()) {
      rendered += "\n\nAdditional instructions:\n" + String(userText).trim();
    }
    return rendered;
  }

  function handleTaskLauncherMessage(ws, msg) {
    if (msg.type !== "launch_task_batch") return false;
    var ownerId = (ws._clayUser && usersModule && usersModule.isMultiUser && usersModule.isMultiUser())
      ? ws._clayUser.id : null;
    var result = launchBatch({
      tasks: msg.tasks,
      project: msg.project,
      version: msg.version,
      batchTitle: msg.batchTitle,
      source: msg.source,
      parentSessionId: msg.parentSessionId,
      promptMode: msg.promptMode,
      promptText: msg.promptText,
      vendor: msg.vendor,
      ownerId: ownerId,
      sessionVisibility: msg.sessionVisibility,
    });
    if (result.error) {
      sendTo(ws, { type: "task_batch_error", error: result.error });
    } else {
      sendTo(ws, {
        type: "task_batch_ack",
        batchId: result.batchId,
        sessionIds: result.sessionIds,
        errors: result.errors,
      });
    }
    return true;
  }

  return {
    handleTaskLauncherMessage: handleTaskLauncherMessage,
    launchBatch: launchBatch,
    DEFAULT_PLANNER_TEMPLATE: DEFAULT_PLANNER_TEMPLATE,
    MAX_TASKS_PER_BATCH: MAX_TASKS_PER_BATCH,
  };
}

module.exports = {
  attachTaskLauncher: attachTaskLauncher,
  DEFAULT_PLANNER_TEMPLATE: DEFAULT_PLANNER_TEMPLATE,
  MAX_TASKS_PER_BATCH: MAX_TASKS_PER_BATCH,
};
