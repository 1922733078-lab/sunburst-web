/* Sunburst frontend — vanilla JS, no external runtime. */
(function () {
  "use strict";

  var API_BASE = (window.SUNBURST_API_BASE || "").replace(/\/+$/, "");
  var TOKEN_KEY = "sunburst_token";
  var TOKEN = "";
  try { TOKEN = localStorage.getItem(TOKEN_KEY) || ""; } catch (err) { TOKEN = ""; }

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var ICONS = {
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m5.5 17 4.2-4.2a2 2 0 0 1 2.8 0l2.1 2.1a2 2 0 0 0 2.8 0l1.1-1.1"/></svg>'
  };

  var state = {
    config: null,
    me: null,
    refs: [],
    model: null,
    size: "1024x1024",
    n: 1,
    view: "create",
    active: new Map(),
    jobs: new Map(),
    gallery: { items: [], total: 0, offset: 0, loading: false },
    pollTimer: null,
    polling: false,
    healthTimer: null,
    submitting: false,
    timersStarted: false
  };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function api(path, opts) {
    var options = Object.assign({}, opts || {});
    options.headers = Object.assign({}, options.headers || {});
    if (TOKEN) options.headers.Authorization = "Bearer " + TOKEN;
    if (typeof options.body === "string" && !options.headers["Content-Type"]) {
      options.headers["Content-Type"] = "application/json";
    }
    return fetch(API_BASE + path, options).then(function (resp) {
      return resp.text().then(function (text) {
        var data = {};
        if (text) {
          try { data = JSON.parse(text); } catch (err) { data = { error: { message: text.slice(0, 240) } }; }
        }
        if (resp.status === 401) {
          clearSession();
          showLogin();
        }
        if (!resp.ok) {
          var error = new Error((data.error && data.error.message) || ("HTTP " + resp.status));
          error.code = data.error && data.error.code;
          error.retryable = data.error && data.error.retryable;
          error.status = resp.status;
          throw error;
        }
        return data;
      });
    });
  }

  function toast(message, tone) {
    var host = $("#toasts");
    if (!host) return;
    var item = document.createElement("div");
    item.className = "toast " + (tone || "info");
    item.textContent = message;
    host.appendChild(item);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    setTimeout(function () {
      item.classList.add("leaving");
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 220);
    }, tone === "error" ? 5600 : 3800);
  }

  function fmtDuration(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
    } catch (err) {
      return iso.slice(5, 16).replace("T", " ");
    }
  }

  function modelInfo(id) {
    var models = (state.config && state.config.models) || [];
    for (var i = 0; i < models.length; i++) if (models[i].id === id) return models[i];
    return { id: id, label: id, note: "" };
  }
  function modelLabel(id) { return modelInfo(id).label || id; }
  function sizeLabel(size) {
    var map = { "1024x1024": "方形", "1536x1024": "横版", "1024x1536": "竖版" };
    return (map[size] || size) + " · " + size;
  }
  function modeLabel(mode) { return mode === "edits" ? "参考图" : "文生图"; }

  function elapsedOf(job) {
    if (job.status === "queued") return 0;
    if (job.status === "running") {
      var start = job.started_at ? new Date(job.started_at).getTime() : new Date(job.created_at).getTime();
      return Math.max(0, (Date.now() - start) / 1000);
    }
    return Number(job.elapsed) || 0;
  }

  function selectSegment(host, value) {
    if (!host) return;
    $$(".segment", host).forEach(function (btn) {
      var on = btn.dataset.value === String(value);
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", String(on));
    });
    host.dataset.value = String(value);
  }

  function buildSegmented(host, options, selected, onChange) {
    if (!host) return;
    host.innerHTML = "";
    options.forEach(function (opt) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "segment";
      btn.dataset.value = String(opt.value);
      btn.setAttribute("role", "radio");
      btn.innerHTML = "<span>" + esc(opt.label) + "</span>" + (opt.note ? "<small>" + esc(opt.note) + "</small>" : "");
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        selectSegment(host, opt.value);
        onChange(opt.value);
      });
      host.appendChild(btn);
    });
    selectSegment(host, selected);
  }

  function applyConfig(cfg) {
    state.config = cfg;
    state.model = cfg.defaultModel || (cfg.models && cfg.models[0] && cfg.models[0].id);
    $("#max-refs").textContent = cfg.maxRefs;
    $("#max-ref-mb").textContent = cfg.maxRefMb;
    $("#prompt").maxLength = cfg.maxPrompt;
    $("#counter").textContent = "0 / " + cfg.maxPrompt;

    buildSegmented($("#seg-model"), (cfg.models || []).map(function (m) {
      return { value: m.id, label: m.label || m.id, note: m.note || "" };
    }), state.model, function (value) { state.model = value; });

    buildSegmented($("#seg-size"), (cfg.sizes || ["1024x1024"]).map(function (s) {
      var note = s === "1024x1024" ? "1024²" : s.replace("x", " × ");
      var label = s === "1024x1024" ? "方形" : (s === "1536x1024" ? "横版" : "竖版");
      return { value: s, label: label, note: note };
    }), state.size, function (value) { state.size = value; });

    var nOptions = [];
    for (var i = 1; i <= cfg.maxN; i++) nOptions.push({ value: String(i), label: String(i), note: i === 1 ? "张" : "张" });
    buildSegmented($("#seg-n"), nOptions, "1", function (value) { state.n = parseInt(value, 10); });
    var sub = $("#gallery-sub");
    if (sub && cfg.maxImagesPerUser) {
      sub.textContent = "你的生成记录 · 每人最多保留最近 " + cfg.maxImagesPerUser + " 张";
    }
    updateModeUI();
  }

  function renderUser(me) {
    state.me = me || {};
    var label = me && (me.username || me.label) ? (me.username || me.label) : "已登录";
    $("#user-label").textContent = label;
    $("#user-avatar").textContent = (label.charAt(0) || "S").toUpperCase();
    $("#user-pill").title = "已登录 · 点击退出";
  }

  function updateModeUI() {
    var hasRefs = state.refs.length > 0;
    var fidelityRow = $("#fidelity-row");
    if (fidelityRow) fidelityRow.hidden = !hasRefs;
    var label = $("#submit .btn-label");
    if (label && !state.submitting) label.textContent = hasRefs ? "参考图生成" : "开始生成";
    var note = $("#submit-note");
    if (note) note.textContent = hasRefs ? "参考图模式固定 1 张输出" : "通常 30–90 秒";
    var clear = $("#clear-refs");
    if (clear) clear.hidden = !hasRefs;
    if (hasRefs && state.n !== 1) {
      state.n = 1;
      selectSegment($("#seg-n"), "1");
    }
    $$("#seg-n .segment").forEach(function (btn) {
      btn.disabled = hasRefs && btn.dataset.value !== "1";
    });
  }

  function renderRefs() {
    var host = $("#refs");
    if (!host) return;
    host.innerHTML = state.refs.map(function (ref, index) {
      return '<div class="ref">' +
        '<img src="' + esc(ref.url) + '" alt="">' +
        '<span class="ref-name">' + esc(ref.name) + "</span>" +
        '<button type="button" class="ref-remove" data-remove="' + index + '" aria-label="移除参考图">×</button>' +
        "</div>";
    }).join("");
    $$(".ref-remove", host).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var index = parseInt(btn.dataset.remove, 10);
        var ref = state.refs[index];
        if (ref && ref.url) URL.revokeObjectURL(ref.url);
        state.refs.splice(index, 1);
        renderRefs();
        updateModeUI();
      });
    });
  }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var maxRefs = (state.config && state.config.maxRefs) || 4;
    var maxBytes = ((state.config && state.config.maxRefMb) || 10) * 1024 * 1024;
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (state.refs.length >= maxRefs) { toast("参考图最多 " + maxRefs + " 张", "error"); break; }
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast("只接受 PNG / JPG / WEBP", "error"); continue; }
      if (file.size > maxBytes) { toast("单张参考图不能超过 " + ((state.config && state.config.maxRefMb) || 10) + " MB", "error"); continue; }
      state.refs.push({ file: file, url: URL.createObjectURL(file), name: file.name || ("reference-" + (state.refs.length + 1)) });
      added++;
    }
    if (added) {
      renderRefs();
      updateModeUI();
    }
    var input = $("#file-input");
    if (input) input.value = "";
  }

  function clearRefs() {
    state.refs.forEach(function (ref) { if (ref.url) URL.revokeObjectURL(ref.url); });
    state.refs = [];
    renderRefs();
    updateModeUI();
  }

  function setSubmitting(value) {
    state.submitting = value;
    var btn = $("#submit");
    if (!btn) return;
    btn.disabled = value;
    var label = $(".btn-label", btn);
    if (label) label.textContent = value ? "提交中…" : (state.refs.length ? "参考图生成" : "开始生成");
    var arrow = $(".btn-arrow", btn);
    if (arrow) arrow.hidden = value;
  }

  function onSubmit(event) {
    event.preventDefault();
    if (state.submitting) return;
    var prompt = $("#prompt").value.trim();
    if (!prompt) {
      toast("先写下画面描述", "error");
      $("#prompt").focus();
      return;
    }
    if (!state.config) { toast("配置尚未加载完成", "error"); return; }
    setSubmitting(true);
    var request;
    if (state.refs.length) {
      var form = new FormData();
      form.append("prompt", prompt);
      form.append("model", state.model);
      form.append("size", state.size);
      form.append("input_fidelity", $("#fidelity").checked ? "high" : "low");
      state.refs.forEach(function (ref) { form.append("images", ref.file, ref.name); });
      request = api("/api/jobs/edit", { method: "POST", body: form });
    } else {
      request = api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt, model: state.model, size: state.size, n: state.n })
      });
    }
    request.then(function (data) {
      if (data.job) ingestJob(data.job);
      toast("已加入队列", "success");
      clearRefs();
      if (state.view !== "create") setView("create");
    }).catch(function (error) {
      toast(error.message || "提交失败", "error");
    }).then(function () {
      setSubmitting(false);
    });
  }

  function ingestJob(job) {
    if (!job || !job.id) return;
    state.jobs.set(job.id, job);
    if (job.status === "queued" || job.status === "running") {
      state.active.set(job.id, job);
      renderActive();
      updateTaskBadge();
      startPolling();
    } else if (job.status === "done") {
      addGalleryJob(job);
    }
  }

  function renderActive() {
    var host = $("#active-list");
    if (!host) return;
    var jobs = Array.from(state.active.values()).sort(function (a, b) {
      return String(a.created_at || "").localeCompare(String(b.created_at || ""));
    });
    var empty = $("#active-empty");
    if (empty) empty.hidden = jobs.length > 0;
    var meta = $("#queue-meta");
    if (meta) meta.textContent = jobs.length ? (jobs.length + " 个任务") : "";
    host.innerHTML = jobs.map(function (job) {
      var queued = job.status === "queued";
      var statusText = queued ? (job.position ? "排队中 · 第 " + job.position + " 位" : "排队中") : "生成中";
      var hint = queued ? "等待前面的任务完成" : "上游生成中，通常 30–90 秒";
      return '<article class="active-card" data-id="' + esc(job.id) + '">' +
        '<div class="active-top"><span class="status-chip"><span class="pulse-dot"></span>' + statusText + "</span>" +
        '<span class="mono elapsed">' + (queued ? "—" : fmtDuration(elapsedOf(job))) + "</span></div>" +
        '<p class="active-prompt">' + esc(job.prompt) + "</p>" +
        '<div class="active-meta"><span>' + esc(modelLabel(job.model)) + "</span><span>" + esc(job.size) + "</span><span>" + job.n + " 张</span></div>" +
        '<div class="shimmer"><span></span></div>' +
        '<div class="active-actions"><span class="tiny">' + hint + "</span>" +
        (queued ? '<button type="button" class="mini-btn" data-cancel="' + esc(job.id) + '">取消</button>' : "") +
        "</div></article>";
    }).join("");
  }

  function updateTaskBadge() {
    var badge = $("#task-badge");
    if (!badge) return;
    var count = state.active.size;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(pollActive, 1800);
    pollActive();
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function pollActive() {
    if (state.polling) return;
    var ids = Array.from(state.active.keys());
    if (!ids.length) { stopPolling(); return; }
    state.polling = true;
    Promise.all(ids.map(function (id) {
      return api("/api/jobs/" + encodeURIComponent(id)).then(function (data) { return data.job; }).catch(function (error) {
        return { id: id, __error: error };
      });
    })).then(function (results) {
      var changed = false;
      results.forEach(function (job) {
        if (!job || job.__error) {
          var id = job && job.id;
          if (id && job.__error && job.__error.status === 404) state.active.delete(id);
          return;
        }
        var previous = state.active.get(job.id);
        state.jobs.set(job.id, job);
        changed = true;
        if (job.status === "done") {
          state.active.delete(job.id);
          addGalleryJob(job);
          toast("生成完成", "success");
        } else if (job.status === "error") {
          state.active.delete(job.id);
          toast((job.error && job.error.message) || "生成失败", "error");
        } else {
          state.active.set(job.id, job);
        }
        if (previous && previous.status !== job.status && state.view === "tasks") loadTasks();
      });
      if (changed) {
        renderActive();
        updateTaskBadge();
      }
      if (!state.active.size) {
        stopPolling();
        loadGallery(true);
      }
    }).catch(function (error) {
      if (state.view === "create") toast(error.message || "轮询失败", "error");
    }).then(function () {
      state.polling = false;
    });
  }

  function loadActive() {
    return api("/api/jobs?status=active&limit=20").then(function (data) {
      state.active.clear();
      (data.items || []).forEach(function (job) { state.active.set(job.id, job); state.jobs.set(job.id, job); });
      renderActive();
      updateTaskBadge();
      if (state.active.size) startPolling();
    }).catch(function (error) {
      toast(error.message || "读取任务失败", "error");
    });
  }

  function loadGallery(reset) {
    if (state.gallery.loading) return Promise.resolve();
    state.gallery.loading = true;
    var offset = reset ? 0 : state.gallery.offset;
    return api("/api/jobs?status=done&limit=24&offset=" + offset).then(function (data) {
      if (reset) state.gallery.items = [];
      var seen = new Set(state.gallery.items.map(function (job) { return job.id; }));
      (data.items || []).forEach(function (job) {
        if (!seen.has(job.id)) { state.gallery.items.push(job); seen.add(job.id); }
      });
      state.gallery.total = data.total || 0;
      state.gallery.offset = state.gallery.items.length;
      renderGallery();
    }).catch(function (error) {
      toast(error.message || "读取画廊失败", "error");
    }).then(function () {
      state.gallery.loading = false;
    });
  }

  function addGalleryJob(job) {
    if (!job || !job.images || !job.images.length) return;
    var existing = state.gallery.items.some(function (item) { return item.id === job.id; });
    if (!existing) state.gallery.items.unshift(job);
    state.gallery.total = Math.max(state.gallery.total, state.gallery.items.length);
    renderGallery();
  }

  function renderGallery() {
    var host = $("#gallery");
    if (!host) return;
    var cards = [];
    state.gallery.items.forEach(function (job) {
      (job.images || []).forEach(function (image, index) {
        cards.push(artCard(job, image, index));
      });
    });
    host.innerHTML = cards.join("");
    var empty = $("#gallery-empty");
    if (empty) empty.hidden = cards.length > 0;
    var count = $("#gallery-count");
    if (count) count.textContent = cards.length ? (state.gallery.items.length + " 个任务 · " + cards.length + " 张图") : "";
    var more = $("#load-more");
    if (more) more.hidden = state.gallery.items.length >= state.gallery.total;
  }

  function artCard(job, image, index) {
    var url = image.url || "";
    return '<figure class="art-card" data-job="' + esc(job.id) + '">' +
      '<div class="art-media" data-open="' + esc(job.id) + '" data-index="' + index + '">' +
      '<img src="' + esc(url) + '" alt="' + esc(job.prompt) + '" loading="lazy">' +
      '<div class="art-overlay">' +
      '<button type="button" class="icon-btn" data-download="' + esc(job.id) + '" data-index="' + index + '" title="下载" aria-label="下载">' + ICONS.download + "</button>" +
      '<button type="button" class="icon-btn" data-asref="' + esc(job.id) + '" data-index="' + index + '" title="作为参考图" aria-label="作为参考图">' + ICONS.image + "</button>" +
      '<button type="button" class="icon-btn danger" data-delete="' + esc(job.id) + '" title="删除" aria-label="删除">' + ICONS.trash + "</button>" +
      "</div></div>" +
      '<figcaption class="art-body"><p class="art-prompt">' + esc(job.prompt) + "</p>" +
      '<div class="art-meta"><span>' + esc(modelLabel(job.model)) + " · " + esc(job.size) + "</span>" +
      '<button type="button" class="art-reuse" data-reuse="' + esc(job.id) + '">复用</button></div></figcaption></figure>';
  }

  function findJob(id) { return state.jobs.get(id) || state.gallery.items.find(function (job) { return job.id === id; }) || null; }

  function openLightbox(job, image) {
    if (!job || !image) return;
    $("#lightbox-img").src = image.url;
    $("#lightbox-img").alt = job.prompt || "";
    $("#lightbox-title").textContent = modeLabel(job.mode) + " · " + modelLabel(job.model);
    $("#lightbox-sub").textContent = job.created_at ? fmtDate(job.created_at) : "";
    var download = $("#lightbox-download");
    download.href = downloadUrl(image.url);
    download.download = "sunburst-" + job.id + ".png";
    var meta = $("#lightbox-meta");
    meta.innerHTML = "<b>描述</b> " + esc(job.prompt) +
      (job.revised_prompt && job.revised_prompt !== job.prompt ? "<br><b>改写</b> " + esc(job.revised_prompt) : "") +
      "<br><b>参数</b> " + esc(modelLabel(job.model)) + " · " + esc(job.size) + " · " + job.n + " 张" +
      (job.input_fidelity ? " · 还原度 " + esc(job.input_fidelity) : "");
    $("#lightbox").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    $("#lightbox").hidden = true;
    $("#lightbox-img").src = "";
    document.body.style.overflow = "";
  }

  function downloadUrl(url) {
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "download=1";
  }

  function downloadImage(job, image) {
    if (!image || !image.url) return;
    var a = document.createElement("a");
    a.href = downloadUrl(image.url);
    a.download = "sunburst-" + (job ? job.id : "image") + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function useAsReference(job, image) {
    if (!image || !image.url) return;
    fetch(image.url).then(function (resp) {
      if (!resp.ok) throw new Error("读取图片失败");
      return resp.blob();
    }).then(function (blob) {
      var name = "reference-" + Date.now() + ".png";
      addFiles([new File([blob], name, { type: blob.type || "image/png" })]);
      setView("create");
      toast("已加入参考图", "success");
      setTimeout(function () { $("#prompt").focus(); }, 250);
    }).catch(function (error) {
      toast(error.message || "读取图片失败", "error");
    });
  }

  function reuseJob(job) {
    if (!job) return;
    $("#prompt").value = job.prompt || "";
    $("#counter").textContent = ($("#prompt").value.length) + " / " + ((state.config && state.config.maxPrompt) || 4000);
    if (job.model) { state.model = job.model; selectSegment($("#seg-model"), job.model); }
    if (job.size) { state.size = job.size; selectSegment($("#seg-size"), job.size); }
    if (job.mode === "generations" && job.n) { state.n = job.n; selectSegment($("#seg-n"), String(job.n)); }
    clearRefs();
    setView("create");
    var refs = job.refs || [];
    if (refs.length) {
      Promise.all(refs.map(function (ref) {
        return fetch(ref.url).then(function (resp) { return resp.blob(); }).then(function (blob) {
          return new File([blob], "reference-" + Date.now() + ".png", { type: blob.type || "image/png" });
        });
      })).then(function (files) {
        addFiles(files);
      }).catch(function () { /* prompt still usable */ });
    }
    toast("已填入提示词", "success");
    setTimeout(function () { $("#prompt").focus(); }, 250);
  }

  function deleteJob(job, options) {
    if (!job) return;
    var isActive = job.status === "queued" || job.status === "running";
    var message = isActive ? "取消这个任务？" : "删除这个任务及它的图片？";
    if (options && options.message) message = options.message;
    if (!window.confirm(message)) return;
    api("/api/jobs/" + encodeURIComponent(job.id), { method: "DELETE" }).then(function () {
      state.active.delete(job.id);
      state.jobs.delete(job.id);
      state.gallery.items = state.gallery.items.filter(function (item) { return item.id !== job.id; });
      renderActive();
      renderGallery();
      updateTaskBadge();
      if (!state.active.size) stopPolling();
      if (state.view === "tasks") loadTasks();
      toast(isActive ? "任务已取消" : "已删除", "success");
    }).catch(function (error) {
      toast(error.message || "操作失败", "error");
    });
  }

  function loadTasks() {
    return api("/api/jobs?limit=50").then(function (data) {
      var items = data.items || [];
      items.forEach(function (job) { state.jobs.set(job.id, job); });
      var host = $("#tasks-list");
      var empty = $("#tasks-empty");
      if (!host) return;
      host.innerHTML = items.map(function (job) {
        var statusClass = job.status === "error" ? "error" : (job.status === "done" ? "done" : "");
        var statusText = job.status === "queued" ? "排队中" : (job.status === "running" ? "生成中" : (job.status === "done" ? "已完成" : "失败"));
        var thumbs = (job.images || []).slice(0, 4).map(function (image, index) {
          return '<img src="' + esc(image.url) + '" alt="" data-task-open="' + esc(job.id) + '" data-index="' + index + '">';
        }).join("");
        var actions = "";
        if (job.status === "queued" || job.status === "error" || job.status === "done") {
          actions = '<button type="button" class="mini-btn" data-task-delete="' + esc(job.id) + '">' + (job.status === "queued" ? "取消" : "删除") + "</button>";
        }
        return '<article class="task-card" data-job="' + esc(job.id) + '">' +
          '<div class="task-main"><div class="task-top"><span class="status-chip ' + statusClass + '">' +
          (job.status === "running" ? '<span class="pulse-dot"></span>' : "") + statusText + "</span>" +
          '<span class="mono">' + esc(fmtDate(job.created_at)) + "</span></div>" +
          '<p class="task-prompt">' + esc(job.prompt) + "</p>" +
          '<div class="task-meta"><span>' + esc(modeLabel(job.mode)) + "</span><span>" + esc(modelLabel(job.model)) + "</span><span>" + esc(job.size) + "</span><span>" + job.n + " 张</span>" +
          (job.status === "running" ? "<span>已用 " + fmtDuration(elapsedOf(job)) + "</span>" : "") + "</div>" +
          (thumbs ? '<div class="task-thumbs">' + thumbs + "</div>" : "") +
          (job.status === "error" && job.error ? '<p class="task-error">' + esc(job.error.message) + "</p>" : "") +
          "</div><div class=\"task-actions\">" + actions + "</div></article>";
      }).join("");
      if (empty) empty.hidden = items.length > 0;
      if (state.view === "tasks") updateTaskBadge();
    }).catch(function (error) {
      toast(error.message || "读取任务失败", "error");
    });
  }

  function setView(name) {
    if (["create", "tasks", "gallery"].indexOf(name) < 0) name = "create";
    state.view = name;
    $$(".view").forEach(function (view) { view.hidden = view.id !== "view-" + name; });
    $$(".tab").forEach(function (tab) {
      var active = tab.dataset.view === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    if (name === "gallery") loadGallery(true);
    if (name === "tasks") loadTasks();
    if (window.location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setViewFromHash() {
    var name = (window.location.hash || "").replace("#", "");
    setView(["create", "tasks", "gallery"].indexOf(name) >= 0 ? name : "create");
  }

  function checkHealth() {
    api("/api/health").then(function (health) {
      var dot = $("#health-dot");
      var text = $("#health-text");
      if (dot) dot.classList.remove("offline");
      var queue = health.queue || {};
      if (text) text.textContent = "服务在线 · " + (queue.queued || 0) + " 排队 / " + (queue.running || 0) + " 生成";
    }).catch(function () {
      var dot = $("#health-dot");
      var text = $("#health-text");
      if (dot) dot.classList.add("offline");
      if (text) text.textContent = "服务连接中断";
    });
  }

  function bind() {
    $$(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () { setView(tab.dataset.view); });
    });
    $$("[data-view]").forEach(function (node) {
      if (node.classList && node.classList.contains("tab")) return;
      node.addEventListener("click", function (event) { event.preventDefault(); setView(node.dataset.view || "create"); });
    });
    $("#composer").addEventListener("submit", onSubmit);
    $("#prompt").addEventListener("input", function (event) {
      $("#counter").textContent = event.target.value.length + " / " + ((state.config && state.config.maxPrompt) || 4000);
    });
    $$("#prompt-chips .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        $("#prompt").value = chip.dataset.prompt || "";
        $("#counter").textContent = $("#prompt").value.length + " / " + ((state.config && state.config.maxPrompt) || 4000);
        $("#prompt").focus();
      });
    });
    var dropzone = $("#dropzone");
    var fileInput = $("#file-input");
    dropzone.addEventListener("click", function () { fileInput.click(); });
    dropzone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener("change", function () { addFiles(fileInput.files); });
    ["dragenter", "dragover"].forEach(function (name) {
      dropzone.addEventListener(name, function (event) { event.preventDefault(); dropzone.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (name) {
      dropzone.addEventListener(name, function (event) { event.preventDefault(); dropzone.classList.remove("is-over"); });
    });
    dropzone.addEventListener("drop", function (event) { addFiles(event.dataTransfer.files); });
    $("#clear-refs").addEventListener("click", clearRefs);

    $("#active-list").addEventListener("click", function (event) {
      var btn = event.target.closest("[data-cancel]");
      if (!btn) return;
      var job = state.jobs.get(btn.dataset.cancel);
      if (job) deleteJob(job, { message: "取消这个排队中的任务？" });
    });

    $("#gallery").addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (button) {
        event.stopPropagation();
        var job = findJob(button.dataset.download || button.dataset.asref || button.dataset.delete || button.dataset.reuse);
        if (button.dataset.download) {
          var image = job && job.images && job.images[parseInt(button.dataset.index, 10)];
          downloadImage(job, image);
        } else if (button.dataset.asref) {
          var refImage = job && job.images && job.images[parseInt(button.dataset.index, 10)];
          useAsReference(job, refImage);
        } else if (button.dataset.delete) {
          deleteJob(job);
        } else if (button.dataset.reuse) {
          reuseJob(job);
        }
        return;
      }
      var media = event.target.closest("[data-open]");
      if (!media) return;
      var openJob = findJob(media.dataset.open);
      var openImage = openJob && openJob.images && openJob.images[parseInt(media.dataset.index, 10)];
      if (openJob && openImage) openLightbox(openJob, openImage);
    });

    $("#tasks-list").addEventListener("click", function (event) {
      var open = event.target.closest("[data-task-open]");
      if (open) {
        var job = findJob(open.dataset.taskOpen);
        var image = job && job.images && job.images[parseInt(open.dataset.index, 10)];
        if (job && image) openLightbox(job, image);
        return;
      }
      var del = event.target.closest("[data-task-delete]");
      if (del) {
        var target = findJob(del.dataset.taskDelete);
        if (target) deleteJob(target);
      }
    });

    $("#refresh-tasks").addEventListener("click", loadTasks);
    $("#load-more").addEventListener("click", function () { loadGallery(false); });
    $("#lightbox-close").addEventListener("click", closeLightbox);
    $("#lightbox").addEventListener("click", function (event) { if (event.target === $("#lightbox")) closeLightbox(); });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !$("#lightbox").hidden) closeLightbox();
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { pollActive(); checkHealth(); }
    });
    window.addEventListener("hashchange", setViewFromHash);
    var loginForm = $("#login-form");
    if (loginForm) loginForm.addEventListener("submit", onLogin);
    var userPill = $("#user-pill");
    if (userPill) {
      userPill.addEventListener("click", function () {
        if (TOKEN && window.confirm("退出登录？")) logout();
      });
    }
  }

  function setToken(token) {
    TOKEN = token || "";
    try {
      if (TOKEN) localStorage.setItem(TOKEN_KEY, TOKEN);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (err) { /* private mode */ }
  }

  function clearSession() {
    setToken("");
    state.active.clear();
    state.jobs.clear();
    stopPolling();
    renderActive();
    updateTaskBadge();
  }

  function showLogin() {
    var overlay = $("#login");
    if (!overlay) return;
    overlay.hidden = false;
    document.body.classList.add("login-open");
    var error = $("#login-error");
    if (error) { error.hidden = true; error.textContent = ""; }
    setTimeout(function () {
      var user = $("#login-user");
      if (user) user.focus();
    }, 60);
  }

  function hideLogin() {
    var overlay = $("#login");
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("login-open");
  }

  function loginError(message) {
    var error = $("#login-error");
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  }

  function onLogin(event) {
    event.preventDefault();
    var user = $("#login-user").value.trim();
    var pass = $("#login-pass").value;
    if (!user || !pass) {
      loginError("请输入用户名和密码");
      return;
    }
    var btn = $("#login-form .login-submit");
    if (btn) { btn.disabled = true; btn.textContent = "登录中…"; }
    fetch(API_BASE + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass })
    }).then(function (resp) {
      return resp.text().then(function (text) {
        var data = {};
        try { data = JSON.parse(text); } catch (err) { data = {}; }
        if (!resp.ok) throw new Error((data.error && data.error.message) || ("HTTP " + resp.status));
        return data;
      });
    }).then(function (data) {
      if (!data.token) throw new Error("登录失败");
      setToken(data.token);
      $("#login-pass").value = "";
      hideLogin();
      return startApp();
    }).catch(function (error) {
      loginError(error.message || "登录失败");
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = "登录"; }
    });
  }

  function logout() {
    clearSession();
    showLogin();
  }

  function startApp() {
    hideLogin();
    return Promise.all([api("/api/config"), api("/api/me")]).then(function (results) {
      applyConfig(results[0]);
      renderUser(results[1]);
      return Promise.all([loadActive(), loadGallery(true)]);
    }).then(function () {
      if (state.timersStarted) return;
      state.timersStarted = true;
      checkHealth();
      state.healthTimer = setInterval(checkHealth, 60000);
      setInterval(function () {
        $$(".active-card").forEach(function (card) {
          var job = state.active.get(card.dataset.id);
          var el = $(".elapsed", card);
          if (job && el) el.textContent = job.status === "queued" ? "—" : fmtDuration(elapsedOf(job));
        });
      }, 1000);
    });
  }

  function init() {
    bind();
    setViewFromHash();
    if (!TOKEN) {
      showLogin();
      return;
    }
    startApp().catch(function (error) {
      showLogin();
      toast(error.message || "登录状态已失效，请重新登录", "error");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
