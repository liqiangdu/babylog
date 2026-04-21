/** Wrap native `<select>` elements with a styled trigger + listbox UI. */
export function initCustomDropdowns(): void {
  document.querySelectorAll("select").forEach((sel) => {
    if (sel.dataset.customized) return;
    sel.dataset.customized = "1";
    const wrap = document.createElement("div");
    wrap.className = "cd-wrap";
    sel.parentNode!.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add("cd-native-hidden");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cd-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    wrap.appendChild(trigger);

    const list = document.createElement("ul");
    list.className = "cd-list";
    list.setAttribute("role", "listbox");
    wrap.appendChild(list);

    function syncLabel() {
      const opt = sel.options[sel.selectedIndex];
      trigger.textContent = opt ? (opt.textContent ?? "") : "";
    }

    function buildOptions() {
      list.innerHTML = "";
      Array.from(sel.options).forEach((opt, i) => {
        const li = document.createElement("li");
        li.className = "cd-option" + (i === sel.selectedIndex ? " is-selected" : "");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === sel.selectedIndex));
        li.dataset.index = String(i);
        li.innerHTML =
          `<span class="cd-option-label">${opt.textContent}</span>` +
          (i === sel.selectedIndex ? `<svg class="cd-check" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"></path></svg>` : "");
        list.appendChild(li);
      });
    }

    function open() {
      if (wrap.classList.contains("is-open")) return;
      buildOptions();
      wrap.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      const selected = list.querySelector(".is-selected");
      if (selected) selected.scrollIntoView({ block: "nearest" });
    }

    function close() {
      wrap.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.classList.contains("is-open") ? close() : open();
    });

    list.addEventListener("click", (e) => {
      const li = e.target instanceof Element ? e.target.closest(".cd-option") : null;
      if (!li || !(li instanceof HTMLElement)) return;
      const idx = Number(li.dataset.index);
      if (sel.selectedIndex !== idx) {
        sel.selectedIndex = idx;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      syncLabel();
      close();
    });

    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (!wrap.classList.contains("is-open")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const items = list.querySelectorAll(".cd-option");
        let cur = -1;
        items.forEach((li, i) => {
          if (li.classList.contains("is-selected")) cur = i;
        });
        const next = Math.max(0, Math.min(items.length - 1, cur + dir));
        sel.selectedIndex = next;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        syncLabel();
        buildOptions();
        const nextEl = list.querySelectorAll(".cd-option")[next];
        if (nextEl) nextEl.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "Enter") {
        e.preventDefault();
        close();
      }
    });

    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target as Node)) close();
    });

    syncLabel();

    sel.addEventListener("change", syncLabel);
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (desc && desc.set) {
      const origSet = desc.set;
      Object.defineProperty(sel, "value", {
        get: desc.get,
        set(v: string) {
          origSet.call(this, v);
          syncLabel();
        },
        configurable: true,
      });
    }
    const observer = new MutationObserver(() => {
      syncLabel();
    });
    observer.observe(sel, { childList: true, attributes: true, subtree: true });
  });
}
