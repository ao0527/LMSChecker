(function installKuLmsParser(global) {
  "use strict";

  if (global.KuLmsParser) return;

  const COURSE_PATH_RE = /\/course\.php\/([^/?#]+)/i;
  const ASSIGNMENT_WORD_RE = /(レポート|自習|report|self[- ]?study)/i;
  const TRACKED_TYPE_RE = /^(?:レポート|自習)$/;
  const DATE_RE = /(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:\s*[（(]?[月火水木金土日][）)]?)?\s+(\d{1,2})[:：](\d{2})(?::(\d{2}))?/g;

  function compactText(value) {
    return String(value || "").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  }

  function normalizeTitle(value) {
    return compactText(value)
      .replace(/\bnew\b/gi, "")
      .replace(/[【\[]?(提出済み|提出済|実施済み|実施済|回答済み|回答済)[】\]]?/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("ja");
  }

  function courseIdFromUrl(rawUrl) {
    if (!rawUrl) return "";
    const pathMatch = String(rawUrl).match(COURSE_PATH_RE);
    if (pathMatch) return decodeURIComponent(pathMatch[1]);
    try {
      const url = new URL(rawUrl, global.location?.href || "https://acanthus.cis.kanazawa-u.ac.jp/");
      return url.searchParams.get("course_id") || url.searchParams.get("course") || "";
    } catch {
      return "";
    }
  }

  function directWebClassUrlFromSsoLink(rawUrl) {
    try {
      const url = new URL(rawUrl, global.location?.href || "https://acanthus.cis.kanazawa-u.ac.jp/");
      if (url.hostname !== "acanthus.cis.kanazawa-u.ac.jp" ||
          !/\/base\/lms-course\/sso-link\/?$/i.test(url.pathname)) return "";
      const courseId = url.searchParams.get("courseId") || "";
      if (!/^[A-Za-z0-9._-]{5,100}$/.test(courseId)) return "";
      return `https://lms-wc.el.kanazawa-u.ac.jp/webclass/course.php/${encodeURIComponent(courseId)}/`;
    } catch {
      return "";
    }
  }

  function currentQuarter(date = new Date()) {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if (month >= 4 && month <= 5) return "Q1";
    if (month === 6) return day <= 11 ? "Q1" : "Q2";
    if (month >= 7 && month <= 9) return "Q2";
    if (month >= 10 && month <= 11) return "Q3";
    return "Q4";
  }

  function parseDeadline(text) {
    const source = compactText(text);
    const dates = [];
    DATE_RE.lastIndex = 0;
    let match;
    while ((match = DATE_RE.exec(source)) !== null) {
      const [, year, month, day, hour, minute, second = "0"] = match;
      const date = new Date(+year, +month - 1, +day, +hour, +minute, +second);
      if (!Number.isNaN(date.getTime())) {
        dates.push({ date, index: match.index, raw: match[0] });
      }
    }
    if (!dates.length) return null;

    const deadlineLabel = /(締め切り|締切|提出期限|終了日時|利用期限|deadline|due)/i;
    const labeled = dates.filter((entry) => deadlineLabel.test(source.slice(Math.max(0, entry.index - 24), entry.index)));
    const selected = labeled.at(-1) || dates.at(-1);
    return { timestamp: selected.date.getTime(), raw: selected.raw };
  }

  function absoluteUrl(href, baseUrl) {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return "";
    }
  }

  function extractCourseLinks(doc, baseUrl) {
    const courses = new Map();
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const url = absoluteUrl(anchor.getAttribute("href"), baseUrl);
      const courseId = courseIdFromUrl(url);
      if (!courseId) continue;

      let name = compactText(anchor.textContent);
      if (!name || name.length < 2) {
        name = compactText(anchor.closest("td, li, .course, .card")?.textContent);
      }
      name = name.replace(/\bnew\b/gi, "").trim();
      if (!courses.has(courseId) || (name && name.length < courses.get(courseId).name.length)) {
        courses.set(courseId, { courseId, name: name || `科目 ${courseId}`, url });
      }
    }
    return [...courses.values()];
  }

  function extractScoreMap(doc) {
    const result = new Map();
    const table = doc.querySelector("#PersonalScoreSheet") ||
      [...doc.querySelectorAll("table")].find((candidate) => candidate.querySelector(".contents-title"));
    if (!table) return result;

    for (const row of table.querySelectorAll("tr")) {
      const titleCell = row.querySelector(".contents-title") || row.querySelector("th");
      const scoreCell = row.querySelector("td");
      const title = compactText(titleCell?.textContent);
      if (!title || !scoreCell) continue;

      const score = compactText(scoreCell.textContent);
      const notSubmitted = !score || /^(未|未提出|未受験|未回答|[-—―])$/.test(score);
      result.set(normalizeTitle(title), !notSubmitted);
    }
    return result;
  }

  function findCourseName(doc, fallback) {
    const selectors = [
      ".course-title",
      ".cm-courseName",
      "#course-title",
      "main h1",
      "main h2",
      "h1"
    ];
    for (const selector of selectors) {
      const value = compactText(doc.querySelector(selector)?.textContent);
      if (value && !/^webclass$/i.test(value)) return value;
    }
    return fallback || "科目名不明";
  }

  function selectedOptionText(select) {
    if (!select) return "";
    const selected = select.options?.[select.selectedIndex] || [...(select.options || [])].find((option) => option.selected);
    return compactText(selected?.textContent || "");
  }

  function extractTimetableMeta(doc) {
    const selects = [...doc.querySelectorAll("select")];
    const quarterSelect = selects.find((select) => {
      const labels = [...select.options].map((option) => compactText(option.textContent));
      return labels.filter((label) => /^Q[1-4]$/i.test(label) || /第[1-4]クォーター/.test(label)).length >= 2;
    }) || null;
    const typeSelect = selects.find((select) => {
      if (select === quarterSelect) return false;
      const context = compactText(select.closest("tr, .row, .form-group, div")?.textContent);
      return /科目種別/.test(context);
    }) || null;
    const pageText = compactText(doc.body?.textContent).slice(0, 5000);
    const headingMatch = pageText.match(/(20\d{2})年度\s*(Q[1-4])/i);
    const quarterText = selectedOptionText(quarterSelect);
    const quarterMatch = quarterText.match(/Q\s*([1-4])/i) || quarterText.match(/第\s*([1-4])\s*クォーター/);
    const quarter = quarterMatch ? `Q${quarterMatch[1]}` : (headingMatch?.[2]?.toUpperCase() || "");
    const academicYear = +(headingMatch?.[1] || (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1));
    return {
      academicYear,
      quarter,
      subjectType: selectedOptionText(typeSelect),
      quarterSelect,
      typeSelect
    };
  }

  function jumpDescriptor(element) {
    const image = element.querySelector?.("img");
    return compactText([
      element.textContent,
      element.getAttribute?.("value"),
      element.getAttribute?.("title"),
      element.getAttribute?.("alt"),
      element.getAttribute?.("aria-label"),
      image?.getAttribute("alt"),
      image?.getAttribute("title")
    ].filter(Boolean).join(" "));
  }

  function jumpUrl(element, baseUrl) {
    const directAttributes = ["href", "data-url", "data-href", "formaction"];
    for (const attribute of directAttributes) {
      const value = element.getAttribute?.(attribute);
      if (value && !/^javascript:/i.test(value)) return absoluteUrl(value, baseUrl);
    }
    const script = element.getAttribute?.("onclick") || "";
    const scripted = script.match(/["']([^"']*(?:lms|webclass|course\.php)[^"']*)["']/i);
    if (scripted) return absoluteUrl(scripted[1], baseUrl);
    return "";
  }

  function navigationUrl(element, baseUrl) {
    for (const attribute of ["href", "data-url", "data-href", "formaction"]) {
      const value = element.getAttribute?.(attribute);
      if (value && !/^javascript:/i.test(value)) return absoluteUrl(value, baseUrl);
    }
    const script = element.getAttribute?.("onclick") || element.getAttribute?.("href") || "";
    const scripted = script.match(/(?:window\.open|location\.replace)\s*\(\s*["']([^"']+)["']/i) ||
      script.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    return scripted ? absoluteUrl(scripted[1], baseUrl) : jumpUrl(element, baseUrl);
  }

  function jumpRequest(element, baseUrl) {
    const form = element.closest?.("form");
    if (!form) return null;
    const action = absoluteUrl(element.getAttribute?.("formaction") || form.getAttribute("action") || baseUrl, baseUrl);
    const method = (element.getAttribute?.("formmethod") || form.getAttribute("method") || "GET").toUpperCase();
    const params = new URLSearchParams();
    for (const control of form.querySelectorAll("input, select, textarea")) {
      const name = control.getAttribute("name");
      if (!name || control.disabled) continue;
      const type = String(control.getAttribute("type") || "").toLowerCase();
      if (control === element || ["submit", "button", "image", "reset", "file"].includes(type)) continue;
      if (["checkbox", "radio"].includes(type) && !control.checked) continue;
      if (control.tagName === "SELECT") {
        for (const option of control.options) if (option.selected) params.append(name, option.value);
      } else {
        params.append(name, control.value || "");
      }
    }

    const elementName = element.getAttribute?.("name");
    const elementType = String(element.getAttribute?.("type") || "").toLowerCase();
    if (elementName) {
      if (elementType === "image") {
        params.append(`${elementName}.x`, "1");
        params.append(`${elementName}.y`, "1");
      } else {
        params.append(elementName, element.getAttribute?.("value") || element.value || "");
      }
    }

    const script = `${element.getAttribute?.("href") || ""} ${element.getAttribute?.("onclick") || ""}`;
    const postback = script.match(/__doPostBack\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']/i);
    if (postback) {
      params.set("__EVENTTARGET", postback[1]);
      params.set("__EVENTARGUMENT", postback[2]);
    }
    return { url: action, method, body: params.toString() };
  }

  function navigationRequest(element, baseUrl) {
    const href = element.getAttribute?.("href") || "";
    const script = element.getAttribute?.("onclick") || "";
    const scriptedPostback = /__doPostBack/i.test(`${href} ${script}`);
    const directUrl = navigationUrl(element, baseUrl);
    const hasExplicitDirectTarget = Boolean(
      (href && !/^javascript:/i.test(href)) ||
      element.getAttribute?.("data-url") ||
      element.getAttribute?.("data-href") ||
      /(?:window\.open|location(?:\.replace|\.href)?\s*[=(])/i.test(script)
    );
    if (directUrl && !scriptedPostback && hasExplicitDirectTarget) {
      return { url: directUrl, method: "GET", body: "" };
    }
    return jumpRequest(element, baseUrl) || (directUrl ? { url: directUrl, method: "GET", body: "" } : null);
  }

  function clickTargetForElement(element) {
    return {
      tagName: element.tagName || "",
      id: element.getAttribute?.("id") || "",
      name: element.getAttribute?.("name") || "",
      type: element.getAttribute?.("type") || "",
      href: element.getAttribute?.("href") || "",
      value: element.getAttribute?.("value") || "",
      descriptor: jumpDescriptor(element)
    };
  }

  function findClickTarget(doc, target) {
    if (!target) return null;
    const elements = [...doc.querySelectorAll(
      "a[href], button, input[type='button'], input[type='submit'], input[type='image'], [role='link'], [onclick]"
    )];
    let best = null;
    let bestScore = 0;
    for (const element of elements) {
      let score = 0;
      const id = element.getAttribute?.("id") || "";
      const name = element.getAttribute?.("name") || "";
      const href = element.getAttribute?.("href") || "";
      const value = element.getAttribute?.("value") || "";
      const type = element.getAttribute?.("type") || "";
      const descriptor = jumpDescriptor(element);
      if (target.id && id === target.id) score += 120;
      if (target.name && name === target.name) score += 100;
      if (target.href && href === target.href) score += 80;
      if (target.value && value === target.value) score += 45;
      if (target.descriptor && descriptor === target.descriptor) score += 60;
      if (target.tagName && element.tagName === target.tagName) score += 10;
      if (target.type && type === target.type) score += 10;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return bestScore >= 50 ? best : null;
  }

  function isTimetableNumber(text) {
    const value = compactText(text).replace(/^時間割番号\s*[：:]?\s*/, "");
    return /^\d{4,6}(?:\.\d{1,3})?$/.test(value) ||
      /^(?=[A-Z0-9.-]{5,}$)(?=.*\d)[A-Z0-9]+(?:[.-][A-Z0-9]+)+$/i.test(value) ||
      /^(?=[A-Z0-9]{5,12}$)(?=.*\d)(?=.*[A-Z])[A-Z0-9]+$/i.test(value);
  }

  function timetableNumberFromContainer(container) {
    const text = String(container.innerText || container.textContent || "");
    const labeled = text.match(/時間割番号\s*[：:]?\s*([A-Za-z0-9.-]{4,20})/i);
    if (labeled) return labeled[1];
    return visibleTextLines(container).find((line) => isTimetableNumber(line))?.replace(/^時間割番号\s*[：:]?\s*/, "") || "";
  }

  function cleanSubjectCandidate(text) {
    return compactText(text)
      .replace(/(?:LMS|WebClass)\s*(?:へ)?\s*(?:ジャンプ|移動|開く)?/gi, "")
      .replace(/ジャンプ|シラバス|授業詳細/g, "")
      .replace(/^(?:共通教育|専門教育|資格科目|自由履修|言語)\s*[：:\-–—]?\s*/i, "")
      .replace(/^(?:時間割番号\s*[：:]?\s*)?(?:\d{4,6}(?:\.\d{1,3})?|(?=[A-Z0-9.-]{5,}\s)(?=[A-Z0-9.-]*\d)[A-Z0-9]+(?:[.-][A-Z0-9]+)+)\s+/i, "")
      .replace(/\s*[（(](?:担当(?:教員)?|教員|講師)\s*[：:]\s*[^（）()]{1,40}[）)]\s*$/i, "")
      .replace(/\s*[（(](?:担当(?:教員)?\s*[：:]?\s*)?[^（）()]{1,30}(?:講師|教授|准教授|助教|先生)[^（）()]*[）)]\s*$/i, "")
      .replace(/\s*[（(][一-龠々]{1,10}[ 　]+[一-龠々]{1,10}[）)]\s*$/, "")
      .replace(/\s*\([A-Za-zÀ-ž.'-]{2,20}[ ]+[A-Za-zÀ-ž .,'-]{2,30}\)\s*$/, "")
      .replace(/^[・●○□■◆◇▶▷]+\s*/, "")
      .trim();
  }

  function isGenericTimetableText(text) {
    const value = cleanSubjectCandidate(text);
    if (!value || value.length < 2 || value.length > 120) return true;
    if (/^(言語|LMS|WebClass|ジャンプ|シラバス|詳細|選択|PDF|未登録|科目なし|なし|[-―—])$/i.test(value)) return true;
    if (/^(月|火|水|木|金|土|日|[1-8]\s*限)$/.test(value)) return true;
    if (/^20\d{2}年度\s*Q[1-4]$/i.test(value)) return true;
    if (/^(?:担当|教員|担当教員|教室|講義室|曜日|時限|単位|時間割番号|開講)\s*[：:].*$/i.test(value)) return true;
    if (/^(?:教室|講義室)?\s*[A-Z]?\d{2,4}[A-Z]?$/i.test(value)) return true;
    if (isTimetableNumber(value)) return true;
    if (/先生$/.test(value) && value.length <= 30) return true;
    return false;
  }

  function visibleTextLines(container) {
    const lines = [];
    let buffer = "";
    const boundaryTags = new Set(["BR", "DIV", "P", "LI", "TR", "TD", "TH", "SECTION", "ARTICLE", "HEADER", "FOOTER"]);
    const flush = () => {
      const value = cleanSubjectCandidate(buffer);
      if (value) lines.push(value);
      buffer = "";
    };
    const visit = (node, isRoot = false) => {
      if (node.nodeType === 3) {
        buffer += ` ${node.nodeValue || ""}`;
        return;
      }
      if (node.nodeType !== 1) return;
      const boundary = !isRoot && boundaryTags.has(node.tagName);
      if (boundary) flush();
      for (const child of node.childNodes) visit(child, false);
      if (boundary) flush();
    };
    visit(container, true);
    flush();
    return [...new Set(lines)];
  }

  function subjectNameFromContainer(container, jumpElement = null) {
    const candidates = [];
    const add = (text, score) => {
      const value = cleanSubjectCandidate(text);
      if (!isGenericTimetableText(value)) candidates.push({ value, score });
    };

    for (const attribute of ["data-subject-name", "data-kamoku-name", "data-course-name"]) {
      add(container.getAttribute?.(attribute), 100);
    }
    for (const element of container.querySelectorAll(
      "[class*='subject-name'], [class*='subjectName'], [class*='kamoku'], [class*='course-name'], [class*='courseName']"
    )) {
      add(element.textContent, 90);
    }
    for (const anchor of container.querySelectorAll("a")) {
      if (anchor === jumpElement || /LMS|WebClass|ジャンプ|シラバス/i.test(jumpDescriptor(anchor))) continue;
      add(anchor.textContent, 70);
    }

    for (const [index, line] of visibleTextLines(container).entries()) {
      add(line, 65 - Math.min(index, 25));
    }

    for (const element of container.querySelectorAll("strong, b, span, div, p")) {
      if (element === jumpElement || (jumpElement && element.contains(jumpElement))) continue;
      add(element.textContent, 35);
    }

    for (const candidate of candidates) {
      if (/(?:学|論|法|演習|実験|実習|英語|English|Ⅰ|Ⅱ|Ⅲ|Ⅳ|[A-D])$/i.test(candidate.value)) candidate.score += 8;
    }
    candidates.sort((a, b) => b.score - a.score || a.value.length - b.value.length);
    return candidates[0]?.value || "";
  }

  function findSubjectContainer(jumpElement) {
    let current = jumpElement.parentElement;
    let fallback = null;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (!fallback && current.matches?.("td, li")) fallback = current;
      if (subjectNameFromContainer(current, jumpElement)) return current;
      if (current.matches?.("td")) break;
    }
    return fallback || jumpElement.parentElement;
  }

  function timetableTables(doc) {
    return [...doc.querySelectorAll("table")].filter((table) => {
      const directRows = [...table.querySelectorAll("tr")].filter((row) => row.closest("table") === table);
      const directCellTexts = directRows.flatMap((row) =>
        [...row.children].filter((child) => /^(TD|TH)$/.test(child.tagName)).map((cell) => compactText(cell.textContent))
      );
      const weekdayHits = ["月", "火", "水", "木", "金", "土"].filter((day) =>
        directCellTexts.some((text) => new RegExp(`^${day}(曜)?$`).test(text))
      ).length;
      const rows = directRows;
      const periodHits = rows.filter((row) => {
        const firstCell = [...row.children].find((child) => /^(TD|TH)$/.test(child.tagName));
        return /^[1-8]\s*限$/.test(compactText(firstCell?.textContent));
      }).length;
      return weekdayHits >= 3 && (periodHits >= 3 || rows.length >= 7);
    });
  }

  function jumpElementsWithin(container) {
    return [...container.querySelectorAll("a[href], button, input[type='button'], input[type='submit'], input[type='image']")]
      .filter((element) => {
        const descriptor = jumpDescriptor(element);
        const href = element.getAttribute?.("href") || "";
        return /LMS|WebClass|ジャンプ/i.test(descriptor) || /lms|webclass|course\.php/i.test(href);
      });
  }

  function subjectNavigationWithin(cell) {
    const candidates = [];
    for (const element of cell.querySelectorAll(
      "a[href], button, input[type='button'], input[type='submit'], input[type='image'], [role='link'], [onclick]"
    )) {
      const descriptor = jumpDescriptor(element);
      if (/LMS|WebClass|ジャンプ|シラバス/i.test(descriptor)) continue;
      const label = cleanSubjectCandidate(descriptor);
      if (!label || isGenericTimetableText(label) || isTimetableNumber(label)) continue;
      let score = element.matches?.("[class*='subject'], [class*='kamoku'], [class*='course']") ? 100 : 70;
      if (/(?:学|論|法|演習|実験|実習|英語|English|Ⅰ|Ⅱ|Ⅲ|Ⅳ|[A-D])$/i.test(label)) score += 10;
      candidates.push({ element, label, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
    return candidates[0]?.element || null;
  }

  function extractLmsJumpRequests(doc, pageUrl) {
    return jumpElementsWithin(doc).map((element) => ({
      descriptor: jumpDescriptor(element),
      request: navigationRequest(element, pageUrl),
      directCourseUrl: directWebClassUrlFromSsoLink(navigationUrl(element, pageUrl)),
      clickTarget: clickTargetForElement(element)
    })).filter((item) => item.request?.url);
  }

  function timetableCells(table) {
    const cells = [];
    const rows = [...table.querySelectorAll("tr")].filter((row) => row.closest("table") === table);
    for (const row of rows) {
      const directCells = [...row.children].filter((child) => /^(TD|TH)$/.test(child.tagName));
      for (const [index, cell] of directCells.entries()) {
        const text = compactText(cell.textContent);
        if (cell.tagName === "TH" || /^(?:月|火|水|木|金|土|日)(?:曜)?$/.test(text)) continue;
        if (index === 0 && /^(?:[1-8]\s*限|時限)$/.test(text)) continue;
        if (!text || /^[-―—\s]+$/.test(text)) continue;
        cells.push(cell);
      }
    }
    return cells;
  }

  function extractTimetableCourses(doc, pageUrl, expectedQuarter = "") {
    const meta = extractTimetableMeta(doc);
    if (expectedQuarter && meta.quarter && meta.quarter !== expectedQuarter) return [];
    const courses = new Map();
    let sequence = 0;
    const addCourse = (name, url, jumpElement = null, cell = null) => {
      const cleanedName = cleanSubjectCandidate(name);
      if (!cleanedName || isGenericTimetableText(cleanedName)) return;
      const key = `${normalizeTitle(cleanedName)}|${url}`;
      if (!courses.has(key)) {
        courses.set(key, {
          courseId: courseIdFromUrl(url) || `timetable-${meta.academicYear}-${meta.quarter}-${sequence}`,
          name: cleanedName,
          url,
          source: "timetable",
          academicYear: meta.academicYear,
          quarter: meta.quarter || expectedQuarter,
          subjectType: meta.subjectType,
          timetableNumber: cell ? timetableNumberFromContainer(cell) : "",
          jumpRequest: jumpElement ? navigationRequest(jumpElement, pageUrl) : null,
          clickTarget: jumpElement ? clickTargetForElement(jumpElement) : null
        });
        sequence += 1;
      }
    };

    const tables = timetableTables(doc);
    for (const table of tables) {
      for (const cell of timetableCells(table)) {
        const subjectNavigation = subjectNavigationWithin(cell);
        if (subjectNavigation) {
          addCourse(
            subjectNameFromContainer(cell),
            navigationUrl(subjectNavigation, pageUrl),
            subjectNavigation,
            cell
          );
          continue;
        }
        const jumps = jumpElementsWithin(cell);
        if (!jumps.length) {
          addCourse(subjectNameFromContainer(cell), "", null, cell);
          continue;
        }
        if (jumps.length === 1) {
          addCourse(subjectNameFromContainer(cell, jumps[0]), jumpUrl(jumps[0], pageUrl), jumps[0], cell);
          continue;
        }
        for (const jumpElement of jumps) {
          const container = findSubjectContainer(jumpElement);
          addCourse(subjectNameFromContainer(container || cell, jumpElement), jumpUrl(jumpElement, pageUrl), jumpElement, cell);
        }
      }
    }

    if (!tables.length) {
      for (const jumpElement of jumpElementsWithin(doc)) {
        const container = findSubjectContainer(jumpElement);
        if (!container) continue;
        addCourse(subjectNameFromContainer(container, jumpElement), jumpUrl(jumpElement, pageUrl), jumpElement, container);
      }
    }
    return [...courses.values()];
  }

  function assignmentRows(doc) {
    const modern = [...doc.querySelectorAll(
      ".cl-contentsList_listGroupItem, .contents-list-item, [data-contents-id]"
    )];
    if (modern.length) return modern;

    return [...doc.querySelectorAll("tr, li")].filter((row) => {
      const text = compactText(row.textContent);
      return ASSIGNMENT_WORD_RE.test(text) && Boolean(parseDeadline(text));
    });
  }

  function titleFromRow(row) {
    const holder = row.querySelector(
      ".cm-contentsList_contentName, .contents-title, [class*='contentName'], [class*='contentsName']"
    );
    const preferred = holder?.querySelector("a, div:not(.cl-contentsList_new), span") || holder;
    const direct = compactText(preferred?.textContent);
    if (direct) return direct.replace(/\bnew\b/gi, "").trim();

    const anchor = [...row.querySelectorAll("a[href]")].find((item) => compactText(item.textContent));
    return compactText(anchor?.textContent).replace(/\bnew\b/gi, "").trim();
  }

  function parseCoursePage(doc, pageUrl, scoreMap = new Map(), fallbackCourse = {}) {
    const courseId = courseIdFromUrl(pageUrl) || fallbackCourse.courseId || "";
    const courseName = fallbackCourse.source === "timetable" && fallbackCourse.name
      ? fallbackCourse.name
      : findCourseName(doc, fallbackCourse.name);
    const assignments = [];

    for (const row of assignmentRows(doc)) {
      const title = titleFromRow(row);
      if (!title) continue;

      const categoryCandidates = [...row.querySelectorAll(
        ".cl-contentsList_categoryLabel, .cm-contentsList_categoryLabel, .category-label, [class*='categoryLabel'], [class*='category-label']"
      )].map((element) => compactText(element.textContent));
      const category = categoryCandidates.find((value) => TRACKED_TYPE_RE.test(value)) || categoryCandidates[0] || "";
      const rowText = compactText(row.textContent);
      const detailElements = [...row.querySelectorAll(
        ".cm-contentsList_contentDetailListItemData, [class*='contentDetail'], .detail, time"
      )];
      const deadline = detailElements.map((node) => parseDeadline(node.textContent)).find(Boolean) || parseDeadline(rowText);
      const availabilityText = detailElements.map((node) => compactText(node.textContent))
        .find((text) => /利用可能期間|公開期間|実施期間/.test(text)) || deadline?.raw || "";

      if (!TRACKED_TYPE_RE.test(category)) continue;

      const normalized = normalizeTitle(title);
      const hasScore = scoreMap.has(normalized);
      const needsResubmission = /(再提出|再回答|再実施)/.test(rowText);
      let submitted = null;
      if (needsResubmission || /未提出|未実施|未回答/.test(rowText)) {
        submitted = false;
      } else if (hasScore) {
        submitted = scoreMap.get(normalized);
      } else if (/提出済み|提出済|実施済み|実施済|回答済み|回答済|完了/.test(rowText)) {
        submitted = true;
      }

      const assignmentAnchor = row.querySelector("a[href]");
      assignments.push({
        id: `${courseId}:${normalized}:${deadline?.timestamp || "none"}`,
        courseId,
        courseName,
        courseUrl: fallbackCourse.url || pageUrl,
        title,
        type: category || "課題",
        url: assignmentAnchor ? absoluteUrl(assignmentAnchor.getAttribute("href"), pageUrl) : pageUrl,
        deadline: deadline?.timestamp || null,
        deadlineText: deadline?.raw || "",
        availabilityText,
        submitted,
        needsResubmission
      });
    }

    const deduped = new Map();
    for (const assignment of assignments) deduped.set(assignment.id, assignment);
    return {
      courseId,
      name: courseName,
      url: fallbackCourse.url || pageUrl,
      assignments: [...deduped.values()]
    };
  }

  function looksLikeLoginPage(doc, pageUrl) {
    const text = compactText(doc.body?.textContent).slice(0, 2000);
    return /login|signin|shibboleth/i.test(pageUrl) ||
      Boolean(doc.querySelector("input[type='password']")) ||
      /(ログイン|サインイン).*(パスワード|金沢大学ID)/.test(text);
  }

  global.KuLmsParser = {
    compactText,
    normalizeTitle,
    courseIdFromUrl,
    directWebClassUrlFromSsoLink,
    parseDeadline,
    currentQuarter,
    extractCourseLinks,
    extractScoreMap,
    extractTimetableMeta,
    extractTimetableCourses,
    extractLmsJumpRequests,
    findClickTarget,
    parseCoursePage,
    looksLikeLoginPage
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.KuLmsParser;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
