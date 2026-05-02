const fs = require('fs');

function testAttribute(filename, regex, expected) {
  const content = fs.readFileSync(filename, 'utf-8');
  const match = content.match(regex);
  if (match) {
    console.log(`✅ [${filename}] Found ${expected}`);
  } else {
    console.error(`❌ [${filename}] Missing ${expected}`);
    process.exit(1);
  }
}

console.log('Testing index.html...');
testAttribute('./frontend/index.html', /<button id="hamburger-btn".*?aria-label="Buka menu navigasi".*?>/s, 'hamburger-btn aria-label');
testAttribute('./frontend/index.html', /<div id="notification-container".*?role="button".*?aria-label="Lihat notifikasi".*?>/s, 'notification-container role & aria-label');
testAttribute('./frontend/index.html', /<button id="close-modal-btn".*?aria-label="Tutup modal".*?>/s, 'close-modal-btn aria-label');

console.log('Testing dashboard.html...');
testAttribute('./frontend/dashboard.html', /<button id="menu-toggle-btn".*?aria-label="Tutup\/Buka menu navigasi".*?>/s, 'menu-toggle-btn aria-label');
testAttribute('./frontend/dashboard.html', /<button id="close-edit-modal-btn".*?aria-label="Tutup modal".*?>/s, 'close-edit-modal-btn aria-label');

console.log('Testing admin.html...');
testAttribute('./frontend/admin.html', /<button id="menu-toggle-btn".*?aria-label="Tutup\/Buka menu navigasi".*?>/s, 'menu-toggle-btn aria-label');

console.log('Testing product.html...');
testAttribute('./frontend/product.html', /<button id="close-modal-btn".*?aria-label="Tutup modal".*?>/s, 'close-modal-btn aria-label');
testAttribute('./frontend/product.html', /<button id="close-confirm-modal-btn".*?aria-label="Tutup modal".*?>/s, 'close-confirm-modal-btn aria-label');

console.log('\n🎉 All static analysis tests passed successfully!');
