const { JSDOM } = require('jsdom');
// Since jsdom is not available, let's write a simple mock
const isPassword = true;
let classList = { 'fa-eye-slash': true };
function toggle(cls, force) {
    if (force) classList[cls] = true;
    else delete classList[cls];
}

toggle('fa-eye', !isPassword);
toggle('fa-eye-slash', isPassword);
console.log(classList); // output for when input becomes text
