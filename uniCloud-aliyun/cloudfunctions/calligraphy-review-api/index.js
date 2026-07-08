'use strict';

const https = require('https');

const styleLabels = {
  kaishu: '楷书',
  xingshu: '行书',
  lishu: '隶书',
  zhuanshu: '篆书',
  caoshu: '草书',
  hard_pen: '硬笔书法'
};

exports.main = async function (event) {
  const method = String(event.httpMethod || event.method || 'GET').toUpperCase();
  const path = String(event.path || event.url || '');
  const respond = (data, statusCode) => jsonResponse(data, statusCode, event);

  if (method === 'OPTIONS') {
    return respond({}, 204);
  }

  if (method === 'GET' && path.endsWith('/api/status')) {
    return respond({
      success: true,
      data: getModelStatus()
    });
  }

  if (method === 'POST' && path.endsWith('/api/calligraphy-review')) {
    try {
      const body = parseJsonBody(event);
      const styleLabel = styleLabels[body.style];

      if (!body.imageBase64 || !body.mimeType) {
        return respond({
          success: false,
          error_code: 'IMAGE_REQUIRED',
          message: '请先上传一张书法作业图片'
        }, 400);
      }

      if (!styleLabel) {
        return respond({
          success: false,
          error_code: 'STYLE_REQUIRED',
          message: '请选择正在学习的书法类型'
        }, 400);
      }

      if (!hasGeminiApiKey()) {
        return respond({
          success: false,
          error_code: 'GEMINI_API_KEY_MISSING',
          message: '云函数环境变量 GEMINI_API_KEY 未配置'
        }, 500);
      }

      const analysis = await requestGeminiReview({
        imageBase64: body.imageBase64,
        mimeType: body.mimeType,
        styleLabel
      });
      const review = normalizeReview(analysis.review, styleLabel);
      const reviewId = `demo_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Math.random().toString(16).slice(2, 10)}`;

      return respond({
        success: true,
        data: {
          review_id: reviewId,
          analysis_source: analysis.source,
          analysis_model: analysis.model,
          original_image_url: '',
          annotated_image_url: `data:${body.mimeType};base64,${body.imageBase64}`,
          ...review
        }
      });
    } catch (error) {
      console.error(error);
      return respond({
        success: false,
        error_code: 'AI_REVIEW_FAILED',
        message: `AI 点评暂时失败：${getPublicErrorMessage(error)}`
      }, 500);
    }
  }

  return respond({
    success: false,
    error_code: 'NOT_FOUND',
    message: '接口不存在'
  }, 404);
};

function parseJsonBody(event) {
  if (event.body && typeof event.body === 'object') return event.body;

  const rawBody = event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String(event.body || '{}');

  return JSON.parse(rawBody || '{}');
}

function jsonResponse(data, statusCode = 200, event = {}) {
  return {
    mpserverlessComposedResponse: true,
    isBase64Encoded: false,
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(data)
  };
}

function corsHeaders(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '*';
  const responseHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin'
  };
  if (origin !== '*') {
    responseHeaders['Access-Control-Allow-Credentials'] = 'true';
  }
  return responseHeaders;
}

function getModelStatus() {
  const model = getGeminiModels()[0];
  return {
    provider: hasGeminiApiKey() ? 'gemini' : 'mock',
    model: hasGeminiApiKey() ? model : 'local-mock',
    fallback_models: hasGeminiApiKey() ? getGeminiModels().slice(1) : [],
    gemini_configured: hasGeminiApiKey(),
    gemini_api_base_url: getGeminiApiBaseUrl(),
    using_default_gemini_api: getGeminiApiBaseUrl() === defaultGeminiApiBaseUrl
  };
}

function hasGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim();
  return Boolean(key) && !/^(your_|你的|replace_me|test)/i.test(key);
}

function getGeminiModels() {
  const configured = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-3.5-flash')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  return [...new Set([configured, ...fallbacks])];
}

async function requestGeminiReview({ imageBase64, mimeType, styleLabel }) {
  const requestBody = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          { text: buildPrompt(styleLabel) },
          { inlineData: { mimeType, data: imageBase64 } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.25,
      responseMimeType: 'application/json',
      responseSchema: reviewSchema()
    }
  });

  const errors = [];
  for (const model of getGeminiModels()) {
    try {
      const url = `${getGeminiApiBaseUrl()}/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY.trim())}`;
      const response = await requestJson(url, requestBody);
      const payload = response.payload;

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error((payload.error && payload.error.message) || response.statusText);
      }

      const text = (((payload.candidates || [])[0] || {}).content || {}).parts
        ?.map((part) => part.text || '')
        .join('')
        .trim();

      if (!text) throw new Error('EMPTY_GEMINI_RESPONSE');

      return {
        source: 'gemini',
        model,
        review: JSON.parse(stripJsonFence(text))
      };
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
      if (!isRetryableGeminiError(error)) break;
    }
  }

  throw new Error(`GEMINI_REQUEST_FAILED: ${errors.join(' | ')}`);
}

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (error) {
          reject(new Error(`INVALID_JSON_RESPONSE: ${text.slice(0, 120)}`));
          return;
        }
        resolve({
          statusCode: res.statusCode || 0,
          statusText: res.statusMessage || '',
          payload
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(getRequestTimeoutMs(), () => {
      req.destroy(new Error('GEMINI_REQUEST_TIMEOUT'));
    });
    req.write(body);
    req.end();
  });
}

const defaultGeminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';

function getGeminiApiBaseUrl() {
  return String(process.env.GEMINI_API_BASE_URL || defaultGeminiApiBaseUrl).trim().replace(/\/+$/, '');
}

function getRequestTimeoutMs() {
  const timeout = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 55000);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 55000;
}

function isRetryableGeminiError(error) {
  const message = String(error.message || '').toLowerCase();
  return ['high demand', 'temporarily unavailable', 'unavailable', 'overloaded', 'quota', 'rate limit', '429', '503', '504', 'fetch failed', 'network', 'etimedout', 'econnreset', 'enotfound', 'gemini_request_timeout']
    .some((keyword) => message.includes(keyword));
}

function stripJsonFence(text) {
  return String(text).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function buildPrompt(styleLabel) {
  return `你是一名专业的书法作业 AI 点评老师，主要服务 50 岁以上的中老年书法学习用户。用户会上传一张自己的书法作业图片，并选择自己正在学习的书法类型。请你根据图片内容和用户选择的书法类型，对作业进行点评，并返回结构化 JSON。

用户选择的书法类型是：${styleLabel}

请完成：识别主要文字；判断整体书写情况；从笔画、结构、章法、墨色、书体特征点评；找出 3-6 个最值得标注的点评点；每个点评点定位到具体区域；bbox 使用 0-1 归一化坐标；语言温和、鼓励、具体，适合中老年用户理解；如果图片模糊或遮挡，也给出可识别范围内点评并提示重新上传更清晰图片；不要编造无法判断的内容。

标注类型：praise 写得好的地方；issue 存在问题；suggestion 重点修改建议；warning 图片质量或识别风险。

请严格输出 JSON，不要输出 JSON 以外的内容。`;
}

function reviewSchema() {
  return {
    type: 'OBJECT',
    properties: {
      image_quality: {
        type: 'OBJECT',
        properties: {
          is_clear: { type: 'BOOLEAN' },
          quality_level: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          issues: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['is_clear', 'quality_level', 'issues']
      },
      calligraphy_info: {
        type: 'OBJECT',
        properties: {
          selected_style: { type: 'STRING' },
          recognized_text: { type: 'STRING' },
          estimated_level: { type: 'STRING' },
          overall_score: { type: 'NUMBER' }
        },
        required: ['selected_style', 'recognized_text', 'estimated_level', 'overall_score']
      },
      overall_comment: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING' },
          strengths: { type: 'ARRAY', items: { type: 'STRING' } },
          main_problems: { type: 'ARRAY', items: { type: 'STRING' } },
          next_focus: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['summary', 'strengths', 'main_problems', 'next_focus']
      },
      annotations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            type: { type: 'STRING', enum: ['praise', 'issue', 'suggestion', 'warning'] },
            target_text: { type: 'STRING' },
            bbox: {
              type: 'OBJECT',
              properties: {
                x: { type: 'NUMBER' },
                y: { type: 'NUMBER' },
                width: { type: 'NUMBER' },
                height: { type: 'NUMBER' }
              },
              required: ['x', 'y', 'width', 'height']
            },
            title: { type: 'STRING' },
            comment: { type: 'STRING' },
            suggestion: { type: 'STRING' },
            severity: { type: 'STRING', enum: ['low', 'medium', 'high'] },
            display_style: { type: 'STRING' }
          },
          required: ['id', 'type', 'target_text', 'bbox', 'title', 'comment', 'suggestion', 'severity', 'display_style']
        }
      },
      practice_advice: {
        type: 'OBJECT',
        properties: {
          today_focus: { type: 'STRING' },
          practice_method: { type: 'STRING' },
          estimated_practice_time: { type: 'STRING' }
        },
        required: ['today_focus', 'practice_method', 'estimated_practice_time']
      },
      user_friendly_feedback: { type: 'STRING' }
    },
    required: ['image_quality', 'calligraphy_info', 'overall_comment', 'annotations', 'practice_advice', 'user_friendly_feedback']
  };
}

function normalizeReview(review, styleLabel) {
  const annotations = Array.isArray(review.annotations) ? review.annotations : [];
  return {
    image_quality: {
      is_clear: Boolean(review.image_quality?.is_clear ?? true),
      quality_level: ['high', 'medium', 'low'].includes(review.image_quality?.quality_level) ? review.image_quality.quality_level : 'medium',
      issues: Array.isArray(review.image_quality?.issues) ? review.image_quality.issues : []
    },
    calligraphy_info: {
      selected_style: styleLabel,
      recognized_text: String(review.calligraphy_info?.recognized_text || '根据图片大致判断'),
      estimated_level: String(review.calligraphy_info?.estimated_level || '入门'),
      overall_score: clampNumber(review.calligraphy_info?.overall_score, 0, 100, 75)
    },
    overall_comment: {
      summary: String(review.overall_comment?.summary || '整体书写比较认真，字形和排布已有基础，后续可继续加强结构稳定性。'),
      strengths: normalizeStringList(review.overall_comment?.strengths, ['态度认真，整体排布较整齐']),
      main_problems: normalizeStringList(review.overall_comment?.main_problems, ['个别字的重心和笔画间距还可以更稳定']),
      next_focus: normalizeStringList(review.overall_comment?.next_focus, ['练习重心', '练习横画间距'])
    },
    annotations: annotations.slice(0, 6).map((item, index) => normalizeAnnotation(item, index)),
    practice_advice: {
      today_focus: String(review.practice_advice?.today_focus || '今天建议重点练习字的重心和横画间距。'),
      practice_method: String(review.practice_advice?.practice_method || '选择 3 个常用字，先观察中轴线，再每个字连续练习 5 遍。'),
      estimated_practice_time: String(review.practice_advice?.estimated_practice_time || '15 分钟')
    },
    user_friendly_feedback: String(review.user_friendly_feedback || '这次作业完成得很认真，接下来把重心写稳，进步会更明显。')
  };
}

function normalizeAnnotation(item, index) {
  const type = ['praise', 'issue', 'suggestion', 'warning'].includes(item?.type) ? item.type : 'issue';
  const bbox = item?.bbox || {};
  return {
    id: item?.id || `A${String(index + 1).padStart(3, '0')}`,
    type,
    target_text: String(item?.target_text || '局部'),
    bbox: {
      x: clampNumber(bbox.x, 0, 0.98, 0.1),
      y: clampNumber(bbox.y, 0, 0.98, 0.1),
      width: clampNumber(bbox.width, 0.04, 1, 0.2),
      height: clampNumber(bbox.height, 0.04, 1, 0.16)
    },
    title: String(item?.title || '结构可再调整'),
    comment: String(item?.comment || '这个位置可以继续观察笔画之间的关系。'),
    suggestion: String(item?.suggestion || '下次书写前先慢慢观察位置，再落笔练习。'),
    severity: ['low', 'medium', 'high'].includes(item?.severity) ? item.severity : 'medium',
    display_style: item?.display_style || 'box'
  };
}

function normalizeStringList(value, fallback) {
  return Array.isArray(value) && value.length > 0 ? value.map(String).slice(0, 4) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function getPublicErrorMessage(error) {
  const message = String(error.message || '');
  if (message.includes('API key not valid')) return 'Gemini API Key 无效，请检查 GEMINI_API_KEY';
  if (message.includes('models/') && message.includes('not found')) return '当前 GEMINI_MODEL 不可用，请换成账号可用的 Gemini 模型';
  if (message.includes('ETIMEDOUT') || message.includes('GEMINI_REQUEST_TIMEOUT')) return '云函数连接 Gemini 超时。阿里云 uniCloud 默认环境可能无法直连 Google，请配置 GEMINI_API_BASE_URL 为可访问的 Gemini 代理地址，或把后端部署到可访问 Google 的服务器';
  if (message.includes('fetch failed')) return '无法连接 Gemini API，请检查云函数网络或 GEMINI_API_BASE_URL 代理配置';
  if (message.includes('EMPTY_GEMINI_RESPONSE')) return 'Gemini 没有返回可解析内容，请换一张更清晰的图片再试';
  if (message.includes('GEMINI_REQUEST_FAILED')) return message.replace('GEMINI_REQUEST_FAILED: ', '');
  return '请稍后重试，或换一张更清晰的图片';
}
