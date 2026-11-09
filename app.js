(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const params = new URLSearchParams(location.search);
  const extOrigin = (params.get("extensionsOrigin") || "").replace(/\/+$/, "");
  const bookAssetsOrigin = params.get("bookAssetsOrigin") || "";
  const backend = params.get("backend") || "";
  const flags = {
    html: params.get("htmlEditor") === "1",
    js: params.get("jsEditor") === "1",
  };
  const THEME_KEY = "lyra.shell.theme";
  const THEMES = new Set(["lyra", "violet", "emerald", "sunset", "sakura", "light"]);
  const state = {
    projectName: params.get("projectName") || "项目",
    theme: "lyra",
    root: "",
    files: [],
    dirs: [],
    expanded: new Set(),
    currentRel: "",
    requestId: 1,
    pending: new Map(),
    loading: false,
  };
  let toastTimer = 0;

  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64 || "");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }
  function encodeText(text) { return bytesToBase64(new TextEncoder().encode(text || "")); }
  function decodeText(b64) { return new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(b64)); }
  function extOf(rel) {
    const s = String(rel || "");
    const i = s.lastIndexOf(".");
    return i >= 0 ? s.slice(i).toLowerCase() : "";
  }
  function baseName(rel) {
    const s = String(rel || "");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function dirOf(rel) {
    const s = String(rel || "");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(0, i) : "";
  }
  function kindOf(rel) {
    const ext = extOf(rel);
    if (ext === ".html" || ext === ".htm") return "html";
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".jsx" || ext === ".ts" || ext === ".tsx" || ext === ".json") return "js";
    if (ext === ".css") return "css";
    return "other";
  }
  function fullPath(rel) {
    const root = String(state.root || "").replace(/[\\/]+$/, "");
    if (!root) return String(rel || "");
    const sep = root.includes("\\") ? "\\" : "/";
    return root + sep + String(rel || "").replace(/\//g, sep);
  }

  function postTheme() {
    try {
      const frame = $("pluginFrame");
      if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "theme", theme: state.theme }, "*");
    } catch { }
  }

  function applyTheme(name) {
    const next = THEMES.has(name) ? name : "lyra";
    state.theme = next;
    document.documentElement.dataset.shellTheme = next;
    const sel = $("themeSelect");
    if (sel) sel.value = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { }
    postTheme();
  }

  function initTheme() {
    let saved = "lyra";
    try { saved = localStorage.getItem(THEME_KEY) || "lyra"; } catch { }
    applyTheme(saved);
  }

  function hostCall(type, payload) {
    return new Promise((resolve, reject) => {
      if (!host) { reject(new Error("请从璃鸢镜扩展窗口打开")); return; }
      const requestId = "shell-" + (state.requestId++) + "-" + Date.now();
      state.pending.set(requestId, { resolve, reject });
      host.postMessage(Object.assign({ type: type, requestId: requestId }, payload || {}));
      setTimeout(() => {
        const p = state.pending.get(requestId);
        if (!p) return;
        state.pending.delete(requestId);
        reject(new Error("宿主响应超时"));
      }, 20000);
    });
  }
  if (host) {
    host.addEventListener("message", (event) => {
      const d = event.data || {};
      const p = state.pending.get(d.requestId);
      if (!p) return;
      state.pending.delete(d.requestId);
      if (d.ok === false) p.reject(new Error(d.error || "宿主操作失败"));
      else p.resolve(d);
    });
  }

  function toast(message, isError) {
    const el = $("toast");
    el.textContent = String(message || "");
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function pluginUrl(kind, rel) {
    const plugin = kind === "html" ? "html-reader" : "js-editor";
    const q = new URLSearchParams();
    q.set("project", "1");
    q.set("projectName", state.projectName);
    if (rel) q.set("projectEntry", rel);
    q.set("shell", "1");
    if (extOrigin) q.set("extensionsOrigin", extOrigin);
    if (bookAssetsOrigin) q.set("bookAssetsOrigin", bookAssetsOrigin);
    if (backend) q.set("backend", backend);
    if (kind === "html") { q.set("startEdit", "1"); q.set("editorEnabled", "1"); }
    const base = extOrigin ? extOrigin + "/" + plugin + "/index.html" : "../" + (plugin === "html-reader" ? "Lyra-Extension-HTML-Reader" : "Lyra-JS-Editor") + "/index.html";
    return base + "?" + q.toString();
  }

  function buildTree() {
    const root = { dirs: new Map(), files: [] };
    for (const d of state.dirs) {
      const parts = String(d || "").split("/").filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length; i += 1) {
        const name = parts[i];
        const path = parts.slice(0, i + 1).join("/");
        if (!node.dirs.has(name)) node.dirs.set(name, { name, path, node: { dirs: new Map(), files: [] } });
        node = node.dirs.get(name).node;
      }
    }
    for (const file of state.files) {
      const parts = String(file.rel || "").split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i];
        const path = parts.slice(0, i + 1).join("/");
        if (!node.dirs.has(name)) node.dirs.set(name, { name, path, node: { dirs: new Map(), files: [] } });
        node = node.dirs.get(name).node;
      }
      node.files.push(file);
    }
    return root;
  }

  function iconFor(kind, rel) {
    if (kind === "js") return extOf(rel) === ".json" ? { cls: "json", text: "{}" } : { cls: "js", text: "JS" };
    if (kind === "html") return { cls: "html", text: "<>" };
    if (kind === "css") return { cls: "css", text: "#" };
    return { cls: "other", text: "·" };
  }

  function renderTree() {
    const box = $("fileTree");
    box.innerHTML = "";
    const root = buildTree();
    let visible = 0;
    function walk(node, container, depth) {
      const dirs = Array.from(node.dirs.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      const files = node.files.slice().sort((a, b) => baseName(a.rel).localeCompare(baseName(b.rel), "zh-CN"));
      for (const dir of dirs) {
        const open = state.expanded.has(dir.path);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row tree-dir" + (open ? " open" : "");
        row.style.paddingLeft = (6 + depth * 13) + "px";
        row.innerHTML = '<span class="tree-chevron">▸</span><span class="tree-icon dir">▤</span><span class="tree-name"></span>';
        row.querySelector(".tree-name").textContent = dir.name;
        const children = document.createElement("div");
        children.className = "tree-children";
        children.hidden = !open;
        row.addEventListener("click", () => {
          if (state.expanded.has(dir.path)) state.expanded.delete(dir.path);
          else state.expanded.add(dir.path);
          renderTree();
        });
        container.append(row, children);
        walk(dir.node, children, depth + 1);
      }
      for (const file of files) {
        visible += 1;
        const kind = kindOf(file.rel);
        const available = kind === "html" ? flags.html : kind === "js" ? flags.js : false;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row tree-file" + (file.rel === state.currentRel ? " active" : "") + (available ? "" : " disabled");
        row.style.paddingLeft = (6 + depth * 13 + 14) + "px";
        row.title = file.rel;
        const icon = iconFor(kind, file.rel);
        row.innerHTML = '<span class="tree-icon ' + icon.cls + '"></span><span class="tree-name"></span>';
        row.querySelector(".tree-icon").textContent = icon.text;
        row.querySelector(".tree-name").textContent = baseName(file.rel);
        row.addEventListener("click", () => {
          if (!available) {
            if (kind === "css") toast("还没有安装 CSS 编辑器插件，暂时不能打开：" + file.rel, true);
            else toast("没有适配这个文件类型的编辑器：" + file.rel, true);
            return;
          }
          openFile(file.rel).catch((e) => toast(e.message || String(e), true));
        });
        container.appendChild(row);
      }
    }
    walk(root, box, 0);
    $("fileCount").textContent = String(visible);
  }

  function showEmpty(message) {
    $("shellEmpty").hidden = false;
    $("emptyMessage").textContent = message || "";
    $("pluginFrame").hidden = true;
    $("pluginLoading").hidden = true;
  }

  function chooseInitial(files) {
    const entry = params.get("projectEntry") || "";
    const all = files.map((f) => f.rel);
    if (entry && all.includes(entry)) return entry;
    const html = all.find((r) => /\.html?$/i.test(r));
    const js = all.find((r) => /\.(m?js|cjs|jsx|tsx?|json)$/i.test(r)) || all.find((r) => /package\.json$/i.test(r));
    if (flags.html && html) return html;
    if (flags.js && js) return js;
    return html || js || "";
  }

  async function openFile(rel) {
    if (!rel || rel === state.currentRel) return;
    const kind = kindOf(rel);
    if (kind === "css") { toast("还没有 CSS 编辑器插件：" + rel, true); return; }
    if (kind !== "html" && kind !== "js") { toast("没有适配这个文件类型的编辑器：" + rel, true); return; }
    if (kind === "html" && !flags.html) { toast("需要安装 HTML 阅读器 + HTML 编辑器插件", true); return; }
    if (kind === "js" && !flags.js) { toast("需要安装 JavaScript 编辑器插件", true); return; }
    state.currentRel = rel;
    state.loading = true;
    $("pluginFrame").hidden = false;
    $("pluginLoading").hidden = false;
    $("pluginLoading").textContent = "正在加载 " + (kind === "html" ? "HTML 编辑器…" : "JavaScript 编辑器…");
    $("pluginBadge").textContent = kind === "html" ? "HTML 编辑器" : "JavaScript 编辑器";
    $("currentFile").textContent = fullPath(rel);
    renderTree();
    const url = pluginUrl(kind, rel);
    $("pluginFrame").src = url;
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        $("pluginFrame").addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    } finally {
      state.loading = false;
      $("pluginLoading").hidden = true;
    }
  }

  async function loadProject() {
    const info = await hostCall("host.project.list");
    state.root = info.root || "";
    state.projectName = info.name || state.projectName;
    state.files = Array.isArray(info.files) ? info.files : [];
    state.dirs = Array.isArray(info.dirs) ? info.dirs : [];
    $("projectName").textContent = state.projectName;
    renderTree();
    if (!flags.html && !flags.js) {
      showEmpty("需要安装 HTML 编辑器插件或 JavaScript 编辑器插件。");
      return;
    }
    const target = chooseInitial(state.files);
    if (!target) { showEmpty("项目里没有可编辑的 HTML / JS 文件。"); return; }
    const parents = String(target).split("/");
    for (let i = 1; i < parents.length; i += 1) state.expanded.add(parents.slice(0, i).join("/"));
    await openFile(target);
  }

  async function handleHost(method, payload) {
    if (method === "editor.open-file") {
      await openFile(payload.rel);
      return { plugin: kindOf(payload.rel) === "html" ? "html-editor" : "js-editor" };
    }
    const p = Object.assign({}, payload || {});
    if (method === "host.workspace.load" && !p.path && state.currentRel) p.path = state.currentRel;
    if (method === "host.workspace.save" && !p.path && state.currentRel) p.path = state.currentRel;
    return await hostCall(method, p);
  }

  window.addEventListener("message", async (event) => {
    const d = event.data || {};
    if (d.type === "shell-host-request") {
      try {
        const result = await handleHost(d.method, d.payload || {});
        event.source.postMessage(Object.assign({}, result || {}, { type: "shell-host-result", requestId: d.requestId, ok: true }), "*");
      } catch (e) {
        try { event.source.postMessage({ type: "shell-host-result", requestId: d.requestId, ok: false, error: e && e.message ? e.message : String(e) }, "*"); } catch { }
      }
      return;
    }
    if (d.type === "shell-open-file") {
      openFile(d.rel).catch((e) => toast(e.message || String(e), true));
    }
  });

  function bind() {
    $("themeSelect").addEventListener("change", () => applyTheme($("themeSelect").value));
    $("refreshBtn").addEventListener("click", () => loadProject().catch((e) => toast(e.message || String(e), true)));
    $("pluginFrame").addEventListener("load", () => {
      $("pluginLoading").hidden = true;
      postTheme();
    });
  }

  (async () => {
      initTheme();
    bind();
    try { await loadProject(); }
    catch (e) { showEmpty("读取项目失败：" + (e && e.message ? e.message : e)); }
  })();
})();