// Spawn MCP Server for Clay
// Exposes a spawn_session tool that lets an agent create new Clay sessions
// inside the current project and seed each one with an initial user message.
//
// Primary use case: a planning session triages a list of work items (JIRA
// issues, GitHub tickets, etc.) and fans them out into per-item sessions,
// each pre-titled and started with the relevant command (e.g. "/jira HARD-207").
//
// SDK-free: returns runtime-agnostic tool definitions for YOKE adapter.
//
// Usage:
//   var spawnMcp = require("./spawn-mcp-server");
//   var toolDefs = spawnMcp.getToolDefs(onSpawn);
//   var mcpConfig = adapter.createToolServer({ name: "clay-sessions", version: "1.0.0", tools: toolDefs });

var z;
try { z = require("zod"); } catch (e) { z = null; }

function buildShape(props, required) {
  if (!z) return {};
  var shape = {};
  var keys = Object.keys(props);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var p = props[k];
    var field;
    if (p.type === "number") field = z.number();
    else if (p.type === "boolean") field = z.boolean();
    else if (p.enum) field = z.enum(p.enum);
    else field = z.string();
    if (p.description) field = field.describe(p.description);
    if (!required || required.indexOf(k) === -1) field = field.optional();
    shape[k] = field;
  }
  return shape;
}

// onSpawn(args) -> Promise<{ sessionId, title }>
// args: { title, initial_prompt, vendor? }
// Throws (or rejects) for invalid input or runtime errors; the wrapper
// translates errors into an isError tool result so the calling agent sees them.
function getToolDefs(onSpawn) {
  var tools = [];

  tools.push({
    name: "spawn_session",
    description:
      "Create a new Clay session in the current project, set its title, and " +
      "send an initial user message to it. Returns immediately so the caller " +
      "can spawn multiple sessions in one turn. Use this to fan out a list " +
      "of work items (e.g. JIRA issues) into per-item sessions, each started " +
      "with the appropriate slash command (e.g. \"/jira HARD-207\"). The title " +
      "is marked as manual and will not be overwritten by Clay's auto-title.",
    inputSchema: buildShape({
      title: {
        type: "string",
        description: "Title for the new session, e.g. the issue key \"HARD-207\".",
      },
      initial_prompt: {
        type: "string",
        description:
          "First user message sent to the new session. Slash commands pass " +
          "through verbatim (e.g. \"/jira HARD-207\").",
      },
      vendor: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Optional vendor for the new session. Defaults to \"claude\".",
      },
    }, ["title", "initial_prompt"]),
    handler: function (args) {
      var title = (args.title || "").trim();
      var initialPrompt = (args.initial_prompt || "").trim();
      var vendor = args.vendor || "claude";

      if (!title) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: title is required and must be non-empty." }],
          isError: true,
        });
      }
      if (!initialPrompt) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: initial_prompt is required and must be non-empty." }],
          isError: true,
        });
      }

      return Promise.resolve()
        .then(function () { return onSpawn({ title: title, initialPrompt: initialPrompt, vendor: vendor }); })
        .then(function (result) {
          var sid = result && result.sessionId;
          var t = (result && result.title) || title;
          return {
            content: [{
              type: "text",
              text: "Spawned session #" + sid + " \"" + t + "\". Initial prompt queued.",
            }],
          };
        })
        .catch(function (err) {
          return {
            content: [{ type: "text", text: "Error spawning session: " + (err && err.message || err) }],
            isError: true,
          };
        });
    },
  });

  return tools;
}

module.exports = { getToolDefs: getToolDefs };
