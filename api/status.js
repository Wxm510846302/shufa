import { getModelStatus } from '../lib/review.js';

export default function handler(_req, res) {
  setCorsHeaders(res);
  res.status(200).json({
    success: true,
    data: getModelStatus()
  });
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
