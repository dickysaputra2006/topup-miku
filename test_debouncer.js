const fs = require('fs');
const content = fs.readFileSync('frontend/script.js', 'utf8');
if (content.includes('debounce(') && content.includes('searchInput.addEventListener')) {
    console.log("SUCCESS: Debouncer implemented");
} else {
    console.error("FAIL: Debouncer missing");
}
