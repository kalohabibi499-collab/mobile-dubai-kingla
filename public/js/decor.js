/* ──────────────────────────────────────────────────────────────────────────
   Decorate overlay module (extracted from mode1.html).

   Self-contained image / text / video sticker layer rendered into #decorLayer.
   Exposes its API on window.App.decor and keeps the legacy window.decor*
   aliases that existing callers use. No dependencies on other app code.
   ────────────────────────────────────────────────────────────────────────── */
(function initDecorModule() {
  window.App = window.App || { modules: {} };

  (function initDecorLayer() {
    const decorLayer = document.getElementById("decorLayer");
    if (!decorLayer) return;

    const decorItems = {};

    function makeDecorEl(item) {
      const wrapper = document.createElement("div");
      wrapper.className = "decor-item";
      wrapper.dataset.decorId = item.id;
      // Restore saved position or place randomly
      wrapper.style.left = item.savedLeft || ((10 + Math.random() * 40) + "%");
      wrapper.style.top  = item.savedTop  || ((10 + Math.random() * 40) + "%");

      if (item.type === "text") {
        const span = document.createElement("span");
        span.className = "decor-text";
        span.textContent = item.text || "";
        span.style.color    = item.color || "#fff";
        span.style.fontSize = item.savedFontSize || ((Number(item.size) || 32) + "px");
        span.style.fontFamily = '"TikTok Sans", "Segoe UI", Arial, sans-serif';
        span.style.fontWeight = "700";
        wrapper.appendChild(span);
        wrapper.style.width  = "auto";
        wrapper.style.height = "auto";
      } else if (item.type === "video") {
        const video = document.createElement("video");
        video.src   = item.url;
        video.autoplay = true;
        video.loop     = true;
        video.muted    = true;
        video.playsInline = true;
        video.style.width  = item.savedWidth  || "200px";
        video.style.height = item.savedHeight || "auto";
        video.style.display = "block";
        wrapper.appendChild(video);
        wrapper.style.width  = item.savedWidth  || "200px";
        wrapper.style.height = item.savedHeight || "auto";
      } else {
        const img = document.createElement("img");
        img.src = item.url;
        img.alt = "";
        img.style.width  = item.savedWidth  || "200px";
        img.style.height = item.savedHeight || "auto";
        img.style.display = "block";
        wrapper.appendChild(img);
        wrapper.style.width  = item.savedWidth  || "200px";
        wrapper.style.height = item.savedHeight || "auto";
      }

      // Remove button (top-right ×)
      const removeBtn = document.createElement("button");
      removeBtn.className = "decor-remove-btn";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        decorRemoveItem(item.id);
      });
      wrapper.appendChild(removeBtn);

      // Resize handle (bottom-right ↘)
      const resizeHandle = document.createElement("div");
      resizeHandle.className = "decor-resize-handle";
      wrapper.appendChild(resizeHandle);

      // Drag logic (pointer events on wrapper)
      let dragActive = false;
      let dragOX = 0, dragOY = 0;
      wrapper.addEventListener("pointerdown", (e) => {
        if (!decorLayer.classList.contains("edit-mode")) return;
        if (e.target === removeBtn || e.target === resizeHandle) return;
        dragActive = true;
        dragOX = e.clientX - wrapper.getBoundingClientRect().left;
        dragOY = e.clientY - wrapper.getBoundingClientRect().top;
        wrapper.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });
      wrapper.addEventListener("pointermove", (e) => {
        if (!dragActive) return;
        const parent = decorLayer.getBoundingClientRect();
        const x = e.clientX - parent.left - dragOX;
        const y = e.clientY - parent.top  - dragOY;
        wrapper.style.left = x + "px";
        wrapper.style.top  = y + "px";
      });
      wrapper.addEventListener("pointerup", () => { dragActive = false; });

      // Resize logic
      let resizeActive = false;
      let resStartX = 0, resStartY = 0, resStartW = 0, resStartH = 0;
      resizeHandle.addEventListener("pointerdown", (e) => {
        if (!decorLayer.classList.contains("edit-mode")) return;
        resizeActive = true;
        resStartX = e.clientX;
        resStartY = e.clientY;
        const rect = wrapper.getBoundingClientRect();
        resStartW = rect.width;
        resStartH = rect.height;
        resizeHandle.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });
      resizeHandle.addEventListener("pointermove", (e) => {
        if (!resizeActive) return;
        const dx = e.clientX - resStartX;
        const dy = e.clientY - resStartY;
        // Scale proportionally using dx (simpler UX)
        const scale = Math.max(0.1, (resStartW + dx) / resStartW);
        const newW = Math.max(40, resStartW + dx);
        const newH = Math.max(20, resStartH + dy);
        // For text just scale font size
        if (item.type === "text") {
          const base = Number(item.size) || 32;
          const textEl = wrapper.querySelector(".decor-text");
          if (textEl) textEl.style.fontSize = Math.max(8, Math.round(base * scale)) + "px";
        } else {
          wrapper.style.width  = newW + "px";
          wrapper.style.height = newH + "px";
          const media = wrapper.querySelector("img, video");
          if (media) {
            media.style.width  = newW + "px";
            media.style.height = newH + "px";
          }
        }
      });
      resizeHandle.addEventListener("pointerup", () => { resizeActive = false; });

      return wrapper;
    }

    window.decorAddItem = function decorAddItem(item) {
      if (!item || !item.id) return;
      if (decorItems[item.id]) return; // already added
      decorItems[item.id] = item;
      const el = makeDecorEl(item);
      decorLayer.appendChild(el);
    };

    window.decorRemoveItem = function decorRemoveItem(id) {
      delete decorItems[id];
      const el = decorLayer.querySelector(`[data-decor-id="${CSS.escape(id)}"]`);
      if (el) el.remove();
    };

    window.decorClearAll = function decorClearAll() {
      Object.keys(decorItems).forEach((k) => delete decorItems[k]);
      decorLayer.innerHTML = "";
    };

    window.decorSetEditMode = function decorSetEditMode(enabled) {
      decorLayer.classList.toggle("edit-mode", !!enabled);
      decorLayer.setAttribute("aria-hidden", enabled ? "false" : "true");
    };

    // Returns a serialisable snapshot of all items including current DOM position & size
    window.decorGetAllState = function decorGetAllState() {
      return Object.values(decorItems).map(function(item) {
        const el = decorLayer.querySelector('[data-decor-id="' + CSS.escape(item.id) + '"]');
        const state = Object.assign({}, item);
        if (el) {
          state.savedLeft   = el.style.left;
          state.savedTop    = el.style.top;
          state.savedWidth  = el.style.width;
          state.savedHeight = el.style.height;
          if (item.type === 'text') {
            const textEl = el.querySelector('.decor-text');
            if (textEl) state.savedFontSize = textEl.style.fontSize;
          }
        }
        return state;
      });
    };
  })();

  // Namespaced handle for the gradually-modularized front-end.
  window.App.decor = {
    addItem:     window.decorAddItem,
    removeItem:  window.decorRemoveItem,
    clearAll:    window.decorClearAll,
    setEditMode: window.decorSetEditMode,
    getAllState: window.decorGetAllState,
  };
})();
