/* Klaar – shared theme toggle
   Pairs with inline <script> in <head> that sets data-theme before first paint. */
(function initTheme() {
  // Ensure data-theme is set (inline head script handles FOUC,
  // but this covers the case if that script is missing)
  if (!document.documentElement.getAttribute("data-theme")) {
    const saved = localStorage.getItem("klaar-theme");
    document.documentElement.setAttribute("data-theme",
      saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }

  const btn = document.getElementById("btn-theme-toggle");
  function updateIcon() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    btn.textContent = dark ? "\u2600" : "\u263E";
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("klaar-theme", next);
    updateIcon();
  });
  updateIcon();

  // Follow system preference changes when user hasn't explicitly chosen
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem("klaar-theme")) {
      document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
    }
    updateIcon();
  });
})();
