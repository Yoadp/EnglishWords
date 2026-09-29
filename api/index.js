// Vercel serverless function: every /api/* request is rewritten here by vercel.json (see backend.js).
const { handleApi } = require("../backend");

module.exports = (req, res) => handleApi(req, res);
