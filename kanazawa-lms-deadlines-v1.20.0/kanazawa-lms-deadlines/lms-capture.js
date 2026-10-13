(function captureWebClassData() {
  "use strict";

  const parser = globalThis.KuLmsParser;
  const DATA_KEY = "kuLmsDeadlineData";
  const TIMETABLE_KEY = "kuLmsCurrentTimetable";
  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (value) => new Promise((resolve) => chrome.storage.local.set(value, resolve));

  async function mergeCourse(parsedCourse, timetable) {
    const stored = await storageGet([DATA_KEY]);
    const data = stored[DATA_KEY]?.version === 11 && stored[DATA_KEY]?.quarter === timetable.quarter
      ? stored[DATA_KEY]
      : { version: 11, updatedAt: 0, academicYear: timetable.academicYear, quarter: timetable.quarter, courses: [] };
    const courses = [...(data.courses || [])];
    const index = courses.findIndex((course) => course.courseId === parsedCourse.courseId);
    if (index >= 0) courses[index] = parsedCourse;
    else courses.push(parsedCourse);
    await storageSet({ [DATA_KEY]: { ...data, version: 11, updatedAt: Date.now(), courses } });
  }

  async function run() {
    if (parser.looksLikeLoginPage(document, location.href)) {
      try { await chrome.runtime.sendMessage({ type: "KU_LMS_RESOLVER_LOGIN_REQUIRED" }); } catch { /* Normal login tab. */ }
      return;
    }

    const courseId = parser.courseIdFromUrl(location.href);
    const isCourseTop = /\/course\.php\/[^/]+\/?$/i.test(location.pathname);
    if (!courseId || !isCourseTop) return;

    const stored = await storageGet([TIMETABLE_KEY]);
    const timetable = stored[TIMETABLE_KEY];
    const timetableCourse = timetable?.version === 12 && timetable.quarter === parser.currentQuarter()
      ? timetable.courses?.find((course) => parser.courseIdFromUrl(course.url) === courseId)
      : null;

    const parsedCourse = parser.parseCoursePage(
      document,
      location.href,
      new Map(),
      timetableCourse || { courseId, name: "", url: location.href, source: "resolver" }
    );
    if (timetableCourse) {
      parsedCourse.name = timetableCourse.name;
      parsedCourse.url = timetableCourse.url || parsedCourse.url;
      parsedCourse.assignments = parsedCourse.assignments.map((assignment) => ({
        ...assignment,
        courseName: timetableCourse.name,
        courseUrl: timetableCourse.url || parsedCourse.url
      }));
    }
    try {
      await chrome.runtime.sendMessage({
        type: "KU_LMS_RESOLVER_CAPTURE",
        url: location.href,
        course: parsedCourse
      });
    } catch { /* This is a normal manually opened LMS tab, not a resolver tab. */ }

    if (timetableCourse) await mergeCourse(parsedCourse, timetable);
  }

  run();
})();
