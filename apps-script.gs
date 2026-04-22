// ────────────────────────────────────────────────────────────
// BIK AI Study Group — 사전퀴즈 제출 수신기 (OTP 인증 포함)
// Google Apps Script Web App
// 배포: 실행 계정 = 나, 액세스 = 모든 사용자
//
// 엔드포인트 (모두 JSONP ?callback= 지원):
//   ?action=sendotp&email=X        → OTP 발송 (중복 선제 체크 포함)
//   ?action=verifyotp&email=X&code=Y → OTP 검증
//   ?check=email                   → 이메일 제출 여부 조회 (읽기 전용)
//   ?payload=<JSON>                → 퀴즈 결과 제출 (OTP 인증 필요)
// ────────────────────────────────────────────────────────────

const SHEET_ID = '1zvDfCA9sjqZKpWLReT7F8LBPK1neusessEVETLaANKU';
const SHEET_NAME = '시트1';

const HEADERS = ['제출일시', '이름', '이메일', '팀', '직무', '점수', '레벨', 'AI활용경험', '배우고싶은것', '한마디', 'UserAgent'];

// OTP 설정
const OTP_TTL_SEC = 600;           // OTP 유효: 10분
const VERIFIED_TTL_SEC = 3600;     // 인증 후 제출 유예: 60분
const OTP_MAX_VERIFY_ATTEMPTS = 5; // OTP 입력 시도 한도
const OTP_MAX_SENDS_PER_HOUR = 3;  // 이메일당 시간당 발송 한도
const REQUIRE_OTP_ON_SUBMIT = true;

function doGet(e) {
  const cb = e.parameter && e.parameter.callback;
  const action = e.parameter && e.parameter.action;

  if (action === 'sendotp') return respond(sendOTP(e.parameter.email), cb);
  if (action === 'verifyotp') return respond(verifyOTP(e.parameter.email, e.parameter.code), cb);

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

// ─── OTP 발송 ───
function sendOTP(email) {
  if (!email) return { status: 'error', message: 'email required' };
  const normalized = String(email).trim().toLowerCase();

  // 중복 체크: 이미 제출한 이메일이면 OTP 발송 안 함
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() >= 2) {
    const emails = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat()
      .map(x => String(x).trim().toLowerCase());
    if (emails.includes(normalized)) {
      const levels = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues().flat();
      const scores = sheet.getRange(2, 6, sheet.getLastRow() - 1, 1).getValues().flat();
      const idx = emails.indexOf(normalized);
      return {
        status: 'already_submitted',
        score: scores[idx],
        level: levels[idx],
        disqualified: levels[idx] === 'DISQUALIFIED'
      };
    }
  }

  const cache = CacheService.getScriptCache();

  // 레이트 리미트
  const rateKey = 'rate_' + normalized;
  const sends = parseInt(cache.get(rateKey) || '0', 10);
  if (sends >= OTP_MAX_SENDS_PER_HOUR) {
    return { status: 'rate_limited', message: '1시간 내 ' + OTP_MAX_SENDS_PER_HOUR + '회 발송 한도 초과' };
  }

  // 6자리 OTP 생성
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const otpData = { code: code, expires: Date.now() + OTP_TTL_SEC * 1000, attempts: 0 };
  cache.put('otp_' + normalized, JSON.stringify(otpData), OTP_TTL_SEC);

  // 이메일 발송
  try {
    MailApp.sendEmail({
      to: email,
      subject: '[BIK AI Study Group] 사전설문 인증번호',
      htmlBody: buildOtpEmailHtml(code)
    });
  } catch (err) {
    return { status: 'mail_error', message: err.toString() };
  }

  // 발송 성공 → 레이트 카운터 증가
  cache.put(rateKey, String(sends + 1), 3600);

  return { status: 'sent', expiresInSec: OTP_TTL_SEC };
}

function buildOtpEmailHtml(code) {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:20px auto;padding:32px;background:#08312A;color:#E8F5EF;border-radius:12px">' +
    '<div style="font-size:11px;color:#00E47C;letter-spacing:2px;margin-bottom:16px">BIK AI STUDY GROUP</div>' +
    '<h2 style="font-size:20px;margin-bottom:8px;color:#E8F5EF">사전설문 인증번호</h2>' +
    '<p style="color:#9FC0B2;font-size:14px;line-height:1.6;margin-bottom:24px">아래 번호를 사이트에 입력해주세요.</p>' +
    '<div style="background:#0E443A;border:1px solid #00E47C;border-radius:10px;padding:24px;text-align:center;margin-bottom:20px">' +
    '<div style="font-size:36px;font-weight:800;color:#4DF09C;letter-spacing:8px;font-family:monospace">' + code + '</div>' +
    '</div>' +
    '<p style="color:#6E9488;font-size:12px;line-height:1.6">이 코드는 10분간 유효하며, 한 번 사용 후 폐기됩니다.<br>요청하지 않았다면 이 메일을 무시해주세요.</p>' +
    '</div>';
}

// ─── OTP 검증 ───
function verifyOTP(email, code) {
  if (!email || !code) return { status: 'error', message: 'email/code required' };
  const normalized = String(email).trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const raw = cache.get('otp_' + normalized);
  if (!raw) return { status: 'not_found' };

  const data = JSON.parse(raw);
  if (Date.now() > data.expires) {
    cache.remove('otp_' + normalized);
    return { status: 'expired' };
  }

  data.attempts = (data.attempts || 0) + 1;
  if (data.attempts > OTP_MAX_VERIFY_ATTEMPTS) {
    cache.remove('otp_' + normalized);
    return { status: 'too_many_attempts' };
  }

  if (String(code).trim() !== data.code) {
    cache.put('otp_' + normalized, JSON.stringify(data), OTP_TTL_SEC);
    return { status: 'mismatch', attemptsLeft: OTP_MAX_VERIFY_ATTEMPTS - data.attempts };
  }

  // 인증 성공 → 제출 유예 마크
  cache.put('verified_' + normalized, '1', VERIFIED_TTL_SEC);
  cache.remove('otp_' + normalized);
  return { status: 'verified' };
}

function checkEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() < 2) return { status: 'available' };
  const data = sheet.getRange(2, 3, sheet.getLastRow() - 1, 5).getValues();
  for (let i = 0; i < data.length; i++) {
    const rowEmail = String(data[i][0]).trim().toLowerCase();
    if (rowEmail === normalized) {
      return {
        status: 'taken',
        score: data[i][3],
        level: data[i][4],
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

  // OTP 인증 확인 (실격 기록은 예외 — 세션 중이라 이미 인증됐음)
  if (REQUIRE_OTP_ON_SUBMIT && !data.disqualified) {
    const cache = CacheService.getScriptCache();
    const verified = cache.get('verified_' + normalized);
    if (!verified) return { status: 'not_verified' };
  }

  // 중복 방지 (덮어쓰기 없음)
  const emails = sheet.getRange(2, 3, Math.max(sheet.getLastRow() - 1, 1), 1)
    .getValues().flat().map(x => String(x).trim().toLowerCase());
  if (emails.includes(normalized)) return { status: 'duplicate' };

  sheet.appendRow([
    new Date(data.submittedAt),
    data.name,
    data.email,
    data.team,
    data.job,
    data.score,
    data.level,
    data.usecase || '',
    data.want || '',
    data.comment || '',
    data.userAgent || ''
  ]);

  return { status: 'ok' };
}

function respond(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
