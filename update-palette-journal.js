const fs = require('fs');
const path = require('path');

const julesDir = path.join(process.cwd(), '.jules');
const journalPath = path.join(julesDir, 'palette.md');

if (!fs.existsSync(julesDir)) {
    fs.mkdirSync(julesDir, { recursive: true });
}

const dateStr = new Date().toISOString().split('T')[0];
const entry = `\n## ${dateStr} - Accessibility Attributes on Pure HTML Elements\n**Learning:** When working in a purely static vanilla HTML/JS application, standard screen reader interactables (like icon-only divs triggering modals or dropdowns) need explicit 'role="button"' additions alongside 'aria-label', as they lack native semantic properties found in framework components.\n**Action:** Always verify if an interactive element is natively semantic (like <button>) before just adding 'aria-label'. If it's a <div> or <span> acting as a button, ensure both 'role="button"' and 'aria-label' are applied.\n`;

fs.appendFileSync(journalPath, entry);
console.log('Palette journal updated at', journalPath);
