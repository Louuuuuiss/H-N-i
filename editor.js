(() => {
  const API = window.TRIP_API_URL || "";
  const TOKEN_KEY = "hanoi-trip-editor-token";
  const FAVORITES_KEY = "hanoi-trip-favorites-v1";
  let favoriteSyncPending = 0;
  let favorites;
  try { favorites = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")); }
  catch { favorites = new Set(); }
  const filters = new Map();
  const labels = { attractions: "景點", entertainment: "娛樂", food: "美食" };
  const colors = { attractions: ["景點", "#2563eb", "🏛"], entertainment: ["娛樂", "#9333ea", "♨"], food: ["美食", "#dc2626", "🍜"] };
  let state;
  let activeTab = "days";
  let activeDayIndex = 0;
  let activeDayFilter = "全部行程";
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
      flag: document.querySelector("header .text-2xl")?.textContent.trim() || "✈️",
      title: h1?.textContent.trim() || "旅行行程",
      dateRange: document.querySelector("header p")?.textContent.trim() || "",
      duration: document.querySelector("header span.bg-red-800")?.textContent.trim() || "",
      days,
      places: { attractions: attractionItems, entertainment: entertainmentItems, food: foodItems },
      flights: []
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

  function categoryMapLabel(category) {
    const lower = String(category || "").toLocaleLowerCase();
    if (lower === "bar") return "Bar";
    if (lower === "barber") return "Barber";
    return category || "未分類";
  }

  function mapCategoryIcon(key, category) {
    if (key === "attractions") return "🏛";
    if (key === "food") {
      if (category === "米其林一星") return "⭐";
      if (category === "必比登") return "🍲";
      return "🍽";
    }
    const lower = String(category || "").toLocaleLowerCase();
    if (lower === "spa" || category === "水療") return "♨";
    if (lower === "barber") return "✂";
    if (lower === "club") return "🎉";
    if (lower === "ktv") return "🎤";
    if (lower === "bar") return "🍸";
    return "✨";
  }

  function categoryMap() {
    const configs = {
      attractions: { type: "attraction", label: "景點", icon: "fa-landmark", color: "#2563eb", symbol: "🏛" },
      entertainment: { type: "entertainment", label: "娛樂", icon: "fa-star", color: "#9333ea", symbol: "✨" },
      food: { type: "food", label: "美食", icon: "fa-utensils", color: "#dc2626", symbol: "🍜" }
    };
    return Object.entries(state.places).flatMap(([key, items]) => items.filter(x => Number.isFinite(Number(x.latitude)) && Number.isFinite(Number(x.longitude)) && x.latitude !== "" && x.longitude !== "").map(x => ({
      name: x.name, url: safeUrl(x.url) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.name)}`,
      ...configs[key], label: categoryMapLabel(x.category || configs[key].label), displayLabel: categoryMapLabel(x.category || configs[key].label),
      coords: [Number(x.latitude), Number(x.longitude)], symbol: mapCategoryIcon(key, x.category)
    })));
  }

  function itineraryCategory(item) {
    if (item.category) return String(item.category);
    const source = (String(item.title || "") + " " + String(item.description || "")).toLocaleLowerCase();
    if (/早餐|午餐|晚餐|宵夜|餐廳|咖啡|河粉|美食|用餐|餐飲|吃飯|飲料|啤酒|餐點/.test(source)) return "美食";
    if (/飯店|酒店|旅館|住宿|check[ -]?in|check[ -]?out|入住|退房/.test(source)) return "住宿";
    if (/spa|按摩|酒吧|夜店|ktv|club|娛樂|夜市|夜逛|購物|barber|水療|休閒/.test(source)) return "娛樂";
    if (/景點|參觀|寺|湖|洞|島|古蹟|博物館|公園|教堂|探索|觀景|散步|市場/.test(source)) return "景點";
    if (/交通|航班|機場|巴士|搭機|機票|前往|移動|接送|入境|登機|車站|碼頭|集合|登船|返回|返程|飛往|高鐵|火車|租車|計程車|taxi|grab/.test(source)) return "交通";
    return "其他";
  }

  function renderPage() {
    if (!state) return;
    const savedPageScroll = window.scrollY;
    document.title = state.title || "旅行行程";
    const flag = document.querySelector("header .text-2xl"); if (flag && state.flag) flag.textContent = state.flag;
    const title = document.querySelector("header h1"); if (title) title.textContent = state.title;
    const date = document.querySelector("header p");
    if (date) {
      const matches = [...String(state.dateRange || "").matchAll(/(\d{1,2})\/(\d{1,2})/g)];
      const monthNames = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
      const daysCount = String(state.duration || "").match(/(\d+)\s*天/);
      date.textContent = matches.length >= 2
        ? monthNames[Number(matches[0][1]) - 1] + " " + matches[0][2] + " — " + monthNames[Number(matches[1][1]) - 1] + " " + matches[1][2] + (daysCount ? "　·　" + daysCount[1] + " DAYS" : "")
        : state.dateRange;
    }
    const duration = document.querySelector("header span.bg-red-800"); if (duration) duration.textContent = "☀️　旅程準備就緒";
    const itinerary = document.getElementById("sec-itinerary");
    if (itinerary) {
      if (state.days.length) activeDayIndex = Math.min(activeDayIndex, state.days.length - 1);
      let dayPicker = document.getElementById("trip-day-picker");
      if (!dayPicker) {
        dayPicker = el("div", "trip-day-picker");
        dayPicker.id = "trip-day-picker";
        const header = document.querySelector("header");
        const headerRow = header?.querySelector(":scope > div");
        let flightSummary = document.getElementById("trip-flight-summary");
        state.flights ||= [];
        if (state.flights.length) {
          if (!flightSummary) {
            flightSummary = el("div", "flight-summary");
            flightSummary.id = "trip-flight-summary";
            if (header && headerRow) headerRow.insertAdjacentElement("afterend", flightSummary);
          }
          flightSummary.replaceChildren();
          const toggle = el("button", "flight-summary-toggle");
          toggle.type = "button";
          toggle.setAttribute("aria-expanded", "false");
          const flightLines = state.flights.map(flight => (flight.flightNumber || "航班待填") + " · " + (flight.departureTime || "--:--") + "→" + (flight.arrivalTime || "--:--") + " " + (flight.direction || ""));
          const airlines = [...new Set(state.flights.map(flight => flight.airline).filter(Boolean))];
          const copy = el("span", "flight-summary-copy");
          copy.append(el("strong", "", flightLines.join("　/　")), el("small", "", (airlines.join("、") || "航班資訊") + " · 點擊展開航班資訊"));
          toggle.append(el("span", "flight-summary-icon", "✈️"), copy, el("span", "flight-summary-chevron", "▾"));
          const details = el("div", "flight-summary-details");
          state.flights.forEach(flight => {
            const line = el("div", "flight-detail-line");
            line.append(el("strong", "", (flight.direction || "航班") + " · " + (flight.flightNumber || "航班待填")));
            line.append(el("span", "", (flight.departureAirport || "出發地待填") + " → " + (flight.arrivalAirport || "抵達地待填")));
            line.append(el("small", "", (flight.date || "") + ((flight.departureTime || flight.arrivalTime) ? "　" + (flight.departureTime || "--:--") + " → " + (flight.arrivalTime || "--:--") : "")));
            if (flight.note) line.append(el("small", "", flight.note));
            details.append(line);
          });
          toggle.addEventListener("click", () => {
            const expanded = flightSummary.classList.toggle("expanded");
            toggle.setAttribute("aria-expanded", String(expanded));
          });
          flightSummary.append(toggle, details);
        } else {
          flightSummary?.remove();
          flightSummary = null;
        }
        if (header && headerRow) (flightSummary || headerRow).insertAdjacentElement("afterend", dayPicker);
        else itinerary.prepend(dayPicker);
      }
      dayPicker.replaceChildren();
      state.days.forEach((day, index) => {
        const dateMatch = String(day.date || "").match(/(\d{1,2})\/(\d{1,2})\s*[（(]?\s*([一二三四五六日天])?/);
        const weekday = { 一: "MON", 二: "TUE", 三: "WED", 四: "THU", 五: "FRI", 六: "SAT", 日: "SUN", 天: "SUN" }[dateMatch?.[3]] || "DAY";
        const dateNumber = dateMatch?.[2] || String(index + 1);
        const button = el("button", "trip-day-choice" + (index === activeDayIndex ? " active" : ""));
        button.type = "button";
        button.setAttribute("aria-label", "前往第 " + (index + 1) + " 天：" + (day.date || "日期待填"));
        button.setAttribute("aria-pressed", String(index === activeDayIndex));
        button.append(el("span", "trip-day-number", weekday), el("strong", "trip-day-date", dateNumber), el("span", "trip-day-label", "DAY " + (index + 1)));
        button.addEventListener("click", () => { activeDayIndex = index; activeDayFilter = "全部行程"; renderPage(); });
        dayPicker.append(button);
      });

      const selectedDay = state.days[activeDayIndex];
      const items = selectedDay?.items || [];
      let overview = document.getElementById("trip-day-overview");
      if (!overview) {
        overview = el("div", "trip-day-overview");
        overview.id = "trip-day-overview";
        const heading = itinerary.querySelector("h2");
        if (heading) heading.insertAdjacentElement("afterend", overview);
        else itinerary.prepend(overview);
      }
      overview.replaceChildren();
      const overviewCopy = el("div");
      overviewCopy.append(el("span", "trip-day-full-date", (selectedDay?.date || "日期待填") + "　·　DAY " + (activeDayIndex + 1)), el("h3", "trip-day-title", selectedDay?.destination || "每日行程"));
      overview.append(overviewCopy, el("span", "trip-day-count", items.length + " 個行程"));

      itinerary.querySelectorAll(":scope > div.bg-white, :scope > article.trip-day").forEach(n => n.remove());
      if (selectedDay) {
        const card = el("article", "trip-day bg-white rounded-xl shadow-sm border border-slate-100 mb-4 overflow-hidden");
        card.dataset.dayIndex = String(activeDayIndex);
        const head = el("div", "trip-day-heading");
        head.append(el("span", "", "DAY " + (activeDayIndex + 1) + " · " + (selectedDay.date || "日期待填")), el("span", "trip-day-destination", selectedDay.destination || ""));
        const body = el("div", "trip-day-timeline");
        items.forEach(item => {
          const row = el("div", "trip-entry");
          const range = String(item.time || "").split(/[-~～]/);
          row.append(el("time", "trip-entry-time", range[0] || item.time || ""));
          const detail = el("div", "trip-entry-card");
          const top = el("div", "trip-entry-top");
          top.append(el("h3", "trip-entry-title", item.title));
          const category = itineraryCategory(item);
          const icons = { "交通": "✈️", "景點": "📍", "娛樂": "♨️", "美食": "🍜", "住宿": "🛏️", "其他": "✨" };
          top.append(el("span", "trip-entry-kind", (icons[category] || "✨") + " " + category));
          detail.append(top, el("p", "trip-entry-description", item.description));
          row.append(detail);
          body.append(row);
        });
        card.append(head, body);
        itinerary.append(card);
      }
    }
    renderCards("sec-attractions", state.places.attractions, "景點");
    renderCards("sec-entertainment", state.places.entertainment, "娛樂");
    renderCards("sec-food", state.places.food, "美食");
    const legend = document.getElementById("map-category-filter");
    if (legend) {
      legend.replaceChildren();
      const all = [...state.places.attractions, ...state.places.entertainment, ...state.places.food];
      const makeFilter = (label, category) => {
        const button = el("button", "map-filter-btn" + (category === "all" ? " active" : ""), label);
        button.type = "button";
        button.dataset.mapCategory = category;
        button.setAttribute("aria-pressed", String(category === "all"));
        button.addEventListener("click", () => { if (typeof filterMapByCategory === "function") filterMapByCategory(category, button); });
        legend.append(button);
      };
      makeFilter("全部", "all");
      [...new Set(all.map(item => categoryMapLabel(item.category || "未分類")).filter(Boolean))].forEach(category => makeFilter(mapCategoryIcon(category === "景點" ? "attractions" : ["米其林一星", "必比登", "米其林入選"].includes(category) ? "food" : "entertainment", category) + " " + category, category));
    }
    if (typeof mapLocations !== "undefined") {
      mapLocations.splice(0, mapLocations.length, ...categoryMap());
      if (typeof pinElements !== "undefined") for (const [name, pin] of pinElements) if (!mapLocations.some(place => place.name === name)) { pin.remove(); pinElements.delete(name); }
      if (document.getElementById("sec-map") && !document.getElementById("sec-map").classList.contains("hidden") && typeof initializeTravelMap === "function") { if (typeof fitMapToPlaces === "function" && mapLocations.length) fitMapToPlaces(); initializeTravelMap(); }
    }
    window.scrollTo(0, savedPageScroll);
  }

  function favoriteId(sectionId, item) {
    return sectionId + ":" + JSON.stringify([
      String(item.name || "").trim().toLocaleLowerCase(),
      (safeUrl(item.url) || "").toLocaleLowerCase()
    ]);
  }

  function saveFavorites() {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch {}
  }

  function applyPlaceFilter(section, filter, datasetKey) {
    section.querySelectorAll(".place-item").forEach(wrapper => {
      const isFavorite = favorites.has(wrapper.dataset.favoriteId);
      const visible = filter === "favorites"
        ? isFavorite
        : filter === "all" || wrapper.dataset[datasetKey] === filter;
      wrapper.classList.toggle("hidden", !visible);
    });
  }

  function renderCards(sectionId, items, badge) {
    const section = document.getElementById(sectionId); if (!section) return;
    const list = sectionId === "sec-entertainment" ? document.getElementById("entertainment-items") : sectionId === "sec-food" ? document.getElementById("michelin-list") : section.querySelector(".space-y-2\\.5");
    if (!list) return;
    list.replaceChildren();
    for (const item of items) {
      const id = favoriteId(sectionId, item);
      const categoryKey = sectionId === "sec-food" ? "foodCategory" : sectionId === "sec-entertainment" ? "entCategory" : "placeCategory";
      const category = item.category || "未分類";
      const wrapper = el("div", "place-item");
      wrapper.dataset.favoriteId = id;
      wrapper.dataset[categoryKey] = category;

      const card = el("div", "bg-white p-3 rounded-xl shadow-sm border border-slate-100 flex gap-2 items-center");
      const favorite = el("button", "favorite-toggle", favorites.has(id) ? "♥" : "♡");
      favorite.type = "button";
      favorite.setAttribute("aria-label", favorites.has(id) ? "從我的最愛移除" : "加入我的最愛");
      favorite.setAttribute("aria-pressed", String(favorites.has(id)));
      favorite.title = favorites.has(id) ? "從我的最愛移除" : "加入我的最愛";
      favorite.addEventListener("click", () => {
        if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
        saveFavorites();
        favoriteSyncPending++;
        api("/api/favorites", { method: "POST", body: JSON.stringify({ placeId: id, favorite: favorites.has(id) }) })
          .catch(error => console.warn("共用最愛同步失敗：", error.message))
          .finally(() => { favoriteSyncPending = Math.max(0, favoriteSyncPending - 1); });
        const active = favorites.has(id);
        favorite.textContent = active ? "♥" : "♡";
        favorite.classList.toggle("is-favorite", active);
        favorite.setAttribute("aria-label", active ? "從我的最愛移除" : "加入我的最愛");
        favorite.setAttribute("aria-pressed", String(active));
        favorite.title = active ? "從我的最愛移除" : "加入我的最愛";
        if (filters.get(sectionId) === "favorites") applyPlaceFilter(section, "favorites", categoryKey);
      });
      favorite.classList.toggle("is-favorite", favorites.has(id));

      const detail = el("div", "flex-1 min-w-0 pr-2"); detail.append(el("h3", "font-bold text-sm text-slate-800", item.name), el("p", "text-xs text-slate-500 mt-0.5", item.description));
      const tag = el("a", "place-tag text-[11px] px-2 py-1 rounded-md shrink-0 inline-flex items-center gap-1 hover:brightness-95 transition");
      tag.href = safeUrl(item.url) || "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(item.name);
      tag.target = "_blank"; tag.rel = "noopener noreferrer";
      const externalIcon = el("i", "fa-solid fa-arrow-up-right-from-square");
      externalIcon.setAttribute("aria-hidden", "true");
      if (sectionId === "sec-attractions") {
        tag.classList.add("bg-blue-100", "text-blue-800");
        tag.append(document.createTextNode("景點"), externalIcon);
      } else if (sectionId === "sec-entertainment") {
        const displayCategory = ({ spa: "SPA", barber: "Barber", bar: "Bar" })[category.toLocaleLowerCase()] || category;
        tag.classList.add("bg-purple-100", "text-purple-800");
        tag.append(document.createTextNode(displayCategory), externalIcon);
      } else {
        const foodTags = {
          "米其林一星": ["⭐ 一星", "bg-amber-100", "text-amber-800"],
          "必比登": ["🍲 必比登", "bg-red-100", "text-red-700"],
          "米其林入選": ["米其林入選", "bg-slate-100", "text-slate-700"]
        };
        const [displayCategory, background, foreground] = foodTags[category] || [category || badge, "bg-slate-100", "text-slate-700"];
        tag.classList.add(background, foreground);
        tag.append(document.createTextNode(displayCategory), externalIcon);
      }
      tag.setAttribute("aria-label", `${category || badge}：在地圖查看 ${item.name}`);
      tag.title = "在 Google Maps 開啟";
      card.append(favorite, detail, tag);
      wrapper.append(card);
      list.append(wrapper);
    }
    const datasetKey = sectionId === "sec-food" ? "foodCategory" : sectionId === "sec-entertainment" ? "entCategory" : "placeCategory";
    const filterClass = sectionId === "sec-food" ? "mich-btn" : sectionId === "sec-entertainment" ? "ent-btn" : "place-btn";
    renderFilters(section, items, datasetKey, filterClass);
  }

  function renderFilters(section, items, datasetKey, className) {
    const holder = section.querySelector(".place-filters"); if (!holder) return;
    holder.replaceChildren();
    holder.style.display = "flex";
    holder.style.flexWrap = "wrap";
    holder.style.overflowX = "visible";
    holder.style.gap = "8px";
    const categories = [...new Set(items.map(item => item.category).filter(Boolean))];
    const activeFilter = filters.get(section.id) || "all";
    const makeButton = (name, category) => {
      const button = el("button", `${className} ${category === activeFilter ? "active bg-red-600 text-white" : "bg-white text-slate-600 border border-slate-200"} text-xs px-3 py-1.5 rounded-full font-medium shrink-0`, name);
      button.type = "button";
      button.setAttribute("aria-pressed", String(category === activeFilter));
      button.addEventListener("click", () => {
        filters.set(section.id, category);
        holder.querySelectorAll("button").forEach(b => {
          b.classList.remove("bg-red-600", "text-white", "active");
          b.classList.add("bg-white", "text-slate-600");
          b.setAttribute("aria-pressed", "false");
        });
        button.classList.add("bg-red-600", "text-white", "active");
        button.classList.remove("bg-white", "text-slate-600");
        button.setAttribute("aria-pressed", "true");
        applyPlaceFilter(section, category, datasetKey);
      });
      holder.append(button);
    };
    makeButton("全部", "all");
    makeButton("♡ 我的最愛", "favorites");
    categories.forEach(category => makeButton(category, category));
    applyPlaceFilter(section, activeFilter, datasetKey);
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
    const previousPanel = document.querySelector(".editor-panel");
    const scrollTop = previousPanel?.scrollTop || 0;
    showDialog(editorMarkup(), true);
    const panel = document.querySelector(".editor-panel");
    if (panel) panel.scrollTop = scrollTop;
    bindEditor();
  }

  function editorMarkup() {
    const tabs = `<div class="edit-tabs">${[["trip", "基本資料"], ["flights", "航班"], ["days", "每日行程"], ["attractions", "景點"], ["entertainment", "娛樂"], ["food", "美食"]].map(([id, name]) => `<button type="button" class="edit-tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${name}</button>`).join("")}</div>`;
    return `<div class="flex items-start justify-between gap-3 mb-4"><div><h2 class="text-xl font-bold">編輯旅程</h2><p class="text-xs text-slate-500 mt-1">儲存後會同步到 Cloudflare，之後旅行可直接改內容。</p></div><button type="button" class="edit-button secondary" data-close>關閉</button></div>${tabs}<form id="trip-form">${tabContents()}<div class="flex justify-between gap-2 mt-5"><button type="button" id="logout-button" class="edit-button secondary">登出</button><button type="submit" class="edit-button">儲存變更</button></div><p id="save-message" class="text-sm text-slate-500 mt-2"></p></form>`;
  }

  function input(label, name, value, type = "text", placeholder = "") { return `<label class="edit-label">${esc(label)}<input class="edit-input" name="${esc(name)}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`; }
  function calendarDateValue(value) {
    const m = String(value || '').match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/);
    const md = String(value || '').match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    const year = (m && m[1]) || String(state?.dateRange || '').match(/20\d{2}/)?.[0] || new Date().getFullYear();
    const month = m ? m[2] : md && md[1], day = m ? m[3] : md && md[2];
    return month && day ? String(year) + '-' + String(month).padStart(2,'0') + '-' + String(day).padStart(2,'0') : '';
  }
  function calendarDateText(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const d = new Date(value + 'T12:00:00');
    return (d.getMonth()+1) + '/' + d.getDate() + ' (' + ['日','一','二','三','四','五','六'][d.getDay()] + ')';
  }
  function readSingleTime(value) {
    const first = String(value || "").split(/[-–~～至]/)[0].trim();
    const match = first.match(/^(\d{1,2}):(\d{2})/);
    return match ? [match[1].padStart(2, "0"), match[2]] : ["09", "00"];
  }
  function timeUnitOptions(max, selected) {
    let options = '';
    for (let n = 0; n <= max; n++) {
      const value = String(n).padStart(2, '0');
      options += '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + value + '</option>';
    }
    return options;
  }
  function timePointEditor(dayIndex, itemIndex, endpoint, values, label) {
    const base = 'days.' + dayIndex + '.items.' + itemIndex + '.' + endpoint;
    return '<div class="time-point"><strong>' + label + '時間</strong><div class="time-units">' +
      '<label>時<select class="edit-input time-wheel" aria-label="' + label + '時間小時" name="' + base + 'Hour">' + timeUnitOptions(23, values[0]) + '</select></label>' +
      '<label>分<select class="edit-input time-wheel" aria-label="' + label + '時間分鐘" name="' + base + 'Minute">' + timeUnitOptions(59, values[1]) + '</select></label>' +
      '</div></div>';
  }
  function tabContents() {
    if (activeTab === "trip") return `<div class="edit-grid">${input("國旗／圖示", "flag", state.flag, "text", "例如 🇯🇵")}${input("旅程標題", "title", state.title)}${input("日期範圍", "dateRange", state.dateRange)}${input("行程天數說明", "duration", state.duration)}</div>`;
    if (activeTab === "flights") {
      state.flights ||= [];
      const cards = state.flights.map((flight, i) => '<section class="edit-card editor-flight-card"><div class="editor-card-heading"><strong>' + esc(flight.direction || "航班") + ' · ' + esc(flight.flightNumber || "新航班") + '</strong><button type="button" class="edit-button tiny danger" data-delete-flight="' + i + '">移除此航班</button></div><div class="edit-grid flight-fields">' +
        input("航班日期", "flights." + i + ".date", flight.date, "date") +
        input("去程／回程", "flights." + i + ".direction", flight.direction, "text", "例如 去程") +
        input("航空公司", "flights." + i + ".airline", flight.airline) +
        input("航班編號", "flights." + i + ".flightNumber", flight.flightNumber, "text", "例如 CI-100") +
        input("出發時間", "flights." + i + ".departureTime", flight.departureTime, "time") +
        input("抵達時間", "flights." + i + ".arrivalTime", flight.arrivalTime, "time") +
        input("出發地／機場", "flights." + i + ".departureAirport", flight.departureAirport) +
        input("目的地／機場", "flights." + i + ".arrivalAirport", flight.arrivalAirport) +
        input("備註", "flights." + i + ".note", flight.note) + '</div></section>').join("");
      return '<div class="editor-section-intro"><span class="editor-section-kicker">FLIGHT DETAILS</span><h3>航班資訊</h3><p>新增去程、回程或轉機航班，儲存後會顯示於頁首。</p><button type="button" class="edit-button" data-add-flight>＋ 新增航班</button></div>' + (cards || '<div class="editor-empty">尚未新增航班，按「新增航班」開始填寫。</div>');
    }
        if (activeTab === "days") return `<div class="flex justify-between items-center mb-3"><p class="text-sm text-slate-500">可新增或刪除天數與每一天的行程。</p><button type="button" class="edit-button secondary" data-add-day>＋ 新增天數</button></div>${state.days.map((day, i) => `<details class="edit-card" open><summary>第 ${i + 1} 天 · ${esc(day.date || "日期待填")}</summary><div class="edit-grid mt-3">${`<label class="edit-label">日期<input class="edit-input" type="date" name="days.${i}.calendarDate" value="${calendarDateValue(day.date)}" /></label>`}${input("當日目的地／摘要", `days.${i}.destination`, day.destination)}</div><div class="mt-3"><div class="flex justify-between items-center mb-2"><strong class="text-sm">行程項目</strong><button type="button" class="edit-button tiny secondary" data-add-item="${i}">＋ 新增行程</button></div>${day.items.map((item, j) => `<div class="edit-row">${`<div class="time-wheel-group single-time-wheel">${timePointEditor(i, j, "time", readSingleTime(item.time), "行程")}</div>`}${input("行程", `days.${i}.items.${j}.title`, item.title)}${input("備註", `days.${i}.items.${j}.description`, item.description)}<button type="button" class="edit-button tiny danger" data-delete-item="${i}.${j}">刪除</button></div>`).join("")}</div><button type="button" class="edit-button tiny danger mt-3" data-delete-day="${i}">刪除第 ${i + 1} 天</button></details>`).join("")}`;
    const key = activeTab; const items = state.places[key];
    state.tagOptions ||= {};
    state.tagOptions[key] = [...new Set([...(state.tagOptions[key] || []), ...items.map(item => item.category).filter(Boolean)])];
    const tagTools = `<div class="edit-card"><div class="flex items-center justify-between gap-2"><strong class="text-sm">可用標籤</strong><button type="button" class="edit-button tiny secondary" data-add-tag="${key}">＋ 新增標籤</button></div><div class="flex flex-wrap gap-2 mt-2">${state.tagOptions[key].map(tag => `<span class="text-xs rounded-full border border-slate-200 bg-white px-3 py-1">${esc(tag)}</span>`).join("") || '<span class="text-xs text-slate-500">尚無標籤</span>'}</div></div>`;
    const categoryInput = (item, i) => `<label class="edit-label">標籤<input class="edit-input" name="places.${key}.${i}.category" list="tag-options-${key}" value="${esc(item.category)}" placeholder="選擇或輸入標籤" /></label>`;
    const tagList = `<datalist id="tag-options-${key}">${state.tagOptions[key].map(tag => `<option value="${esc(tag)}"></option>`).join("")}</datalist>`;
    return `<div class="flex justify-between items-center mb-3"><p class="text-sm text-slate-500">管理${labels[key]}名稱、標籤、描述、外部連結及選填座標。</p><button type="button" class="edit-button secondary" data-add-place="${key}">＋ 新增${labels[key]}</button></div>${tagTools}${tagList}${items.map((item, i) => `<details class="edit-card"><summary>${esc(item.name || `新${labels[key]}`)} <span class="text-xs text-slate-500">· ${esc(item.category || "未分類")}</span></summary><div class="edit-grid mt-3">${input("名稱", `places.${key}.${i}.name`, item.name)}${categoryInput(item, i)}${input("描述／備註", `places.${key}.${i}.description`, item.description)}${input("連結", `places.${key}.${i}.url`, item.url, "url", "https://...")}${input("緯度（選填）", `places.${key}.${i}.latitude`, item.latitude, "number")}${input("經度（選填）", `places.${key}.${i}.longitude`, item.longitude, "number")}</div><button type="button" class="edit-button tiny danger mt-3" data-delete-place="${key}.${i}">刪除此${labels[key]}</button></details>`).join("")}`;
  }

  function addTagDialog(key) {
    showDialog(`<h2 class="text-xl font-bold mb-2">新增${labels[key]}標籤</h2><p class="text-sm text-slate-500 mb-4">建立後可在項目的標籤欄選用，儲存旅程後會保留。</p><form id="new-tag-form"><label class="edit-label">標籤名稱<input name="tag" class="edit-input" maxlength="100" required placeholder="例如 SPA／Massage" /></label><p id="tag-error" class="text-sm text-red-600 mt-2"></p><div class="flex justify-end gap-2 mt-5"><button type="button" class="edit-button secondary" data-close>取消</button><button class="edit-button">新增標籤</button></div></form>`);
    document.getElementById("new-tag-form").addEventListener("submit", event => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get("tag") || "").trim();
      state.tagOptions ||= {};
      state.tagOptions[key] ||= [];
      if (!value) return;
      if (state.tagOptions[key].some(tag => tag.toLocaleLowerCase() === value.toLocaleLowerCase())) {
        document.getElementById("tag-error").textContent = "這個標籤已存在。";
        return;
      }
      state.tagOptions[key].push(value);
      closeDialog();
      editDialog();
    });
  }

  function setPath(object, path, value) { const parts = path.split("."); let ref = object; for (let i = 0; i < parts.length - 1; i++) ref = ref[parts[i]]; ref[parts.at(-1)] = value; }
  function bindEditor() {
    document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => { readForm(); activeTab = button.dataset.tab; editDialog(); }));
    document.querySelector("[data-add-flight]")?.addEventListener("click", () => { readForm(); state.flights ||= []; state.flights.push({ direction: "去程", airline: "", flightNumber: "", departureTime: "", arrivalTime: "", departureAirport: "", arrivalAirport: "", date: "", note: "" }); editDialog(); });
    document.querySelectorAll("[data-delete-flight]").forEach(button => button.addEventListener("click", () => { readForm(); state.flights.splice(Number(button.dataset.deleteFlight), 1); editDialog(); }));
    document.querySelector("[data-add-day]")?.addEventListener("click", () => { readForm(); state.days.push({ date: "", destination: "", items: [] }); editDialog(); });
    document.querySelectorAll("[data-add-item]").forEach(button => button.addEventListener("click", () => { readForm(); state.days[Number(button.dataset.addItem)].items.push({ time: "00:00-01:00", title: "", description: "" }); editDialog(); }));
    document.querySelectorAll("[data-delete-item]").forEach(button => button.addEventListener("click", () => { readForm(); const [i,j] = button.dataset.deleteItem.split(".").map(Number); state.days[i].items.splice(j,1); editDialog(); }));
    document.querySelectorAll("[data-delete-day]").forEach(button => button.addEventListener("click", () => { readForm(); state.days.splice(Number(button.dataset.deleteDay),1); editDialog(); }));
    document.querySelectorAll("[data-add-place]").forEach(button => button.addEventListener("click", () => { readForm(); state.places[button.dataset.addPlace].push({ name: "", category: "", description: "", url: "", latitude: "", longitude: "" }); editDialog(); }));
    document.querySelectorAll("[data-add-tag]").forEach(button => button.addEventListener("click", () => { readForm(); addTagDialog(button.dataset.addTag); }));
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
    const data = new FormData(form);
    for (const [path, value] of data) {
      if (!path || path.endsWith(".calendarDate") || /\.time(Hour|Minute)$/.test(path)) continue;
      setPath(state, path, value);
    }
    for (let i = 0; i < state.days.length; i++) {
      const date = data.get("days." + i + ".calendarDate");
      if (date) state.days[i].date = calendarDateText(String(date));
      for (let j = 0; j < state.days[i].items.length; j++) {
        const path = "days." + i + ".items." + j;
        const time = ["Hour", "Minute"].map(unit => data.get(path + ".time" + unit));
        if (time.every(value => value !== null)) state.days[i].items[j].time = time.join(":");
      }
    }
  }

  function addStyles() {
    const style = document.createElement("style"); style.textContent = `
      .editor-overlay{position:fixed;inset:0;z-index:1000;background:#0f172a99;display:flex;align-items:center;justify-content:center;padding:12px}
      .editor-panel{width:min(100%,440px);max-height:94vh;overflow:auto;background:#fff;border-radius:16px;padding:20px;box-shadow:0 20px 60px #0004}.editor-panel.wide{width:min(100%,860px)}
      .edit-tabs{display:flex;gap:6px;overflow:auto;padding-bottom:12px;margin-bottom:12px}.edit-tab{white-space:nowrap;border:1px solid #e2e8f0;border-radius:999px;padding:7px 12px;background:#fff;color:#475569;font-size:13px}.edit-tab.active,.edit-button{background:#b91c1c;color:#fff;border:0}
      .edit-button{border-radius:8px;padding:9px 13px;font-size:13px;font-weight:600}.time-wheel{min-height:42px;appearance:auto}.time-wheel-group{display:grid;grid-template-columns:1fr 1fr;gap:10px;grid-column:1/-1;min-width:0}.time-point{border:1px solid #e2e8f0;border-radius:10px;background:#fff;padding:9px}.time-point>strong{display:block;font-size:12px;color:#475569;margin-bottom:6px}.time-units{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.time-units label{font-size:10px;color:#64748b;display:flex;flex-direction:column;gap:3px}.time-units .edit-input{padding:7px 4px;text-align:center}@media(max-width:640px){.time-wheel-group{grid-template-columns:1fr}.time-point{padding:8px}.time-units{gap:8px}}
      button:not(:disabled){transition:transform .12s ease,filter .12s ease,box-shadow .12s ease;-webkit-tap-highlight-color:transparent}
      button:not(:disabled):active{transform:scale(.96);filter:brightness(.91);box-shadow:inset 0 2px 5px rgba(15,23,42,.22)}
      button:focus-visible{outline:2px solid #dc2626;outline-offset:2px}.edit-button.secondary{background:#f1f5f9;color:#334155}.edit-button.danger{background:#fee2e2;color:#b91c1c}.edit-button.tiny{padding:6px 9px;font-size:12px}
      .edit-label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:#475569;min-width:0}.edit-input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px;font-size:14px;color:#0f172a;background:#fff}.edit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.edit-row{display:grid;grid-template-columns:1fr 1.5fr 1.5fr auto;gap:8px;align-items:end;border-top:1px solid #e2e8f0;padding:10px 0}.time-wheel-group{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:end;min-width:250px}.time-wheel-group.single-time-wheel{grid-template-columns:minmax(0,1fr);max-width:280px}.time-range-separator{padding-bottom:10px;color:#64748b;font-weight:700}.edit-row>.time-wheel-group{grid-column:1/-1}@media(min-width:641px){.edit-row{grid-template-columns:minmax(250px,1.5fr) 1.2fr 1.5fr auto}.edit-row>.time-wheel-group{grid-column:auto}}.edit-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:10px 0}.edit-card summary{cursor:pointer;font-weight:700;font-size:14px}.favorite-toggle{flex:0 0 auto;width:32px;height:32px;border-radius:9999px;color:#94a3b8;font-size:23px;line-height:1;display:inline-flex;align-items:center;justify-content:center;transition:color .15s,transform .15s}.favorite-toggle:hover{transform:scale(1.08)}.favorite-toggle:disabled{cursor:default;opacity:.85}.favorite-toggle.is-favorite{color:#dc2626}.favorite-toggle:focus-visible{outline:2px solid #dc2626;outline-offset:2px}.trip-editor-login,.trip-editor-share{border:0;border-radius:999px;background:#fff;color:#b91c1c;padding:7px 11px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}.trip-editor-share{background:#fee2e2;color:#7f1d1d}.shared-favorites-banner{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px;font-weight:600}.shared-favorites-banner.error{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
      @media(max-width:640px){.editor-overlay{padding:0;align-items:flex-end}.editor-panel,.editor-panel.wide{width:100%;max-height:96vh;border-radius:16px 16px 0 0;padding:16px}.edit-grid{grid-template-columns:1fr}.edit-row{grid-template-columns:1fr 1fr}.edit-row .edit-label:nth-child(3){grid-column:1/-1}.edit-row button{justify-self:start}}
      /* Travel planner refresh: preserve Hanoi content and features while refining the layout. */
      :root{--trip-teal:#168f91;--trip-teal-dark:#126f73;--trip-ink:#173b40;--trip-canvas:#f4f8f7;--trip-line:#dcebea}
      html{scroll-behavior:smooth;scroll-padding-top:92px}
      body{background:var(--trip-canvas)!important;color:var(--trip-ink)!important;padding-bottom:88px!important}
      header.sticky{background:#fff!important;color:var(--trip-ink)!important;border-bottom:1px solid var(--trip-line);box-shadow:0 5px 18px rgba(18,65,68,.06)!important}
      header .text-red-100{color:#789395!important}
      header span.bg-red-800{background:#eaf6f5!important;color:var(--trip-teal-dark)!important}
      header h1{letter-spacing:.01em}
      .trip-editor-login,.trip-editor-share{border:1px solid #c9e3e1!important;background:#f2fbfa!important;color:var(--trip-teal-dark)!important;padding:9px 13px!important;box-shadow:0 2px 8px rgba(22,143,145,.08)}
      main.max-w-md{max-width:780px!important;padding:22px 18px 32px!important}
      .tab-content>h2{color:var(--trip-ink)!important;font-size:1.2rem!important;margin-bottom:16px!important}
      .tab-content>h2 i{color:var(--trip-teal)!important}
      #trip-day-picker{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 16px;margin:0 0 8px;scrollbar-width:none;scroll-snap-type:x mandatory}
      #trip-day-picker::-webkit-scrollbar{display:none}
      .trip-day-choice{flex:0 0 104px;min-height:112px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:5px;padding:13px 14px;border:1px solid transparent;border-radius:19px;background:#eaf2f1;color:#50696b;text-align:left;scroll-snap-align:start}
      .trip-day-choice .trip-day-number{font-size:10px;letter-spacing:.13em;font-weight:800}
      .trip-day-choice .trip-day-date{font-family:Georgia,serif;font-size:24px;line-height:1.05;color:#29484a}
      .trip-day-choice .trip-day-destination{max-width:100%;font-size:10px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .trip-day-choice.active{background:var(--trip-teal);color:#fff;box-shadow:0 9px 20px rgba(22,143,145,.2)}
      .trip-day-choice.active .trip-day-date{color:#fff}
      .trip-day{scroll-margin-top:92px;border:1px solid var(--trip-line)!important;border-radius:20px!important;box-shadow:0 5px 18px rgba(28,71,73,.055)!important;margin-bottom:16px!important}
      .trip-day>div:first-child{background:#fff!important;color:var(--trip-ink)!important;border-bottom:1px solid #edf3f2;padding:14px 17px!important}
      .trip-day>div:first-child span:first-child{font-size:14px!important;color:var(--trip-teal-dark)}
      .trip-day>div:first-child span:last-child{background:#eaf6f5!important;color:#477577!important}
      .trip-day>.p-4{padding:18px!important}
      .trip-day .p-4>.flex{position:relative;gap:13px!important;padding:0 0 14px 14px!important;margin-left:6px;border-bottom:0!important}
      .trip-day .p-4>.flex:before{content:"";position:absolute;left:-5px;top:5px;width:10px;height:10px;border:2px solid #fff;border-radius:50%;background:var(--trip-teal);box-shadow:0 0 0 2px #b9dfdc}
      .trip-day .p-4>.flex:after{content:"";position:absolute;left:-1px;top:19px;bottom:-1px;width:2px;background:#cce5e2}
      .trip-day .p-4>.flex:last-child{padding-bottom:0!important}
      .trip-day .p-4>.flex:last-child:after{display:none}
      .trip-day .p-4>.flex>span:first-child{font-size:12px!important;min-width:90px;text-align:center;border-radius:999px!important;background:#e9f6f5!important;color:var(--trip-teal-dark)!important;padding:5px 9px!important}
      .trip-day .p-4>.flex>div{min-width:0;padding-top:3px}
      .place-filters{flex-wrap:wrap!important;overflow:visible!important;gap:8px!important;padding-bottom:10px}
      .place-filters button,.map-filter-btn{min-height:36px;padding:7px 13px!important;border-radius:999px!important;white-space:nowrap}
      .place-filters button.active,.map-filter-btn.active{background:var(--trip-teal)!important;border-color:var(--trip-teal)!important;color:#fff!important}
      .place-item>div{min-height:72px;padding:14px!important;border-radius:17px!important;border-color:#e4eeed!important;box-shadow:0 3px 12px rgba(28,71,73,.045)!important;transition:transform .16s ease,box-shadow .16s ease}
      .place-item>div:hover{transform:translateY(-1px);box-shadow:0 7px 18px rgba(28,71,73,.09)!important}
      .place-item h3{font-size:14px!important;color:var(--trip-ink)!important}
      .favorite-toggle{width:36px;height:36px;background:#f4f7f7;color:#9baaaa}
      .favorite-toggle.is-favorite{background:#fff0f0}
      #sec-map>div.bg-white{border-radius:18px!important;border-color:var(--trip-line)!important;padding:14px!important}
      #travel-map{border-radius:20px!important;box-shadow:0 5px 18px rgba(28,71,73,.08)}
      nav.fixed.bottom-0{border-color:#e6efee!important;box-shadow:0 -6px 22px rgba(22,55,57,.07);padding-bottom:env(safe-area-inset-bottom,0)}
      nav.fixed.bottom-0>div{max-width:780px!important;padding:8px 8px calc(8px + env(safe-area-inset-bottom,0))!important}
      nav .nav-btn{min-height:52px;border-radius:14px;transition:background .15s,color .15s}
      nav .nav-btn.active{color:var(--trip-teal)!important;background:#eaf6f5}
      nav .nav-btn:not(.active){color:#93a2a3!important}
      button:not(:disabled){transition:transform .12s ease,filter .12s ease,box-shadow .12s ease;-webkit-tap-highlight-color:transparent}
      button:not(:disabled):active{transform:scale(.96);filter:brightness(.91);box-shadow:inset 0 2px 5px rgba(15,23,42,.16)}
      /* Match the approved preview: day strip in the header and one selected day timeline. */
      header.sticky{position:relative!important;top:auto!important;border-radius:0 0 28px 28px;background:linear-gradient(145deg,#fff 30%,#eaf8f6)!important;padding-bottom:12px}
      header.sticky>div:first-child{padding:22px 20px 12px!important;align-items:center}
      header.sticky>div:first-child .text-2xl{font-size:1.6rem;line-height:1}
      header.sticky>div:first-child h1{font-size:1.3rem}
      header.sticky>div:first-child p{font-size:10px;letter-spacing:.12em;color:#819198!important}
      #trip-day-picker{padding:12px 20px 15px;margin:0;gap:9px;background:transparent}
      .trip-day-choice{flex:0 0 66px;min-height:88px;align-items:center;text-align:center;gap:2px;padding:9px 6px;border-radius:19px;background:#fff;box-shadow:0 4px 14px rgba(36,78,77,.07)}
      .trip-day-choice .trip-day-number{font-size:10px;letter-spacing:.1em;color:#819198}
      .trip-day-choice .trip-day-date{font-size:25px;margin:2px 0;color:#22313a}
      .trip-day-choice .trip-day-label{font-size:9px;font-weight:800;color:#829297}
      .trip-day-choice.active{background:#198e8b;color:#d6f4f2;transform:translateY(-2px)}
      .trip-day-choice.active .trip-day-number,.trip-day-choice.active .trip-day-date,.trip-day-choice.active .trip-day-label{color:white}
      #sec-itinerary>h2{display:none}
      .trip-day-overview{display:flex;justify-content:space-between;align-items:end;gap:10px;margin:12px 2px 18px}
      .trip-day-full-date{display:block;color:#829297;font-size:12px;font-weight:700;letter-spacing:.06em}
      .trip-day-title{margin:4px 0 0;font-size:19px;font-weight:750;color:#22313a}
      .trip-day-count{flex:0 0 auto;padding:7px 10px;border-radius:999px;background:#e5f5f3;color:#198e8b;font-size:11px}
      .trip-day{background:transparent!important;border:0!important;box-shadow:none!important;overflow:visible!important;margin:0!important}
      .trip-day-heading{display:none}
      .trip-day-timeline{position:relative;padding:0 0 8px}
      .trip-day-timeline:before{content:"";position:absolute;left:52px;top:12px;bottom:18px;width:2px;background:linear-gradient(#198e8b,#cde9e6 92%,transparent)}
      .trip-entry{display:grid;grid-template-columns:45px minmax(0,1fr);gap:15px;position:relative;margin-bottom:16px}
      .trip-entry-time{padding-top:18px;text-align:right;font-family:Georgia,serif;font-size:13px;font-weight:700;color:#198e8b;white-space:nowrap}
      .trip-entry:before{content:"";position:absolute;left:47px;top:22px;width:12px;height:12px;border:3px solid #198e8b;border-radius:50%;background:#fff;box-shadow:0 0 0 4px #e5f5f3;z-index:1}
      .trip-entry-card{position:relative;min-width:0;padding:16px;background:#fff;border:1px solid #dceceb;border-radius:21px;box-shadow:0 10px 30px rgba(37,83,84,.08)}
      .trip-entry-title{margin:0 0 6px;font-size:15px;font-weight:750;color:#22313a}
      .trip-entry-description{margin:0;color:#819198;font-size:12px;line-height:1.65}
      .trip-entry-range{display:inline-flex;margin-top:11px;padding:5px 8px;border-radius:9px;background:#edf8f7;color:#307a78;font-size:10px}
      @media(max-width:640px){header.sticky>div:first-child{padding:20px 18px 10px!important}#trip-day-picker{padding-left:18px;padding-right:18px}.trip-entry{grid-template-columns:42px minmax(0,1fr);gap:14px}.trip-day-timeline:before{left:48px}.trip-entry:before{left:43px}.trip-entry-card{padding:14px}}
      /* Make the live page follow the preview's compact travel-app frame and filter row. */
      body{max-width:480px;margin:0 auto;background:#eaf0ef!important;box-shadow:0 0 45px rgba(36,60,59,.1)}
      header.sticky{max-width:480px!important}
      .trip-eyebrow{display:block;margin-bottom:5px;color:#198e8b;font-size:10px;letter-spacing:.18em;font-weight:800}
      header.sticky>div:first-child>div{min-width:0}
      header.sticky>div:first-child h1{margin:0 0 3px}
      header.sticky span.bg-red-800{border:1px solid #b6e0dd;border-radius:999px;padding:9px 12px!important;background:#f8ffff!important;color:#257a78!important;font-size:11px}
      #trip-day-picker{padding:12px 18px 15px}
      .trip-day-choice{flex-basis:66px;min-height:88px}
      #sec-itinerary>h2{display:none}
      #trip-day-filters{display:flex;flex-wrap:wrap;gap:6px;padding:14px 18px 12px}
      .trip-day-filter{border:1px solid #dceceb;border-radius:999px;background:#fff;padding:8px 12px;color:#61767b;font-size:11px;white-space:nowrap}
      .trip-day-filter.active{background:#198e8b;border-color:#198e8b;color:#fff;box-shadow:0 4px 10px rgba(25,142,139,.25)}
      .trip-day-overview{margin:12px 2px 18px}
      .trip-day-title{font-size:18px}
      .trip-entry-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
      .trip-entry-title{min-width:0}
      .trip-entry-kind{flex:0 0 auto;max-width:42%;padding:6px 8px;border-radius:9px;background:#edf8f7;color:#307a78;font-size:10px;white-space:nowrap}
      nav.fixed.bottom-0{max-width:480px!important;left:50%!important;right:auto!important;width:min(100%,480px)!important;transform:translateX(-50%)}
      nav.fixed.bottom-0>div{max-width:480px!important}
      nav .nav-btn{font-size:10px}
      nav .nav-btn i{display:none}
      nav .nav-btn:nth-child(1):before{content:"🗓️"}
      nav .nav-btn:nth-child(2):before{content:"📍"}
      nav .nav-btn:nth-child(3):before{content:"♨️"}
      nav .nav-btn:nth-child(4):before{content:"🍜"}
      nav .nav-btn:nth-child(5):before{content:"🗺️"}
      nav .nav-btn:before{display:block;font-size:18px;line-height:1.2}
      @media(min-width:700px){header.sticky{max-width:480px;margin:0 auto;border-radius:26px 26px 0 0}}
      .flight-summary{margin:0;padding:0 16px 12px;background:linear-gradient(145deg,#fff 30%,#eaf8f6)}
      .flight-summary-toggle{width:100%;display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid #dceceb;border-radius:15px;background:#fff;color:#173b40;text-align:left;box-shadow:0 4px 14px rgba(37,83,84,.06)}
      .flight-summary-icon{flex:0 0 auto;font-size:19px}
      .flight-summary-copy{display:grid;gap:3px;min-width:0;flex:1}
      .flight-summary-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
      .flight-summary-copy small{color:#819198;font-size:10px}
      .flight-summary-chevron{color:#198e8b;transition:transform .15s}
      .flight-summary.expanded .flight-summary-chevron{transform:rotate(180deg)}
      .flight-summary-details{display:none;padding:5px 10px 0}
      .flight-summary.expanded .flight-summary-details{display:block}
      .flight-detail-line{display:grid;gap:3px;padding:9px 4px;border-top:1px solid #e5efed;font-size:11px;color:#526c6e}
      .flight-detail-line small{color:#819198}
      .editor-flight-card .flight-fields{padding:12px}
      .editor-card-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .editor-empty{padding:22px;text-align:center;color:#819198;background:#fff;border:1px dashed #b8d8d6;border-radius:16px}
    `; document.head.append(style);
  }

  async function syncSharedFavorites(mergeLocal = false) {
    if (favoriteSyncPending) return;
    try {
      const remote = await api("/api/favorites");
      const serverFavorites = new Set(Array.isArray(remote.favorites) ? remote.favorites : []);
      if (mergeLocal) {
        const uploads = [...favorites].filter(id => !serverFavorites.has(id));
        for (const id of uploads) serverFavorites.add(id);
        saveFavorites();
        await Promise.allSettled(uploads.map(placeId => api("/api/favorites", { method: "POST", body: JSON.stringify({ placeId, favorite: true }) })));
      }
      const changed = serverFavorites.size !== favorites.size || [...serverFavorites].some(id => !favorites.has(id));
      favorites = serverFavorites;
      saveFavorites();
      if (changed || mergeLocal) renderPage();
    } catch (error) { console.warn("共用最愛尚未同步：", error.message); }
  }

  async function init() {
    addStyles();
    const header = document.querySelector("header > div");
    if (header) {
      const actions = el("div", "flex items-center gap-2");
      const login = el("button", "trip-editor-login", "登入編輯");
      login.type = "button"; login.addEventListener("click", async () => { if (!token) return loginDialog(); try { await api("/api/content"); editDialog(); } catch { token = ""; sessionStorage.removeItem(TOKEN_KEY); loginDialog(); } });
      actions.append(login); header.append(actions);
      const h1 = header.querySelector("h1");
      if (h1 && !header.querySelector(".trip-eyebrow")) h1.insertAdjacentElement("beforebegin", el("span", "trip-eyebrow", "HANOI JOURNEY"));
    }
    state = captureInitial();
    try { const result = await api("/api/content", { headers: token ? { Authorization: `Bearer ${token}` } : {} }); if (result.content) { state = result.content; state.tagOptions ||= {}; state.flights ||= []; renderPage(); } }
    catch (error) { console.warn("旅程資料尚未從 Cloudflare 載入：", error.message); }
    if (token) { try { await api("/api/content"); } catch { token = ""; sessionStorage.removeItem(TOKEN_KEY); } }
    await syncSharedFavorites(true);
    window.setInterval(() => {
      if (document.visibilityState === "visible") syncSharedFavorites(false);
    }, 15000);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
