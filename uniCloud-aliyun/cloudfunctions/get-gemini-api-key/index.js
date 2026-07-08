'use strict';

exports.main = async function () {
  const apiKey = process.env.GEMINI_API_KEY || '';

  if (!apiKey.trim()) {
    return {
      success: false,
      error_code: 'GEMINI_API_KEY_MISSING',
      message: '云函数环境变量 GEMINI_API_KEY 未配置'
    };
  }

  return {
    success: true,
    data: {
      apiKey
    }
  };
};
