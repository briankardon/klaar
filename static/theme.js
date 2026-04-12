/* Klaar – shared theme toggle */
(function initTheme() {
  const saved = localStorage.getItem("klaar-theme");
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  }
  const btn = document.getElementById("btn-theme-toggle");
  function updateIcon() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
      (!document.documentElement.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    btn.textContent = dark ? "\u2600" : "\u263E";
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }
  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const isDark = current === "dark" ||
      (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("klaar-theme", next);
    updateIcon();
  });
  updateIcon();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateIcon);
})();
