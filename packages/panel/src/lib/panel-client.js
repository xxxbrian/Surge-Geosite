import { detectPreferredLang, translations } from "./i18n";

const must = (id) => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing required element: #${id}`);
  }
  return node;
};

export function startPanel() {
  const state = {
    index: {},
    names: [],
    selected: null,
    mode: "balanced",
    lang: detectPreferredLang(),
    loadToken: 0,
    manualDebounceTimer: null,
  };

  const ui = {
    mainTitle: must("mainTitle"),
    subTitle: must("subTitle"),
    datasetsTitle: must("datasetsTitle"),
    listCount: must("listCount"),
    searchInput: must("searchInput"),
    listContainer: must("listContainer"),
    selectedDatasetLabel: must("selectedDatasetLabel"),
    selectedName: must("selectedName"),
    filterLabel: must("filterLabel"),
    manualFilterLabel: must("manualFilterLabel"),
    filterSelect: must("filterSelect"),
    manualFilter: must("manualFilter"),
    loadRules: must("loadRules"),
    etagLabel: must("etagLabel"),
    rulesPreview: must("rulesPreview"),
    etag: must("etag"),
    staleLabel: must("staleLabel"),
    isStale: must("isStale"),
    modeLabel: must("modeLabel"),
    activeMode: must("activeMode"),
    rulesLabel: must("rulesLabel"),
    ruleLines: must("ruleLines"),
    rulePreviewTitle: must("rulePreviewTitle"),
    sourceFile: must("sourceFile"),
    datasetInfoTitle: must("datasetInfoTitle"),
    sourceFileLabel: must("sourceFileLabel"),
    filterCountLabel: must("filterCountLabel"),
    filterCount: must("filterCount"),
    rawLink: must("rawLink"),
    quickLinksTitle: must("quickLinksTitle"),
    quickLinks: must("quickLinks"),
    langZh: must("langZh"),
    langEn: must("langEn"),
    modeButtons: Array.from(document.querySelectorAll(".mode-btn")),
    langButtons: Array.from(document.querySelectorAll(".lang-btn")),
  };

  const t = (key, vars = {}) => {
    const table = translations[state.lang] || translations.zh;
    let text = table[key] || translations.zh[key] || key;
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(`{${name}}`, String(value));
    }
    return text;
  };

  const applyLocale = () => {
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";

    ui.langZh.textContent = t("langZh");
    ui.langEn.textContent = t("langEn");
    ui.mainTitle.textContent = t("mainTitle");
    ui.subTitle.textContent = t("subTitle");
    ui.datasetsTitle.textContent = t("datasetsTitle");
    ui.searchInput.placeholder = t("searchPlaceholder");
    ui.selectedDatasetLabel.textContent = t("selectedDatasetLabel");
    ui.filterLabel.textContent = t("filterLabel");
    ui.manualFilterLabel.textContent = t("manualFilterLabel");
    ui.manualFilter.placeholder = t("manualFilterPlaceholder");
    ui.loadRules.textContent = t("loadRules");
    ui.etagLabel.textContent = t("etagLabel");
    ui.staleLabel.textContent = t("staleLabel");
    ui.modeLabel.textContent = t("modeLabel");
    ui.rulesLabel.textContent = t("rulesLabel");
    ui.rulePreviewTitle.textContent = t("rulePreviewTitle");
    ui.rawLink.textContent = t("openRawUrl");
    ui.datasetInfoTitle.textContent = t("datasetInfoTitle");
    ui.sourceFileLabel.textContent = t("sourceFileLabel");
    ui.filterCountLabel.textContent = t("filterCountLabel");
    ui.quickLinksTitle.textContent = t("quickLinksTitle");

    ui.langButtons.forEach((button) => {
      const active = button.dataset.lang === state.lang;
      button.className = active
        ? "lang-btn border-r border-[color:var(--border)] bg-[color:var(--primary)] px-2.5 py-1.5 text-xs font-semibold text-white"
        : "lang-btn border-r border-[color:var(--border)] px-2.5 py-1.5 text-xs font-semibold";
    });

    const lastLangButton = ui.langButtons[ui.langButtons.length - 1];
    if (lastLangButton) {
      lastLangButton.className = lastLangButton.className.replace(" border-r", "");
    }

    if (state.names.length > 0) {
      ui.listCount.textContent = t("listsCount", { count: state.names.length });
    }
  };

  const setLanguage = (lang) => {
    if (lang !== "zh" && lang !== "en") {
      return;
    }
    state.lang = lang;
    localStorage.setItem("panel-lang", lang);
    applyLocale();
    renderList(ui.searchInput.value);
    if (state.selected) {
      renderFilters(state.index[state.selected]?.filters ?? []);
    }
  };

  const resetPreview = (message) => {
    ui.rulesPreview.textContent = message;
    ui.etag.textContent = "-";
    ui.isStale.textContent = "-";
    ui.ruleLines.textContent = "-";
    ui.rawLink.href = "#";
  };

  const setMode = (mode) => {
    state.mode = mode;
    ui.activeMode.textContent = mode;

    for (const button of ui.modeButtons) {
      const active = button.dataset.mode === mode;
      button.className = active
        ? "mode-btn border-r border-[color:var(--border)] bg-[color:var(--primary)] px-3 py-2 text-sm font-semibold text-white"
        : "mode-btn border-r border-[color:var(--border)] px-3 py-2 text-sm font-semibold text-[color:var(--muted)]";
    }

    const lastModeButton = ui.modeButtons[ui.modeButtons.length - 1];
    if (lastModeButton) {
      lastModeButton.className = lastModeButton.className.replace(" border-r", "");
    }

    updateQuickLinks();

    if (state.selected) {
      resetPreview(t("modeSwitchLoading", { mode }));
      void loadRules();
    }
  };

  const normalizeFilter = () => {
    const manual = ui.manualFilter.value.trim().toLowerCase();
    if (manual.length > 0) {
      return manual;
    }
    const selected = ui.filterSelect.value;
    return selected === "" ? null : selected;
  };

  const buildRulePath = () => {
    if (!state.selected) {
      return null;
    }
    const filter = normalizeFilter();
    const withFilter = filter ? `${state.selected}@${filter}` : state.selected;
    return `/geosite/${state.mode}/${encodeURIComponent(withFilter)}`;
  };

  const updateQuickLinks = () => {
    if (!state.selected) {
      const empty = document.createElement("p");
      empty.className = "text-[color:var(--muted)]";
      empty.textContent = "-";
      ui.quickLinks.replaceChildren(empty);
      return;
    }

    const filter = normalizeFilter();
    const withFilter = filter ? `${state.selected}@${filter}` : state.selected;
    const encoded = encodeURIComponent(withFilter);
    const fragment = document.createDocumentFragment();

    for (const mode of ["strict", "balanced", "full"]) {
      const link = document.createElement("a");
      link.className =
        "block border border-[color:var(--border)] px-2 py-1 text-[color:var(--text)] transition hover:border-[color:var(--primary)] hover:text-[color:var(--primary)]";
      link.href = `/geosite/${mode}/${encoded}`;
      link.target = "_blank";
      link.textContent = mode;
      fragment.append(link);
    }

    ui.quickLinks.replaceChildren(fragment);
  };

  const renderList = (keyword = "") => {
    const query = keyword.trim().toLowerCase();
    const filtered = query ? state.names.filter((name) => name.includes(query)) : state.names;

    if (filtered.length === 0) {
      ui.listContainer.innerHTML = `<p class="px-2 py-3 text-xs text-[color:var(--muted)]">${t("noMatch")}</p>`;
      return;
    }

    ui.listContainer.innerHTML = filtered
      .slice(0, 1000)
      .map((name) => {
        const active = name === state.selected;
        const count = state.index[name]?.filters?.length ?? 0;
        const cls = active
          ? "border-[color:var(--primary)] bg-white text-[color:var(--primary)]"
          : "border-transparent text-[color:var(--text)] hover:border-[color:var(--border)] hover:bg-white";
        return `<button type="button" data-name="${name}" class="list-item flex w-full items-center justify-between border px-3 py-2 text-left text-sm ${cls}"><span class="code-font">${name}</span><span class="code-font text-xs text-[color:var(--muted)]">@${count}</span></button>`;
      })
      .join("");
  };

  const renderFilters = (filters) => {
    const options = [`<option value="">${t("noneOption")}</option>`];
    for (const item of filters) {
      options.push(`<option value="${item}">${item}</option>`);
    }
    ui.filterSelect.innerHTML = options.join("");
    ui.filterCount.textContent = String(filters.length);
  };

  const selectList = (name) => {
    state.selected = name;

    const info = state.index[name];
    ui.selectedName.textContent = info?.name ?? name.toUpperCase();
    ui.sourceFile.textContent = info?.sourceFile ?? "-";

    ui.manualFilter.value = "";
    renderFilters(info?.filters ?? []);
    renderList(ui.searchInput.value);
    updateQuickLinks();

    resetPreview(t("switchedDatasetLoading", { name }));
    void loadRules();
  };

  const loadRules = async () => {
    const path = buildRulePath();
    if (!path) {
      return;
    }

    const token = ++state.loadToken;
    ui.rawLink.href = path;
    ui.rulesPreview.textContent = t("loading");
    try {
      const response = await fetch(path, { headers: { accept: "text/plain" } });
      const payload = await response.text();

      if (token !== state.loadToken) {
        return;
      }

      if (!response.ok) {
        ui.rulesPreview.textContent = `${response.status} ${response.statusText}\n${payload}`;
        ui.ruleLines.textContent = "-";
        ui.etag.textContent = response.headers.get("x-upstream-etag") || "-";
        ui.isStale.textContent = response.headers.get("x-stale") === "1" ? t("yes") : t("no");
        return;
      }

      ui.rulesPreview.textContent = payload.length === 0 ? t("emptyResult") : payload;
      ui.ruleLines.textContent = String(payload.split(/\r?\n/).filter((line) => line.length > 0).length);
      ui.etag.textContent = response.headers.get("x-upstream-etag") || "-";
      ui.isStale.textContent = response.headers.get("x-stale") === "1" ? t("yes") : t("no");
    } catch (error) {
      if (token !== state.loadToken) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ui.rulesPreview.textContent = t("requestFailed", { message });
      ui.ruleLines.textContent = "-";
      ui.etag.textContent = "-";
      ui.isStale.textContent = "-";
    }
  };

  const init = async () => {
    try {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let response = null;

      for (let attempt = 0; attempt < 15; attempt += 1) {
        response = await fetch("/geosite", { headers: { accept: "application/json" } });
        if (response.ok) {
          break;
        }

        if (response.status !== 503) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        ui.listCount.textContent = t("initializing");
        resetPreview(t("upstreamInitializing", { current: attempt + 1, total: 15 }));
        await wait(1200);
      }

      if (!response || !response.ok) {
        throw new Error(t("dataNotReady"));
      }

      state.index = await response.json();
      state.names = Object.keys(state.index).sort();
      ui.listCount.textContent = t("listsCount", { count: state.names.length });

      setMode("balanced");
      renderList();

      if (state.names.length > 0) {
        selectList(state.names[0]);
      } else {
        resetPreview(t("indexEmpty"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ui.listCount.textContent = t("error");
      resetPreview(t("failedLoad", { message }));
    }
  };

  ui.searchInput.addEventListener("input", (event) => {
    renderList(event.target.value);
  });

  ui.listContainer.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-name]");
    if (!target) {
      return;
    }
    selectList(target.dataset.name);
  });

  ui.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode) {
        setMode(mode);
      }
    });
  });

  ui.langButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const lang = button.dataset.lang;
      if (lang) {
        setLanguage(lang);
      }
    });
  });

  ui.filterSelect.addEventListener("change", () => {
    updateQuickLinks();
    if (!state.selected) {
      return;
    }
    resetPreview(t("filterSwitchLoading"));
    void loadRules();
  });

  ui.manualFilter.addEventListener("input", () => {
    updateQuickLinks();
    if (!state.selected) {
      return;
    }

    resetPreview(t("filterInputLoading"));
    if (state.manualDebounceTimer) {
      clearTimeout(state.manualDebounceTimer);
    }
    state.manualDebounceTimer = setTimeout(() => {
      void loadRules();
    }, 280);
  });

  ui.loadRules.addEventListener("click", () => {
    if (!state.selected) {
      return;
    }
    resetPreview(t("loading"));
    void loadRules();
  });

  applyLocale();
  resetPreview(t("selectDataset"));
  init();
}
