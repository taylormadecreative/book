// Proposal view reporter. Tells the Studio CRM a proposal was opened. Stores no
// visitor details: the database keeps only first view, last view and a count.
// Add ?notrack=1 once in your own browsers; ?notrack=0 undoes it.
(function () {
  var script = document.currentScript;
  var key = script && script.dataset ? script.dataset.key : "";
  var url = "https://pgqdmnmessbbzyszjfvr.supabase.co/rest/v1/rpc/bk_money_view";
  var publicKey = "sb_publishable_fyYqa9QkEeA5LD_0hYLTTA_F8Gxw1oz";
  function store(area, name, value) {
    try {
      if (value === undefined) return window[area].getItem(name);
      if (value === null) window[area].removeItem(name);
      else window[area].setItem(name, value);
    } catch (error) {}
    return null;
  }
  try {
    var params = new URLSearchParams(location.search);
    var choice = params.get("notrack");
    if (choice === "1" || choice === "0") {
      store("localStorage", "tm-notrack", choice === "1" ? "1" : null);
      params.delete("notrack");
      var query = params.toString();
      history.replaceState(history.state, "", location.pathname + (query ? "?" + query : "") + location.hash);
      if (choice === "1") {
        var note = document.createElement("div");
        note.setAttribute("role", "status");
        note.textContent = "This browser won't be counted as a proposal view.";
        note.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;" +
          "max-width:calc(100vw - 32px);padding:10px 16px;border-radius:6px;background:#0b0b0d;color:#f4f1ea;" +
          "font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
        (document.body || document.documentElement).appendChild(note);
        setTimeout(function () { note.remove(); }, 7000);
      }
    }
  } catch (error) {}
  var host = location.hostname;
  if (!key || key.length < 16 || navigator.webdriver || location.protocol !== "https:" ||
    host === "localhost" || host === "127.0.0.1" || store("localStorage", "tm-notrack") === "1" ||
    store("sessionStorage", "tm-viewed-" + key)) return;
  store("sessionStorage", "tm-viewed-" + key, "1");
  try {
    fetch(url, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", apikey: publicKey, Authorization: "Bearer " + publicKey },
      body: JSON.stringify({ p_key: key }),
    }).catch(function () {});
  } catch (error) {}
})();
