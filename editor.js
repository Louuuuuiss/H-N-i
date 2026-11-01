(() => {
  const API = window.TRIP_API_URL || "";
  const TOKEN_KEY = "hanoi-trip-editor-token";
  const labels = { attractions: "景點", entertainment: "娛樂", food: "美食" };
  const colors = { attractions: ["景點", "#2563eb", "🏛"], entertainment: ["娛樂", "#9333ea", "♨"], food: ["美食", "#dc2626", "🍜"] };
  let state;
  let activeTab = "days";
  let token = sessionStorage.getItem(TOKEN_KEY) || "";

  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = value => { try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) ? u.href : ""; } catch { return ""; } };
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
  const textOf = (node, selector) => node.querySelector(selector)?.textContent.trim() || "";

  function captureInitial() {
    const dayNodes = [...document.querySelectorAll("#sec-itinerary > div.bg-white")];
    const days = dayNodes.map(day => {
      const header = day.querySelector(".bg-slate-800");
      const spans = header ? [...header.querySelectorAll("span")] : [];
      const label = spans[0]?.textContent.trim() || "";
      return {
        date: label.replace(/^DAY\s+\d+\s*[·.]\s*/, ""),
        destination: spans[1]?.textContent.trim() || "",
        items: [...day.querySelectorAll(".p-4 > .flex")].map(row => ({
          time: row.querySelector("span")?.textContent.trim() || "",
          title: textOf(row, "p.font-semibold"),
          description: row.querySelectorAll("p")[1]?.textContent.trim() || ""
        }))
      };
    });
    const attractionItems = [...document.querySelectorAll("#sec-attractions h3")].map(h => {
      const card = h.closest(".flex.justify-between");
      return { name: h.textContent.trim(), category: "景點", description: textOf(card, "p"), url: safeUrl(card?.querySelector("a")?.href), latitude: "", longitude: "" };
    });
    const entertainmentItems = [...document.querySelectorAll("#entertainment-items .ent-item")].map(card => ({
      name: textOf(card, "h3"), category: card.dataset.entCategory || "SPA", description: textOf(card, "p"), url: safeUrl(card.querySelector("a")?.href), latitude: "", longitude: ""
    }));
    const foodItems = (typeof michelinData !== "undefined" ? michelinData : []).map(item => ({
      name: item.name, category: item.type === "star" ? "米其林一星" : item.type === "bib" ? "必比登" : "米其林入選", description: item.desc,
      url: item.name === "Lamai Garden" ? "https://www.google.com/maps/search/?api=1&query=Lamai%20Garden%2C%20Hanoi" : "", latitude: "", longitude: ""
    }));
    const map = typeof mapLocations !== "undefined" ? mapLocations : [];
    for (const [key, list] of [["attractions", attractionItems], ["entertainment", entertainmentItems], ["food", foodItems]]) {
      for (const item of list) {
        const loc = map.find(m => m.name === item.name);
        if (loc) { item.url = item.url || safeUrl(loc.url); item.latitude = loc.coords?.[0] ?? ""; item.longitude = loc.coords?.[1] ?? ""; }
      }
    }
    const h1 = document.querySelector("header h1");
    return {
      title: h1?.textContent.trim() || "旅行行程",
      dateRange: document.querySelector("header p")?.textContent.trim() || "",
      duration: document.querySelector("header span.bg-red-800")?.textContent.trim() || "",
      days,
      places: { attractions: attractionItems, entertainment: entertainmentItems, food: foodItems }
    };
  }

  function api(path, options = {}) {
    if (!API) return Promise.reject(new Error("編輯服務尚未設定。"));
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${API}${path}`, { ...options, headers }).then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "連線失敗，請稍後再試。");
      return body;
    });
  }

  function categoryMap() {
    const configs = {
      attractions: { type: "attraction", label: "景點", icon: "fa-landmark", color: "#2563eb", symbol: "🏛" },
      entertainment: { type: "entertainment", label: "娛樂", icon: "fa-star", color: "#9333ea", symbol: "✨" },
      food: { type: "food", label: "美食", icon: "fa-utensils", color: "#dc2626", symbol: "🍜" }
    };
    return Object.entries(state.places).flatMap(([key, items]) => items.filter(x => Number.isFinite(Number(x.latitude)) && Number.isFinite(Number(x.longitude)) && x.latitude !== "" && x.longitude !== "").map(x => ({
      name: x.name, url: safeUrl(x.url) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.name)}`,
      ...configs[key], label: x.category || configs[key].label, coords: [Number(x.latitude), Number(x.longitude)], symbol: configs[key].symbol
    })));
  }

  function renderPage() {
    if (!state) return;
    const title = document.querySelector("header h1"); if (title) title.textContent = state.title;
    const date = document.querySelector("header p"); if (date) date.textContent = state.dateRange;
    const duration = document.querySelector("header span.bg-red-800"); if (duration) duration.textContent = state.duration;
    const itinerary = document.getElementById("sec-itinerary");
    if (itinerary) {
      itinerary.querySelectorAll(":scope > div.bg-white, :scope > article.trip-day").forEach(n => n.remove());
      state.days.forEach((day, index) => {
        const card = el("article", "trip-day bg-white rounded-xl shadow-sm border border-slate-100 mb-4 overflow-hidden");
        const head = el("div", "bg-slate-800 text-white px-4 py-2.5 flex justify-between items-center");
        head.append(el("span", "font-bold text-sm", `DAY ${index + 1} · ${day.date || "日期待填"}`), el("span", "text-xs bg-slate-700 px-2 py-0.5 rounded", day.destination));
        const body = el("div", "p-4 space-y-3");
        day.items.forEach(item => { const row = el("div", "flex items-start gap-3 border-b border-slate-100 pb-2"); row.append(el("span", "text-xs font-semibold bg-red-100 text-red-700 px-2 py-1 rounded shrink-0 mt-0.5", item.time)); const detail = el("div"); detail.append(el("p", "font-semibold text-sm", item.title), el("p", "text-xs text-slate-500", item.description)); row.append(detail); body.append(row); });
        card.append(head, body); itinerary.append(card);
      });
    }
    renderCards("sec-attractions", state.places.attractions, "景點");
    renderCards("sec-entertainment", state.places.entertainment, "娛樂");
    renderCards("sec-food", state.places.food, "美食");
    if (typeof mapLocations !== "undefined") {
      mapLocations.splice(0, mapLocations.length, ...categoryMap());
      if (typeof pinElements !== "undefined") for (const [name, pin] of pinElements) if (!mapLocations.some(place => place.name === name)) { pin.remove(); pinElements.delete(name); }
      if (document.getElementById("sec-map") && !document.getElementById("sec-map").classList.contains("hidden") && typeof initializeTravelMap === "function") { if (typeof fitMapToPlaces === "function" && mapLocations.length) fitMapToPlaces(); initializeTravelMap(); }
    }
  }

  function renderCards(sectionId, items, badge) {
    const section = document.getElementById(sectionId); if (!section) return;
    const list = sectionId === "sec-entertainment" ? document.getElementById("entertainment-items") : sectionId === "sec-food" ? document.getElementById("michelin-list") : section.querySelector(".space-y-2\\.5");
    if (!list) return;
    list.replaceChildren();
    for (const item of items) {
      const card = el("div", "bg-white p-3 rounded-xl shadow-sm border border-slate-100 flex justify-between items-center");
      const detail = el("div", "pr-2"); detail.append(el("h3", "font-bold text-sm text-slate-800", item.name), el("p", "text-xs text-slate-500 mt-0.5", item.description));
      const link = el("a", "text-[11px] px-2 py-1 rounded-md shrink-0 bg-blue-100 text-blue-800 inline-flex items-center gap-1 hover:brightness-95 transition", item.category || badge);
      link.href = safeUrl(item.url) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.name)}`; link.target = "_blank"; link.rel = "noopener noreferrer";
      card.append(detail, link);
      if (sectionId === "sec-entertainment" || sectionId === "sec-food") { const wrapper = el("div", sectionId === "sec-food" ? "food-item" : "ent-item"); wrapper.dataset[sectionId === "sec-food" ? "foodCategory" : "entCategory"] = item.category || "未分類"; wrapper.append(card); list.append(wrapper); }
      else list.append(card);
    }
    if (sectionId === "sec-entertainment" || sectionId === "sec-food") renderFilters(section, items, sectionId === "sec-food" ? "foodCategory" : "entCategory", sectionId === "sec-food" ? "mich-btn" : "ent-btn");
  }

  function renderFilters(section, items, datasetKey, className) {
    const holder = section.querySelector(".flex.gap-2.mb-4"); if (!holder) return;
    holder.replaceChildren();
    const categories = [...new Set(items.map(item => item.category).filter(Boolean))];
    const makeButton = (name, category) => {
      const button = el("button", `${className} ${category === "all" ? "active bg-red-600 text-white" : "bg-white text-slate-600 border border-slate-200"} text-xs px-3 py-1.5 rounded-full font-medium shrink-0`, name);
      button.type = "button";
      button.addEventListener("click", () => {
        holder.querySelectorAll("button").forEach(b => { b.classList.remove("bg-red-600", "text-white", "active"); b.classList.add("bg-white", "text-slate-600"); });
        button.classList.add("bg-red-600", "text-white", "active"); button.classList.remove("bg-white", "text-slate-600");
        section.querySelectorAll(datasetKey === "foodCategory" ? ".food-item" : ".ent-item").forEach(card => card.classList.toggle("hidden", category !== "all" && card.dataset[datasetKey] !== category));
      });
      holder.append(button);
    };
    makeButton("全部", "all"); categories.forEach(category => makeButton(category, category));
  }

  function loginDialog() {
    showDialog(`<h2 class="text-xl font-bold mb-2">管理者登入</h2><p class="text-sm text-slate-500 mb-4">輸入密碼進入行程編輯模式。</p><form id="login-form"><label class="edit-label">密碼<input name="password" type="password" autocomplete="current-password" required class="edit-input" /></label><p id="login-error" class="text-sm text-red-600 mt-2"></p><div class="flex justify-end gap-2 mt-5"><button type="button" class="edit-button secondary" data-close>取消</button><button class="edit-button">登入</button></div></form>`);
    document.getElementById("login-form").addEventListener("submit", async event => {
      event.preventDefault(); const error = document.getElementById("login-error");
      try { const result = await api("/api/login", { method: "POST", body: JSON.stringify({ password: new FormData(event.currentTarget).get("password") }) }); token = result.token; sessionStorage.setItem(TOKEN_KEY, token); closeDialog(); editDialog(); }
      catch (err) { error.textContent = err.message; }
    });
  }

  function showDialog(content, wide = false) {
    closeDialog();
    const overlay = el("div", "editor-overlay"); overlay.id = "trip-editor-overlay";
    const panel = el("div", `editor-panel${wide ? " wide" : ""}`); panel.innerHTML = content;
    overlay.append(panel); overlay.addEventListener("click", event => { if (event.target === overlay || event.target.closest("[data-close]")) closeDialog(); }); document.body.append(overlay);
  }
  function closeDialog() { document.getElementById("trip-editor-overlay")?.remove(); }

  function editDialog() {
    if (!token) return loginDialog();
    showDialog(editorMarkup(), true);
    bindEditor();
  }

  function editorMarkup() {
    const tabs = `<div class="edit-tabs">${[["trip", "基本資料"], ["days", "每日行程"], ["attractions", "景點"], ["entertainment", "娛樂"], ["food", "美食"]].map(([id, name]) => `<button type="button" class="edit-tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${name}</button>`).join("")}</div>`;
    return `<div class="flex items-start justify-between gap-3 mb-4"><div><h2 class="text-xl font-bold">編輯旅程</h2><p class="text-xs text-slate-500 mt-1">儲存後會同步到 Cloudflare，之後旅行可直接改內容。</p></div><button type="button" class="edit-button secondary" data-close>關閉</button></div>${tabs}<form id="trip-form">${tabContents()}<div class="flex justify-between gap-2 mt-5"><button type="button" id="logout-button" class="edit-button secondary">登出</button><button type="submit" class="edit-button">儲存變更</button></div><p id="save-message" class="text-sm text-slate-500 mt-2"></p></form>`;
  }

  function input(label, name, value, type = "text", placeholder = "") { return `<label class="edit-label">${esc(label)}<input class="edit-input" name="${esc(name)}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`; }
  function tabContents() {
    if (activeTab === "trip") return `<div class="edit-grid">${input("旅程標題", "title", state.title)}${input("日期範圍", "dateRange", state.dateRange)}${input("行程天數說明", "duration", state.duration)}</div>`;
    if (activeTab === "days") return `<div class="flex justify-between items-center mb-3"><p class="text-sm text-slate-500">可新增或刪除天數與每一天的行程。</p><button type="button" class="edit-button secondary" data-add-day>＋ 新增天數</button></div>${state.days.map((day, i) => `<details class="edit-card" open><summary>第 ${i + 1} 天 · ${esc(day.date || "日期待填")}</summary><div class="edit-grid mt-3">${input("日期", `days.${i}.date`, day.date)}${input("當日目的地／摘要", `days.${i}.destination`, day.destination)}</div><div class="mt-3"><div class="flex justify-between items-center mb-2"><strong class="text-sm">行程項目</strong><button type="button" class="edit-button tiny secondary" data-add-item="${i}">＋ 新增行程</button></div>${day.items.map((item, j) => `<div class="edit-row">${input("時間", `days.${i}.items.${j}.time`, item.time, "text", "例如 09:00-10:00")}${input("行程", `days.${i}.items.${j}.title`, item.title)}${input("備註", `days.${i}.items.${j}.description`, item.description)}<button type="button" class="edit-button tiny danger" data-delete-item="${i}.${j}">刪除</button></div>`).join("")}</div><button type="button" class="edit-button tiny danger mt-3" data-delete-day="${i}">刪除第 ${i + 1} 天</button></details>`).join("")}`;
    const key = activeTab; const items = state.places[key];
    return `<div class="flex justify-between items-center mb-3"><p class="text-sm text-slate-500">管理${labels[key]}名稱、標籤、描述、外部連結及選填座標。</p><button type="button" class="edit-button secondary" data-add-place="${key}">＋ 新增${labels[key]}</button></div>${items.map((item, i) => `<details class="edit-card"><summary>${esc(item.name || `新${labels[key]}`)} <span class="text-xs text-slate-500">· ${esc(item.category || "未分類")}</span></summary><div class="edit-grid mt-3">${input("名稱", `places.${key}.${i}.name`, item.name)}${input("標籤", `places.${key}.${i}.category`, item.category, "text", key === "food" ? "例如 必比登" : "例如 SPA／Massage")}${input("描述／備註", `places.${key}.${i}.description`, item.description)}${input("連結", `places.${key}.${i}.url`, item.url, "url", "https://...")}${input("緯度（選填）", `places.${key}.${i}.latitude`, item.latitude, "number")}${input("經度（選填）", `places.${key}.${i}.longitude`, item.longitude, "number")}</div><button type="button" class="edit-button tiny danger mt-3" data-delete-place="${key}.${i}">刪除此${labels[key]}</button></details>`).join("")}`;
  }

  function setPath(object, path, value) { const parts = path.split("."); let ref = object; for (let i = 0; i < parts.length - 1; i++) ref = ref[parts[i]]; ref[parts.at(-1)] = value; }
  function bindEditor() {
    document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => { readForm(); activeTab = button.dataset.tab; editDialog(); }));
    document.querySelector("[data-add-day]")?.addEventListener("click", () => { readForm(); state.days.push({ date: "", destination: "", items: [] }); editDialog(); });
    document.querySelectorAll("[data-add-item]").forEach(button => button.addEventListener("click", () => { readForm(); state.days[Number(button.dataset.addItem)].items.push({ time: "", title: "", description: "" }); editDialog(); }));
    document.querySelectorAll("[data-delete-item]").forEach(button => button.addEventListener("click", () => { readForm(); const [i,j] = button.dataset.deleteItem.split(".").map(Number); state.days[i].items.splice(j,1); editDialog(); }));
    document.querySelectorAll("[data-delete-day]").forEach(button => button.addEventListener("click", () => { readForm(); state.days.splice(Number(button.dataset.deleteDay),1); editDialog(); }));
    document.querySelectorAll("[data-add-place]").forEach(button => button.addEventListener("click", () => { readForm(); state.places[button.dataset.addPlace].push({ name: "", category: "", description: "", url: "", latitude: "", longitude: "" }); editDialog(); }));
    document.querySelectorAll("[data-delete-place]").forEach(button => button.addEventListener("click", () => { readForm(); const [key,i] = button.dataset.deletePlace.split("."); state.places[key].splice(Number(i),1); editDialog(); }));
    document.getElementById("trip-form").addEventListener("submit", async event => {
      event.preventDefault(); readForm();
      const msg = document.getElementById("save-message"); msg.textContent = "正在儲存…";
      try { await api("/api/content", { method: "POST", body: JSON.stringify({ content: state }) }); renderPage(); msg.textContent = "已儲存到 Cloudflare。"; }
      catch (error) { msg.textContent = error.message; }
    });
    document.getElementById("logout-button").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {} token = ""; sessionStorage.removeItem(TOKEN_KEY); closeDialog(); });
  }
  function readForm() {
    const form = document.getElementById("trip-form"); if (!form) return;
    for (const [path, value] of new FormData(form)) if (path !== "") setPath(state, path, value);
  }

  function addStyles() {
    const style = document.createElement("style"); style.textContent = `
      .editor-overlay{position:fixed;inset:0;z-index:1000;background:#0f172a99;display:flex;align-items:center;justify-content:center;padding:12px}
      .editor-panel{width:min(100%,440px);max-height:94vh;overflow:auto;background:#fff;border-radius:16px;padding:20px;box-shadow:0 20px 60px #0004}.editor-panel.wide{width:min(100%,860px)}
      .edit-tabs{display:flex;gap:6px;overflow:auto;padding-bottom:12px;margin-bottom:12px}.edit-tab{white-space:nowrap;border:1px solid #e2e8f0;border-radius:999px;padding:7px 12px;background:#fff;color:#475569;font-size:13px}.edit-tab.active,.edit-button{background:#b91c1c;color:#fff;border:0}
      .edit-button{border-radius:8px;padding:9px 13px;font-size:13px;font-weight:600}.edit-button.secondary{background:#f1f5f9;color:#334155}.edit-button.danger{background:#fee2e2;color:#b91c1c}.edit-button.tiny{padding:6px 9px;font-size:12px}
      .edit-label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:#475569;min-width:0}.edit-input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px;font-size:14px;color:#0f172a;background:#fff}.edit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.edit-row{display:grid;grid-template-columns:1fr 1.5fr 1.5fr auto;gap:8px;align-items:end;border-top:1px solid #e2e8f0;padding:10px 0}.edit-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:10px 0}.edit-card summary{cursor:pointer;font-weight:700;font-size:14px}.trip-editor-login{border:0;border-radius:999px;background:#fff;color:#b91c1c;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer}
      @media(max-width:640px){.editor-overlay{padding:0;align-items:flex-end}.editor-panel,.editor-panel.wide{width:100%;max-height:96vh;border-radius:16px 16px 0 0;padding:16px}.edit-grid{grid-template-columns:1fr}.edit-row{grid-template-columns:1fr 1fr}.edit-row .edit-label:nth-child(3){grid-column:1/-1}.edit-row button{justify-self:start}}
    `; document.head.append(style);
  }

  async function init() {
    addStyles();
    const header = document.querySelector("header > div");
    if (header) { const button = el("button", "trip-editor-login", "登入編輯"); button.type = "button"; button.addEventListener("click", async () => { if (!token) return loginDialog(); try { await api("/api/content"); editDialog(); } catch { token = ""; sessionStorage.removeItem(TOKEN_KEY); loginDialog(); } }); header.append(button); }
    state = captureInitial();
    try { const result = await api("/api/content", { headers: token ? { Authorization: `Bearer ${token}` } : {} }); if (result.content) { state = result.content; renderPage(); } }
    catch (error) { console.warn("旅程資料尚未從 Cloudflare 載入：", error.message); }
    if (token) { try { await api("/api/content"); } catch { token = ""; sessionStorage.removeItem(TOKEN_KEY); } }
  }
  document.addEventListener("DOMContentLoaded", init);
})();

