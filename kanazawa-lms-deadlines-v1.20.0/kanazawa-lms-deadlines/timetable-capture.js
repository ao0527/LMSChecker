(function installTimetableCapture() {
  "use strict";

  const parser = globalThis.KuLmsParser;
  const DATA_KEY = "kuLmsDeadlineData";
  const TIMETABLE_KEY = "kuLmsCurrentTimetable";
  const SCAN_KEY = "kuLmsTimetableScanState";
  const HELPER_ID = "ku-lms-timetable-helper";
  const targetQuarter = parser.currentQuarter();
  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (value) => new Promise((resolve) => chrome.storage.local.set(value, resolve));
  const storageRemove = (keys) => new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  let scanBusy = false;
  let navigationPending = false;

  function forwardResolverRedirect() {
    const source = document.documentElement?.innerHTML?.replace(/&amp;/g, "&") || "";
    const patterns = [
      /(?:window\.open|location\.replace)\s*\(\s*["']([^"']+)["']/i,
      /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (!match) continue;
      try {
        const url = new URL(match[1], location.href);
        if (!/(?:lms-wc|webclass\/course\.php)/i.test(url.href)) continue;
        chrome.runtime.sendMessage({ type: "KU_LMS_RESOLVER_REDIRECT", url: url.href }).catch(() => {});
        return;
      } catch { /* Try the next redirect representation. */ }
    }
  }

  forwardResolverRedirect();

  function clickInResolverTab(element) {
    if (element.tagName === "A") element.setAttribute("target", "_self");
    const form = element.closest?.("form");
    if (form) form.setAttribute("target", "_self");
    setTimeout(() => element.click(), 50);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "KU_LMS_RESOLVER_CLICK") return false;
    const element = parser.findClickTarget(document, message.target);
    if (!element) {
      sendResponse({ ok: false, error: "クリック対象が見つかりませんでした。" });
      return false;
    }
    sendResponse({ ok: true });
    clickInResolverTab(element);
    return false;
  });

  async function advanceResolverFromCourseDetail() {
    const candidates = parser.extractLmsJumpRequests(document, location.href);
    for (const candidate of candidates) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "KU_LMS_RESOLVER_IS_ACTIVE" });
        if (!response?.ok) return false;
        const element = parser.findClickTarget(document, candidate.clickTarget);
        if (!element) continue;
        clickInResolverTab(element);
        return true;
      } catch { /* This is a normal academic-service tab, not a resolver tab. */ }
    }
    return false;
  }

  async function claimResolverInitialClick() {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "KU_LMS_RESOLVER_CLAIM_CLICK" });
        if (response?.target) {
          const element = parser.findClickTarget(document, response.target);
          if (element) {
            const accepted = await chrome.runtime.sendMessage({ type: "KU_LMS_RESOLVER_CLICKED" });
            if (accepted?.ok) {
              clickInResolverTab(element);
              return true;
            }
          }
        }
      } catch { /* This is the user's normal timetable tab. */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  const initialMeta = parser.extractTimetableMeta(document);

  async function isResolverTab() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "KU_LMS_RESOLVER_IS_ACTIVE" });
        if (response?.ok) return true;
      } catch { /* Background worker may still be registering the duplicated tab. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  function optionQuarter(option) {
    const text = parser.compactText(option?.textContent);
    const match = text.match(/Q\s*([1-4])/i) || text.match(/第\s*([1-4])\s*クォーター/);
    return match ? `Q${match[1]}` : "";
  }

  function selectAndNotify(select, option) {
    navigationPending = true;
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(() => {
      if (document.contains(select) && select.form && option.selected) {
        try { select.form.requestSubmit(); } catch { /* The site's change handler may already have navigated. */ }
      }
    }, 900);
    setTimeout(() => {
      navigationPending = false;
      continueScan();
    }, 1600);
  }

  function timetableMenuTarget() {
    return [...document.querySelectorAll("a[href], button, input[type='button'], input[type='submit']")]
      .find((element) => /履修時間割表/.test(parser.compactText(
        `${element.textContent || ""} ${element.getAttribute?.("value") || ""} ${element.getAttribute?.("title") || ""}`
      ))) || null;
  }

  function setHelperStatus(text, kind = "") {
    const helper = document.getElementById(HELPER_ID);
    if (!helper) return;
    const status = helper.querySelector(".ku-lms-timetable-status");
    status.textContent = text;
    status.className = `ku-lms-timetable-status ${kind}`;
  }

  function injectHelper(isTimetablePage) {
    if (document.getElementById(HELPER_ID)) return;
    const helper = document.createElement("aside");
    helper.id = HELPER_ID;
    helper.innerHTML = `
      <strong>金沢大学 LMS 課題チェッカー</strong>
      <span class="ku-lms-timetable-status">${isTimetablePage ? `1科目をLMSで開いた後、WebClassタブを閉じて${targetQuarter}を取り込みます` : "履修時間割表を開いて科目を取得します"}</span>
      <button type="button">${isTimetablePage ? `現在の${targetQuarter}を取り込む` : "履修時間割表を開く"}</button>`;
    document.body.appendChild(helper);
    helper.querySelector("button").addEventListener("click", async () => {
      if (isTimetablePage) {
        await storageSet({
          [SCAN_KEY]: {
            targetQuarter,
            startedAt: Date.now(),
            academicYear: null,
            visitedTypes: [],
            courses: []
          }
        });
        setHelperStatus(`${targetQuarter}を確認中…`, "running");
        await continueScan();
        return;
      }
      const target = timetableMenuTarget();
      if (target) target.click();
      else setHelperStatus("上部メニューの「履修・成績情報」→「履修時間割表」を開いてください", "warning");
    });
  }

  function mergeCourses(existing, incoming) {
    const merged = new Map();
    for (const course of [...existing, ...incoming]) {
      const key = `${parser.normalizeTitle(course.name)}|${course.url}`;
      merged.set(key, course);
    }
    return [...merged.values()];
  }

  async function lmsJumpRequestFromDetail(request) {
    if (String(request?.method || "GET").toUpperCase() !== "GET" || !request?.url) return null;
    try {
      const url = new URL(request.url, location.href);
      if (url.hostname !== "eduweb.sta.kanazawa-u.ac.jp") return null;
      const response = await fetch(url.href, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
      if (!response.ok) return null;
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      if (parser.looksLikeLoginPage(doc, response.url || url.href)) return null;
      return parser.extractLmsJumpRequests(doc, response.url || url.href)
        .find((candidate) => candidate.directCourseUrl)?.request || null;
    } catch {
      return null;
    }
  }

  async function resolveCourseTarget(course) {
    const request = course.jumpRequest || (course.url ? { url: course.url, method: "GET", body: "" } : null);
    let resolvedUrl = course.url || "";
    let lmsSsoUrl = course.lmsSsoUrl || "";
    let capturedCourse = null;
    let syncError = "LMSへの移動情報が見つかりませんでした。";
    if (request?.url && !parser.courseIdFromUrl(resolvedUrl)) {
      try {
        const lmsJumpRequest = await lmsJumpRequestFromDetail(request);
        if (lmsJumpRequest?.url) lmsSsoUrl = lmsJumpRequest.url;
        const effectiveRequest = lmsJumpRequest
          ? lmsJumpRequest
          : request;
        const response = await chrome.runtime.sendMessage({
          type: "KU_LMS_RESOLVE_COURSE",
          request: effectiveRequest,
          clickTarget: lmsJumpRequest ? null : (course.clickTarget || null)
        });
        if (parser.courseIdFromUrl(response?.url)) resolvedUrl = response.url;
        if (response?.ok && parser.courseIdFromUrl(response.url)) {
          resolvedUrl = response.url;
          capturedCourse = response.course || null;
          syncError = capturedCourse ? "" : "LMSの課題一覧を読み取れませんでした。";
        } else {
          syncError = response?.error || "LMSへ移動できませんでした。";
        }
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
        // Keep the course in the timetable even if its LMS jump cannot be resolved.
      }
    } else if (parser.courseIdFromUrl(resolvedUrl)) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "KU_LMS_RESOLVE_COURSE",
          request: { url: resolvedUrl, method: "GET", body: "" }
        });
        if (response?.ok && response.course) {
          capturedCourse = response.course;
          resolvedUrl = response.url || resolvedUrl;
          syncError = "";
        } else {
          syncError = response?.error || "LMSの課題一覧を読み取れませんでした。";
        }
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
      }
    }
    const { jumpRequest: _discardRequest, clickTarget: _discardTarget, ...serializableCourse } = course;
    const assignments = (capturedCourse?.assignments || []).map((assignment) => ({
      ...assignment,
      courseName: serializableCourse.name,
      courseUrl: resolvedUrl
    }));
    return {
      ...serializableCourse,
      courseId: parser.courseIdFromUrl(resolvedUrl) || serializableCourse.courseId,
      url: resolvedUrl,
      lmsSsoUrl,
      assignments,
      syncError
    };
  }

  async function resolveCourseTargets(courses, onProgress = null) {
    const results = new Array(courses.length);
    let next = 0;
    let completed = 0;
    async function worker() {
      while (next < courses.length) {
        const index = next++;
        results[index] = await resolveCourseTarget(courses[index]);
        completed += 1;
        onProgress?.(completed, courses.length, courses[index]);
      }
    }
    // The academic system is based on stateful WebForms. Resolve one course at a
    // time so its hidden form fields and SSO transitions do not interfere.
    await Promise.all(Array.from({ length: Math.min(1, courses.length) }, worker));
    return results;
  }

  async function continueScan() {
    if (scanBusy || navigationPending) return;
    scanBusy = true;
    try {
      const meta = parser.extractTimetableMeta(document);
      if (!meta.quarterSelect) return;
      const stored = await storageGet([SCAN_KEY]);
      const state = stored[SCAN_KEY];
      if (!state || state.targetQuarter !== targetQuarter || Date.now() - state.startedAt > 10 * 60 * 1000) return;

      if (meta.quarter !== targetQuarter) {
        const quarterOption = [...meta.quarterSelect.options].find((option) => optionQuarter(option) === targetQuarter);
        if (!quarterOption) {
          setHelperStatus(`${targetQuarter}が選択肢にありません`, "warning");
          await storageRemove([SCAN_KEY]);
          return;
        }
        setHelperStatus(`${targetQuarter}へ切り替え中…`, "running");
        selectAndNotify(meta.quarterSelect, quarterOption);
        return;
      }

      const subjectType = meta.subjectType || "全科目";
      const rawCaptured = parser.extractTimetableCourses(document, location.href, targetQuarter);
      setHelperStatus(`${subjectType}: LMSリンクを確認中…`, "running");
      const captured = await resolveCourseTargets(rawCaptured, (completed, total, course) => {
        setHelperStatus(`${subjectType}: ${completed}/${total} ${course.name}`, "running");
      });
      state.courses = mergeCourses(state.courses || [], captured);
      state.academicYear = meta.academicYear;
      if (!state.visitedTypes.includes(subjectType)) state.visitedTypes.push(subjectType);
      await storageSet({ [SCAN_KEY]: state });

      const typeOptions = meta.typeSelect
        ? [...meta.typeSelect.options].filter((option) => {
            const label = parser.compactText(option.textContent);
            return label && option.value !== "" && !/選択|してください|^[-―—]+$/.test(label);
          })
        : [];
      const nextType = typeOptions.find((option) => !state.visitedTypes.includes(parser.compactText(option.textContent)));
      if (nextType) {
        setHelperStatus(`${parser.compactText(nextType.textContent)}を確認中…`, "running");
        selectAndNotify(meta.typeSelect, nextType);
        return;
      }

      const timetable = {
        version: 12,
        capturedAt: Date.now(),
        academicYear: state.academicYear,
        quarter: targetQuarter,
        subjectTypes: state.visitedTypes,
        courses: state.courses
      };
      const deadlineData = {
        version: 11,
        updatedAt: Date.now(),
        academicYear: timetable.academicYear,
        quarter: timetable.quarter,
        courses: timetable.courses.map((course) => ({
          ...course,
          assignments: course.assignments || []
        }))
      };
      await storageSet({ [TIMETABLE_KEY]: timetable, [DATA_KEY]: deadlineData });
      await storageRemove([SCAN_KEY]);
      const failures = timetable.courses.filter((course) => course.syncError).length;
      setHelperStatus(
        failures
          ? `${targetQuarter}: ${timetable.courses.length - failures}/${timetable.courses.length}科目を取得（${failures}科目失敗）`
          : `${targetQuarter}: ${timetable.courses.length}科目を取り込みました`,
        failures ? "warning" : "success"
      );
    } finally {
      scanBusy = false;
    }
  }

  async function initializePage() {
    if (await isResolverTab()) {
      if (initialMeta.quarterSelect) await claimResolverInitialClick();
      else await advanceResolverFromCourseDetail();
      return;
    }

    const meta = initialMeta;
    const isTimetablePage = Boolean(meta.quarterSelect);
    if (!isTimetablePage && !timetableMenuTarget()) return;
    injectHelper(isTimetablePage);
    if (isTimetablePage) {
      continueScan();
      const observer = new MutationObserver(() => continueScan());
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 15000);
    }
  }

  initializePage();
})();
