// Sessions MCP Server for Clay
// Exposes session-fan-out tools so an in-session agent can spawn sibling
// sessions in the same project, check their status, and wait for them.
//
// Convention: parentSessionId is determined from sm.getActiveSession() at
// call time, matching the existing clay-ask-user pattern. This is reliable
// when the user is interacting with the focused session (the typical
// orchestration flow). Background-loop spawns may attribute parent to the
// last-focused session; document this if the limitation matters.

var z;
try { z = require("zod"); } catch (e) { z = null; }

var MAX_BATCH = 10;
var MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes hard cap
var DEFAULT_WAIT_MS = 5 * 60 * 1000; // 5 minutes default
var POLL_INTERVAL_MS = 500;

function buildShapes() {
  if (!z) return {};

  var visibilityField = z.enum(["shared", "private"]).optional()
    .describe("Session visibility. 'shared' (default) is visible to all project users; 'private' is owner-only.");
  var vendorField = z.enum(["claude", "codex"]).optional()
    .describe("Agent vendor for the new session. Defaults to the project's primary vendor.");

  return {
    spawn: {
      prompt: z.string().min(1)
        .describe("Initial user message for the new session. The new session starts processing this immediately."),
      title: z.string().max(100).optional()
        .describe("Optional session title shown in the sidebar. Defaults to the first 60 chars of prompt."),
      vendor: vendorField,
      visibility: visibilityField,
    },
    spawnMany: {
      sessions: z.array(z.object({
        prompt: z.string().min(1)
          .describe("Initial user message for this child session."),
        title: z.string().max(100).optional()
          .describe("Optional title for this child session."),
      })).min(1).max(MAX_BATCH)
        .describe("Batch of child sessions to spawn. Each entry runs in parallel as its own session."),
      vendor: vendorField,
      visibility: visibilityField,
    },
    status: {
      sessionId: z.number().int().nonnegative()
        .describe("The localId returned by spawn_session / spawn_sessions."),
    },
    wait: {
      sessionId: z.number().int().nonnegative()
        .describe("The localId returned by spawn_session / spawn_sessions."),
      timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional()
        .describe("Max ms to wait for the session to stop processing. Default 5 minutes, hard cap 15 minutes."),
    },
  };
}

var SPAWN_DESCRIPTION = [
  "Spawn a new sibling session in the current Clay project, seeded with an initial user message.",
  "The new session runs in parallel; this call returns immediately with the new session's localId.",
  "Use this to fan out independent work-streams (e.g. after a planning phase, kick off N sessions to implement N features in parallel).",
  "The new session's parentSessionId is set to the calling session, so the UI can render the relationship.",
].join(" ");

var SPAWN_MANY_DESCRIPTION = [
  "Spawn multiple sibling sessions at once. Each entry in `sessions` becomes its own session with its own initial prompt.",
  "Returns an array of { localId, title } for the spawned sessions.",
  "Prefer this over multiple spawn_session calls when fanning out a planned set of tasks.",
  "Hard cap: " + MAX_BATCH + " sessions per call.",
].join(" ");

var STATUS_DESCRIPTION = [
  "Get the current status of a previously spawned session: title, isProcessing, turnCount, lastActivity, and the most recent user/assistant text snippet.",
  "Use this to check on a child session without blocking. For blocking, use wait_for_session.",
].join(" ");

var WAIT_DESCRIPTION = [
  "Block until the given session stops processing (its turn ends), or until timeoutMs elapses.",
  "Returns the same shape as get_session_status, plus { timedOut: true|false }.",
  "Default timeout 5 minutes, hard cap 15 minutes. Use this AFTER you have other work queued; otherwise prefer status polling.",
].join(" ");

function getToolDefs(handlers) {
  var shapes = buildShapes();
  var tools = [];

  tools.push({
    name: "spawn_session",
    description: SPAWN_DESCRIPTION,
    inputSchema: shapes.spawn,
    handler: function (args) {
      if (!args || typeof args.prompt !== "string" || args.prompt.length === 0) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: `prompt` is required." }],
          isError: true,
        });
      }
      try {
        var result = handlers.onSpawn(args);
        return Promise.resolve({
          content: [{
            type: "text",
            text: "Spawned session #" + result.localId + " (\"" + (result.title || "") + "\"). It is now running in parallel. Use get_session_status(" + result.localId + ") to check on it, or wait_for_session(" + result.localId + ") to block until it finishes.",
          }],
        });
      } catch (e) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error spawning session: " + (e.message || String(e)) }],
          isError: true,
        });
      }
    },
  });

  tools.push({
    name: "spawn_sessions",
    description: SPAWN_MANY_DESCRIPTION,
    inputSchema: shapes.spawnMany,
    handler: function (args) {
      if (!args || !Array.isArray(args.sessions) || args.sessions.length === 0) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: `sessions` must be a non-empty array." }],
          isError: true,
        });
      }
      if (args.sessions.length > MAX_BATCH) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: cannot spawn more than " + MAX_BATCH + " sessions in one call." }],
          isError: true,
        });
      }
      try {
        var spawned = [];
        for (var i = 0; i < args.sessions.length; i++) {
          var s = args.sessions[i];
          var result = handlers.onSpawn({
            prompt: s.prompt,
            title: s.title,
            vendor: args.vendor,
            visibility: args.visibility,
          });
          spawned.push({ localId: result.localId, title: result.title || "" });
        }
        var summary = spawned.map(function (s) { return "#" + s.localId + " (\"" + s.title + "\")"; }).join(", ");
        return Promise.resolve({
          content: [{
            type: "text",
            text: "Spawned " + spawned.length + " sessions in parallel: " + summary + ". They are running independently. Poll get_session_status or call wait_for_session to track them.",
          }],
        });
      } catch (e) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error spawning sessions: " + (e.message || String(e)) }],
          isError: true,
        });
      }
    },
  });

  tools.push({
    name: "get_session_status",
    description: STATUS_DESCRIPTION,
    inputSchema: shapes.status,
    handler: function (args) {
      if (!args || typeof args.sessionId !== "number") {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: `sessionId` is required." }],
          isError: true,
        });
      }
      var status = handlers.onStatus(args.sessionId);
      if (!status) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: no session #" + args.sessionId + " in this project." }],
          isError: true,
        });
      }
      return Promise.resolve({
        content: [{ type: "text", text: formatStatus(status) }],
      });
    },
  });

  tools.push({
    name: "wait_for_session",
    description: WAIT_DESCRIPTION,
    inputSchema: shapes.wait,
    handler: function (args) {
      if (!args || typeof args.sessionId !== "number") {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: `sessionId` is required." }],
          isError: true,
        });
      }
      var timeoutMs = (typeof args.timeoutMs === "number" && args.timeoutMs > 0)
        ? Math.min(args.timeoutMs, MAX_WAIT_MS)
        : DEFAULT_WAIT_MS;
      return handlers.onWait(args.sessionId, timeoutMs, POLL_INTERVAL_MS).then(function (result) {
        if (!result || !result.status) {
          return {
            content: [{ type: "text", text: "Error: no session #" + args.sessionId + " in this project." }],
            isError: true,
          };
        }
        var prefix = result.timedOut
          ? "Timed out after " + timeoutMs + "ms (session still processing). "
          : "Session finished. ";
        return { content: [{ type: "text", text: prefix + formatStatus(result.status) }] };
      });
    },
  });

  return tools;
}

function formatStatus(s) {
  var lines = [];
  lines.push("Session #" + s.localId + " (\"" + (s.title || "") + "\")");
  lines.push("  isProcessing: " + (s.isProcessing ? "true" : "false"));
  lines.push("  turnCount: " + (s.turnCount || 0));
  lines.push("  vendor: " + (s.vendor || "(default)"));
  if (typeof s.parentSessionId === "number") lines.push("  parentSessionId: " + s.parentSessionId);
  if (s.lastUserText) lines.push("  lastUser: " + truncate(s.lastUserText, 200));
  if (s.lastAssistantText) lines.push("  lastAssistant: " + truncate(s.lastAssistantText, 400));
  return lines.join("\n");
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

module.exports = { getToolDefs: getToolDefs };
