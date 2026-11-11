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
  let activeEditDayIndex = 0;
  let activeDayFilter = "全部行程";
  let editorHasUnsavedChanges = false;
  let pendingHomeInstall = null;
  const placeEditFilters = { attractions: "all", entertainment: "all", food: "all" };
  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let weatherCache = { location: "", promise: null, data: null, loadedAt: 0 };

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
      weatherLocation: "",
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

  function resolveTripDate(value) {
    const source = String(value || "");
    const iso = source.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    if (iso) return iso[1] + "-" + iso[2].padStart(2, "0") + "-" + iso[3].padStart(2, "0");
    const md = source.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (!md) return "";
    const year = Number(String(state?.dateRange || "").match(/20\d{2}/)?.[0] || new Date().getFullYear());
    return year + "-" + md[1].padStart(2, "0") + "-" + md[2].padStart(2, "0");
  }
  function weatherIcon(code, isDay) {
    if (code === 0) return isDay ? "☀️" : "🌙";
    if ([1, 2].includes(code)) return isDay ? "🌤️" : "☁️";
    if (code === 3) return "☁️";
    if ([45, 48].includes(code)) return "🌫️";
    if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
    if ([95, 96, 99].includes(code)) return "⛈️";
    return "🌡️";
  }
  function weatherDescription(code) {
    if (code === 0) return "晴朗";
    if ([1, 2].includes(code)) return "晴時多雲";
    if (code === 3) return "多雲";
    if ([45, 48].includes(code)) return "有霧";
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "有雨";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "降雪";
    if ([95, 96, 99].includes(code)) return "雷雨";
    return "目前天氣";
  }
  function renderDayWeather(location, data) {
    if (String(state?.weatherLocation || "").trim() !== location) return;
    const daily = data.daily || {};
    document.querySelectorAll("#trip-day-picker .trip-day-choice").forEach(button => {
      const output = button.querySelector(".trip-day-weather");
      if (!output) return;
      const index = (daily.time || []).indexOf(button.dataset.weatherDate || "");
      const high = daily.temperature_2m_max?.[index];
      const low = daily.temperature_2m_min?.[index];
      const code = Number(daily.weather_code?.[index]);
      if (index < 0 || high == null || low == null) { output.textContent = "—°"; return; }
      output.textContent = weatherIcon(code, 1) + " " + Math.round(Number(high)) + "°/" + Math.round(Number(low)) + "°";
      output.title = weatherDescription(code) + " · 最高 " + Math.round(Number(high)) + "°C，最低 " + Math.round(Number(low)) + "°C";
    });
    const credit = document.getElementById("trip-weather-credit");
    if (credit) {
      const date = resolveTripDate(state.days[activeDayIndex]?.date);
      const index = (daily.time || []).indexOf(date);
      const region = [data.place || location, data.country].filter(Boolean).join(", ");
      const high = daily.temperature_2m_max?.[index], low = daily.temperature_2m_min?.[index];
      const code = Number(daily.weather_code?.[index]);
      credit.textContent = index >= 0 && high != null && low != null
        ? region + " · " + weatherIcon(code, 1) + " " + weatherDescription(code) + " · 最高 " + Math.round(Number(high)) + "° / 最低 " + Math.round(Number(low)) + "° · By Open-Meteo"
        : region + " · 當日天氣預報尚未提供 · By Open-Meteo";
      credit.title = "行程日期：" + (state.days[activeDayIndex]?.date || "未設定日期");
    }
  }
  async function fetchTripWeather(location) {
    const geoUrl = "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(location) + "&count=1&language=zh&format=json";
    const geoResponse = await fetch(geoUrl);
    if (!geoResponse.ok) throw new Error("地區搜尋失敗");
    const geo = await geoResponse.json();
    const place = geo.results?.[0];
    if (!place) throw new Error("找不到這個地區");
    const query = new URLSearchParams({
      latitude: String(place.latitude), longitude: String(place.longitude),
      current: "temperature_2m,weather_code,is_day", daily: "weather_code,temperature_2m_max,temperature_2m_min", timezone: "auto", forecast_days: "16"
    });
    const weatherResponse = await fetch("https://api.open-meteo.com/v1/forecast?" + query);
    if (!weatherResponse.ok) throw new Error("天氣資料暫時無法讀取");
    const weather = await weatherResponse.json();
    return { place: place.name, country: place.country, current: weather.current, daily: weather.daily };
  }
  function refreshTripWeather() {
    const location = String(state?.weatherLocation || "").trim();
    if (!state || !location) return;
    const show = data => {
      if (String(state?.weatherLocation || "").trim() !== location) return;
      renderDayWeather(location, data);
    };
    if (weatherCache.location === location && weatherCache.data && Date.now() - weatherCache.loadedAt < 30 * 60 * 1000) {
      show(weatherCache.data); return;
    }
    if (weatherCache.location === location && weatherCache.promise) {
      weatherCache.promise.then(show).catch(() => {});
      return;
    }
    const promise = fetchTripWeather(location);
    weatherCache = { location, promise, data: null, loadedAt: 0 };
    promise.then(data => {
      if (weatherCache.location === location) weatherCache = { location, promise: null, data, loadedAt: Date.now() };
      show(data);
    }).catch(() => {
      if (weatherCache.location === location) weatherCache = { location, promise: null, data: null, loadedAt: Date.now() };
    });
  }

  function renderFlightSummary() {
    if (!state) return;
    const header = document.querySelector("header");
    const headerRow = header?.querySelector(":scope > div");
    state.flights ||= [];
    let box = document.getElementById("trip-flight-summary");
    if (!state.flights.length) { box?.remove(); return; }
    if (!box) { box = el("div", "flight-summary"); box.id = "trip-flight-summary"; }
    box.replaceChildren();
    const toggle = el("button", "flight-summary-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    const lines = state.flights.map(f => (f.flightNumber || "航班待填") + " · " + (f.departureTime || "--:--") + "→" + (f.arrivalTime || "--:--") + " " + (f.direction || ""));
    const airlines = [...new Set(state.flights.map(f => f.airline).filter(Boolean))];
    const copy = el("span", "flight-summary-copy");
    copy.append(el("strong", "", lines.join("　/　")), el("small", "", (airlines.join("、") || "航班資訊") + " · 點擊展開航班資訊"));
    toggle.append(el("span", "flight-summary-icon", "✈️"), copy, el("span", "flight-summary-chevron", "▾"));
    const details = el("div", "flight-summary-details");
    state.flights.forEach(f => {
      const row = el("div", "flight-detail-line");
      row.append(el("strong", "", (f.direction || "航班") + " · " + (f.flightNumber || "航班待填")));
      row.append(el("span", "", (f.departureAirport || "出發地待填") + " → " + (f.arrivalAirport || "抵達地待填")));
      row.append(el("small", "", (f.date || "") + ((f.departureTime || f.arrivalTime) ? "　" + (f.departureTime || "--:--") + " → " + (f.arrivalTime || "--:--") : "")));
      if (f.note) row.append(el("small", "", f.note));
      details.append(row);
    });
    toggle.addEventListener("click", () => {
      const expanded = box.classList.toggle("expanded");
      toggle.setAttribute("aria-expanded", String(expanded));
    });
    box.append(toggle, details);
    if (header && headerRow && box.parentElement !== header) headerRow.insertAdjacentElement("afterend", box);
  }

  function renderPage() {
    if (!state) return;
    const savedPageScroll = window.scrollY;
    document.title = state.title || "旅行行程";
    const installTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]'); if (installTitle) installTitle.content = state.title || "旅行行程";
    const applicationTitle = document.querySelector('meta[name="application-name"]'); if (applicationTitle) applicationTitle.content = state.title || "旅行行程";
    const flag = document.querySelector("header .text-2xl"); if (flag && state.flag) flag.textContent = state.flag;
    const title = document.querySelector("header h1"); if (title) title.textContent = state.title;
    const date = document.querySelector("header p");
    if (date) {
      const matches = [...String(tripHeaderDateRange()).matchAll(/(\d{1,2})\/(\d{1,2})/g)];
      const monthNames = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
      const daysCount = state.days.length;
      date.textContent = matches.length >= 2
        ? monthNames[Number(matches[0][1]) - 1] + " " + matches[0][2] + " — " + monthNames[Number(matches[1][1]) - 1] + " " + matches[1][2] + (daysCount ? "　·　" + daysCount + " DAYS" : "")
        : (tripHeaderDateRange() + (daysCount ? "　·　" + daysCount + " DAYS" : ""));
    }
    document.querySelector("header span.bg-red-800")?.remove();
    refreshTripWeather();
    renderFlightSummary();
    const itinerary = document.getElementById("sec-itinerary");
    if (itinerary) {
      if (state.days.length) activeDayIndex = Math.min(activeDayIndex, state.days.length - 1);
      let dayPicker = document.getElementById("trip-day-picker");
      if (!dayPicker) {
        dayPicker = el("div", "trip-day-picker");
        dayPicker.id = "trip-day-picker";
        const header = document.querySelector("header");
        const headerRow = header?.querySelector(":scope > div");
        renderFlightSummary();
        const flightSummary = document.getElementById("trip-flight-summary");
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
        button.dataset.weatherDate = resolveTripDate(day.date);
        button.append(el("span", "trip-day-number", weekday), el("strong", "trip-day-date", dateNumber), el("span", "trip-day-weather", "—°"), el("span", "trip-day-label", "DAY " + (index + 1)));
        button.addEventListener("click", () => { activeDayIndex = index; activeDayFilter = "全部行程"; renderPage(); });
        dayPicker.append(button);
      });
      if (weatherCache.location === String(state.weatherLocation || "").trim() && weatherCache.data) renderDayWeather(weatherCache.location, weatherCache.data);

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
      if (state.weatherLocation) {
        const credit = el("a", "weather-credit", state.weatherLocation + " · 正在讀取當日天氣 · By Open-Meteo");
        credit.id = "trip-weather-credit";
        credit.href = "https://open-meteo.com/"; credit.target = "_blank"; credit.rel = "noopener noreferrer";
        overviewCopy.append(credit);
      }
      overview.append(overviewCopy, el("span", "trip-day-count", items.length + " 個行程"));
      if (weatherCache.location === String(state.weatherLocation || "").trim() && weatherCache.data) renderDayWeather(weatherCache.location, weatherCache.data);

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
          detail.append(top);
          if (item.description?.trim()) detail.append(el("p", "trip-entry-description", item.description));
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
      try { const result = await api("/api/login", { method: "POST", body: JSON.stringify({ password: new FormData(event.currentTarget).get("password") }) }); token = result.token; sessionStorage.setItem(TOKEN_KEY, token); editorHasUnsavedChanges = false; closeDialog(); editDialog(); }
      catch (err) { error.textContent = err.message; }
    });
  }

  async function addToHomeScreen() {
    const appName = state?.title || document.querySelector("header h1")?.textContent.trim() || "旅行行程";
    const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appleTitle) appleTitle.content = appName;
    const applicationTitle = document.querySelector('meta[name="application-name"]');
    if (applicationTitle) applicationTitle.content = appName;
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone) {
      showDialog(`<h2 class="text-xl font-bold mb-2">已在主畫面模式</h2><p class="text-sm text-slate-600">「${esc(appName)}」已以獨立視窗開啟。</p><div class="flex justify-end mt-5"><button type="button" class="edit-button" data-close>知道了</button></div>`);
      return;
    }
    if (pendingHomeInstall) {
      const promptEvent = pendingHomeInstall;
      pendingHomeInstall = null;
      await promptEvent.prompt();
      await promptEvent.userChoice;
      return;
    }
    const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const instructions = isAppleMobile
      ? `在 Safari 點「分享」→「加入主畫面」，名稱會使用「${esc(appName)}」。開啟「以網頁 App 打開」後點「加入」。`
      : `在瀏覽器選單選擇「安裝應用程式」或「加到主畫面」，確認名稱為「${esc(appName)}」後完成新增。`;
    showDialog(`<span class="editor-section-kicker">HOME SCREEN</span><h2 class="text-xl font-bold mb-2">加入主畫面</h2><p class="text-sm text-slate-600">${instructions}</p><div class="flex justify-end mt-5"><button type="button" class="edit-button" data-close>知道了</button></div>`);
  }

  function showDialog(content, wide = false) {
    closeDialog();
    const overlay = el("div", "editor-overlay"); overlay.id = "trip-editor-overlay";
    const panel = el("div", `editor-panel${wide ? " wide" : ""}`); panel.innerHTML = content;
    overlay.append(panel); overlay.addEventListener("click", event => {
      if (!event.target.closest("[data-close]")) return;
      if (panel.querySelector("#trip-form") && editorHasUnsavedChanges && !window.confirm("有尚未儲存的修改，確定離開編輯畫面嗎？")) return;
      const returnToEditor = Boolean(panel.querySelector("#new-tag-form, #edit-tag-form"));
      if (panel.querySelector("#trip-form")) editorHasUnsavedChanges = false;
      closeDialog();
      if (returnToEditor) editDialog();
    }); document.body.append(overlay);
  }
  function closeDialog() {
    const overlay = document.getElementById("trip-editor-overlay");
    overlay?.querySelector(".editor-panel")?._stickyResizeObserver?.disconnect();
    overlay?.remove();
  }

  function syncEditorStickyLayout(panel) {
    const heading = panel.querySelector(".editor-heading"), tabs = panel.querySelector(".edit-tabs");
    if (!heading || !tabs) return;
    const update = () => {
      panel.style.setProperty("--editor-heading-height", heading.offsetHeight + "px");
      panel.style.setProperty("--editor-tabs-height", tabs.offsetHeight + "px");
    };
    update();
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(update);
      observer.observe(heading); observer.observe(tabs);
      panel._stickyResizeObserver = observer;
    }
  }

  function editDialog() {
    if (!token) return loginDialog();
    const previousPanel = document.querySelector(".editor-panel");
    const scrollTop = previousPanel?.scrollTop || 0;
    showDialog(editorMarkup(), true);
    const panel = document.querySelector(".editor-panel");
    if (panel) panel.scrollTop = scrollTop;
    if (panel) syncEditorStickyLayout(panel);
    if (activeTab === "days" && panel) prepareDayEditor(panel);
    bindEditor();
  }

  function editorMarkup() {
    const tabs = `<div class="edit-tabs">${[["trip", "基本資料"], ["flights", "航班"], ["days", "每日行程"], ["attractions", "景點"], ["entertainment", "娛樂"], ["food", "美食"]].map(([id, name]) => `<button type="button" class="edit-tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${name}</button>`).join("")}</div>`;
    return `<form id="trip-form" class="editor-form"><div class="editor-heading"><div><span class="editor-eyebrow">TRIP SETTINGS</span><h2>編輯旅程</h2><p>行程、航班與地點資料會同步儲存。</p></div><div class="editor-heading-actions"><button type="button" id="logout-button" class="edit-button secondary">登出</button><button type="submit" class="edit-button">儲存</button><button type="button" class="edit-button secondary" data-close>完成</button><span id="save-message" class="editor-save-message"></span></div></div>${tabs}${tabContents()}</form>`;
  }

  function prepareDayEditor(panel) {
    const toolbar = panel.querySelector(".days-toolbar");
    if (!toolbar) return;
    activeEditDayIndex = state.days.length ? Math.max(0, Math.min(activeEditDayIndex, state.days.length - 1)) : 0;
    const picker = el("div", "editor-day-picker");
    const dayList = el("div", "editor-day-list");
    dayList.id = "editor-day-list";
    state.days.forEach((day, index) => {
      const button = el("button", `editor-day-choice${index === activeEditDayIndex ? " active" : ""}`);
      button.type = "button";
      button.draggable = true;
      button.dataset.dayIndex = String(index);
      button.title = "拖曳或按住 ⠿ 調整日期順序";
      button.setAttribute("aria-pressed", String(index === activeEditDayIndex));
      const label = el("span", "editor-day-choice-label");
      label.append(document.createTextNode(`DAY ${index + 1} `), el("i", "editor-day-drag-grip", "⠿"));
      button.append(label, el("strong", "", day.date || "日期待填"));
      button.addEventListener("click", () => { readForm(); activeEditDayIndex = index; editDialog(); });
      dayList.append(button);
    });
    const addDay = el("button", "editor-day-add", "+");
    addDay.type = "button";
    addDay.dataset.addDay = "";
    addDay.setAttribute("aria-label", "新增天數");
    addDay.title = "新增天數";
    picker.append(dayList, addDay);
    const sticky = el("div", "editor-day-sticky");
    sticky.append(picker);
    if (state.days.length) {
      const actions = el("div", "editor-day-fixed-actions");
      actions.append(el("strong", "", `第 ${activeEditDayIndex + 1} 天 · ${state.days[activeEditDayIndex].date || "日期待填"}`));
      const buttons = el("div", "editor-day-fixed-buttons");
      const addItem = el("button", "edit-button secondary", "＋ 新增行程");
      addItem.type = "button"; addItem.dataset.addItem = String(activeEditDayIndex);
      const deleteDay = el("button", "edit-button danger", "刪除本日");
      deleteDay.type = "button"; deleteDay.dataset.deleteDay = String(activeEditDayIndex);
      buttons.append(addItem, deleteDay); actions.append(buttons); sticky.append(actions);
    }
    toolbar.insertAdjacentElement("afterend", sticky);
    if (!state.days.length) sticky.insertAdjacentElement("afterend", el("div", "editor-empty", "目前沒有行程日，請新增一天開始編輯。"));
    panel.querySelectorAll(".editor-day-card").forEach((card, index) => {
      card.open = index === activeEditDayIndex;
      card.style.display = index === activeEditDayIndex ? "" : "none";
    });
  }

  function input(label, name, value, type = "text", placeholder = "") {
    const step = type === "number" ? ' step="any"' : "";
    return `<label class="edit-label">${esc(label)}<input class="edit-input" name="${esc(name)}" type="${type}"${step} value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`;
  }
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
  function shiftStoredDate(value, amount) {
    const iso = calendarDateValue(value);
    if (!iso) return '';
    const date = new Date(iso + 'T12:00:00');
    date.setDate(date.getDate() + amount);
    return calendarDateText([date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'));
  }
  function resequenceDayDates(anchor) {
    const iso = calendarDateValue(anchor);
    if (!iso) return;
    const start = new Date(iso + 'T12:00:00');
    state.days.forEach((day, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      day.date = calendarDateText([date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'));
    });
  }
  function tripHeaderDateRange() {
    const dates = state.days.map(day => calendarDateValue(day.date)).filter(Boolean);
    if (!dates.length) return state.dateRange || '';
    const label = value => { const [, month, day] = value.split('-'); return Number(month) + '/' + Number(day); };
    return dates.length === 1 ? label(dates[0]) : label(dates[0]) + ' — ' + label(dates[dates.length - 1]);
  }
  function readSingleTime(value) {
    const first = String(value || "").split(/[-–~～至]/)[0].trim();
    const match = first.match(/^(\d{1,2}):(\d{2})/);
    return match ? [match[1].padStart(2, "0"), match[2]] : ["09", "00"];
  }
  function timePointEditor(dayIndex, itemIndex, endpoint, values, label) {
    const base = 'days.' + dayIndex + '.items.' + itemIndex + '.' + endpoint;
    const value = Array.isArray(values) ? values.join(":") : readSingleTime(values).join(":");
    return '<div class="time-point itinerary-time-point"><input class="edit-input time-wheel" type="time" lang="en-GB" step="60" aria-label="' + esc(label) + '時間" name="' + base + '" value="' + esc(value) + '" /></div>';
  }
  function flightTimeEditor(label, name, value) {
    const time = readSingleTime(value).join(":");
    return '<label class="edit-label flight-time-editor">' + esc(label) + '（24 小時制）<input class="edit-input time-wheel" type="time" lang="en-GB" step="60" name="' + name + '" aria-label="' + esc(label) + '" value="' + esc(time) + '" /></label>';
  }
  function tabContents() {
    if (activeTab === "trip") return `<div class="editor-section-intro"><span class="editor-section-kicker">TRIP SETTINGS</span><h3>旅程基本資料</h3><p>設定名稱、日期與天數，這些資訊會顯示在頁首。</p></div><div class="edit-grid trip-settings-grid">${input("國旗／圖示", "flag", state.flag, "text", "例如 🇯🇵")}${input("旅程標題", "title", state.title)}${input("日期範圍", "dateRange", state.dateRange)}${input("行程天數說明", "duration", state.duration)}${input("天氣地區", "weatherLocation", state.weatherLocation || "", "text", "例如 Hanoi, Vietnam")}</div>`;
    if (activeTab === "flights") {
      state.flights ||= [];
      const cards = state.flights.map((flight, i) => '<section class="edit-card editor-flight-card"><div class="editor-card-heading"><strong>' + esc(flight.direction || "航班") + ' · ' + esc(flight.flightNumber || "新航班") + '</strong><button type="button" class="edit-button tiny danger" data-delete-flight="' + i + '">移除此航班</button></div><div class="edit-grid flight-fields">' +
        input("航班日期", "flights." + i + ".date", flight.date, "date") +
        '<label class="edit-label">航程<select class="edit-input" name="flights.' + i + '.direction"><option value="去程"' + (flight.direction === "去程" ? " selected" : "") + '>去程</option><option value="回程"' + (flight.direction === "回程" ? " selected" : "") + '>回程</option></select></label>' +
        input("航空公司", "flights." + i + ".airline", flight.airline) +
        input("航班編號", "flights." + i + ".flightNumber", flight.flightNumber, "text", "例如 CI-100") +
        flightTimeEditor("出發時間", "flights." + i + ".departureTime", flight.departureTime) +
        flightTimeEditor("抵達時間", "flights." + i + ".arrivalTime", flight.arrivalTime) +
        input("出發地／機場", "flights." + i + ".departureAirport", flight.departureAirport) +
        input("目的地／機場", "flights." + i + ".arrivalAirport", flight.arrivalAirport) +
        input("備註", "flights." + i + ".note", flight.note) + '</div></section>').join("");
      return '<div class="editor-section-intro"><span class="editor-section-kicker">FLIGHT DETAILS</span><h3>航班資訊</h3><p>使用 24 小時制設定航班時間，可選擇去程或回程。</p><div class="flight-add-actions"><button type="button" class="edit-button" data-add-flight="去程">＋ 新增去程</button><button type="button" class="edit-button secondary" data-add-flight="回程">＋ 新增回程</button></div></div>' + (cards || '<div class="editor-empty">尚未新增航班，請新增去程或回程航班。</div>');
    }
        if (activeTab === "days") return `<div class="days-toolbar"><div><span class="editor-section-kicker">DAILY PLAN</span><h3>每日行程</h3><p>可新增天數，並設定日期與單一時間。</p></div></div>${state.days.map((day, i) => `<details class="edit-card editor-day-card" ${i === activeEditDayIndex ? "open" : ""}><summary class="editor-card-summary">第 ${i + 1} 天 · ${esc(day.date || "日期待填")}</summary><div class="edit-grid mt-3">${`<label class="edit-label">日期<input class="edit-input" type="date" name="days.${i}.calendarDate" value="${calendarDateValue(day.date)}" /></label>`}${input("當日目的地／摘要", `days.${i}.destination`, day.destination)}</div><div class="mt-3"><div class="flex justify-between items-center mb-2"><strong class="text-sm">行程項目　<span class="itinerary-sort-hint">⠿ 可拖曳排序</span></strong></div>${day.items.map((item, j) => `<div class="edit-row editor-itinerary-row" data-item-index="${j}" draggable="true"><span class="itinerary-drag-handle" aria-label="拖曳調整順序">⠿</span>${`<div class="time-wheel-group single-time-wheel">${timePointEditor(i, j, "time", readSingleTime(item.time), "行程")}</div>`}<div class="itinerary-item-fields"><input class="edit-input itinerary-title-input" name="days.${i}.items.${j}.title" value="${esc(item.title)}" aria-label="行程" placeholder="行程項目" /><input class="edit-input itinerary-note-input" name="days.${i}.items.${j}.description" value="${esc(item.description || "")}" aria-label="備註" placeholder="備註（選填）" /></div><button type="button" class="edit-button itinerary-delete-icon" data-delete-item="${i}.${j}" aria-label="刪除此行程" title="刪除行程"><span aria-hidden="true">×</span></button></div>`).join("")}</div></details>`).join("")}`;
    const key = activeTab; const items = state.places[key];
    state.tagOptions ||= {};
    state.tagOptions[key] = [...new Set([...(state.tagOptions[key] || []), ...items.map(item => item.category).filter(Boolean)])];
    const activePlaceFilter = placeEditFilters[key] || "all";
    const placeFilters = `<div class="editor-place-filter-row" aria-label="依標籤篩選${labels[key]}">${[["all", "全部"], ...state.tagOptions[key].map(tag => [tag, tag])].map(([value, title]) => `<button type="button" class="editor-place-filter${value === activePlaceFilter ? " active" : ""}" data-place-filter="${esc(value)}">${esc(title)}</button>`).join("")}</div>`;
    const categoryInput = (item, i) => `<label class="edit-label">標籤<input class="edit-input" name="places.${key}.${i}.category" list="tag-options-${key}" value="${esc(item.category)}" placeholder="選擇或輸入標籤" /></label>`;
    const tagList = `<datalist id="tag-options-${key}">${state.tagOptions[key].map(tag => `<option value="${esc(tag)}"></option>`).join("")}</datalist>`;
    const tagManager = `<details class="editor-tag-manager"><summary>標籤管理 · ${state.tagOptions[key].length} 個</summary><div class="editor-tag-list">${state.tagOptions[key].map((tag, i) => `<div class="editor-tag-entry"><span>${esc(tag)}</span><div><button type="button" class="edit-button tiny secondary" data-edit-tag="${i}">編輯</button><button type="button" class="edit-button tiny danger" data-delete-tag="${i}">刪除</button></div></div>`).join("") || '<span class="text-sm text-slate-500">尚無標籤</span>'}</div></details>`;
    return `<div class="editor-place-toolbar">${placeFilters}<div class="editor-place-actions"><button type="button" class="edit-button secondary" data-add-tag="${key}">＋標籤</button><button type="button" class="edit-button editor-place-add" data-add-place="${key}" aria-label="新增${labels[key]}" title="新增${labels[key]}">+</button></div></div><p class="editor-place-help">選擇標籤篩選項目；可在「標籤管理」編輯或刪除標籤。</p>${tagManager}${tagList}${items.map((item, i) => `<details class="edit-card editor-place-card" data-place-category="${esc(item.category || "未分類")}"><summary class="editor-card-summary">${esc(item.name || `新${labels[key]}`)} <span class="text-xs text-slate-500">· ${esc(item.category || "未分類")}</span></summary><div class="edit-grid mt-3">${input("名稱", `places.${key}.${i}.name`, item.name)}${categoryInput(item, i)}${input("描述／備註", `places.${key}.${i}.description`, item.description)}${input("連結", `places.${key}.${i}.url`, item.url, "url", "https://...")}${input("緯度（選填）", `places.${key}.${i}.latitude`, item.latitude, "number")}${input("經度（選填）", `places.${key}.${i}.longitude`, item.longitude, "number")}</div><button type="button" class="edit-button tiny danger mt-3" data-delete-place="${key}.${i}">刪除此${labels[key]}</button></details>`).join("")}`;
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
      editorHasUnsavedChanges = true;
      closeDialog();
      editDialog();
    });
  }

  function editTagDialog(key, index) {
    const oldTag = state.tagOptions?.[key]?.[index];
    if (oldTag === undefined) return;
    showDialog(`<h2 class="text-xl font-bold mb-2">編輯標籤</h2><p class="text-sm text-slate-500 mb-4">改名後，所有使用此標籤的項目與篩選會一起更新。</p><form id="edit-tag-form"><label class="edit-label">標籤名稱<input name="tag" class="edit-input" maxlength="100" required value="${esc(oldTag)}" /></label><p id="tag-error" class="text-sm text-red-600 mt-2"></p><div class="flex justify-end gap-2 mt-5"><button type="button" class="edit-button secondary" data-close>取消</button><button class="edit-button">儲存名稱</button></div></form>`);
    document.getElementById("edit-tag-form").addEventListener("submit", event => {
      event.preventDefault();
      const updated = String(new FormData(event.currentTarget).get("tag") || "").trim();
      const error = document.getElementById("tag-error");
      if (!updated) { error.textContent = "請輸入標籤名稱。"; return; }
      if (state.tagOptions[key].some((tag, i) => i !== index && tag.toLocaleLowerCase() === updated.toLocaleLowerCase())) { error.textContent = "這個標籤已存在。"; return; }
      if (updated !== oldTag) {
        state.tagOptions ||= {};
        for (const placeKey of Object.keys(state.places || {})) {
          state.places[placeKey].forEach(item => { if (item.category === oldTag) item.category = updated; });
          const options = state.tagOptions[placeKey] || [];
          const matching = options.indexOf(oldTag);
          if (matching >= 0) {
            if (options.some((tag, i) => i !== matching && tag.toLocaleLowerCase() === updated.toLocaleLowerCase())) options.splice(matching, 1);
            else options[matching] = updated;
          }
          if (placeEditFilters[placeKey] === oldTag) placeEditFilters[placeKey] = updated;
        }
        editorHasUnsavedChanges = true;
      }
      closeDialog();
      editDialog();
    });
  }

  function setPath(object, path, value) { const parts = path.split("."); let ref = object; for (let i = 0; i < parts.length - 1; i++) ref = ref[parts[i]]; ref[parts.at(-1)] = value; }
  function applyEditorPlaceFilter(key) {
    const selected = placeEditFilters[key] || "all";
    document.querySelectorAll(".editor-place-card").forEach(card => {
      card.style.display = selected === "all" || card.dataset.placeCategory === selected ? "" : "none";
    });
    document.querySelectorAll("[data-place-filter]").forEach(button => button.classList.toggle("active", button.dataset.placeFilter === selected));
  }
  function bindSortable(root, itemSelector, handleSelector, onSorted) {
    if (!root) return;
    let dragged = null, changed = false;
    const moveTo = (x, y) => {
      const target = document.elementFromPoint(x, y)?.closest(itemSelector);
      if (!dragged || !target || target === dragged || target.parentElement !== root) return;
      const rect = target.getBoundingClientRect();
      const before = root.id === "editor-day-list" ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2;
      root.insertBefore(dragged, before ? target : target.nextSibling); changed = true;
    };
    const finish = () => {
      if (dragged && changed) onSorted([...root.querySelectorAll(itemSelector)]);
      dragged?.classList.remove("is-dragging"); dragged = null; changed = false;
    };
    root.querySelectorAll(itemSelector).forEach(item => {
      item.addEventListener("dragstart", event => { dragged = item; changed = false; item.classList.add("is-dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", "reorder"); });
      item.addEventListener("dragend", () => { item.classList.remove("is-dragging"); dragged = null; });
      item.addEventListener("pointerdown", event => {
        if (event.pointerType !== "touch" || !event.target.closest(handleSelector)) return;
        const pointer = event.pointerId, startX = event.clientX, startY = event.clientY;
        let timer = setTimeout(() => { dragged = item; changed = false; item.classList.add("is-dragging"); }, 320);
        const move = ev => { if (ev.pointerId !== pointer) return; if (!dragged) { if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) clearTimeout(timer); return; } ev.preventDefault(); moveTo(ev.clientX, ev.clientY); };
        const end = ev => { if (ev.pointerId !== pointer) return; clearTimeout(timer); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end); if (dragged === item) finish(); };
        document.addEventListener("pointermove", move, { passive: false }); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
      });
    });
    root.addEventListener("dragover", event => { if (!dragged) return; event.preventDefault(); moveTo(event.clientX, event.clientY); });
    root.addEventListener("drop", event => { if (!dragged) return; event.preventDefault(); finish(); });
  }
  function bindEditor() {
    const form = document.getElementById("trip-form");
    form.addEventListener("input", () => { editorHasUnsavedChanges = true; });
    form.addEventListener("change", () => { editorHasUnsavedChanges = true; });
    form.addEventListener("click", event => {
      if (event.target.closest("[data-add-day],[data-add-item],[data-delete-item],[data-delete-day],[data-add-flight],[data-delete-flight],[data-add-place],[data-delete-place],[data-add-tag]")) editorHasUnsavedChanges = true;
    });
    document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => { readForm(); activeTab = button.dataset.tab; editDialog(); }));
    bindSortable(document.getElementById("editor-day-list"), ".editor-day-choice", ".editor-day-drag-grip", ordered => {
      readForm();
      const selected = state.days[activeEditDayIndex];
      const anchor = state.days.map(day => calendarDateValue(day.date)).filter(Boolean).sort()[0];
      const reordered = ordered.map(node => state.days[Number(node.dataset.dayIndex)]);
      state.days.splice(0, state.days.length, ...reordered);
      activeEditDayIndex = state.days.indexOf(selected);
      resequenceDayDates(anchor);
      editorHasUnsavedChanges = true;
      editDialog();
    });
    document.querySelectorAll(".editor-day-card").forEach((card, cardIndex) => {
      const root = card.querySelector(".editor-itinerary-row")?.parentElement;
      bindSortable(root, ".editor-itinerary-row", ".itinerary-drag-handle", ordered => {
        readForm();
        const dayIndex = cardIndex;
        const items = state.days[dayIndex]?.items;
        if (!items) return;
        const reordered = ordered.map(node => items[Number(node.dataset.itemIndex)]);
        items.splice(0, items.length, ...reordered);
        editorHasUnsavedChanges = true;
        editDialog();
      });
    });
    document.querySelectorAll("[data-place-filter]").forEach(button => button.addEventListener("click", () => { readForm(); placeEditFilters[activeTab] = button.dataset.placeFilter; applyEditorPlaceFilter(activeTab); }));
    document.querySelectorAll("[data-add-flight]").forEach(button => button.addEventListener("click", () => { readForm(); state.flights ||= []; state.flights.push({ direction: button.dataset.addFlight || "去程", airline: "", flightNumber: "", departureTime: "", arrivalTime: "", departureAirport: "", arrivalAirport: "", date: "", note: "" }); editDialog(); }));
    document.querySelectorAll("[data-delete-flight]").forEach(button => button.addEventListener("click", () => { readForm(); state.flights.splice(Number(button.dataset.deleteFlight), 1); editDialog(); }));
    document.querySelector("[data-add-day]")?.addEventListener("click", () => { readForm(); const previous = [...state.days].reverse().find(day => calendarDateValue(day.date)); state.days.push({ date: previous ? shiftStoredDate(previous.date, 1) : "", destination: "", items: [] }); activeEditDayIndex = state.days.length - 1; editDialog(); });
    document.querySelectorAll("[data-add-item]").forEach(button => button.addEventListener("click", () => { readForm(); activeEditDayIndex = Number(button.dataset.addItem); state.days[activeEditDayIndex].items.push({ time: "00:00-01:00", title: "", description: "" }); editDialog(); }));
    document.querySelectorAll("[data-delete-item]").forEach(button => button.addEventListener("click", () => { readForm(); const [i,j] = button.dataset.deleteItem.split(".").map(Number); state.days[i].items.splice(j,1); editDialog(); }));
    document.querySelectorAll("[data-delete-day]").forEach(button => button.addEventListener("click", () => { readForm(); const removedIndex = Number(button.dataset.deleteDay); state.days.splice(removedIndex,1); for (let i = removedIndex; i < state.days.length; i++) if (calendarDateValue(state.days[i].date)) state.days[i].date = shiftStoredDate(state.days[i].date, -1); activeEditDayIndex = Math.max(0, Math.min(activeEditDayIndex, state.days.length - 1)); editDialog(); }));
    document.querySelectorAll("[data-add-place]").forEach(button => button.addEventListener("click", () => { readForm(); state.places[button.dataset.addPlace].push({ name: "", category: "", description: "", url: "", latitude: "", longitude: "" }); editDialog(); }));
    document.querySelectorAll("[data-add-tag]").forEach(button => button.addEventListener("click", () => { readForm(); addTagDialog(button.dataset.addTag); }));
    document.querySelectorAll("[data-edit-tag]").forEach(button => button.addEventListener("click", () => {
      readForm();
      editTagDialog(activeTab, Number(button.dataset.editTag));
    }));
    document.querySelectorAll("[data-delete-tag]").forEach(button => button.addEventListener("click", () => {
      readForm();
      const key = activeTab, index = Number(button.dataset.deleteTag), tag = state.tagOptions[key]?.[index];
      if (tag === undefined || !window.confirm(`確定刪除「${tag}」標籤嗎？使用此標籤的項目會改為未分類。`)) return;
      state.tagOptions[key].splice(index, 1);
      state.places[key].forEach(item => { if (item.category === tag) item.category = ""; });
      if (placeEditFilters[key] === tag) placeEditFilters[key] = "all";
      editorHasUnsavedChanges = true; editDialog();
    }));
    document.querySelectorAll("[data-delete-place]").forEach(button => button.addEventListener("click", () => { readForm(); const [key,i] = button.dataset.deletePlace.split("."); state.places[key].splice(Number(i),1); editDialog(); }));
    document.getElementById("trip-form").addEventListener("submit", async event => {
      event.preventDefault(); readForm();
      const msg = document.getElementById("save-message"); msg.textContent = "正在儲存…";
      try { await api("/api/content", { method: "POST", body: JSON.stringify({ content: state }) }); editorHasUnsavedChanges = false; renderPage(); msg.textContent = "已儲存到 Cloudflare。"; }
      catch (error) { msg.textContent = error.message; }
    });
    document.getElementById("logout-button").addEventListener("click", async () => { if (editorHasUnsavedChanges && !window.confirm("有尚未儲存的修改，確定登出並放棄嗎？")) return; try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {} editorHasUnsavedChanges = false; token = ""; sessionStorage.removeItem(TOKEN_KEY); closeDialog(); });
  }
  function readForm() {
    const form = document.getElementById("trip-form"); if (!form) return;
    const data = new FormData(form);
    for (const [path, value] of data) {
      if (!path || path.endsWith(".calendarDate")) continue;
      setPath(state, path, value);
    }
    for (let i = 0; i < state.days.length; i++) {
      const date = data.get("days." + i + ".calendarDate");
      if (date) state.days[i].date = calendarDateText(String(date));
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
      .trip-day-timeline:before{content:"";position:absolute;left:63px;top:12px;bottom:18px;width:2px;background:linear-gradient(#198e8b,#cde9e6 92%,transparent)}
      .trip-entry{display:grid;grid-template-columns:55px minmax(0,1fr);gap:15px;position:relative;margin-bottom:16px}
      .trip-entry-time{min-width:0;padding-top:18px;text-align:right;font-family:Georgia,serif;font-size:13px;font-weight:700;color:#198e8b;white-space:nowrap;font-variant-numeric:tabular-nums}
      .trip-entry:before{content:"";position:absolute;left:57px;top:22px;width:12px;height:12px;border:3px solid #198e8b;border-radius:50%;background:#fff;box-shadow:0 0 0 2px #e5f5f3;z-index:1}
      .trip-entry-card{position:relative;min-width:0;padding:16px;background:#fff;border:1px solid #dceceb;border-radius:21px;box-shadow:0 10px 30px rgba(37,83,84,.08)}
      .trip-entry-title{margin:0 0 6px;font-size:15px;font-weight:750;color:#22313a}
      .trip-entry-description{margin:0;color:#819198;font-size:12px;line-height:1.65}
      .trip-entry-range{display:inline-flex;margin-top:11px;padding:5px 8px;border-radius:9px;background:#edf8f7;color:#307a78;font-size:10px}
      @media(max-width:640px){header.sticky>div:first-child{padding:20px 18px 10px!important}#trip-day-picker{padding-left:18px;padding-right:18px}.trip-entry{grid-template-columns:45px minmax(0,1fr);gap:10px}.trip-day-timeline:before{left:53px}.trip-entry:before{left:47px}.trip-entry-time{padding-right:2px;font-size:12px}.trip-entry-card{padding:14px}}
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
      .flight-summary{padding:0 16px 12px;background:linear-gradient(145deg,#fff 30%,#eaf8f6)}
      .flight-summary-toggle{width:100%;display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid #dceceb;border-radius:15px;background:#fff;color:#173b40;text-align:left;box-shadow:0 4px 14px rgba(37,83,84,.06)}
      .flight-summary-icon{flex:0 0 auto;font-size:19px}.flight-summary-copy{display:grid;gap:3px;min-width:0;flex:1}
      .flight-summary-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.flight-summary-copy small{color:#819198;font-size:10px}
      .flight-summary-chevron{color:#198e8b;transition:transform .15s}.flight-summary.expanded .flight-summary-chevron{transform:rotate(180deg)}
      .flight-summary-details{display:none;padding:5px 10px 0}.flight-summary.expanded .flight-summary-details{display:block}
      .flight-detail-line{display:grid;gap:3px;padding:9px 4px;border-top:1px solid #e5efed;font-size:11px;color:#526c6e}.flight-detail-line small{color:#819198}
      .editor-flight-card .flight-fields{padding:12px}.editor-card-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .editor-empty{padding:24px 16px;text-align:center;border:1px dashed #b8d8d6;border-radius:16px;color:#7b9092;background:#fff;font-size:13px}
      /* Teal editor workspace styled to match the live travel planner. */
      .editor-overlay{padding:18px;background:rgba(28,56,57,.42);backdrop-filter:blur(5px)}
      .editor-panel,.editor-panel.wide{width:min(100%,900px);max-height:min(92vh,900px);padding:22px;background:#f4f8f7;border:1px solid #dceceb;border-radius:24px;color:#173b40;box-shadow:0 24px 70px rgba(18,65,68,.2)}
      .editor-heading{position:sticky;top:-22px;z-index:12;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:-22px -22px 16px;padding:18px 22px 14px;background:linear-gradient(145deg,#fff 30%,#eaf8f6);border-bottom:1px solid #dceceb;border-radius:24px 24px 0 0}
      .editor-heading h2{margin:2px 0;font-size:21px;font-weight:800;color:#173b40}
      .editor-heading p,.editor-section-intro p,.days-toolbar p{margin:3px 0 0;color:#7b9092;font-size:12px;line-height:1.55}
      .editor-eyebrow,.editor-section-kicker{display:block;color:#198e8b;font-size:10px;font-weight:800;letter-spacing:.17em}
      .edit-tabs{position:sticky;top:78px;z-index:11;display:flex;flex-wrap:wrap;gap:7px;padding:10px;margin:0 0 16px;background:#e9f3f2;border:1px solid #dceceb;border-radius:16px;overflow:visible}
      .edit-tab{padding:8px 13px;border:1px solid #d3e5e3;background:#fff;color:#61767b;font-weight:650}
      .edit-tab.active{background:#198e8b!important;color:#fff!important;border:1px solid #198e8b!important;box-shadow:0 4px 10px rgba(25,142,139,.2)}
      .edit-button{border:1px solid #198e8b!important;border-radius:11px;background:#198e8b!important;color:#fff!important;padding:9px 13px;font-weight:750;box-shadow:0 3px 9px rgba(25,142,139,.12)}
      .edit-button.secondary{background:#fff!important;color:#267c7b!important;border:1px solid #c7e1df!important;box-shadow:none}
      .edit-button.danger{background:#fff3f3!important;color:#bb6d75!important;border:1px solid #f0d6d9!important;box-shadow:none}
      .edit-button:focus-visible,.edit-input:focus-visible{outline:2px solid #198e8b;outline-offset:2px}
      .edit-input{min-height:42px;border-color:#d5e2e1;border-radius:11px;padding:10px 12px;color:#173b40;background:#fff}
      .edit-input:focus{border-color:#63b9b4;box-shadow:0 0 0 3px rgba(25,142,139,.1)}
      .edit-label{color:#526c6e;font-size:12px;font-weight:700;gap:6px}
      .edit-grid{gap:13px}
      .editor-section-intro{margin:4px 2px 16px;padding:15px 16px;background:#fff;border:1px solid #dceceb;border-radius:17px}
      .editor-section-intro h3,.days-toolbar h3{margin:4px 0 0;color:#173b40;font-size:17px;font-weight:800}
      .editor-section-intro .edit-button{margin-top:12px}
      .trip-settings-grid{padding:4px 2px 10px}
      .days-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 2px 14px;padding:14px 16px;background:#fff;border:1px solid #dceceb;border-radius:17px}
      .editor-day-card,.editor-place-card,.editor-flight-card{margin:10px 0;padding:0;background:#fff;border:1px solid #dceceb;border-radius:17px;overflow:hidden;box-shadow:0 4px 13px rgba(28,71,73,.04)}
      .editor-card-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:15px 17px;color:#173b40;font-size:14px;font-weight:800;cursor:pointer}
      .editor-card-summary::marker{color:#198e8b}
      .editor-day-card[open]>.editor-card-summary,.editor-place-card[open]>.editor-card-summary{border-bottom:1px solid #edf3f2;background:#fbfefd}
      .editor-day-card>.edit-grid,.editor-day-card>.mt-3,.editor-place-card>.edit-grid,.editor-flight-card>.flight-fields,.editor-day-card>[data-delete-day],.editor-place-card>[data-delete-place]{margin:12px 15px}
      .editor-day-card>.mt-3{padding:12px 13px;background:#f7faf9;border:1px solid #e7efee;border-radius:14px}
      .editor-itinerary-row{grid-template-columns:minmax(160px,.8fr) minmax(170px,1.1fr) minmax(180px,1.3fr) auto;gap:10px;padding:13px 0;border-top:1px solid #e6efee}
      .editor-itinerary-row>.time-wheel-group.single-time-wheel{grid-column:auto;min-width:0}
      .editor-itinerary-row .time-point{padding:9px;border-color:#dceceb;border-radius:12px;background:#fff}
      .editor-itinerary-row .time-point>strong{color:#267c7b}
      .time-wheel-group.single-time-wheel{min-width:0}
      .editor-card-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 15px;border-bottom:1px solid #edf3f2;background:#fbfefd}
      .editor-flight-card .flight-fields{padding:12px}
      .editor-empty{padding:24px 16px;text-align:center;border:1px dashed #b8d8d6;border-radius:16px;color:#7b9092;background:#fff;font-size:13px}
      .editor-savebar{position:sticky;bottom:-22px;z-index:12;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:18px -22px -22px;padding:13px 22px calc(13px + env(safe-area-inset-bottom,0));background:rgba(255,255,255,.96);border-top:1px solid #dceceb;border-radius:0 0 24px 24px;backdrop-filter:blur(12px)}
      .editor-save-message{flex:1;color:#638082;font-size:12px;text-align:center}
      @media(max-width:640px){.editor-overlay{padding:0;align-items:flex-end}.editor-panel,.editor-panel.wide{width:100%;max-height:96vh;padding:16px 14px 0;border-radius:22px 22px 0 0}.editor-heading{top:-16px;margin:-16px -14px 13px;padding:16px 14px 12px;border-radius:22px 22px 0 0}.edit-tabs{top:72px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.edit-tabs::-webkit-scrollbar{display:none}.edit-tab{flex:0 0 auto}.days-toolbar{align-items:flex-start;padding:12px}.days-toolbar>.edit-button{flex:0 0 auto}.editor-day-card>.edit-grid,.editor-day-card>.mt-3,.editor-place-card>.edit-grid,.editor-flight-card>.flight-fields{margin:10px 11px}.editor-itinerary-row{grid-template-columns:1fr 1fr;gap:9px}.editor-itinerary-row>.time-wheel-group.single-time-wheel{grid-column:1/-1;max-width:none}.editor-itinerary-row .edit-label:nth-of-type(2){grid-column:1/-1}.editor-itinerary-row>button{justify-self:start}.editor-savebar{bottom:0;margin:16px -14px 0;padding:11px 14px calc(11px + env(safe-area-inset-bottom,0));border-radius:0}.editor-save-message{text-align:left}.editor-card-heading{padding:11px}.flight-fields{grid-template-columns:1fr}}
      /* Keep the itinerary information fixed only on the itinerary tab. */
      body[data-active-tab="sec-itinerary"] header.sticky{position:sticky!important;top:0!important;z-index:60!important;max-width:480px!important}
      body:not([data-active-tab="sec-itinerary"]) header.sticky{display:none!important}
      .trip-header-actions{margin-left:auto;flex:0 0 auto}
      .trip-add-home{border:1px solid #c9e3e1!important;border-radius:999px!important;background:#168f91!important;color:#fff!important;padding:9px 13px!important;font-size:12px!important;font-weight:800!important;white-space:nowrap;box-shadow:0 3px 10px rgba(22,143,145,.18)}
      .trip-add-home:active{transform:scale(.96)}
      body:not([data-active-tab="sec-itinerary"]) .tab-content:not(.hidden)>h2{position:sticky;top:0;z-index:55;display:flex;align-items:center;gap:8px;margin:0 0 4px;padding:12px 2px;background:#f4f8f7;box-shadow:0 5px 12px rgba(37,83,84,.04)}
      body:not([data-active-tab="sec-itinerary"]) .tab-content:not(.hidden)>h2 .trip-header-actions{margin-left:auto}
      body:not([data-active-tab="sec-itinerary"]) .tab-content:not(.hidden)>.place-filters{position:sticky;top:52px;z-index:54;margin:0 0 10px;padding:9px 0 11px;background:#f4f8f7}
      body:not([data-active-tab="sec-itinerary"]) #sec-map>.bg-white{position:sticky;top:48px;z-index:54;margin:0 0 10px;padding:10px;background:#f4f8f7;border:0!important;border-radius:0!important;box-shadow:0 5px 12px rgba(37,83,84,.04)!important}
      body:not([data-active-tab="sec-itinerary"]) #sec-map #map-category-filter{gap:6px}
      .map-pin{touch-action:none;user-select:none;-webkit-user-select:none}
      @media(max-width:640px){body:not([data-active-tab="sec-itinerary"]) .tab-content:not(.hidden)>h2{top:0;padding:10px 2px}.trip-header-actions{gap:5px!important}.trip-header-actions .trip-editor-login,.trip-header-actions .trip-add-home{padding:7px 8px!important;font-size:10px!important}}
      .weather-credit{display:inline-flex;margin-top:4px;color:#819198;font-size:9px;line-height:1.3;text-decoration:none}
      .weather-credit:hover{text-decoration:underline;color:#198e8b}
      header span.bg-red-800{display:none!important;max-width:148px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .trip-day-choice{min-height:104px}
      .trip-day-choice .trip-day-weather{font-size:9px;font-weight:800;color:#347b79;white-space:nowrap;line-height:1.15}
      .trip-day-choice.active .trip-day-weather{color:#fff}
      .trip-day-choice .trip-day-label{margin-top:1px}
      .editor-heading-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap;max-width:55%}.editor-heading-actions .edit-button{white-space:nowrap;padding:8px 11px}.editor-heading-actions .editor-save-message{flex-basis:100%;text-align:right;min-height:16px;font-size:11px}
      .edit-tabs{top:78px;z-index:14}.editor-day-picker{position:sticky;top:132px;z-index:13;display:flex;gap:8px;overflow-x:auto;margin:-6px -2px 12px;padding:9px 2px 12px;background:#f4f8f7;scrollbar-width:none}.editor-day-picker::-webkit-scrollbar{display:none}.editor-day-choice{flex:0 0 auto;min-width:76px;min-height:62px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:8px 11px;border:1px solid #dceceb;border-radius:15px;background:#fff;color:#61767b}.editor-day-choice-label{font-size:9px;font-weight:800;letter-spacing:.08em;color:#819198}.editor-day-choice strong{font-size:12px;color:#29484a}.editor-day-choice.active{border-color:#198e8b;background:#198e8b;color:#fff;box-shadow:0 5px 12px rgba(25,142,139,.18)}.editor-day-choice.active .editor-day-choice-label,.editor-day-choice.active strong{color:#fff}
      @media(max-width:640px){.editor-heading{align-items:flex-start}.editor-heading-actions{gap:5px;max-width:58%}.editor-heading-actions .edit-button{padding:7px 9px;font-size:11px}.editor-heading-actions .editor-save-message{font-size:10px}.edit-tabs{top:72px;z-index:14}.editor-day-picker{top:124px;gap:6px;margin-top:-7px;padding-top:8px}.editor-day-choice{min-width:68px;min-height:56px;padding:7px 9px}}
      .editor-day-add{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:0 0 46px;width:46px;height:46px;align-self:center;padding:0;border:1px dashed #198e8b;border-radius:50%;background:#e9f6f5;color:#198e8b;font-size:27px;line-height:1;text-align:center;font-weight:500}.editor-place-toolbar{display:flex;align-items:center;gap:10px;margin:4px 2px 5px}.editor-place-filter-row{display:flex;flex-wrap:wrap;gap:7px;flex:1;min-width:0}.editor-place-filter{padding:7px 12px;border:1px solid #d3e5e3;border-radius:999px;background:#fff;color:#61767b;font-size:12px;font-weight:700;white-space:nowrap}.editor-place-filter.active{background:#198e8b;color:#fff;border-color:#198e8b;box-shadow:0 3px 9px rgba(25,142,139,.15)}.editor-place-help{margin:0 2px 12px;color:#7b9092;font-size:11px}.editor-place-toolbar>.edit-button{flex:0 0 auto}.flight-add-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.flight-add-actions .edit-button{margin-top:0!important}.flight-time-editor>.time-units{margin-top:6px}.flight-time-editor .time-wheel{font-size:14px}
      @media(max-width:640px){.editor-day-add{width:42px;height:42px;flex-basis:42px}.editor-place-toolbar{align-items:flex-start;flex-direction:column}.editor-place-toolbar>.edit-button{align-self:flex-end}.editor-place-filter-row{width:100%;flex-wrap:nowrap;overflow-x:auto;padding:2px 0 8px;scrollbar-width:none}.editor-place-filter-row::-webkit-scrollbar{display:none}.editor-place-filter{flex:0 0 auto}}
      .editor-day-sticky{position:sticky;top:132px;z-index:13;background:#f4f8f7;padding-bottom:9px}.editor-day-picker{position:static;top:auto;margin:-6px -2px 8px;padding:9px 2px;background:#f4f8f7}.editor-day-fixed-actions{display:flex;align-items:center;justify-content:space-between;gap:9px;padding:10px 12px;background:#fff;border:1px solid #dceceb;border-radius:15px;box-shadow:0 4px 12px rgba(28,71,73,.04)}.editor-day-fixed-actions>strong{font-size:14px;color:#173b40}.editor-day-fixed-buttons{display:flex;gap:7px;flex:0 0 auto}.editor-day-fixed-buttons .edit-button{min-height:42px;padding:8px 11px}.editor-day-choice[draggable="true"],.editor-itinerary-row[draggable="true"]{cursor:grab}.itinerary-drag-handle,.editor-day-drag-grip{color:#819198;cursor:grab;user-select:none;touch-action:none}.itinerary-drag-handle{display:flex;align-items:center;justify-content:center;font-size:19px}.editor-day-drag-grip{font-style:normal;font-size:15px}.itinerary-sort-hint{color:#819198;font-size:11px;font-weight:500}.editor-day-choice.is-dragging,.editor-itinerary-row.is-dragging{opacity:.4}.editor-itinerary-row{grid-template-columns:24px minmax(160px,.8fr) minmax(170px,1.1fr) minmax(180px,1.3fr) auto}
      @media(max-width:640px){.editor-day-sticky{top:124px}.editor-day-fixed-actions{padding:9px;gap:6px}.editor-day-fixed-actions>strong{font-size:12px}.editor-day-fixed-buttons{gap:5px}.editor-day-fixed-buttons .edit-button{min-height:40px;padding:7px 8px;font-size:12px}.editor-day-choice{min-width:74px}.editor-itinerary-row{grid-template-columns:22px minmax(0,1fr);gap:8px}.editor-itinerary-row>.time-wheel-group.single-time-wheel,.editor-itinerary-row>.edit-label,.editor-itinerary-row>button{grid-column:2/-1;max-width:none}.editor-itinerary-row .edit-label:nth-of-type(2){grid-column:2/-1}.editor-itinerary-row>button{justify-self:start}}
      .editor-place-toolbar{position:sticky;top:132px;z-index:13;display:flex;align-items:center;gap:8px;margin:0 -2px 9px;padding:8px 2px;background:#f4f8f7}.editor-place-filter-row{display:flex;flex-wrap:wrap;gap:7px;flex:1;min-width:0}.editor-place-actions{display:flex;align-items:center;gap:7px;flex:0 0 auto}.editor-place-actions>.edit-button{margin:0}.editor-place-add{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:0 0 44px;width:44px;height:44px;padding:0!important;border-radius:50%!important;font-size:25px!important;line-height:1;text-align:center}.editor-place-help{margin:0 2px 10px;color:#7b9092;font-size:12px}.editor-tag-manager{margin:0 0 12px;padding:0 12px;background:#fff;border:1px solid #dceceb;border-radius:14px;color:#526c6e}.editor-tag-manager>summary{padding:12px 0;font-size:13px;font-weight:750;cursor:pointer}.editor-tag-list{display:grid;gap:7px;padding:0 0 12px}.editor-tag-entry{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid #e6efee;border-radius:10px;background:#f8fbfa;font-size:13px;font-weight:650}.editor-tag-entry>div{display:flex;gap:6px}.editor-tag-entry .edit-button{min-height:36px}.editor-itinerary-row{grid-template-columns:24px minmax(160px,.8fr) minmax(170px,1.1fr) auto}.editor-itinerary-row .time-point{padding:6px 8px}.editor-itinerary-row>[data-delete-item]{justify-self:start;width:auto;min-width:54px;max-width:78px;min-height:36px;padding:5px 9px;font-size:12px}
      @media(max-width:640px){.editor-place-toolbar{top:124px;gap:6px;align-items:center;flex-direction:row}.editor-place-filter-row{flex-wrap:nowrap;overflow-x:auto;padding:2px 0 6px;scrollbar-width:none}.editor-place-filter-row::-webkit-scrollbar{display:none}.editor-place-filter{flex:0 0 auto;padding:8px 12px;font-size:13px}.editor-place-actions{gap:5px}.editor-place-actions>[data-add-tag]{min-height:42px;padding:8px 10px}.editor-place-add{flex:0 0 42px;width:42px;height:42px}.editor-itinerary-row>[data-delete-item]{grid-column:2/-1}}
      .editor-day-picker{display:flex;align-items:center;gap:8px;overflow:hidden}.editor-day-list{display:flex;align-items:center;flex:1 1 auto;min-width:0;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;scroll-snap-type:x proximity}.editor-day-list::-webkit-scrollbar{display:none}.editor-day-choice{scroll-snap-align:start}.editor-day-picker>.editor-day-add{flex:0 0 46px;margin-left:auto}
      @media(max-width:640px){.editor-day-picker{gap:6px}.editor-day-list{gap:6px}.editor-day-picker>.editor-day-add{flex-basis:42px}}
      .itinerary-time-point{min-width:0}.itinerary-time-point .time-wheel{display:block;width:100%;min-width:0;font-variant-numeric:tabular-nums}.flight-time-editor .time-wheel{margin-top:5px}
      @media(max-width:640px){.editor-panel,.editor-panel.wide{width:100vw;max-width:100vw;min-width:0;box-sizing:border-box;overflow-x:hidden}.editor-form,.editor-day-card,.editor-day-card>.edit-grid,.editor-day-card>.mt-3,.editor-itinerary-row,.editor-itinerary-row>.edit-label,.editor-itinerary-row>.time-wheel-group,.time-point,.flight-fields,.flight-time-editor{min-width:0;max-width:100%;box-sizing:border-box}.editor-heading{flex-wrap:nowrap;align-items:center}.editor-heading>div:first-child{flex:1 1 auto;min-width:0}.editor-heading p{display:none}.editor-heading-actions{flex:0 1 auto;max-width:58%;width:auto;flex-wrap:wrap;gap:4px}.editor-heading-actions .edit-button{padding:7px 8px;font-size:11px}.editor-heading-actions .editor-save-message{flex-basis:100%;max-width:100%;font-size:10px}.edit-input{min-width:0;max-width:100%;box-sizing:border-box}.editor-itinerary-row{grid-template-columns:22px minmax(0,1fr);width:100%;gap:8px}.editor-itinerary-row>.time-wheel-group.single-time-wheel{grid-column:2/-1;width:100%;max-width:none}.editor-itinerary-row>.edit-label,.editor-itinerary-row>[data-delete-item]{grid-column:2/-1}.editor-itinerary-row .itinerary-time-point{padding:0;border:0;background:transparent}.editor-itinerary-row .time-wheel{min-height:44px;font-size:16px}.editor-itinerary-row>[data-delete-item]{width:auto;justify-self:start}}
      .editor-itinerary-row{grid-template-columns:24px minmax(120px,160px) minmax(0,1fr) 36px;align-items:center}.editor-itinerary-row>.time-wheel-group.single-time-wheel{width:100%;max-width:160px}.itinerary-item-fields{display:grid;grid-template-columns:minmax(0,1fr);gap:5px;min-width:0}.itinerary-item-fields>.edit-input{width:100%;min-width:0}.itinerary-item-fields>.itinerary-note-input{min-height:38px;padding-top:7px;padding-bottom:7px;font-size:13px;color:#627b7d}.itinerary-delete-icon{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:36px;min-width:36px;max-width:36px;height:36px;min-height:36px;padding:0!important;border:1px solid #f0d6d9!important;border-radius:50%!important;background:#fff3f3!important;color:#bb6d75!important;font-size:22px;line-height:1;font-weight:500}.itinerary-delete-icon span{display:block;transform:translateY(-1px)}
      @media(max-width:640px){.editor-day-card>.mt-3{margin:8px 6px;padding:8px}.editor-itinerary-row{grid-template-columns:20px minmax(92px,28vw) minmax(0,1fr) 32px;align-items:center;gap:5px;padding:9px 0}.editor-itinerary-row>.time-wheel-group.single-time-wheel{grid-column:auto;width:auto;max-width:none;justify-self:stretch}.editor-itinerary-row>.itinerary-item-fields{grid-column:auto;width:100%;min-width:0}.editor-itinerary-row .itinerary-item-fields .edit-input{min-height:40px;padding:6px 8px;font-size:14px}.editor-itinerary-row .itinerary-item-fields .itinerary-note-input{min-height:36px;font-size:12px}.editor-itinerary-row .itinerary-time-point{padding:0;border:0;background:transparent}.editor-itinerary-row .time-wheel{width:100%;min-height:42px;padding:6px 3px;font-size:15px}.editor-itinerary-row>.itinerary-delete-icon{grid-column:auto;justify-self:center;width:32px;min-width:32px;max-width:32px;height:32px;min-height:32px}.editor-itinerary-row>.itinerary-drag-handle{grid-column:auto;justify-self:center;font-size:17px}}
      .editor-panel.wide{height:min(78vh,780px);max-height:94vh;box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain}
      @media(max-width:640px){.editor-panel.wide{height:min(78dvh,900px);max-height:94dvh;min-height:0}}
      /* On iPhone, let the editor fill the live Safari page viewport edge to edge. */
      @media(max-width:640px){.editor-overlay{position:fixed;inset:0;height:100vh;height:100dvh;padding:0;align-items:stretch;justify-content:stretch}.editor-panel.wide{width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:none;min-height:0;margin:0;padding:calc(16px + env(safe-area-inset-top,0px)) 14px calc(94px + env(safe-area-inset-bottom,0px));border-radius:0;box-sizing:border-box;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}}
      /* Four fixed columns prevent itinerary controls from overlapping on phones. */
      .editor-itinerary-row{display:grid!important;grid-template-columns:24px minmax(120px,160px) minmax(0,1fr) 36px!important;align-items:center;gap:8px;min-width:0;box-sizing:border-box}
      .editor-itinerary-row>.itinerary-drag-handle{grid-column:1!important;min-width:0}
      .editor-itinerary-row>.time-wheel-group.single-time-wheel{grid-column:2!important;width:100%;min-width:0;max-width:none;justify-self:stretch}
      .editor-itinerary-row>.itinerary-item-fields{grid-column:3!important;display:grid;grid-template-columns:minmax(0,1fr);width:100%;min-width:0;max-width:100%;box-sizing:border-box}
      .editor-itinerary-row>.itinerary-item-fields>.edit-input{display:block;width:100%;min-width:0;max-width:100%;box-sizing:border-box}
      .editor-itinerary-row>.itinerary-delete-icon{grid-column:4!important;justify-self:center;width:36px;min-width:36px;max-width:36px;box-sizing:border-box}
      .editor-itinerary-row .time-point,.editor-itinerary-row .itinerary-time-point,.editor-itinerary-row .time-wheel,.editor-itinerary-row .time-wheel-group{min-width:0;max-width:100%;box-sizing:border-box}
      @media(max-width:640px){.editor-itinerary-row{grid-template-columns:20px clamp(86px,26vw,108px) minmax(0,1fr) 30px!important;gap:5px;padding:9px 0}.editor-itinerary-row>.itinerary-drag-handle{grid-column:1!important;font-size:16px}.editor-itinerary-row>.time-wheel-group.single-time-wheel{grid-column:2!important}.editor-itinerary-row>.itinerary-item-fields{grid-column:3!important}.editor-itinerary-row>.itinerary-delete-icon{grid-column:4!important;width:30px;min-width:30px;max-width:30px;height:30px;min-height:30px}.editor-itinerary-row .time-wheel{min-height:40px;padding:5px 2px;font-size:14px}.editor-itinerary-row .itinerary-item-fields .edit-input{min-height:40px;padding:6px 8px;font-size:14px}.editor-itinerary-row .itinerary-item-fields .itinerary-note-input{min-height:36px;font-size:12px}}
      @media(display-mode:standalone){@supports(height:100dvh){.editor-overlay{align-items:stretch;padding:env(safe-area-inset-top) 0 0}.editor-panel,.editor-panel.wide{width:100vw;max-width:100vw;height:calc(100dvh - env(safe-area-inset-top));max-height:none;border-radius:0;padding-bottom:calc(14px + env(safe-area-inset-bottom,0))}}}
      @media(max-width:640px){.editor-heading{z-index:30!important}.edit-tabs{top:calc(var(--editor-heading-height,88px) - 16px);z-index:29!important}.editor-day-sticky,.editor-place-toolbar{top:calc(var(--editor-heading-height,88px) + var(--editor-tabs-height,58px) - 16px);z-index:28}}
      @media(max-width:640px){.editor-panel.wide{padding-bottom:calc(82px + env(safe-area-inset-bottom,0px))}.editor-heading-actions{position:fixed;left:calc(8px + env(safe-area-inset-left,0px));right:calc(8px + env(safe-area-inset-right,0px));bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:1100;display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:nowrap;box-sizing:border-box;max-width:none;width:auto;padding:8px;border:1px solid #dceceb;border-radius:16px;background:rgba(255,255,255,.97);box-shadow:0 5px 22px rgba(23,59,64,.16);backdrop-filter:blur(14px)}.editor-heading-actions .edit-button{flex:0 0 auto;min-height:40px;padding:7px 9px;font-size:11px}.editor-heading-actions .editor-save-message{order:-1;flex:1 1 auto;flex-basis:auto;min-width:0;max-width:none;text-align:left;font-size:10px;line-height:1.3}.editor-heading{padding-bottom:8px}}
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
    window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); pendingHomeInstall = event; });
    window.addEventListener("appinstalled", () => { pendingHomeInstall = null; });
    const header = document.querySelector("header > div");
    if (header) {
      const actions = el("div", "flex items-center gap-2 trip-header-actions");
      const login = el("button", "trip-editor-login", "登入編輯");
      login.type = "button"; login.addEventListener("click", async () => { if (!token) return loginDialog(); try { await api("/api/content"); editorHasUnsavedChanges = false; editDialog(); } catch { token = ""; sessionStorage.removeItem(TOKEN_KEY); loginDialog(); } });
      const homeButton = el("button", "trip-add-home", "加入主畫面");
      homeButton.type = "button"; homeButton.addEventListener("click", addToHomeScreen);
      actions.append(homeButton, login); header.append(actions);
      const h1 = header.querySelector("h1");
      if (h1 && !header.querySelector(".trip-eyebrow")) h1.insertAdjacentElement("beforebegin", el("span", "trip-eyebrow", "HANOI JOURNEY"));
      const placeActions = tabId => {
        homeButton.style.display = tabId === "sec-itinerary" ? "" : "none";
        if (tabId === "sec-itinerary") header.append(actions);
        else {
          const heading = document.querySelector("#" + tabId + " > h2");
          if (heading) heading.append(actions);
        }
      };
      window.addEventListener("trip:tab-change", event => { const tabId = event.detail?.tabId || document.body.dataset.activeTab; placeActions(tabId); if (tabId === "sec-itinerary") refreshTripWeather(); });
      placeActions(document.body.dataset.activeTab || "sec-itinerary");
    }
    state = captureInitial();
    try { const result = await api("/api/content", { headers: token ? { Authorization: `Bearer ${token}` } : {} }); if (result.content) { state = result.content; state.tagOptions ||= {}; state.flights ||= []; state.weatherLocation ||= ""; renderPage(); } }
    catch (error) { console.warn("旅程資料尚未從 Cloudflare 載入：", error.message); }
    if (token) { try { await api("/api/content"); } catch { token = ""; sessionStorage.removeItem(TOKEN_KEY); } }
    await syncSharedFavorites(true);
    window.setInterval(() => {
      if (document.visibilityState === "visible") syncSharedFavorites(false);
    }, 15000);
  }
  document.addEventListener("DOMContentLoaded", init);
})();


