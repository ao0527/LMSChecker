"use strict";

(async () => {
  const token = new URL(location.href).searchParams.get("token");
  if (!token) return;
  const key = `kuLmsResolver:${token}`;
  const stored = await chrome.storage.session.get(key);
  const request = stored[key];
  if (!request?.url) {
    chrome.runtime.sendMessage({ type: "KU_LMS_RESOLVER_FAILED", token, error: "ジャンプ情報がありません。" });
    return;
  }

  const form = document.createElement("form");
  form.method = request.method === "POST" ? "POST" : "GET";
  form.action = request.url;
  for (const [name, value] of new URLSearchParams(request.body || "")) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
})();
