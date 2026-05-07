// Clay FAB + popover chat — phablet-style, persistent across the app.
// Self-contained: own DOM, own renderer, own WS protocol (home_clay_*).
// Does not interfere with the active project session.

import { escapeHtml } from './utils.js';
import { getWs } from './ws-ref.js';
import { renderMarkdown } from './markdown.js';
import { switchProject } from './app-projects.js';

var initialized = false;
var openState = false;
var fabBtn = null;
var popoverEl = null;
var messagesEl = null;
var inputEl = null;
var sendBtn = null;
var typingEl = null;
var newBtnEl = null;
var closeBtnEl = null;

// Per-turn assembly state. Server may emit many delta events for a single
// assistant turn; we accumulate text and render incrementally into the
// last bubble.
var currentAssistantBubble = null;
var currentAssistantText = "";
var openedOnce = false;  // gate the initial home_clay_open request

export function initHomeChat() {
  if (initialized) return;
  initialized = true;

  fabBtn = document.getElementById("clay-fab");
  popoverEl = document.getElementById("clay-popover");
  messagesEl = document.getElementById("home-chat-messages");
  inputEl = document.getElementById("home-chat-input");
  sendBtn = document.getElementById("home-chat-send-btn");
  typingEl = document.getElementById("home-chat-typing");
  newBtnEl = document.getElementById("home-chat-new-btn");
  closeBtnEl = document.getElementById("home-chat-close-btn");

  if (!fabBtn || !popoverEl || !messagesEl || !inputEl || !sendBtn) return;

  // --- FAB toggle ---
  fabBtn.addEventListener("click", toggleOpen);
  if (closeBtnEl) closeBtnEl.addEventListener("click", closePopover);

  // ESC closes the popover.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openState) {
      closePopover();
    }
  });

  // --- Input handling ---
  inputEl.addEventListener("input", function () {
    autoResize();
    sendBtn.disabled = inputEl.value.trim().length === 0;
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.addEventListener("click", doSend);
  if (newBtnEl) {
    newBtnEl.addEventListener("click", function () {
      var ws = getWs();
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "home_clay_new_session" }));
      messagesEl.innerHTML = "";
      currentAssistantBubble = null;
      currentAssistantText = "";
      hideTyping();
      addSystemBubble("New conversation started.");
    });
  }
}

function openPopover() {
  if (!popoverEl || openState) return;
  openState = true;
  popoverEl.classList.remove("hidden");
  if (fabBtn) fabBtn.classList.add("open");
  // Pull session history on first open. If WS isn't ready yet, leave
  // openedOnce false so the next open retries.
  if (!openedOnce) {
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      openedOnce = true;
      requestSession();
    } else {
      addSystemBubble("Connecting…");
    }
  }
  // Focus the input so the user can start typing immediately.
  setTimeout(function () { if (inputEl) inputEl.focus(); }, 60);
}

function closePopover() {
  if (!openState) return;
  openState = false;
  if (popoverEl) popoverEl.classList.add("hidden");
  if (fabBtn) {
    fabBtn.classList.remove("open");
    fabBtn.focus();
  }
}

function toggleOpen() {
  if (openState) closePopover(); else openPopover();
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(120, inputEl.scrollHeight) + "px";
}

function requestSession() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "home_clay_open" }));
}

function doSend() {
  var text = inputEl.value.trim();
  if (!text) return;
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;

  // Optimistic render of the user's message.
  addUserBubble(text);
  inputEl.value = "";
  autoResize();
  sendBtn.disabled = true;

  ws.send(JSON.stringify({ type: "home_clay_send", text: text }));
  showTyping();
}

// --- Rendering ---

function addUserBubble(text) {
  finalizeAssistant();
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-user";
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
}

function ensureAssistantBubble() {
  if (currentAssistantBubble) return currentAssistantBubble;
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-clay";
  messagesEl.appendChild(bubble);
  currentAssistantBubble = bubble;
  currentAssistantText = "";
  return bubble;
}

function appendAssistantText(text) {
  var bubble = ensureAssistantBubble();
  currentAssistantText += text;
  bubble.innerHTML = linkifyRefs(renderMarkdown(currentAssistantText));
  scrollToBottom();
}

function finalizeAssistant() {
  if (currentAssistantBubble && !currentAssistantText) {
    currentAssistantBubble.remove();
  }
  currentAssistantBubble = null;
  currentAssistantText = "";
}

function addSystemBubble(text) {
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-system";
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
}

function linkifyRefs(html) {
  // Match [slug/sess_id - date]. Conservative: slug is alphanumeric/-/_,
  // sess id starts with sess_.
  var re = /\[([a-zA-Z0-9_\-]+)\/(sess_[a-zA-Z0-9_\-]+)(?:\s+[—-]\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\]/g;
  return html.replace(re, function (_full, slug, sessId, date) {
    var label = slug + "/" + sessId.substring(0, 14) + (date ? " · " + date : "");
    return '<span class="home-chat-ref" data-slug="' + escapeHtml(slug) + '" data-session="' + escapeHtml(sessId) + '">' + escapeHtml(label) + '</span>';
  });
}

function scrollToBottom() {
  if (!messagesEl) return;
  requestAnimationFrame(function () {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function showTyping() { if (typingEl) typingEl.classList.remove("hidden"); }
function hideTyping() { if (typingEl) typingEl.classList.add("hidden"); }

// --- Server message handlers (called from app-messages.js dispatcher) ---

export function handleHomeClayHistory(msg) {
  if (!messagesEl) return;
  messagesEl.innerHTML = "";
  currentAssistantBubble = null;
  currentAssistantText = "";
  hideTyping();
  var entries = msg.messages || [];
  if (entries.length === 0) {
    addSystemBubble("Hi — I'm Clay. I can search every session, project, and decision in your workspace. What are you trying to find?");
    return;
  }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.role === "user") {
      addUserBubble(e.text || "");
    } else if (e.role === "assistant") {
      appendAssistantText(e.text || "");
      finalizeAssistant();
    }
  }
}

export function handleHomeClayDelta(msg) {
  hideTyping();
  if (typeof msg.text === "string") appendAssistantText(msg.text);
}

export function handleHomeClayDone() {
  hideTyping();
  finalizeAssistant();
}

export function handleHomeClayError(msg) {
  hideTyping();
  finalizeAssistant();
  addSystemBubble("Error: " + (msg.text || "unknown"));
}

// --- Click delegation for session ref chips ---

document.addEventListener("click", function (e) {
  var chip = e.target && e.target.closest && e.target.closest(".home-chat-ref");
  if (!chip) return;
  var slug = chip.dataset.slug;
  if (!slug) return;
  closePopover();
  if (typeof switchProject === "function") {
    switchProject(slug);
  }
});

// --- Initialize on DOM ready ---

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHomeChat);
  } else {
    initHomeChat();
  }
}
