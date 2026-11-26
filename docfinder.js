// MaxRace document finder: finds the Notice of Race, Sailing Instructions and amendments of an event on the web and brings back their text.
// The model only FINDS and READS the pages (Anthropic's web search and web fetch tools run on Anthropic's side, so there is no
// browser cross-origin problem); what MaxRace shows is NOT what the model says but the text of the documents it fetched, which then goes
// through racedocs.js like a file the user opened (positions, times, VHF... each with its source line, to be confirmed by the user).
//   find({event | url, place, year, hint}, {key, model, fetch})   event may be a name or the address of the event page -> Promise<{documents:[{url, title, kind, text | pdf (base64)}], searched, notes}>
// Needs an API key; sends the event name to Anthropic. Typed errors as in llm.js (code: nokey | auth | rate | network | server | request | none).
// Works in the page (window.MRDocFinder) and in Node.
(function (root) {
  "use strict";
  var NODE = typeof require !== "undefined" && typeof module !== "undefined";
  function LL() { return NODE ? require("./llm.js") : root.MRLLM; }   // looked up when used: in the page llm.js loads after this file
  var TOOLS_BASIC = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 6, max_content_tokens: 60000 }];
  var TOOLS_NEW = [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, max_content_tokens: 60000 }];
  function err(code, msg) { var e = new Error(msg); e.code = code; return e; }
  var URL_RE = /https?:\/\/[^\s"'<>]+/i;
  var SITES = "Race documents are often on the event page of racingrulesofsailing.org (documents/<number>/event), on manage2sail.com, on the organizing club's own site or on the national federation site (federvela.it).";
  var JSON_ANSWER = "When you are done, answer with ONLY a JSON object: {\"documents\":[{\"url\":\"...\",\"title\":\"...\",\"kind\":\"nor|si|amendment|other\"}],\"notes\":\"one short sentence, e.g. what you could not find\"}. Do not summarise the documents and do not write numbers from them.";
  function prompt(q) {
    var u = URL_RE.exec(q.event || "") || URL_RE.exec(q.url || "");
    if (u) {   // the user pointed at the event page: read it and follow its document links
      return "Read this sailing event page: " + u[0] + ". Fetch it, find the documents it lists or links (Notice of Race / Bando di Regata, Sailing Instructions / Istruzioni di Regata, amendments, notices to competitors, course diagrams as text) and fetch each of them. " +
        "Fetch the page itself first, then only documents that belong to this event. If a link is not shown in the page text, say so in notes. " + JSON_ANSWER;
    }
    return "Find the official race documents for this sailing event: " + [q.event, q.place, q.year].filter(Boolean).join(", ") + (q.hint ? " (" + q.hint + ")" : "") + ". " +
      "I need the Notice of Race (Bando di Regata), the Sailing Instructions (Istruzioni di Regata) and any amendments or notices to competitors (Comunicati). " + SITES + " " +
      "Search the web, then fetch each document page or PDF. Fetch only documents that belong to this exact event and edition. " + JSON_ANSWER;
  }
  // fetched documents in a response's content blocks
  function fetched(content, out) {
    (content || []).forEach(function (b) {
      if (b.type !== "web_fetch_tool_result") return;
      var c = b.content; if (!c || c.type !== "web_fetch_result") return;
      var doc = c.content && c.content.source, d = { url: c.url, title: (c.content && c.content.title) || c.url, kind: "other" };
      if (doc && doc.type === "text" && typeof doc.data === "string") d.text = doc.data;
      else if (doc && doc.type === "base64" && /pdf/i.test(doc.media_type || "")) d.pdf = doc.data;
      else return;
      if (!out.some(function (x) { return x.url === d.url; })) out.push(d);
    });
  }
  function lastText(content) { return (content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join(" "); }
  function parseJson(t) { var m = /\{[\s\S]*\}/.exec(t || ""); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } }

  function find(q, o) {
    o = o || {};
    var f = o.fetch || (typeof fetch !== "undefined" ? fetch.bind(root) : null);
    if (!o.key) return Promise.reject(err("nokey", "no API key"));
    if (!q || !(q.event || q.url)) return Promise.reject(err("request", "no event name"));
    var tools = TOOLS_BASIC, docs = [], msgs = [{ role: "user", content: prompt(q) }], rounds = 0, searched = 0, final = null;
    function body() { return { model: o.model || LL().DEFAULT_MODEL, max_tokens: 4096, tools: tools, messages: msgs, output_config: { effort: "low" } }; }
    function step() {
      if (++rounds > 8) return Promise.resolve();
      return LL().post(f, body(), o.key).catch(function (e) {
        // the basic tool versions not accepted on this model: use the newer ones, once
        if (e.code === "request" && tools === TOOLS_BASIC && /web_(search|fetch)|tool/i.test(e.message)) { tools = TOOLS_NEW; return LL().post(f, body(), o.key); }
        throw e;
      }).then(function (res) {
        (res.content || []).forEach(function (b) { if (b.type === "server_tool_use" && b.name === "web_search") searched++; });
        fetched(res.content, docs);
        if (res.stop_reason === "pause_turn") { msgs.push({ role: "assistant", content: res.content }); return step(); }   // the server paused a long turn: continue it
        if (res.stop_reason === "refusal") throw err("refused", "refused");
        final = parseJson(lastText(res.content));
      });
    }
    return step().then(function () {
      var meta = (final && final.documents) || [];
      docs.forEach(function (d) { var m = meta.filter(function (x) { return x && x.url === d.url; })[0]; if (m) { d.kind = m.kind || "other"; if (m.title) d.title = m.title; } });
      if (!docs.length) throw err("none", "no document could be fetched" + (final && final.notes ? ": " + final.notes : ""));
      return { documents: docs, searched: searched, notes: (final && final.notes) || "" };
    });
  }
  var api = { find: find, fetched: fetched, prompt: prompt };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRDocFinder = api;
})(this);
