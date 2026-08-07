// Optional company members: change only these booleans to publish/unpublish a card.
const OPTIONAL_MEMBER_VISIBILITY = {};

document.querySelectorAll("[data-optional-member]").forEach((card) => {
  const visible = OPTIONAL_MEMBER_VISIBILITY[card.dataset.optionalMember];
  card.hidden = !visible;
});

const header = document.querySelector("[data-header]");
const menuButton = document.querySelector("[data-menu-button]");
const mobileNav = document.querySelector("[data-mobile-nav]");
const isEnglish = document.documentElement.lang === "en";
const mobileViewport = window.matchMedia("(max-width: 820px)");

const setMenu = (open) => {
  menuButton?.setAttribute("aria-expanded", String(open));
  menuButton?.setAttribute("aria-label", open
    ? (isEnglish ? "Close menu" : "メニューを閉じる")
    : (isEnglish ? "Open menu" : "メニューを開く"));
  if (mobileNav) {
    mobileNav.inert = !open;
    mobileNav.setAttribute("aria-hidden", String(!open));
  }
  header?.classList.toggle("menu-open", open);
  document.body.classList.toggle("nav-open", open);
  if (open) mobileNav?.querySelector("a")?.focus();
};

setMenu(false);

const handleViewportChange = (event) => {
  if (!event.matches) setMenu(false);
};

if (typeof mobileViewport.addEventListener === "function") {
  mobileViewport.addEventListener("change", handleViewportChange);
} else {
  mobileViewport.addListener(handleViewportChange);
}

menuButton?.addEventListener("click", () => {
  setMenu(menuButton.getAttribute("aria-expanded") !== "true");
});

mobileNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuButton?.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    menuButton.focus();
  }
});

const updateHeader = () => {
  header?.classList.toggle("is-scrolled", window.scrollY > 24);
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const revealElements = [...document.querySelectorAll(".reveal")];
const showReveal = (element) => element.classList.add("is-visible");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        showReveal(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px" });

  revealElements.forEach((element) => observer.observe(element));

  // Reveal sections skipped by large scroll jumps, keyboard navigation or scrollbar dragging.
  const revealPassedSections = () => {
    const reachedPageEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    revealElements.forEach((element) => {
      if (!element.classList.contains("is-visible") && (reachedPageEnd || element.getBoundingClientRect().top < window.innerHeight - 20)) {
        showReveal(element);
        observer.unobserve(element);
      }
    });
  };

  revealPassedSections();
  window.addEventListener("scroll", revealPassedSections, { passive: true });
} else {
  revealElements.forEach(showReveal);
}
