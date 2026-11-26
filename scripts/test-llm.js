// llm.js with a fake API (no network): node scripts/test-llm.js
var L = require("../llm.js"), assert = require("assert");
var calls = [];
function fakeFetch(plan) { var i = 0; return function (url, o) { var body = JSON.parse(o.body); calls.push({ url: url, headers: o.headers, body: body }); var r = plan[Math.min(i++, plan.length - 1)]; return Promise.resolve({ ok: r.status ? r.status < 300 : true, status: r.status || 200, json: function () { return Promise.resolve(r.json); }, text: function () { return Promise.resolve(JSON.stringify(r.json || "")); } }); }; }
var tools = { get_boat_state: { description: "boat", run: function () { return { bsp_kn: 7.42, twa_deg: 41.3, polar_pct: 96.8, nan: NaN, skip: function () {} }; } }, broken: { description: "x", run: function () { throw new Error("boom"); } } };
(async function () {
  // 1. tool round then answer; numbers verified, one invented
  var f = fakeFetch([
    { json: { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "get_boat_state", input: {} }, { type: "tool_use", id: "t2", name: "broken", input: {} }] } },
    { json: { stop_reason: "end_turn", model: "claude-opus-5-5", content: [{ type: "text", text: "Fai 7,4 nodi, 97 per cento della polare, angolo 41 gradi, e 12 nodi di vento." }] } }]);
  var a = L.create({ fetch: f, getKey: function () { return "k"; }, tools: tools });
  var r = await a.ask("come andiamo?");
  assert.strictEqual(r.rounds, 2); assert.deepStrictEqual(r.tools, ["get_boat_state"]);
  assert.deepStrictEqual(r.unverified, ["12"], "only the invented number is flagged");
  var c0 = calls[0], c1 = calls[1];
  assert.strictEqual(c0.headers["x-api-key"], "k"); assert.strictEqual(c0.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.strictEqual(c0.body.model, "claude-opus-5-5"); assert.strictEqual(c0.body.output_config.effort, "low"); assert.strictEqual(c0.body.fallbacks, "default");
  assert(!("tool_choice" in c0.body) && !("temperature" in c0.body) && !("thinking" in c0.body), "no forced tool use, sampling or thinking param");
  var last = c1.body.messages[c1.body.messages.length - 1];
  assert.strictEqual(last.role, "user"); assert.strictEqual(last.content.length, 2, "both tool results in ONE user message");
  assert.strictEqual(last.content[1].is_error, true);
  assert.strictEqual(JSON.parse(last.content[0].content).nan, null, "NaN becomes null");
  assert.strictEqual(c1.body.messages[1].content[0].type, "thinking", "assistant blocks passed back unchanged");
  // 2. typed errors
  async function code(plan, key) { try { await L.create({ fetch: fakeFetch(plan), getKey: function () { return key; }, tools: tools }).ask("x"); } catch (e) { return e.code; } }
  assert.strictEqual(await code([{}], ""), "nokey");
  assert.strictEqual(await code([{ status: 401, json: {} }], "k"), "auth");
  assert.strictEqual(await code([{ status: 429, json: {} }], "k"), "rate");
  assert.strictEqual(await code([{ status: 503, json: {} }], "k"), "server");
  assert.strictEqual(await code([{ json: { stop_reason: "refusal", content: [] } }], "k"), "refused");
  assert.strictEqual(await L.create({ fetch: function () { return Promise.reject(new Error("offline")); }, getKey: function () { return "k"; }, tools: tools }).ask("x").catch(function (e) { return e.code; }), "network");
  // 3. fallback beta rejected -> retried without it
  calls.length = 0;
  var f3 = fakeFetch([{ status: 400, json: { error: { message: "fallbacks: not supported" } } }, { json: { stop_reason: "end_turn", content: [{ type: "text", text: "Ok." }] } }]);
  var r3 = await L.create({ fetch: f3, getKey: function () { return "k"; }, tools: tools }).ask("x");
  assert.strictEqual(r3.text, "Ok."); assert(!("fallbacks" in calls[1].body), "retried without fallbacks");
  // 4. number check helpers
  assert.deepStrictEqual(L.unverified("Mancano 45 secondi, 3 gradi e 7,5 nodi", [45, 10, 7]), ["7,5"], "3 = 10 - 7 is a difference of sources; 7,5 is not explained");
  console.log("ok");
})().catch(function (e) { console.error(e); process.exit(1); });
