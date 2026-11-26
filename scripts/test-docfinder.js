// docfinder.js with a fake API (shapes of the web search / web fetch server tool results): node scripts/test-docfinder.js
var D = require("../docfinder.js"), R = require("../racedocs.js"), assert = require("assert");
var calls = [];
function fakeFetch(plan) { var i = 0; return function (url, o) { calls.push(JSON.parse(o.body)); var r = plan[Math.min(i++, plan.length - 1)]; return Promise.resolve({ ok: r.status ? r.status < 300 : true, status: r.status || 200, json: function () { return Promise.resolve(r.json); }, text: function () { return Promise.resolve(JSON.stringify(r.json || "")); } }); }; }
var NOR = "BANDO DI REGATA - Trofeo Test\nLinea di partenza: Barca comitato 44°21.500'N 008°34.200'E\nSegnale di avviso ore 11:55\nCanale VHF 72\n";
var fetchBlock = function (url, text) { return { type: "web_fetch_tool_result", tool_use_id: "x", content: { type: "web_fetch_result", url: url, content: { type: "document", title: "NoR", source: { type: "text", media_type: "text/plain", data: text } } } }; };
(async function () {
  var f = fakeFetch([
    { json: { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: [] }] } },
    { json: { stop_reason: "end_turn", content: [fetchBlock("https://club.example/nor.pdf", NOR), { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://club.example/img", content: { type: "document", source: { type: "base64", media_type: "image/png", data: "AA" } } } },
      { type: "text", text: "```json\n{\"documents\":[{\"url\":\"https://club.example/nor.pdf\",\"title\":\"Bando\",\"kind\":\"nor\"}],\"notes\":\"SI not published yet\"}\n```" }] } }]);
  var r = await D.find({ event: "Trofeo Test", place: "Varazze", year: 2026 }, { key: "k", fetch: f });
  assert.strictEqual(r.documents.length, 1, "only the readable document"); assert.strictEqual(r.documents[0].kind, "nor"); assert.strictEqual(r.documents[0].title, "Bando"); assert.strictEqual(r.searched, 1); assert.strictEqual(r.notes, "SI not published yet");
  assert.strictEqual(calls[0].tools[0].type, "web_search_20250305"); assert(!("tool_choice" in calls[0]) && !("fallbacks" in calls[0]));
  assert.strictEqual(calls[1].messages.length, 2, "paused turn continued with the assistant content");
  // the items shown come from the DOCUMENT text, not from the model
  var items = R.fromText(r.documents[0].text).items; assert(items.some(function (x) { return x.kind === "mark" && Math.abs(x.lat - 44.3583) < 1e-3; }) && items.some(function (x) { return x.kind === "vhf" && x.value === "72"; }) && items.some(function (x) { return x.kind === "time" && x.value === "11:55"; }));
  // basic tool types refused -> newer ones
  calls.length = 0;
  var f2 = fakeFetch([{ status: 400, json: { error: { message: "tools.0: web_search_20250305 is not supported for this model" } } }, { json: { stop_reason: "end_turn", content: [fetchBlock("https://a/b", NOR), { type: "text", text: "{\"documents\":[]}" }] } }]);
  var r2 = await D.find({ event: "x" }, { key: "k", fetch: f2 }); assert.strictEqual(r2.documents.length, 1); assert.strictEqual(calls[1].tools[0].type, "web_search_20260209");
  // typed errors
  async function code(p, o) { try { await D.find(p, o); } catch (e) { return e.code; } }
  assert.strictEqual(await code({ event: "x" }, { key: "" }), "nokey"); assert.strictEqual(await code({}, { key: "k" }), "request");
  assert.strictEqual(await code({ event: "x" }, { key: "k", fetch: fakeFetch([{ status: 401, json: {} }]) }), "auth");
  assert.strictEqual(await code({ event: "x" }, { key: "k", fetch: fakeFetch([{ json: { stop_reason: "end_turn", content: [{ type: "text", text: "{\"documents\":[],\"notes\":\"not found\"}" }] } }]) }), "none");
  console.log("ok");
})().catch(function (e) { console.error(e); process.exit(1); });
