// MaxRace conversational assistant: a cloud model (Anthropic Messages API) that answers by calling read-only tools on the
// live MaxRace data, and never states a number the tools did not give it.
//   - tools: name -> {description, input_schema, run(input)} (supplied by the page; all read-only)
//   - the model's text is checked: every number in it must come from a tool result or from the question (rounding allowed,
//     simple sums/differences allowed); if not, the answer is marked `unverified` and the page says so
//   - errors are typed (code: "nokey" | "auth" | "rate" | "network" | "server" | "refused") so the caller can fall back to the
//     built-in commands when offline
// Plain fetch on purpose: the app is static HTML in a webview, with no bundler for the SDK. Works in the page (window.MRLLM) and Node.
(function (root) {
  "use strict";
  var URL_ = "https://api.anthropic.com/v1/messages";
  var DEFAULT_MODEL = "claude-opus-5-5";
  var SYSTEM = [
    "Sei il tattico a bordo di una barca da regata (Cape 31). Rispondi in italiano, a voce: al massimo due frasi corte, senza elenchi, senza markdown, senza emoji.",
    "Usa SOLO i dati che ti danno gli strumenti. Non inventare e non calcolare numeri: riporta i numeri come li dà lo strumento (arrotondati). Se un dato manca o è null, dillo chiaramente ('non ho il dato').",
    "Le distanze degli strumenti sono nel campo indicato (m = metri, nm = miglia nautiche); i tempi in secondi; gli angoli in gradi; le velocità in nodi. Di' le unità.",
    "Per decisioni tattiche dai un consiglio breve con il numero che lo giustifica; la decisione resta del tattico. Se la domanda non riguarda la regata o i dati, rispondi in una frase che non puoi aiutare."
  ].join(" ");

  function fin(v) { return typeof v === "number" && isFinite(v); }
  function err(code, msg, extra) { var e = new Error(msg); e.code = code; if (extra) for (var k in extra) e[k] = extra[k]; return e; }

  // all numbers in a value (for the number check)
  function numbers(v, out) {
    out = out || [];
    if (fin(v)) out.push(v);
    else if (typeof v === "string") { (v.match(/-?\d+(?:[.,]\d+)?/g) || []).forEach(function (s) { out.push(parseFloat(s.replace(",", "."))); }); }
    else if (Array.isArray(v)) v.forEach(function (x) { numbers(x, out); });
    else if (v && typeof v === "object") Object.keys(v).forEach(function (k) { numbers(v[k], out); });
    return out;
  }
  // numbers written in an Italian answer (digits; decimals with a comma)
  function spoken(text) { return (String(text).match(/\d+(?:[.,]\d+)?/g) || []).map(function (s) { return { s: s, v: parseFloat(s.replace(",", ".")) }; }); }
  function decimals(s) { var m = /[.,](\d+)/.exec(s); return m ? m[1].length : 0; }
  // numbers in the answer that no tool result (or the question) explains: rounding to the decimals said, abs value, sums and differences of two source numbers
  function unverified(answer, sources) {
    var src = [], seen = {};
    sources.forEach(function (x) { if (fin(x)) { var k = Math.round(x * 1000); if (!seen[k]) { seen[k] = 1; src.push(x); } } });
    var pairs = src.length <= 120;
    return spoken(answer).filter(function (n) {
      var tol = 0.5 * Math.pow(10, -decimals(n.s)) + 1e-9, ok = function (x) { return Math.abs(Math.abs(x) - n.v) <= tol; };
      if (src.some(ok)) return false;
      if (pairs) for (var i = 0; i < src.length; i++) for (var j = i + 1; j < src.length; j++) if (ok(src[i] + src[j]) || ok(src[i] - src[j])) return false;
      return true;
    }).map(function (n) { return n.s; });
  }

  function clean(v, depth) {
    depth = depth || 0;
    if (typeof v === "number") return isFinite(v) ? Math.round(v * 100) / 100 : null;
    if (v == null || typeof v === "string" || typeof v === "boolean") return v == null ? null : v;
    if (typeof v === "function" || depth > 4) return undefined;
    if (Array.isArray(v)) return v.slice(0, 20).map(function (x) { return clean(x, depth + 1); });
    var o = {}; Object.keys(v).forEach(function (k) { var c = clean(v[k], depth + 1); if (c !== undefined) o[k] = c; }); return o;
  }

  // one Messages API call with the typed errors (shared by the assistant and the document finder)
  function postJson(f, body, key) {
    var headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    if (body.fallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    return f(URL_, { method: "POST", headers: headers, body: JSON.stringify(body) }).catch(function (e) { throw err("network", "network: " + (e && e.message)); }).then(function (r) {
      if (r.ok) return r.json();
      return r.text().then(function (t) {
        var code = r.status === 401 || r.status === 403 ? "auth" : r.status === 429 ? "rate" : r.status >= 500 ? "server" : "request";
        throw err(code, "HTTP " + r.status + ": " + t.slice(0, 300), { status: r.status });
      });
    });
  }

  // create({fetch, getKey, getModel, tools, maxRounds, system})
  function create(opts) {
    var f = opts.fetch || (typeof fetch !== "undefined" ? fetch.bind(root) : null), tools = opts.tools || {}, names = Object.keys(tools), memory = [];
    var toolDefs = names.map(function (n) { return { name: n, description: tools[n].description, input_schema: tools[n].input_schema || { type: "object", properties: {}, additionalProperties: false } }; });
    function post(body, key) { return postJson(f, body, key); }
    function ask(question) {
      var key = opts.getKey && opts.getKey();
      if (!key) return Promise.reject(err("nokey", "no API key"));
      var t0 = Date.now(), msgs = memory.concat([{ role: "user", content: question }]), sources = numbers(question), used = [], rounds = 0, api = 0;
      var model = (opts.getModel && opts.getModel()) || DEFAULT_MODEL, maxRounds = opts.maxRounds || 5, fb = opts.fallbacks !== false;
      function body() {
        var b = { model: model, max_tokens: 1024, system: opts.system || SYSTEM, tools: toolDefs, messages: msgs, output_config: { effort: opts.effort || "low" } };
        if (fb) b.fallbacks = "default";
        return b;
      }
      function step() {
        if (++rounds > maxRounds) return Promise.reject(err("loop", "too many tool rounds"));
        var ts = Date.now();
        return post(body(), key).catch(function (e) {
          // the fallback parameter is a beta: if the server does not take it, go on without it
          if (fb && e.code === "request" && /fallback/i.test(e.message)) { fb = false; return post(body(), key); }
          throw e;
        }).then(function (res) {
          api += Date.now() - ts;
          if (res.stop_reason === "refusal") throw err("refused", "refused");
          if (res.stop_reason === "tool_use") {
            msgs.push({ role: "assistant", content: res.content });     // unchanged, thinking blocks included
            var results = res.content.filter(function (b) { return b.type === "tool_use"; }).map(function (b) {
              var out, bad = false;
              try { if (!tools[b.name]) throw new Error("unknown tool"); out = clean(tools[b.name].run(b.input || {})); } catch (e) { out = { error: String(e.message || e) }; bad = true; }
              if (!bad) { used.push(b.name); numbers(out, sources); }
              return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out === undefined ? null : out), is_error: bad };
            });
            msgs.push({ role: "user", content: results });                 // all results in one message
            return step();
          }
          var text = res.content.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join(" ").replace(/\s+/g, " ").trim();
          if (res.stop_reason === "max_tokens" && !text) throw err("server", "empty answer (max_tokens)");
          memory = memory.concat([{ role: "user", content: question }, { role: "assistant", content: text }]).slice(-6);
          return { text: text, unverified: unverified(text, sources), tools: used, rounds: rounds, ms: Date.now() - t0, apiMs: api, model: res.model || model };
        });
      }
      return step();
    }
    return { ask: ask, forget: function () { memory = []; }, tools: names };
  }
  var api = { create: create, post: postJson, unverified: unverified, numbers: numbers, clean: clean, SYSTEM: SYSTEM, DEFAULT_MODEL: DEFAULT_MODEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRLLM = api;
})(this);
