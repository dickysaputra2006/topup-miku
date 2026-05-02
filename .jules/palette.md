
## 2026-05-02 - Accessibility Attributes on Pure HTML Elements
**Learning:** When working in a purely static vanilla HTML/JS application, standard screen reader interactables (like icon-only divs triggering modals or dropdowns) need explicit 'role="button"' additions alongside 'aria-label', as they lack native semantic properties found in framework components.
**Action:** Always verify if an interactive element is natively semantic (like <button>) before just adding 'aria-label'. If it's a <div> or <span> acting as a button, ensure both 'role="button"' and 'aria-label' are applied.
