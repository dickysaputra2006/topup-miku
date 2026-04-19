const axios = require('axios');
require('dotenv').config({ path: 'backend/.env' });

// Mock Foxy API base URL
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
// Create a fast-failing mock or we can just mock axios entirely.
