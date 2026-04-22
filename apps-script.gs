// ────────────────────────────────────────────────────────────
// BIK AI Study Group — 사전퀴즈 제출 수신기
// Google Apps Script Web App
// 배포: 실행 계정 = 나, 액세스 = 모든 사용자
//
// 엔드포인트:
//   1) 이메일 조회 (JSONP 지원):
//      GET ?check=email@example.com&callback=cb
//      → 응답: { status: 'taken', level: 'L2~L3' } or { status: 'available' }
//
//   2) 제출:
//      GET ?payload=<JSON> (기존 방식, fire-and-forget)
//      POST body JSON
//      → 중복 이메일은 자동 거부 (덮어쓰기 없음)
// ────────────────────────────────────────────────────────────

const SHEET_ID = '1zvDfCA9sjqZKpWLReT7F8LBPK1neusessEVETLaANKU';
const SHEET_NAME = '시트1';

const HEADERS = ['제출일시', '이름', '이메일', '팀', '직무', '점수', '레벨', 'AI활용경험', '배우고싶은것', '한마디', 'UserAgent'];

function doGet(e) {
  const cb = e.parameter && e.parameter.callback;

  // 1) CHECK mode: ?check=email
  if (e.parameter && e.parameter.check) {
    return respond(checkEmail(e.parameter.check), cb);
  }

  // 2) SUBMIT mode: ?payload=<JSON>
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
    const raw = (e.parameter && e.parameter.payload)
      ? e.parameter.payload
      : e.postData.contents;
    const data = JSON.parse(raw);
    return respond(saveSubmission(data), null);
  } catch (err) {
    return respond({ status: 'error', message: err.toString() }, null);
  }
}

function checkEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() < 2) return { status: 'available' };

  const data = sheet.getRange(2, 3, sheet.getLastRow() - 1, 5).getValues(); // C:이메일 ~ G:레벨
  for (let i = 0; i < data.length; i++) {
    const rowEmail = String(data[i][0]).trim().toLowerCase();
    if (rowEmail === normalized) {
      const score = data[i][3]; // F 열 = 점수
      const level = data[i][4]; // G 열 = 레벨
      return {
        status: 'taken',
        score: score,
        level: level,
        disqualified: level === 'DISQUALIFIED'
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
  const emails = sheet.getRange(2, 3, Math.max(sheet.getLastRow() - 1, 1), 1)
    .getValues().flat().map(x => String(x).trim().toLowerCase());
  if (emails.includes(normalized)) {
    return { status: 'duplicate' };
  }

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

// JSONP 지원 응답 헬퍼
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
