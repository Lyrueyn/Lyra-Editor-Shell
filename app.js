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
    epub: params.get("epubEditor") === "1",
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
    rootExpanded: true,
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
    if (ext === ".epub") return "epub";
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
      if (d.type === "editor.cdp-event") {
        try {
          const frame = document.getElementById("pluginFrame");
          if (frame && frame.contentWindow) frame.contentWindow.postMessage(d, "*");
        } catch { }
        return;
      }
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
    const plugin = kind === "html" ? "html-reader" : kind === "epub" ? "epub-editor" : "js-editor";
    const q = new URLSearchParams();
    q.set("project", "1");
    q.set("projectName", state.projectName);
    if (rel) q.set("projectEntry", rel);
    q.set("shell", "1");
    if (extOrigin) q.set("extensionsOrigin", extOrigin);
    if (bookAssetsOrigin) q.set("bookAssetsOrigin", bookAssetsOrigin);
    if (backend) q.set("backend", backend);
    if (kind === "html") { q.set("startEdit", "1"); q.set("editorEnabled", "1"); }
    if (kind === "epub") q.set("editorEnabled", "1");
    const base = extOrigin ? extOrigin + "/" + plugin + "/index.html" : "../" + (plugin === "html-reader" ? "Lyra-Extension-HTML-Reader" : plugin === "epub-editor" ? "Lyra-Extension-Epub-Editor" : "Lyra-JS-Editor") + "/index.html";
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

  function expandParents(rel) {
    const parts = String(rel || "").split("/");
    for (let i = 1; i < parts.length; i += 1) state.expanded.add(parts.slice(0, i).join("/"));
  }

  function renderTree() {
    const box = $("fileTree");
    box.innerHTML = "";
    const root = buildTree();
    let visible = 0;
    const makeRow = (cls, depth, iconText, iconClass, name) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = cls;
      row.style.paddingLeft = (6 + depth * 13) + "px";
      row.innerHTML = '<span class="tree-chevron">▸</span><span class="tree-icon ' + iconClass + '"></span><span class="tree-name"></span>';
      row.querySelector(".tree-icon").textContent = iconText;
      row.querySelector(".tree-name").textContent = name;
      return row;
    };
    function walk(node, container, depth) {
      const dirs = Array.from(node.dirs.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      const files = node.files.slice().sort((a, b) => baseName(a.rel).localeCompare(baseName(b.rel), "zh-CN"));
      for (const dir of dirs) {
        const open = state.expanded.has(dir.path);
        const row = makeRow("tree-row tree-dir" + (open ? " open" : ""), depth, "▤", "dir", dir.name);
        row.title = dir.path;
        row.dataset.kind = "dir";
        row.dataset.rel = dir.path;
        row.dataset.name = dir.name;
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
        const row = makeRow("tree-row tree-file" + (file.rel === state.currentRel ? " active" : "") + (available ? "" : " disabled"), depth, "", "", baseName(file.rel));
        row.querySelector(".tree-chevron").style.visibility = "hidden";
        row.title = file.rel;
        row.dataset.kind = "file";
        row.dataset.rel = file.rel;
        row.dataset.name = baseName(file.rel);
        const icon = iconFor(kind, file.rel);
        row.querySelector(".tree-icon").textContent = icon.text;
        row.querySelector(".tree-icon").className = "tree-icon " + icon.cls;
        row.style.paddingLeft = (6 + depth * 13) + "px";
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
    const rootRow = document.createElement("button");
    rootRow.type = "button";
    rootRow.className = "tree-row tree-root" + (state.rootExpanded ? " open" : "");
    rootRow.dataset.kind = "root";
    rootRow.dataset.rel = "";
    rootRow.dataset.name = state.projectName;
    rootRow.title = state.root || state.projectName;
    rootRow.innerHTML = '<span class="tree-chevron">▸</span><span class="tree-icon dir">▤</span><span class="tree-name"></span>';
    rootRow.querySelector(".tree-name").textContent = state.projectName || "项目";
    const rootChildren = document.createElement("div");
    rootChildren.className = "tree-children";
    rootChildren.hidden = !state.rootExpanded;
    rootRow.addEventListener("click", () => {
      state.rootExpanded = !state.rootExpanded;
      renderTree();
    });
    box.append(rootRow, rootChildren);
    walk(root, rootChildren, 1);
    $("fileCount").textContent = String(visible);
  }

  let treeDialogState = null;
  let treeMenuTarget = null;
  let treeMenuCleanup = null;

  function treeDirname(rel) {
    const v = String(rel || "");
    const i = v.lastIndexOf("/");
    return i >= 0 ? v.slice(0, i) : "";
  }
  function treeJoin(dir, name) {
    const d = String(dir || "").replace(/\/+$/, "");
    return d ? d + "/" + name : name;
  }
  function validateTreeName(name) {
    const v = String(name || "").trim();
    if (!v) throw new Error("名称不能为空");
    if (v === "." || v === "..") throw new Error("名称不合法");
    if (/[\\/:*?"<>|]/.test(v)) throw new Error("名称不能包含 \\ / : * ? \" < > |");
    return v;
  }
  function newFileText(name) {
    if (/\.html?$/i.test(name)) return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>' + name.replace(/\.html?$/i, "") + '</title>\n</head>\n<body>\n  <h1>新建页面</h1>\n</body>\n</html>\n';
    if (/\.css$/i.test(name)) return "/* " + name + " */\n";
    if (/\.(m?js|cjs)$/i.test(name)) return "// " + name + "\n";
    if (/\.json$/i.test(name)) return "{}\n";
    return "";
  }
  function openTreeDialog(opts) {
    return new Promise((resolve) => {
      treeDialogState = { resolve: resolve, hasInput: opts.hasInput !== false };
      $("treeDialogTitle").textContent = opts.title || "";
      $("treeDialogMessage").textContent = opts.message || "";
      const input = $("treeDialogInput");
      input.hidden = opts.hasInput === false;
      input.value = opts.value || "";
      $("treeDialogOk").textContent = opts.okText || "确定";
      $("treeDialogOk").classList.toggle("danger", !!opts.danger);
      $("treeDialogMask").hidden = false;
      setTimeout(() => {
        if (!input.hidden) { input.focus(); input.select(); }
        else $("treeDialogOk").focus();
      }, 20);
    });
  }
  function closeTreeDialog(ok) {
    const st = treeDialogState;
    treeDialogState = null;
    $("treeDialogMask").hidden = true;
    if (!st) return;
    st.resolve(ok && st.hasInput ? $("treeDialogInput").value.trim() : ok);
  }
  function treePrompt(title, value, message) {
    return openTreeDialog({ title: title, value: value, message: message, hasInput: true });
  }
  function treeConfirm(title, message) {
    return openTreeDialog({ title: title, message: message, hasInput: false, okText: "删除", danger: true });
  }
  function closeTreeMenu() {
    const menu = $("treeCtxMenu");
    if (menu) { menu.hidden = true; menu.innerHTML = ""; }
    treeMenuTarget = null;
    if (treeMenuCleanup) { treeMenuCleanup(); treeMenuCleanup = null; }
  }
  function showTreeMenu(x, y, target) {
    const menu = $("treeCtxMenu");
    if (!menu) return;
    closeTreeMenu();
    treeMenuTarget = target;
    const add = (label, handler, danger) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-ctx-item" + (danger ? " danger" : "");
      btn.textContent = label;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeTreeMenu();
        Promise.resolve().then(handler).catch((e) => toast(e.message || String(e), true));
      });
      menu.appendChild(btn);
    };
    const sep = () => {
      const d = document.createElement("div");
      d.className = "tree-ctx-sep";
      menu.appendChild(d);
    };
    const kind = target ? target.kind : "root";
    const dirRel = kind === "root" ? "" : kind === "dir" ? target.rel : treeDirname(target.rel);
    if (kind === "root" || kind === "dir") {
      add("新建文件", () => createProjectFile(dirRel));
      add("新建文件夹", () => createProjectFolder(dirRel));
    }
    if (kind === "dir" || kind === "file") {
      sep();
      add("重命名…", () => renameProjectTarget(target));
      add(kind === "dir" ? "删除文件夹" : "删除文件", () => deleteProjectTarget(target), true);
    }
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6)) + "px";
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6)) + "px";
    const onDoc = (event) => {
      if (event.target && event.target.closest && event.target.closest("#treeCtxMenu")) return;
      closeTreeMenu();
    };
    const onScroll = () => closeTreeMenu();
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("scroll", onScroll, true);
    treeMenuCleanup = () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }

  async function reloadProjectTree() {
    const info = await hostCall("host.project.list");
    if (!info || !info.ok) throw new Error((info && info.error) || "刷新项目失败");
    state.root = info.root || state.root;
    state.projectName = info.name || state.projectName;
    state.files = Array.isArray(info.files) ? info.files : [];
    state.dirs = Array.isArray(info.dirs) ? info.dirs : [];
    renderTree();
  }
  async function createProjectFile(dirRel) {
    let name = await treePrompt("新建文件", "", "文件名，例如 page.html");
    if (name == null) return;
    name = validateTreeName(name);
    if (!/\.[a-z0-9]+$/i.test(name)) name += ".html";
    const rel = treeJoin(dirRel, name);
    const res = await hostCall("host.file.save", { path: rel, data: encodeText(newFileText(name)) });
    if (!res || !res.ok) throw new Error((res && res.error) || "新建文件失败");
    expandParents(rel);
    await reloadProjectTree();
    const kind = kindOf(rel);
    if (kind === "html" || kind === "js") await openFile(rel);
    toast("已新建文件：" + rel);
  }
  async function createProjectFolder(dirRel) {
    let name = await treePrompt("新建文件夹", "", "文件夹名称");
    if (name == null) return;
    name = validateTreeName(name);
    const rel = treeJoin(dirRel, name);
    const res = await hostCall("host.file.mkdir", { path: rel });
    if (!res || !res.ok) throw new Error((res && res.error) || "新建文件夹失败");
    expandParents(rel);
    state.expanded.add(rel);
    await reloadProjectTree();
    toast("已新建文件夹：" + rel);
  }
  async function renameProjectTarget(target) {
    if (!target || target.kind === "root") return;
    const oldRel = target.rel;
    const oldName = target.name || baseName(oldRel);
    const next = await treePrompt("重命名", oldName, "输入新名称");
    if (next == null) return;
    const newName = validateTreeName(next);
    if (newName === oldName) return;
    const toRel = treeJoin(treeDirname(oldRel), newName);
    const res = await hostCall("host.file.rename", { from: oldRel, to: toRel });
    if (!res || !res.ok) throw new Error((res && res.error) || "重命名失败");
    const affected = state.currentRel === oldRel || state.currentRel.startsWith(oldRel + "/");
    const nextCurrent = affected ? toRel + state.currentRel.slice(oldRel.length) : state.currentRel;
    if (affected) expandParents(nextCurrent);
    await reloadProjectTree();
    if (affected && nextCurrent) await openFile(nextCurrent);
    toast("已重命名：" + oldRel + " → " + toRel);
  }
  async function deleteProjectTarget(target) {
    if (!target || target.kind === "root") return;
    const isDir = target.kind === "dir";
    const ok = await treeConfirm("删除" + (isDir ? "文件夹" : "文件"), "确定删除 " + target.rel + " 吗？\n" + (isDir ? "文件夹内的所有内容都会被删除。" : "文件会被删除。") + "\n此操作不可撤销。");
    if (!ok) return;
    const res = await hostCall("host.file.delete", { path: target.rel });
    if (!res || !res.ok) throw new Error((res && res.error) || "删除失败");
    const affected = state.currentRel === target.rel || state.currentRel.startsWith(target.rel + "/");
    await reloadProjectTree();
    if (affected) {
      const next = state.files.find((f) => /^.*\.(html?|m?js|cjs|json)$/i.test(f.rel));
      if (next) await openFile(next.rel);
      else {
        state.currentRel = "";
        $("currentFile").textContent = "未打开文件";
        $("pluginBadge").textContent = "";
        $("pluginFrame").src = "about:blank";
        showEmpty("项目里没有可编辑的 HTML / JS 文件了。");
      }
    }
    toast("已删除：" + target.rel);
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
    const epub = all.find((r) => /\.epub$/i.test(r));
    if (flags.epub && epub) return epub;
    if (flags.html && html) return html;
    if (flags.js && js) return js;
    return html || js || "";
  }

  async function openFile(rel) {
    if (!rel || rel === state.currentRel) return;
    const kind = kindOf(rel);
    if (kind === "css") { toast("还没有 CSS 编辑器插件：" + rel, true); return; }
    if (kind !== "html" && kind !== "js" && kind !== "epub") { toast("没有适配这个文件类型的编辑器：" + rel, true); return; }
    if (kind === "html" && !flags.html) { toast("需要安装 HTML 阅读器 + HTML 编辑器插件", true); return; }
    if (kind === "js" && !flags.js) { toast("需要安装 JavaScript 编辑器插件", true); return; }
    if (kind === "epub" && !flags.epub) { toast("需要安装 EPUB 编辑器插件", true); return; }
    state.currentRel = rel;
    state.loading = true;
    $("pluginFrame").hidden = false;
    $("pluginLoading").hidden = false;
    $("pluginLoading").textContent = "正在加载 " + (kind === "html" ? "HTML 编辑器…" : kind === "epub" ? "EPUB 编辑器…" : "JavaScript 编辑器…");
    $("pluginBadge").textContent = kind === "html" ? "HTML 编辑器" : kind === "epub" ? "EPUB 编辑器" : "JavaScript 编辑器";
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
    if (!target) { showEmpty("项目里没有可编辑的 HTML / JS / EPUB 文件。"); return; }
    const parents = String(target).split("/");
    for (let i = 1; i < parents.length; i += 1) state.expanded.add(parents.slice(0, i).join("/"));
    await openFile(target);
  }

  async function handleHost(method, payload) {
    if (method === "editor.open-file") {
      await openFile(payload.rel);
      const k = kindOf(payload.rel);
      return { plugin: k === "html" ? "html-editor" : k === "epub" ? "epub-editor" : "js-editor" };
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
    $("fileTree").addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = event.target && event.target.closest ? event.target.closest(".tree-row") : null;
      const target = row ? { kind: row.dataset.kind, rel: row.dataset.rel, name: row.dataset.name } : { kind: "root", rel: "", name: state.projectName };
      showTreeMenu(event.clientX, event.clientY, target);
    });
    $("treeDialogOk").addEventListener("click", () => closeTreeDialog(true));
    $("treeDialogCancel").addEventListener("click", () => closeTreeDialog(false));
    $("treeDialogInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); closeTreeDialog(true); }
      else if (event.key === "Escape") { event.preventDefault(); closeTreeDialog(false); }
    });
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeTreeMenu();
      if (!$("treeDialogMask").hidden) closeTreeDialog(false);
    });
    window.addEventListener("blur", () => closeTreeMenu());
  }

  (async () => {
      initTheme();
    bind();
    try { await loadProject(); }
    catch (e) { showEmpty("读取项目失败：" + (e && e.message ? e.message : e)); }
  })();
})();