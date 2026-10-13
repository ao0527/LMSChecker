"use strict";

const PORTAL_URL = "https://acanthus.cis.kanazawa-u.ac.jp/base/top/";
const DATA_KEY = "kuLmsDeadlineData";
const HIDDEN_ASSIGNMENTS_KEY = "kuLmsHiddenAssignmentIds";
const COMPLETED_ASSIGNMENTS_KEY = "kuLmsCompletedAssignmentIds";
const PAST_DISPLAY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

chrome.storage.local.get([DATA_KEY, HIDDEN_ASSIGNMENTS_KEY, COMPLETED_ASSIGNMENTS_KEY], (stored) => {
  const data = stored[DATA_KEY];
  const parserQuarter = (() => {
    const now = new Date();
    const month = now.getMonth() + 1;
    if (month >= 4 && month <= 5) return "Q1";
    if (month === 6) return now.getDate() <= 11 ? "Q1" : "Q2";
    if (month >= 7 && month <= 9) return "Q2";
    if (month >= 10 && month <= 11) return "Q3";
    return "Q4";
  })();
  if (data?.version !== 11 || data.quarter !== parserQuarter || !data.courses?.length) return;
  const hiddenIds = new Set(Array.isArray(stored[HIDDEN_ASSIGNMENTS_KEY]) ? stored[HIDDEN_ASSIGNMENTS_KEY].map(String) : []);
  const completedIds = new Set(Array.isArray(stored[COMPLETED_ASSIGNMENTS_KEY]) ? stored[COMPLETED_ASSIGNMENTS_KEY].map(String) : []);
  const now = Date.now();
  const assignments = data.courses.flatMap((course) => course.assignments || [])
    .filter((item) => Number.isFinite(item.deadline) &&
      item.deadline >= now - PAST_DISPLAY_WINDOW_MS &&
      !hiddenIds.has(String(item.id || "")));
  const incomplete = assignments.filter((item) => !completedIds.has(String(item.id || ""))).length;
  const overdue = assignments.filter((item) => !completedIds.has(String(item.id || "")) && item.deadline < now).length;
  document.getElementById("summary").textContent = `${data.quarter} · 期限切れは3日前まで · 未完了 ${incomplete}件 · 期限超過 ${overdue}件`;
});

document.getElementById("open").addEventListener("click", () => chrome.tabs.create({ url: PORTAL_URL }));

document.getElementById("refresh").addEventListener("click", async () => {
  const message = document.getElementById("message");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(PORTAL_URL)) {
    message.textContent = "アカンサスポータルの最初の画面を開いてから実行してください。";
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "KU_LMS_REFRESH" });
    message.textContent = "更新を開始しました。ポータル上の表をご確認ください。";
  } catch {
    message.textContent = "ページを再読み込みしてから、もう一度お試しください。";
  }
});
