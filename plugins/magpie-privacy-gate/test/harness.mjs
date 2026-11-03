// test/harness.mjs — proves the gate runs under moejs-style constraints and makes
// the right allow/reject decision for every protocol shape magpie's gateway can
// hand a middleware.
//
// The middleware is NOT imported the way Node would import a module. magpie's
// gateway runs it inside moejs (a JavaScript engine written in Go), compiled once
// per file, with named exports collected from the module. This harness reproduces
// the load with node:vm: a bare context whose only extra global is console.log,
// then the file's `export` keywords stripped (the only module syntax it uses) and
// the rest evaluated as a plain script. If the file needed require, process,
// fetch, a timer, a Node built-in or an import today, the load below would fail.
//
// Run: node test/harness.mjs      (no network, no installs, no magpie needed)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");
const SOURCE_PATH = join(PLUGIN_DIR, "gate.middleware.js");
const SOURCE = readFileSync(SOURCE_PATH, "utf8");
const PKG = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));

// Synthetic payloads only. Nothing here is a real document, image or PII.
const B64 = "QUJD"; // base64 of "ABC", repeated to make synthetic payloads
const BLOB = B64.repeat(700); // 2800 chars -> over the 2048 base64 threshold
const BLOB_24 = BLOB.slice(0, 24);
const DATA_URI = "data:image/png;base64," + B64.repeat(60); // 240 chars payload
const HEX_BLOB = "a3f9".repeat(300); // 1200 chars -> over the 1024 hex threshold
const WRAPPED = new Array(40)
  .fill("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk")
  .join("\n");

// ---------------------------------------------------------------------------
// Loading, exactly as the gateway would do it: one file, bare context, console.
// ---------------------------------------------------------------------------

function loadGate() {
  const logs = [];
  const sandbox = {
    console: { log: (...args) => logs.push(args.map((a) => String(a)).join(" ")) },
  };
  const context = vm.createContext(sandbox);
  const script = SOURCE.replace(/^export\s+/gm, "");
  new vm.Script(script, { filename: "gate.middleware.js" }).runInContext(context);
  const globals = JSON.parse(
    vm.runInContext(
      "JSON.stringify({" +
        "fetch: typeof fetch, require: typeof require, process: typeof process," +
        "setTimeout: typeof setTimeout, setInterval: typeof setInterval," +
        "Buffer: typeof Buffer, module: typeof module, XMLHttpRequest: typeof XMLHttpRequest," +
        "WebSocket: typeof WebSocket, queueMicrotask: typeof queueMicrotask})",
      context
    )
  );
  return {
    onRequest: sandbox.onRequest,
    onProvider: sandbox.onProvider,
    onUsage: sandbox.onUsage,
    logs,
    context,
    globals,
  };
}

// ---------------------------------------------------------------------------
// Decision helpers
// ---------------------------------------------------------------------------

function mkCtx({ protocol = "chat", model = "deepseek/deepseek-v4", options, canReject = true } = {}) {
  const seen = [];
  const ctx = { protocol, model, stream: false, path: "/v1", options, state: {} };
  if (canReject) {
    // magpie's host rejects on the call and returns nothing; model that faithfully.
    ctx.reject = (status, message) => {
      seen.push({ status, message });
      return undefined;
    };
  }
  return { ctx, seen };
}

function allow(gate, body, ctx, seen) {
  const out = gate.onRequest(body, ctx);
  assert.equal(out, body, "an allowed request must be returned unchanged");
  assert.equal(seen.length, 0, "an allowed request must not call ctx.reject");
}

function reject(gate, body, ctx, seen, contains) {
  const out = gate.onRequest(body, ctx);
  assert.equal(out, undefined, "a rejected request returns nothing after ctx.reject(...)");
  assert.equal(seen.length, 1, "exactly one reject per request");
  assert.equal(seen[0].status, 403);
  const message = seen[0].message;
  assert.ok(typeof message === "string" && message.length > 0);
  if (contains) {
    assert.ok(
      message.toLowerCase().includes(contains.toLowerCase()),
      `expected the 403 message to mention "${contains}", got: ${message}`
    );
  }
  assert.ok(!message.includes(BLOB_24), "a 403 message must never echo request content");
  assert.ok(!message.includes("data:image"), "a 403 message must never echo request content");
  return message;
}

const markerPresent = (value) => JSON.stringify(value).includes("[privacy-gate: content withheld locally]");

// ---------------------------------------------------------------------------
// Protocol-shaped fixtures (synthetic text only; binaries are fake base64 runs)
// ---------------------------------------------------------------------------

const chat = {
  text: () => ({
    model: "deepseek/deepseek-v4",
    messages: [{ role: "user", content: "Summarise the attached order, ref 4711." }],
  }),
  imageUrl: () => ({
    model: "deepseek/deepseek-v4",
    messages: [
      { role: "user", content: [{ type: "text", text: "what is in this screenshot?" },
        { type: "image_url", image_url: { url: DATA_URI } }] },
    ],
  }),
  filePart: () => ({
    model: "deepseek/deepseek-v4",
    messages: [{ role: "user", content: [{ type: "text", text: "read this" },
      { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64," + B64.repeat(40) } }] }],
  }),
  audioPart: () => ({
    model: "deepseek/deepseek-v4",
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { format: "wav", data: B64.repeat(40) } }] }],
  }),
  toolCallBlob: () => ({
    model: "deepseek/deepseek-v4",
    messages: [
      { role: "user", content: "continue" },
      { role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: "x.pdf", data: BLOB }) } }] },
    ],
  }),
  toolArgFile: () => ({
    model: "deepseek/deepseek-v4",
    messages: [{ role: "assistant", content: null,
      tool_calls: [{ id: "call_2", type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ file: "report.txt" }) } }] }],
  }),
  toolSchema: () => ({
    model: "deepseek/deepseek-v4",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function",
      function: { name: "f", description: "takes a picture",
        parameters: { type: "object", properties: { image: { type: "string" }, file: { type: "string" } } } } }],
  }),
};

const responses = {
  text: () => ({
    model: "deepseek/deepseek-v4",
    instructions: "You are helpful.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  }),
  inputImage: () => ({
    model: "deepseek/deepseek-v4",
    input: [{ type: "message", role: "user",
      content: [{ type: "input_text", text: "describe" },
        { type: "input_image", image_url: "https://example.invalid/x.png" }] }],
  }),
  inputFile: () => ({
    model: "deepseek/deepseek-v4",
    input: [{ type: "message", role: "user",
      content: [{ type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64," + B64.repeat(40) }] }],
  }),
  toolOutputImage: () => ({
    model: "deepseek/deepseek-v4",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "function_call_output", call_id: "c1",
        output: [{ type: "input_image", image_url: "https://example.invalid/y.png" }] },
    ],
  }),
};

const anthropic = {
  text: () => ({
    model: "deepseek/deepseek-v4",
    system: [{ type: "text", text: "Be terse." }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }),
  image: () => ({
    model: "deepseek/deepseek-v4",
    messages: [{ role: "user", content: [{ type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: B64.repeat(40) } }] }],
  }),
  document: () => ({
    model: "deepseek/deepseek-v4",
    messages: [{ role: "user", content: [{ type: "text", text: "read" },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "synthetic" } }] }],
  }),
  toolResultImage: () => ({
    model: "deepseek/deepseek-v4",
    messages: [
      { role: "user", content: "go" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: B64.repeat(40) } }] }] },
    ],
  }),
};

const gemini = {
  text: () => ({
    model: "deepseek/deepseek-v4",
    systemInstruction: { parts: [{ text: "Be brief." }] },
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  }),
  inlineData: () => ({
    model: "deepseek/deepseek-v4",
    contents: [{ role: "user", parts: [{ text: "what is this" },
      { inlineData: { mimeType: "image/png", data: B64.repeat(40) } }] }],
  }),
  snakeInline: () => ({
    model: "deepseek/deepseek-v4",
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: "application/pdf", data: BLOB } }] }],
  }),
  fileData: () => ({
    model: "deepseek/deepseek-v4",
    contents: [{ role: "user", parts: [{ text: "read" },
      { fileData: { mimeType: "application/pdf", fileUri: "https://example.invalid/a.pdf" } }] }],
  }),
  functionArgBlob: () => ({
    model: "deepseek/deepseek-v4",
    contents: [{ role: "user", parts: [{ functionResponse: { name: "f", response: { data: BLOB } } }] }],
  }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok   - " + name);
  } catch (err) {
    failures.push({ name, error: err });
    console.log("FAIL - " + name);
    console.log("       " + String((err && err.message) || err).split("\n").join("\n       "));
  }
}

// --- packaging and the moejs constraint -----------------------------------

test("package.json declares the middleware and no main/exports (middleware only)", () => {
  assert.equal(PKG.magpie.middleware, "./gate.middleware.js");
  assert.ok(!("main" in PKG), "no main: the package is middleware only");
  assert.ok(!("exports" in PKG), "no exports: the package is middleware only");
});

test("middleware source contains no network, timer, Node API or import usage", () => {
  const forbidden = [
    ["fetch(", /\bfetch\s*\(/],
    ["require(", /\brequire\s*\(/],
    ["setTimeout", /\bsetTimeout\b/],
    ["setInterval", /\bsetInterval\b/],
    ["process.", /\bprocess\s*\./],
    ["node: specifier", /["']node:/],
    ["import statement", /^\s*import\b/m],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["WebSocket", /\bWebSocket\b/],
    ["Buffer", /\bBuffer\b/],
    ["eval(", /\beval\s*\(/],
    ["new Function", /\bnew\s+Function\b/],
    ["Math.random", /\bMath\s*\.\s*random\b/],
    ["Date.now", /\bDate\s*\.\s*now\b/],
  ];
  for (const [label, re] of forbidden) {
    assert.ok(!re.test(SOURCE), `gate.middleware.js must not contain ${label}`);
  }
});

test("middleware exports the hooks as named exports", () => {
  for (const hook of ["onRequest", "onProvider", "onUsage"]) {
    assert.ok(
      new RegExp(`^export\\s+function\\s+${hook}\\b`, "m").test(SOURCE),
      `expected a named export for ${hook}`
    );
  }
});

test("middleware loads in a bare vm context with only console.log added", () => {
  const gate = loadGate();
  assert.equal(typeof gate.onRequest, "function");
  assert.equal(typeof gate.onProvider, "function");
  assert.equal(typeof gate.onUsage, "function");
});

test("the vm context has no Node or browser escape hatches", () => {
  const { globals } = loadGate();
  for (const key of Object.keys(globals)) {
    assert.equal(globals[key], "undefined", `${key} must not exist in the moejs-like context`);
  }
});

// --- chat completions ----------------------------------------------------

test("chat: text-only request is allowed unchanged", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  allow(gate, chat.text(), ctx, seen);
  assert.equal(gate.logs.length, 0, "an allowed request logs nothing");
});

test("chat: image_url part is rejected with 403 and no content echo", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  reject(gate, chat.imageUrl(), ctx, seen, "image_url");
});

test("chat: file part is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  reject(gate, chat.filePart(), ctx, seen, "file");
});

test("chat: input_audio part is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  reject(gate, chat.audioPart(), ctx, seen, "input_audio");
});

test("chat: base64 smuggled through a text field is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const body = { model: "deepseek/deepseek-v4", messages: [{ role: "user", content: "here: " + BLOB }] };
  reject(gate, body, ctx, seen, "blob");
});

test("chat: base64 smuggled through assistant tool-call arguments is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  reject(gate, chat.toolCallBlob(), ctx, seen, "blob");
});

test("chat: hex blob and data: URI in text are rejected", () => {
  const gate = loadGate();
  let r = mkCtx();
  reject(gate, { model: "m/x", messages: [{ role: "user", content: HEX_BLOB }] }, r.ctx, r.seen, "blob");
  r = mkCtx();
  reject(gate, { model: "m/x", messages: [{ role: "user", content: "look " + DATA_URI }] }, r.ctx, r.seen, "blob");
});

test("chat: wrapped base64 (many short lines) is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  reject(gate, { model: "m/x", messages: [{ role: "user", content: WRAPPED }] }, ctx, seen, "blob");
});

test("chat: long prose, UUID, semver and a 64-char hash are not false positives", () => {
  const gate = loadGate();
  const prose = "Please summarise. ".repeat(240); // ~4300 chars of text
  const benign =
    "uuid 123e4567-e89b-12d3-a456-426614174000, version 1.2.3, " +
    "hash d41d8cd98f00b204e9800998ecf8427e, ip 127.0.0.1";
  const { ctx, seen } = mkCtx();
  allow(gate, { model: "m/x", messages: [{ role: "user", content: prose + benign }] }, ctx, seen);
});

test("chat: tool schemas and ordinary tool arguments are not treated as binaries", () => {
  const gate = loadGate();
  let r = mkCtx();
  allow(gate, chat.toolSchema(), r.ctx, r.seen);
  r = mkCtx();
  allow(gate, chat.toolArgFile(), r.ctx, r.seen);
});

// --- OpenAI Responses ----------------------------------------------------

test("responses: text-only request is allowed", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  allow(gate, responses.text(), ctx, seen);
});

test("responses: input_image is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  reject(gate, responses.inputImage(), ctx, seen, "input_image");
});

test("responses: input_file is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  reject(gate, responses.inputFile(), ctx, seen, "input_file");
});

test("responses: an image inside function_call_output is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  reject(gate, responses.toolOutputImage(), ctx, seen, "input_image");
});

// --- Anthropic Messages --------------------------------------------------

test("anthropic: text-only request with system blocks is allowed", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "anthropic" });
  allow(gate, anthropic.text(), ctx, seen);
});

test("anthropic: image block is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "anthropic" });
  reject(gate, anthropic.image(), ctx, seen, "image");
});

test("anthropic: document block is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "anthropic" });
  reject(gate, anthropic.document(), ctx, seen, "document");
});

test("anthropic: an image inside tool_result is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "anthropic" });
  reject(gate, anthropic.toolResultImage(), ctx, seen, "image");
});

// --- Gemini --------------------------------------------------------------

test("gemini: text-only request is allowed", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "gemini" });
  allow(gate, gemini.text(), ctx, seen);
});

test("gemini: inlineData is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "gemini" });
  reject(gate, gemini.inlineData(), ctx, seen, "inlineData");
});

test("gemini: snake_case inline_data is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "gemini" });
  reject(gate, gemini.snakeInline(), ctx, seen, "inline_data");
});

test("gemini: fileData is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "gemini" });
  reject(gate, gemini.fileData(), ctx, seen, "fileData");
});

test("gemini: a blob inside functionResponse is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "gemini" });
  reject(gate, gemini.functionArgBlob(), ctx, seen, "blob");
});

// --- policy: local models, model allowlist, protocol, limits ------------

test("policy: a localModels match may receive an image part", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({
    model: "ollama/llava",
    options: { localModels: ["ollama/*", "lmstudio/*"] },
  });
  allow(gate, { model: "ollama/llava", messages: chat.imageUrl().messages }, ctx, seen);
});

test("policy: localModels is a suffix/glob decision, not a substring one", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ model: "openai/gpt-5", options: { localModels: ["ollama/*"] } });
  reject(gate, chat.imageUrl(), ctx, seen, "image_url");
});

test("policy: localModels does not waive the blob rule", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ model: "ollama/llava", options: { localModels: ["ollama/*"] } });
  reject(gate, { model: "ollama/llava", messages: [{ role: "user", content: BLOB }] }, ctx, seen, "blob");
});

test("policy: model allowlist allows a matching model and rejects the rest", () => {
  const gate = loadGate();
  let r = mkCtx({ model: "deepseek/deepseek-v4", options: { allowModels: ["deepseek/*"] } });
  allow(gate, chat.text(), r.ctx, r.seen);
  r = mkCtx({ model: "openai/gpt-5", options: { allowModels: ["deepseek/*"] } });
  const message = reject(gate, chat.text(), r.ctx, r.seen, "allowlist");
  assert.ok(message.includes("openai/gpt-5"), "the 403 must name the model");
});

test("policy: empty allowModels means every model passes rule 3", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ model: "anything/at-all", options: {} });
  allow(gate, chat.text(), ctx, seen);
});

test("policy: an unknown protocol is rejected (fail closed) unless allowed", () => {
  const gate = loadGate();
  let r = mkCtx({ protocol: "ollama-native" });
  reject(gate, chat.text(), r.ctx, r.seen, "protocol");
  r = mkCtx({ protocol: "ollama-native", options: { allowUnknownProtocol: true } });
  allow(gate, chat.text(), r.ctx, r.seen);
});

test("policy: allowUnknownProtocol still rejects a binary part", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "other", options: { allowUnknownProtocol: true } });
  const body = { model: "m/x", input: [{ type: "message", content: [{ type: "input_image", image_url: "x" }] }] };
  reject(gate, body, ctx, seen, "input_image");
});

test("policy: a long conversation is not rejected for size (bounded scan, not refusal)", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  // ~1.05M chars: a normal 260k-token session must keep working.
  const big = "ordinary prose about an invoice and a date. ".repeat(24000);
  const body = { model: "m/x", messages: [{ role: "user", content: big }] };
  allow(gate, body, ctx, seen);
});

test("policy: a one-page document encoded as base64 is rejected even under 2k chars", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const smallDoc = B64.repeat(338); // 1352 chars: a ~1 KB PDF
  reject(gate, { model: "m/x", messages: [{ role: "user", content: smallDoc }] }, ctx, seen, "blob");
});

test("policy: a line-wrapped one-page document is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const wrapped = (B64.repeat(338).match(/.{1,64}/g) || []).join("\n");
  reject(gate, { model: "m/x", messages: [{ role: "user", content: wrapped }] }, ctx, seen, "blob");
});

test("policy: a Format-Hex style hex dump is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const lines = [];
  for (let i = 0; i < 80; i++) {
    const off = (i * 16).toString(16).padStart(8, "0");
    lines.push(off + "  25 50 44 46 2d 31 2e 34 20 0a 25 e2 e3 cf d3 0a");
  }
  reject(gate, { model: "m/x", messages: [{ role: "user", content: lines.join("\n") }] }, ctx, seen, "blob");
});

test("policy: a blob late in a large conversation is still found", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const messages = [];
  for (let i = 0; i < 600; i++) {
    messages.push({ role: "user", content: `Turn ${i}: ordinary prose about an invoice and a date.` });
  }
  messages.push({ role: "user", content: "and the bytes: " + BLOB });
  reject(gate, { model: "m/x", messages }, ctx, seen, "blob");
});

test("policy: ctx.reject returning nothing is still a rejection", () => {
  const gate = loadGate();
  const seen = [];
  const ctx = { protocol: "chat", model: "m/x", reject(status, message) { seen.push({ status, message }); } };
  const out = gate.onRequest(chat.imageUrl(), ctx);
  assert.equal(out, undefined, "returning nothing after ctx.reject is the rejection");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 403);
});

test("policy: a body that is not an object is rejected", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const out = gate.onRequest("just a string", ctx);
  assert.equal(out, undefined);
  assert.equal(seen[0].status, 403);
});

test("policy: an unreadable body rejects instead of throwing (fail closed)", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const body = { model: "m/x" };
  Object.defineProperty(body, "messages", {
    enumerable: true,
    get() {
      throw new Error("synthetic-boom");
    },
  });
  let out;
  assert.doesNotThrow(() => {
    out = gate.onRequest(body, ctx);
  }, "the hook must never throw: magpie would then send the request as it was");
  assert.equal(out, undefined);
  assert.equal(seen[0].status, 403);
  assert.ok(!seen[0].message.includes("synthetic-boom"));
});

// --- vendor-sealed signatures: replay fields must not look like smuggled bytes ---

const SIG = "QUJD".repeat(400); // 1600 base64 chars, like a real thinking signature
const SIG2 = "REVG".repeat(300); // 1200 base64 chars

test("chat/DSH: a thinkingSignature and a toolCall thoughtSignature are exempt", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const body = {
    model: "deepseek/deepseek-v4",
    messages: [
      { role: "user", content: "read the invoice" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Let me check the totals.", thinkingSignature: SIG },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" }, thoughtSignature: SIG2 },
      ] },
    ],
  };
  allow(gate, body, ctx, seen);
});

test("anthropic: a thinking block signature is exempt", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "anthropic" });
  const body = { model: "m/x", messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Checking.", signature: SIG },
      { type: "text", text: "done" },
    ] },
  ] };
  allow(gate, body, ctx, seen);
});

test("responses: a reasoning item encrypted_content is exempt", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  const body = { model: "m/x", input: [
    { type: "reasoning", id: "rs_1", encrypted_content: SIG, summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }] },
  ] };
  allow(gate, body, ctx, seen);
});

test("gemini: a part thoughtSignature is exempt", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "gemini" });
  const body = { model: "m/x", contents: [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [
      { text: "done" },
      { functionCall: { name: "read", args: { path: "a.txt" } }, thoughtSignature: SIG },
    ] },
  ] };
  allow(gate, body, ctx, seen);
});

test("signatures are exempt only inside vendor blocks: tool arguments still scanned", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx();
  const body = { model: "m/x", messages: [
    { role: "assistant", content: [
      { type: "toolCall", id: "call_1", name: "write", arguments: { signature: SIG } },
    ] },
  ] };
  reject(gate, body, ctx, seen, "blob");
});

test("signatures are exempt only inside vendor blocks: thinking text is still scanned", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "anthropic" });
  const body = { model: "m/x", messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: SIG, signature: "QUJD".repeat(400) }] },
  ] };
  reject(gate, body, ctx, seen, "blob");
});

test("responses reasoning: only encrypted_content is exempt, its content is scanned", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  const body = { model: "m/x", input: [
    { type: "reasoning", encrypted_content: SIG, content: [{ type: "reasoning_text", text: SIG }], summary: [] },
  ] };
  reject(gate, body, ctx, seen, "blob");
});

test("responses: vendor item ids that are themselves long base64 are exempt", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  const body = { model: "m/x", input: [
    { type: "reasoning", id: SIG, encrypted_content: SIG, summary: [] },
    { type: "message", id: SIG, role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ] };
  allow(gate, body, ctx, seen);
});

test("responses: a user item id is not exempt just because it is in input", () => {
  const gate = loadGate();
  const { ctx, seen } = mkCtx({ protocol: "responses" });
  const body = { model: "m/x", input: [
    { role: "user", id: SIG, content: [{ type: "input_text", text: "hi" }] },
  ] };
  reject(gate, body, ctx, seen, "blob");
});

// --- onProvider: cannot reject, must not leak ---------------------------

test("onProvider: never rejects, blanks the body when it finds bytes", () => {
  const gate = loadGate();
  const ctx = {
    protocol: "chat",
    model: "deepseek/deepseek-v4",
    reject() {
      throw new Error("onProvider must not reject");
    },
  };
  const out = gate.onProvider(chat.imageUrl(), ctx);
  assert.ok(markerPresent(out), "the sent body must be the content-less marker request");
  assert.ok(!JSON.stringify(out).includes(B64), "no payload may survive");
  assert.ok(!JSON.stringify(out).includes("image_url"), "no binary part may survive");
});

test("onProvider: a binary part to a provider not declared local is blanked even if the model id looks local", () => {
  const gate = loadGate();
  const body = chat.imageUrl();
  const ctx = {
    protocol: "chat",
    model: "ollama/llava",
    provider: { id: "some-remote-plugin", name: "Some Remote", model: "ollama/llava" },
    options: { localModels: ["ollama/*"], localProviders: ["ollama"] },
  };
  const out = gate.onProvider(body, ctx);
  assert.ok(markerPresent(out), "the provider is what magpie calls; a local-sounding model id is not enough");
  assert.ok(!JSON.stringify(out).includes("image_url"));
});

test("onProvider: an allowed body is returned unchanged", () => {
  const gate = loadGate();
  const body = chat.text();
  const ctx = { protocol: "chat", model: "deepseek/deepseek-v4" };
  assert.equal(gate.onProvider(body, ctx), body);
});

test("onRequest without ctx.reject blanks the body instead of sending it", () => {
  const gate = loadGate();
  const { ctx } = mkCtx({ canReject: false });
  const out = gate.onRequest(chat.imageUrl(), ctx);
  assert.ok(markerPresent(out));
  assert.ok(!JSON.stringify(out).includes("image_url"));
  assert.ok(!JSON.stringify(out).includes(B64));
});

// --- onUsage: audit only, no bodies -------------------------------------

test("onUsage: counters only, bounded output, no row text", () => {
  const gate = loadGate();
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({
      provider: "deepseek",
      model: "deepseek/deepseek-v4",
      status: 403,
      ms: 5,
      errorType: null,
      prompt: "PROMPT-SENTINEL",
      body: "BODY-SENTINEL",
    });
  }
  assert.doesNotThrow(() => {
    for (const row of rows) gate.onUsage(row, {});
  });
  assert.ok(gate.logs.length > 0, "usage rows are audited");
  assert.ok(gate.logs.length <= 40, `output is bounded, got ${gate.logs.length} lines`);
  for (const line of gate.logs) {
    assert.ok(line.startsWith("privacy-gate: usage"), line);
    assert.ok(!line.includes("PROMPT-SENTINEL"));
    assert.ok(!line.includes("BODY-SENTINEL"));
  }
  assert.ok(gate.logs[gate.logs.length - 1].includes("blocked403=100"), "the last emitted row is row 100");
});

test("onUsage: tolerates a missing row and missing options", () => {
  const gate = loadGate();
  assert.doesNotThrow(() => gate.onUsage(undefined, undefined));
  assert.doesNotThrow(() => gate.onUsage({}, undefined));
});

// ---------------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`- ${failure.name}\n  ${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}
