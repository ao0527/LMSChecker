(function startPortalExtension() {
  "use strict";

  const parser = globalThis.KuLmsParser;
  const DATA_KEY = "kuLmsDeadlineData";
  const TIMETABLE_KEY = "kuLmsCurrentTimetable";
  const PANEL_STATE_KEY = "kuLmsPanelCollapsed";
  const HIDDEN_ASSIGNMENTS_KEY = "kuLmsHiddenAssignmentIds";
  const COMPLETED_ASSIGNMENTS_KEY = "kuLmsCompletedAssignmentIds";
  const HOST_ID = "ku-lms-deadline-root";
  const CACHE_MAX_AGE = 10 * 60 * 1000;
  const PAST_DISPLAY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
  const DUE_SOON_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
  const CURRENT_QUARTER = parser.currentQuarter();
  const ACADEMIC_SERVICE_HOME = "https://eduweb.sta.kanazawa-u.ac.jp/portal/";
  let currentData = null;
  let syncRunning = false;
  let hiddenAssignmentIds = new Set();
  let completedAssignmentIds = new Set();

  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (value) => new Promise((resolve) => chrome.storage.local.set(value, resolve));

  function buildPanel() {
    const existing = document.getElementById(HOST_ID);
    if (existing) return existing;

    const root = document.createElement("section");
    root.id = HOST_ID;
    root.className = "is-collapsed";
    root.setAttribute("aria-label", "LMS課題・提出期限");
    root.innerHTML = `
      <div class="ku-lms-card">
        <header class="ku-lms-header">
          <div>
            <div class="ku-lms-eyebrow">KANAZAWA UNIVERSITY · LMS</div>
            <h2>課題・提出期限</h2>
            <p id="ku-lms-subtitle">${CURRENT_QUARTER}の期限前の課題と、期限切れから3日以内の課題を表示します</p>
          </div>
          <div class="ku-lms-header-controls">
            <span id="ku-lms-collapsed-summary" class="ku-lms-collapsed-summary">課題を確認</span>
            <div class="ku-lms-actions">
              <label class="ku-lms-checkbox"><input id="ku-lms-hide-submitted" type="checkbox"> チェック済みを隠す</label>
              <button id="ku-lms-restore-hidden" class="ku-lms-restore-hidden" type="button" hidden>非表示をすべて戻す</button>
              <a id="ku-lms-timetable" class="ku-lms-button secondary" target="_blank" rel="noopener">時間割を取得</a>
              <button id="ku-lms-refresh" type="button"><span aria-hidden="true">↻</span> LMSを更新</button>
            </div>
            <button id="ku-lms-toggle" class="ku-lms-toggle" type="button" aria-expanded="false" aria-controls="ku-lms-body">課題を表示</button>
          </div>
        </header>
        <div id="ku-lms-summary" class="ku-lms-summary" aria-live="polite"></div>
        <div id="ku-lms-message" class="ku-lms-message" hidden></div>
        <div class="ku-lms-table-wrap">
          <table>
            <thead><tr><th>完了</th><th>科目</th><th>課題</th><th>利用可能期間の終了</th><th>残り</th><th>操作</th></tr></thead>
            <tbody id="ku-lms-body"></tbody>
          </table>
        </div>
        <footer>
          <span id="ku-lms-updated">未更新</span>
          <span class="ku-lms-footer-note">データはこのChrome内にのみ保存されます</span>
          <span id="ku-lms-version" class="ku-lms-version">v${chrome.runtime.getManifest().version}</span>
        </footer>
      </div>`;

    const target = document.querySelector("main, #contents, #content, .main") || document.body;
    target.prepend(root);
    pinPortalHeader(root);
    root.querySelector("#ku-lms-timetable").href = academicServiceUrl();
    root.querySelector("#ku-lms-refresh").addEventListener("click", () => syncAll(true));
    root.querySelector("#ku-lms-hide-submitted").addEventListener("change", () => render(currentData));
    root.querySelector("#ku-lms-restore-hidden").addEventListener("click", async () => {
      hiddenAssignmentIds.clear();
      await storageSet({ [HIDDEN_ASSIGNMENTS_KEY]: [] });
      render(currentData);
    });
    root.querySelector("#ku-lms-toggle").addEventListener("click", () => {
      const collapsed = !root.classList.contains("is-collapsed");
      setPanelCollapsed(root, collapsed);
      storageSet({ [PANEL_STATE_KEY]: collapsed });
    });
    storageGet([PANEL_STATE_KEY]).then((stored) => {
      setPanelCollapsed(root, stored[PANEL_STATE_KEY] !== false);
    });
    return root;
  }

  function setPanelCollapsed(root, collapsed) {
    root.classList.toggle("is-collapsed", collapsed);
    const toggle = root.querySelector("#ku-lms-toggle");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? "課題を表示" : "収納";
  }

  function pinPortalHeader(root) {
    const candidates = [...document.querySelectorAll("#header, .header, header, [role='banner']")]
      .filter((element) => !root.contains(element));
    const header = candidates[0];
    if (!header) return;
    header.classList.add("ku-lms-portal-header-pinned");
    const updateOffset = () => {
      const height = Math.ceil(header.getBoundingClientRect?.().height || header.offsetHeight || 0);
      root.style.setProperty("--ku-portal-header-height", `${height}px`);
    };
    updateOffset();
    if (globalThis.ResizeObserver) new ResizeObserver(updateOffset).observe(header);
  }

  function academicServiceUrl() {
    for (const anchor of document.querySelectorAll("a[href]")) {
      const text = parser.compactText(anchor.textContent);
      if (!/学務情報サービス/.test(text)) continue;
      try {
        const url = new URL(anchor.getAttribute("href"), location.href);
        if (url.protocol === "https:") return url.href;
      } catch { /* Use the official fallback URL. */ }
    }
    return ACADEMIC_SERVICE_HOME;
  }

  function formatDate(timestamp) {
    if (!timestamp) return "期限の設定なし";
    const date = new Date(timestamp);
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
  }

  function formatRemaining(timestamp) {
    if (!timestamp) return "—";
    const diff = timestamp - Date.now();
    const absoluteMinutes = Math.floor(Math.abs(diff) / 60000);
    const days = Math.floor(absoluteMinutes / 1440);
    const hours = Math.floor((absoluteMinutes % 1440) / 60);
    const minutes = absoluteMinutes % 60;
    const parts = days ? `${days}日${hours ? `${hours}時間` : ""}` : hours ? `${hours}時間${minutes}分` : `${minutes}分`;
    return diff < 0 ? `${parts}超過` : `あと${parts}`;
  }

  function assignmentStatus(assignment) {
    if (completedAssignmentIds.has(assignmentKey(assignment))) return { key: "submitted", label: "完了" };
    if (assignment.deadline && assignment.deadline < Date.now()) return { key: "overdue", label: "期限超過" };
    return { key: "pending", label: "未完了" };
  }

  function assignmentKey(assignment) {
    return String(assignment.id || [
      assignment.courseId || assignment.courseName || "course",
      assignment.title || "assignment",
      assignment.deadline || "none"
    ].join("|"));
  }

  function flattenRows(data) {
    const rows = [];
    const now = Date.now();
    const windowStart = now - PAST_DISPLAY_WINDOW_MS;
    for (const course of data?.courses || []) {
      rows.push(...(course.assignments || []).filter((assignment) =>
        Number.isFinite(assignment.deadline) &&
        assignment.deadline >= windowStart &&
        !hiddenAssignmentIds.has(assignmentKey(assignment))
      ));
    }
    return rows.sort((a, b) => a.deadline - b.deadline);
  }

  function appendLink(cell, text, url) {
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = text;
      cell.appendChild(link);
    } else {
      cell.textContent = text;
    }
  }

  function render(data) {
    const root = buildPanel();
    currentData = data || null;
    const body = root.querySelector("#ku-lms-body");
    const summary = root.querySelector("#ku-lms-summary");
    const updated = root.querySelector("#ku-lms-updated");
    const restoreHidden = root.querySelector("#ku-lms-restore-hidden");
    const hideCompleted = root.querySelector("#ku-lms-hide-submitted").checked;
    restoreHidden.hidden = hiddenAssignmentIds.size === 0;
    restoreHidden.textContent = `非表示をすべて戻す (${hiddenAssignmentIds.size})`;
    body.replaceChildren();

    if (!data?.courses?.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "ku-lms-empty";
      cell.textContent = `「時間割を取得」から履修時間割表の${CURRENT_QUARTER}を取り込んでください。`;
      row.appendChild(cell);
      body.appendChild(row);
      summary.innerHTML = `<span class="ku-lms-chip neutral">科目 —</span><span class="ku-lms-chip neutral">未完了 —</span>`;
      root.querySelector("#ku-lms-collapsed-summary").textContent = "課題を確認";
      updated.textContent = "未更新";
      return;
    }

    const allRows = flattenRows(data);
    const counts = allRows.reduce((acc, item) => {
      const key = assignmentStatus(item).key;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    summary.replaceChildren();
    for (const [className, label] of [
      ["danger", `期限超過 ${counts.overdue || 0}`],
      ["warning", `未完了 ${(counts.pending || 0) + (counts.overdue || 0)}`],
      ["success", `完了 ${counts.submitted || 0}`],
      ["neutral", `対象 ${allRows.length}件`],
      ["neutral", "期限切れは3日前まで"],
      ["neutral", `${data.quarter || CURRENT_QUARTER}`]
    ]) {
      const chip = document.createElement("span");
      chip.className = `ku-lms-chip ${className}`;
      chip.textContent = label;
      summary.appendChild(chip);
    }
    root.querySelector("#ku-lms-collapsed-summary").textContent =
      `未完了 ${(counts.pending || 0) + (counts.overdue || 0)}・期限超過 ${counts.overdue || 0}`;

    for (const item of allRows) {
      const status = assignmentStatus(item);
      if (hideCompleted && status.key === "submitted") continue;
      const row = document.createElement("tr");
      row.className = `ku-lms-row-${status.key}`;
      if (status.key !== "submitted" && item.deadline) {
        const remaining = item.deadline - Date.now();
        if (remaining < 0) row.classList.add("ku-lms-row-deadline-passed");
        else if (remaining <= DUE_SOON_WINDOW_MS) row.classList.add("ku-lms-row-deadline-soon");
      }

      const statusCell = document.createElement("td");
      const completedCheckbox = document.createElement("input");
      completedCheckbox.type = "checkbox";
      completedCheckbox.className = "ku-lms-completed-checkbox";
      completedCheckbox.checked = completedAssignmentIds.has(assignmentKey(item));
      completedCheckbox.setAttribute("aria-label", `${item.title || "この課題"}を完了として記録`);
      let completionChangeSequence = 0;
      completedCheckbox.addEventListener("change", async () => {
        const sequence = ++completionChangeSequence;
        const key = assignmentKey(item);
        const isCompleted = completedCheckbox.checked;
        if (isCompleted) {
          completedCheckbox.classList.add("is-checking");
          row.classList.add("ku-lms-row-submitted");
          row.classList.remove("ku-lms-row-deadline-passed", "ku-lms-row-deadline-soon");
          await new Promise((resolve) => setTimeout(resolve, 260));
          if (sequence !== completionChangeSequence || !completedCheckbox.isConnected) return;
          completedAssignmentIds.add(key);
        } else {
          completedAssignmentIds.delete(key);
        }
        await storageSet({ [COMPLETED_ASSIGNMENTS_KEY]: [...completedAssignmentIds] });
        if (sequence === completionChangeSequence) render(currentData);
      });
      statusCell.appendChild(completedCheckbox);

      const courseCell = document.createElement("td");
      appendLink(courseCell, item.courseName || "科目名不明", item.courseUrl);
      const titleCell = document.createElement("td");
      appendLink(titleCell, item.title || "課題名不明", item.url);
      const dateCell = document.createElement("td");
      dateCell.textContent = item.kind === "none" || item.kind === "error"
        ? "—"
        : formatDate(item.deadline);
      const remainingCell = document.createElement("td");
      remainingCell.textContent = item.kind === "none" || item.kind === "error" ? "—" : formatRemaining(item.deadline);
      const actionCell = document.createElement("td");
      const hideButton = document.createElement("button");
      hideButton.type = "button";
      hideButton.className = "ku-lms-hide-assignment";
      hideButton.textContent = "非表示";
      hideButton.setAttribute("aria-label", `${item.title || "この課題"}を非表示にする`);
      hideButton.addEventListener("click", async () => {
        const title = item.title || "この課題";
        if (!window.confirm(`「${title}」を非表示にしますか？\n後で「非表示をすべて戻す」から元に戻せます。`)) return;
        hiddenAssignmentIds.add(assignmentKey(item));
        await storageSet({ [HIDDEN_ASSIGNMENTS_KEY]: [...hiddenAssignmentIds] });
        render(currentData);
      });
      actionCell.appendChild(hideButton);

      row.append(statusCell, courseCell, titleCell, dateCell, remainingCell, actionCell);
      body.appendChild(row);
    }

    if (!body.children.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "ku-lms-empty";
      cell.textContent = "期限前、または期限切れから3日以内の課題はありません。";
      row.appendChild(cell);
      body.appendChild(row);
    }

    updated.textContent = `最終更新: ${new Intl.DateTimeFormat("ja-JP", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(new Date(data.updatedAt))}`;
  }

  function showMessage(text, kind = "info") {
    const message = buildPanel().querySelector("#ku-lms-message");
    message.hidden = !text;
    message.className = `ku-lms-message ${kind}`;
    message.textContent = text || "";
  }

  function setBusy(isBusy, progress = "") {
    const button = buildPanel().querySelector("#ku-lms-refresh");
    button.disabled = isBusy;
    button.classList.toggle("is-loading", isBusy);
    button.lastChild.textContent = isBusy ? ` 取得中${progress ? ` ${progress}` : ""}` : " LMSを更新";
  }

  async function fetchPage(url) {
    const response = await chrome.runtime.sendMessage({ type: "KU_LMS_FETCH_PAGE", url });
    if (!response?.ok || !response.text) throw new Error(response?.error || "ページを取得できませんでした。");
    const doc = new DOMParser().parseFromString(response.text, "text/html");
    return { doc, url: response.url || url };
  }

  async function fetchCourse(course) {
    try {
      const requestUrl = course.lmsSsoUrl || course.url;
      if (!course.lmsSsoUrl && !parser.courseIdFromUrl(course.url)) {
        throw new Error(course.syncError || "科目詳細ページからLMSのcourseIdを取得できませんでした。");
      }
      const response = await chrome.runtime.sendMessage({
        type: "KU_LMS_RESOLVE_COURSE",
        request: { url: requestUrl, method: "GET", body: "" }
      });
      if (!response?.ok || !response.course) throw new Error(response?.error || "LMSの課題一覧を読み取れませんでした。");
      return {
        ...course,
        ...response.course,
        name: course.name,
        url: response.url || course.url,
        assignments: (response.course.assignments || []).map((assignment) => ({
          ...assignment,
          courseName: course.name,
          courseUrl: response.url || course.url
        })),
        syncError: ""
      };
    } catch (error) {
      if (Array.isArray(course.assignments) && !course.syncError) return course;
      return { ...course, assignments: [], syncError: error instanceof Error ? error.message : String(error) };
    }
  }

  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function run() {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  async function syncAll(manual = false) {
    if (syncRunning) return;
    syncRunning = true;
    showMessage("");
    setBusy(true);
    try {
      const stored = await storageGet([TIMETABLE_KEY]);
      const timetable = stored[TIMETABLE_KEY];
      if (timetable?.version !== 12 || !timetable.courses?.length || timetable.quarter !== CURRENT_QUARTER) {
        throw new Error(`先に「時間割を取得」から履修時間割表を開き、現在の${CURRENT_QUARTER}を取り込んでください。`);
      }
      const courses = timetable.courses;
      let completed = 0;
      const courseResults = await mapWithConcurrency(courses, 1, async (course) => {
        const result = await fetchCourse(course);
        completed += 1;
        setBusy(true, `${completed}/${courses.length}`);
        return result;
      });

      const data = {
        version: 11,
        updatedAt: Date.now(),
        academicYear: timetable.academicYear,
        quarter: timetable.quarter,
        courses: courseResults
      };
      await storageSet({ [DATA_KEY]: data });
      render(data);
      const failures = courseResults.filter((course) => course.syncError).length;
      showMessage(
        failures ? `${failures}科目の取得に失敗しました。WebClassのタブをすべて閉じてから、もう一度更新してください。` : "更新が完了しました。",
        failures ? "warning" : "success"
      );
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), "error");
      if (manual && !currentData) render(null);
    } finally {
      syncRunning = false;
      setBusy(false);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "KU_LMS_REFRESH") return false;
    syncAll(true).then(() => sendResponse({ ok: true }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const newData = changes[DATA_KEY]?.newValue;
    if (newData?.version === 11 && newData.quarter === CURRENT_QUARTER) render(newData);
    if (changes[HIDDEN_ASSIGNMENTS_KEY]) {
      const ids = changes[HIDDEN_ASSIGNMENTS_KEY].newValue;
      hiddenAssignmentIds = new Set(Array.isArray(ids) ? ids.map(String) : []);
      render(currentData);
    }
    if (changes[COMPLETED_ASSIGNMENTS_KEY]) {
      const ids = changes[COMPLETED_ASSIGNMENTS_KEY].newValue;
      completedAssignmentIds = new Set(Array.isArray(ids) ? ids.map(String) : []);
      render(currentData);
    }
    const newTimetable = changes[TIMETABLE_KEY]?.newValue;
    if (newTimetable?.version === 12 && newTimetable.quarter === CURRENT_QUARTER && newTimetable.courses?.length &&
        !(newData?.version === 11 && newData.quarter === CURRENT_QUARTER)) syncAll(true);
  });

  async function init() {
    buildPanel();
    const stored = await storageGet([DATA_KEY, TIMETABLE_KEY, HIDDEN_ASSIGNMENTS_KEY, COMPLETED_ASSIGNMENTS_KEY]);
    hiddenAssignmentIds = new Set(
      Array.isArray(stored[HIDDEN_ASSIGNMENTS_KEY]) ? stored[HIDDEN_ASSIGNMENTS_KEY].map(String) : []
    );
    completedAssignmentIds = new Set(
      Array.isArray(stored[COMPLETED_ASSIGNMENTS_KEY]) ? stored[COMPLETED_ASSIGNMENTS_KEY].map(String) : []
    );
    const cached = stored[DATA_KEY];
    currentData = cached?.version === 11 && cached.quarter === CURRENT_QUARTER ? cached : null;
    render(currentData);
    if (stored[TIMETABLE_KEY]?.version === 12 && stored[TIMETABLE_KEY]?.quarter === CURRENT_QUARTER &&
        (!currentData || Date.now() - currentData.updatedAt > CACHE_MAX_AGE)) {
      syncAll(false);
    } else if (!currentData) {
      showMessage(`履修時間割表から現在の${CURRENT_QUARTER}を取り込むと、課題を取得できます。`, "info");
    }
  }

  init();
})();
