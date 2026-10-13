"use strict";

const ALLOWED_HOST_SUFFIX = ".kanazawa-u.ac.jp";
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const RESOLVER_TIMEOUT_MS = 45 * 1000;
const RESOLVER_STORAGE_PREFIX = "kuLmsResolver:";
const pendingResolvers = new Map();
const resolverByTab = new Map();

function isAllowedUniversityUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" &&
      (url.hostname === "kanazawa-u.ac.jp" || url.hostname.endsWith(ALLOWED_HOST_SUFFIX));
  } catch {
    return false;
  }
}

function clientRedirectUrl(html, baseUrl) {
  const normalized = String(html || "").replace(/&amp;/g, "&");
  const patterns = [
    /(?:window\.open|location\.replace)\s*\(\s*["']([^"']+)["']/i,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i,
    /href=["'](https:\/\/[^"']*(?:lms|webclass|course\.php)[^"']*)["']/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    try {
      const url = new URL(match[1], baseUrl).href;
      if (isAllowedUniversityUrl(url)) return url;
    } catch { /* Try the next client-side redirect pattern. */ }
  }
  return "";
}

async function fetchUniversityPage(rawUrl, requestOptions = {}) {
  if (!isAllowedUniversityUrl(rawUrl)) {
    return { ok: false, error: "許可されていないURLです。" };
  }

  const method = String(requestOptions.method || "GET").toUpperCase();
  const body = method === "POST" ? String(requestOptions.body || "") : undefined;
  if (!/^(GET|POST)$/.test(method) || (body && body.length > MAX_REQUEST_BYTES)) {
    return { ok: false, error: "許可されていないリクエストです。" };
  }

  try {
    let response = await fetch(rawUrl, {
      method,
      body,
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
      }
    });

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_HTML_BYTES) {
      return { ok: false, status: response.status, url: response.url, error: "ページサイズが大きすぎます。" };
    }

    let text = (await response.text()).slice(0, MAX_HTML_BYTES);
    const clientTarget = clientRedirectUrl(text, response.url || rawUrl);
    if (clientTarget && clientTarget !== response.url) {
      response = await fetch(clientTarget, {
        method: "GET",
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" }
      });
      text = (await response.text()).slice(0, MAX_HTML_BYTES);
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get("content-type") || "",
      text,
      error: response.ok ? "" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function courseTopUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!isAllowedUniversityUrl(url.href)) return "";
    const match = url.pathname.match(/^\/webclass\/course\.php\/([^/?#]+)(?:\/.*)?$/i);
    return match
      ? `${url.origin}/webclass/course.php/${encodeURIComponent(decodeURIComponent(match[1]))}/`
      : "";
  } catch {
    return "";
  }
}

function isLmsSsoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === "acanthus.cis.kanazawa-u.ac.jp" &&
      /\/base\/lms-course\/sso-link\/?$/i.test(url.pathname) &&
      Boolean(url.searchParams.get("courseId"));
  } catch {
    return false;
  }
}

function resolverToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function removeTabs(tabIds) {
  for (const tabId of tabIds) {
    try { await chrome.tabs.remove(tabId); } catch { /* The tab may already be closed. */ }
  }
}

async function finishResolver(token, response) {
  const pending = pendingResolvers.get(token);
  if (!pending) return;
  pendingResolvers.delete(token);
  clearTimeout(pending.timeoutId);
  clearTimeout(pending.clickRetryTimer);
  for (const tabId of pending.tabIds) resolverByTab.delete(tabId);
  try { await chrome.storage.session.remove(`${RESOLVER_STORAGE_PREFIX}${token}`); } catch { /* Best effort. */ }
  await removeTabs([...pending.tabIds]);
  pending.sendResponse({
    ...response,
    url: response.url || pending.resolvedUrl || ""
  });
}

async function hasUserWebClassTab() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://lms-wc.el.kanazawa-u.ac.jp/webclass/*" });
    return tabs.some((tab) => Number.isInteger(tab.id) && !resolverByTab.has(tab.id));
  } catch {
    return false;
  }
}

async function dispatchResolverClick(token, tabId) {
  const pending = pendingResolvers.get(token);
  if (!pending?.initialClick || pending.clickDispatched || pending.clickInFlight) return;
  pending.clickInFlight = true;
  pending.clickAttempts = (pending.clickAttempts || 0) + 1;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "KU_LMS_RESOLVER_CLICK",
      target: pending.initialClick
    });
    if (response?.ok) {
      pending.clickDispatched = true;
      pending.clickInFlight = false;
      clearTimeout(pending.clickRetryTimer);
      return;
    }
  } catch { /* The duplicated page's content script may still be loading. */ }
  pending.clickInFlight = false;
  if (pending.clickAttempts >= 20) {
    finishResolver(token, { ok: false, error: "複製した時間割で科目名をクリックできませんでした。" });
    return;
  }
  clearTimeout(pending.clickRetryTimer);
  pending.clickRetryTimer = setTimeout(() => dispatchResolverClick(token, tabId), 400);
}

async function startResolver(request, clickTarget, sourceTabId, sendResponse) {
  const method = String(request?.method || "GET").toUpperCase();
  const body = String(request?.body || "");
  if (!isAllowedUniversityUrl(request?.url) || !/^(GET|POST)$/.test(method) || body.length > MAX_REQUEST_BYTES) {
    sendResponse({ ok: false, error: "LMSへの移動情報が正しくありません。" });
    return;
  }

  const directUrl = courseTopUrl(request.url);
  if ((directUrl || isLmsSsoUrl(request.url)) && await hasUserWebClassTab()) {
    sendResponse({
      ok: false,
      url: directUrl,
      error: "WebClassのタブが開いたままです。WebClassのウインドウとタブをすべて閉じてから再実行してください。"
    });
    return;
  }

  const token = resolverToken();
  const storageKey = `${RESOLVER_STORAGE_PREFIX}${token}`;
  try {
    await chrome.storage.session.set({
      [storageKey]: { url: request.url, method, body }
    });
    const useInPageClick = Boolean(clickTarget && Number.isInteger(sourceTabId));
    if (!useInPageClick && method === "POST") {
      throw new Error("科目名のクリック情報を取得できませんでした。時間割ページを再読み込みしてください。");
    }
    const tab = useInPageClick
      ? await chrome.tabs.duplicate(sourceTabId)
      : await chrome.tabs.create({ url: "about:blank", active: false });
    if (!Number.isInteger(tab?.id)) throw new Error("一時タブを作成できませんでした。");

    const pending = {
      sendResponse,
      tabIds: new Set([tab.id]),
      seenSteps: new Set([`${method}|${request.url}|${body}`]),
      initialClick: useInPageClick ? clickTarget : null,
      clickDispatched: false,
      clickAttempts: 0,
      resolvedUrl: directUrl,
      sawAuthenticationPage: false,
      timeoutId: setTimeout(() => {
        const state = pendingResolvers.get(token);
        finishResolver(token, {
          ok: false,
          authRequired: Boolean(state?.sawAuthenticationPage),
          error: state?.sawAuthenticationPage
            ? "大学のSSO認証が完了しませんでした。任意の科目を通常操作でLMSまで開き、WebClassのタブをすべて閉じてから再実行してください。"
            : "LMSへの移動が時間切れになりました。"
        });
      }, RESOLVER_TIMEOUT_MS)
    };
    pendingResolvers.set(token, pending);
    resolverByTab.set(tab.id, token);
    await chrome.tabs.update(tab.id, { active: false });
    if (useInPageClick) {
      dispatchResolverClick(token, tab.id);
    } else if (method === "GET" && !body) {
      await chrome.tabs.update(tab.id, { url: request.url, active: false });
    } else {
      await chrome.tabs.update(tab.id, {
        url: chrome.runtime.getURL(`resolver.html?token=${encodeURIComponent(token)}`),
        active: false
      });
    }
  } catch (error) {
    if (pendingResolvers.has(token)) {
      await finishResolver(token, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try { await chrome.storage.session.remove(storageKey); } catch { /* Best effort. */ }
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const token = resolverByTab.get(tab.openerTabId);
  const pending = token && pendingResolvers.get(token);
  if (!pending || !Number.isInteger(tab.id)) return;
  pending.tabIds.add(tab.id);
  resolverByTab.set(tab.id, token);
  if (tab.active) chrome.tabs.update(tab.id, { active: false }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const token = resolverByTab.get(tabId);
  if (!token) return;
  const pending = pendingResolvers.get(token);
  if (changeInfo.status === "complete" && pending?.initialClick && !pending.clickDispatched) {
    dispatchResolverClick(token, tabId);
  }
  const currentUrl = changeInfo.url || tab.url || "";
  try {
    const parsed = new URL(currentUrl);
    if (/^(?:ku-sso|azami)\.cis\.kanazawa-u\.ac\.jp$/i.test(parsed.hostname) ||
        /\/Shibboleth\.sso\//i.test(parsed.pathname)) {
      // A valid SSO flow can briefly visit these pages. Do not abort it. If the
      // resolver remains there until timeout, report an authentication error.
      if (pending) pending.sawAuthenticationPage = true;
    }
  } catch { /* Wait for the next valid navigation URL. */ }
  const resolvedUrl = courseTopUrl(changeInfo.url || tab.url || "");
  if (!pending || !resolvedUrl) return;
  pending.resolvedUrl = resolvedUrl;
  if (pending.capturedCourse) {
    finishResolver(token, { ok: true, url: resolvedUrl, course: pending.capturedCourse });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const token = resolverByTab.get(tabId);
  if (!token) return;
  resolverByTab.delete(tabId);
  const pending = pendingResolvers.get(token);
  if (!pending) return;
  pending.tabIds.delete(tabId);
  if (!pending.tabIds.size) {
    finishResolver(token, { ok: false, error: "LMSへの移動用タブが閉じられました。" });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "KU_LMS_FETCH_PAGE") {
    fetchUniversityPage(message.url, { method: message.method, body: message.body })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "KU_LMS_RESOLVE_COURSE") {
    startResolver(message.request, message.clickTarget, _sender.tab?.id, sendResponse);
    return true;
  }
  if (message?.type === "KU_LMS_RESOLVER_FAILED") {
    finishResolver(message.token, { ok: false, error: message.error || "LMSへ移動できませんでした。" });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "KU_LMS_RESOLVER_CAPTURE") {
    const token = resolverByTab.get(_sender.tab?.id);
    const pending = token && pendingResolvers.get(token);
    const resolvedUrl = courseTopUrl(message.url);
    if (!pending || !resolvedUrl || !message.course) {
      sendResponse({ ok: false });
      return false;
    }
    pending.resolvedUrl ||= resolvedUrl;
    pending.capturedCourse = message.course;
    sendResponse({ ok: true });
    finishResolver(token, {
      ok: true,
      url: pending.resolvedUrl,
      course: pending.capturedCourse
    });
    return false;
  }
  if (message?.type === "KU_LMS_RESOLVER_REDIRECT") {
    const tabId = _sender.tab?.id;
    const token = resolverByTab.get(tabId);
    if (!token || !isAllowedUniversityUrl(message.url)) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.tabs.update(tabId, { url: message.url, active: false })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "KU_LMS_RESOLVER_IS_ACTIVE") {
    const token = resolverByTab.get(_sender.tab?.id);
    sendResponse({ ok: Boolean(token && pendingResolvers.has(token)) });
    return false;
  }
  if (message?.type === "KU_LMS_RESOLVER_LOGIN_REQUIRED") {
    const token = resolverByTab.get(_sender.tab?.id);
    if (token) {
      finishResolver(token, {
        ok: false,
        authRequired: true,
        error: "WebClassにログインしていません。先に任意の科目を通常操作でLMSまで開いてください。"
      });
    }
    sendResponse({ ok: Boolean(token) });
    return false;
  }
  if (message?.type === "KU_LMS_RESOLVER_CLAIM_CLICK") {
    const token = resolverByTab.get(_sender.tab?.id);
    const pending = token && pendingResolvers.get(token);
    sendResponse({
      ok: Boolean(pending),
      target: pending && !pending.clickDispatched ? pending.initialClick : null
    });
    return false;
  }
  if (message?.type === "KU_LMS_RESOLVER_CLICKED") {
    const token = resolverByTab.get(_sender.tab?.id);
    const pending = token && pendingResolvers.get(token);
    if (!pending || pending.clickDispatched) {
      sendResponse({ ok: false });
      return false;
    }
    pending.clickDispatched = true;
    pending.clickInFlight = false;
    clearTimeout(pending.clickRetryTimer);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "KU_LMS_RESOLVER_STEP") {
    const tabId = _sender.tab?.id;
    const token = resolverByTab.get(tabId);
    const pending = token && pendingResolvers.get(token);
    const request = message.request;
    const method = String(request?.method || "GET").toUpperCase();
    const body = String(request?.body || "");
    const signature = `${method}|${request?.url}|${body}`;
    if (!pending || !isAllowedUniversityUrl(request?.url) || !/^(GET|POST)$/.test(method) ||
        body.length > MAX_REQUEST_BYTES || pending.seenSteps.has(signature)) {
      sendResponse({ ok: false });
      return false;
    }
    pending.seenSteps.add(signature);
    const storageKey = `${RESOLVER_STORAGE_PREFIX}${token}`;
    chrome.storage.session.set({ [storageKey]: { url: request.url, method, body } })
      .then(() => chrome.tabs.update(tabId, {
        url: chrome.runtime.getURL(`resolver.html?token=${encodeURIComponent(token)}`),
        active: false
      }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
