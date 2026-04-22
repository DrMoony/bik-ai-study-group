// ────────────────────────────────────────────────────────────
// BIK AI Study Group — 사전퀴즈 제출 수신기 (매직링크 인증)
// Google Apps Script Web App
// 배포: 실행 계정 = 나, 액세스 = 모든 사용자
//
// 엔드포인트 (모두 JSONP ?callback= 지원):
//   ?action=magiclink&email=X&userinfo=<JSON> → 매직링크 메일 발송
//   ?action=validatetoken&token=T             → 토큰 검증 + userInfo 반환
//   ?check=email                              → 이메일 제출 여부 조회
//   ?payload=<JSON>                           → 퀴즈 결과 제출 (verified 필요)
// ────────────────────────────────────────────────────────────

const SHEET_ID = '1zvDfCA9sjqZKpWLReT7F8LBPK1neusessEVETLaANKU';
const SHEET_NAME = 'sheet1';  // Google Sheets 탭명과 반드시 일치해야 함
const SITE_URL = 'https://drmoony.github.io/bik-ai-study-group/';

const HEADERS = ['제출일시', '이름', '이메일', '팀', '직무', '점수', '레벨', 'AI활용경험', '배우고싶은것', '한마디', 'UserAgent'];

const TOKEN_TTL_SEC = 1800;        // 매직링크 유효: 30분
const VERIFIED_TTL_SEC = 3600;     // 인증 후 제출 유예: 60분
const MAX_SENDS_PER_HOUR = 3;
const REQUIRE_VERIFIED_ON_SUBMIT = true;

function doGet(e) {
  const cb = e.parameter && e.parameter.callback;
  const action = e.parameter && e.parameter.action;

  if (action === 'magiclink')     return respond(sendMagicLink(e.parameter.email, e.parameter.userinfo), cb);
  if (action === 'validatetoken') return respond(validateToken(e.parameter.token), cb);

  if (e.parameter && e.parameter.check) return respond(checkEmail(e.parameter.check), cb);

  if (e.parameter && e.parameter.payload) {
    try {
      const data = JSON.parse(e.parameter.payload);
      return respond(saveSubmission(data), cb);
    } catch (err) {
      return respond({ status: 'error', message: err.toString() }, cb);
    }
  }

  return respond({ status: 'ok', message: 'BIK AI Study Group Quiz API' }, cb);
}

function doPost(e) {
  try {
    const raw = (e.parameter && e.parameter.payload) ? e.parameter.payload : e.postData.contents;
    const data = JSON.parse(raw);
    return respond(saveSubmission(data), null);
  } catch (err) {
    return respond({ status: 'error', message: err.toString() }, null);
  }
}

// ─── 매직링크 발송 ───
function sendMagicLink(email, userInfoStr) {
  if (!email) return { status: 'error', message: 'email required' };
  const normalized = String(email).trim().toLowerCase();

  // 이미 제출한 이메일이면 차단
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() >= 2) {
    const emails = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat()
      .map(x => String(x).trim().toLowerCase());
    if (emails.includes(normalized)) {
      const scores = sheet.getRange(2, 6, sheet.getLastRow() - 1, 1).getValues().flat();
      const levels = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues().flat();
      const idx = emails.indexOf(normalized);
      return {
        status: 'already_submitted',
        score: scores[idx], level: levels[idx],
        disqualified: levels[idx] === 'DISQUALIFIED'
      };
    }
  }

  const cache = CacheService.getScriptCache();

  // 레이트 리미트
  const rateKey = 'rate_' + normalized;
  const sends = parseInt(cache.get(rateKey) || '0', 10);
  if (sends >= MAX_SENDS_PER_HOUR) {
    return { status: 'rate_limited', message: '1시간 내 ' + MAX_SENDS_PER_HOUR + '회 발송 한도 초과' };
  }

  // 토큰 생성
  const token = Utilities.getUuid(); // 36자 UUID
  const tokenData = {
    email: normalized,
    userInfo: userInfoStr || '{}',
    expires: Date.now() + TOKEN_TTL_SEC * 1000
  };
  cache.put('token_' + token, JSON.stringify(tokenData), TOKEN_TTL_SEC);

  // 메일 발송
  const link = SITE_URL + '?token=' + encodeURIComponent(token);
  try {
    MailApp.sendEmail({
      to: email,
      subject: '[BIK AI Study Group] 사전설문 인증 링크',
      htmlBody: buildLinkEmailHtml(link)
    });
  } catch (err) {
    return { status: 'mail_error', message: err.toString() };
  }

  cache.put(rateKey, String(sends + 1), 3600);
  return { status: 'sent', expiresInSec: TOKEN_TTL_SEC };
}

function buildLinkEmailHtml(link) {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:20px auto;padding:36px;background:#08312A;color:#E8F5EF;border-radius:12px">' +
    '<div style="font-size:11px;color:#00E47C;letter-spacing:2px;margin-bottom:16px">BIK AI STUDY GROUP</div>' +
    '<h2 style="font-size:22px;margin-bottom:12px;color:#E8F5EF">사전설문 인증 링크</h2>' +
    '<p style="color:#9FC0B2;font-size:14px;line-height:1.7;margin-bottom:28px">아래 버튼을 클릭하면 사전설문을 계속 진행할 수 있습니다. 링크는 30분간만 유효합니다.</p>' +
    '<div style="text-align:center;margin-bottom:24px">' +
    '<a href="' + link + '" style="display:inline-block;background:linear-gradient(135deg,#00B362,#00E47C);color:#08312A;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:16px">설문 계속하기 →</a>' +
    '</div>' +
    '<p style="color:#6E9488;font-size:12px;line-height:1.6">버튼이 작동하지 않으면 아래 URL을 직접 복사해 브라우저에 붙여넣으세요:</p>' +
    '<p style="color:#6E9488;font-size:11px;word-break:break-all;font-family:monospace;background:#0E443A;padding:10px;border-radius:6px">' + link + '</p>' +
    '<p style="color:#6E9488;font-size:12px;line-height:1.6;margin-top:20px">요청하지 않으셨다면 이 메일을 무시해주세요. 1회 사용 후 자동 폐기됩니다.</p>' +
    '</div>';
}

// ─── 토큰 검증 ───
function validateToken(token) {
  try {
    if (!token) return { status: 'error', message: 'token required' };
    const cache = CacheService.getScriptCache();
    const raw = cache.get('token_' + token);
    console.log('validateToken called, token prefix:', token.substring(0, 8), 'cache hit:', !!raw);
    if (!raw) return { status: 'not_found' };

    const data = JSON.parse(raw);
    if (Date.now() > data.expires) {
      cache.remove('token_' + token);
      return { status: 'expired' };
    }

    let userInfo;
    try { userInfo = JSON.parse(data.userInfo); }
    catch (e) { userInfo = {}; }

    cache.put('verified_' + data.email, '1', VERIFIED_TTL_SEC);
    cache.remove('token_' + token);

    return { status: 'verified', userInfo: userInfo };
  } catch (err) {
    console.error('validateToken error:', err.toString(), err.stack);
    return { status: 'error', message: err.toString() };
  }
}

function checkEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() < 2) return { status: 'available' };
  const data = sheet.getRange(2, 3, sheet.getLastRow() - 1, 5).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === normalized) {
      return {
        status: 'taken',
        score: data[i][3], level: data[i][4],
        disqualified: data[i][4] === 'DISQUALIFIED'
      };
    }
  }
  return { status: 'available' };
}

function saveSubmission(data) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }

  const normalized = String(data.email).trim().toLowerCase();

  if (REQUIRE_VERIFIED_ON_SUBMIT && !data.disqualified) {
    const cache = CacheService.getScriptCache();
    if (!cache.get('verified_' + normalized)) return { status: 'not_verified' };
  }

  const emails = sheet.getRange(2, 3, Math.max(sheet.getLastRow() - 1, 1), 1)
    .getValues().flat().map(x => String(x).trim().toLowerCase());
  if (emails.includes(normalized)) return { status: 'duplicate' };

  sheet.appendRow([
    new Date(data.submittedAt),
    data.name, data.email, data.team, data.job,
    data.score, data.level,
    data.usecase || '', data.want || '', data.comment || '',
    data.userAgent || ''
  ]);

  return { status: 'ok' };
}

function respond(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
