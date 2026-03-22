const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);

app.use(express.json());

// HTML 파일은 캐시 금지, 나머지 정적 파일은 1시간 캐시
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// 배포 버전 확인용 (Railway 배포 여부 즉시 확인 가능)
app.get('/version', (req, res) => res.json({ version: 'v3.0', time: new Date().toISOString() }));

// ==================== 설정 ====================
const TIME_LIMIT_MS = 30000;  // 문제당 30초
const MAX_SCORE     = 100;    // 최고 점수 (즉시 정답)
const MIN_SCORE     = 5;      // 최저 점수 (30초 직전 정답)

// ==================== 데이터 ====================
let questions = [];
try {
  questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  console.log(`✅ 문제 ${questions.length}개 로드 완료`);
} catch (e) {
  console.error('⚠️  questions.json을 찾을 수 없습니다.');
  questions = [
    {
      id: 1,
      question: "노아가 방주를 만들 때 쓴 나무 이름은?",
      answer: "고페르",
      altAnswers: ["고페르나무"],
      explanation: "창6:14 고페르 나무로 방주를 만들었습니다"
    }
  ];
}

// 가정 데이터 (메모리)
const families = new Map();

// SSE 클라이언트
const sseClients = new Set();

// ==================== 유틸 ====================
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// 답안 정규화: 소문자, 공백제거, 특수문자 제거
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[.,!?~·]/g, '');
}

// 정답 체크 (다중 정답 지원)
function checkAnswer(userInput, question) {
  const norm = normalize(userInput);
  if (!norm) return false;
  if (norm === normalize(question.answer)) return true;
  if (question.altAnswers && Array.isArray(question.altAnswers)) {
    return question.altAnswers.some(a => normalize(a) === norm);
  }
  return false;
}

// 시간 기반 점수 계산 (밀리초 단위)
function calcScore(elapsedMs) {
  if (elapsedMs >= TIME_LIMIT_MS) return MIN_SCORE; // 30초 넘겨도 맞히면 최소 점수
  const ratio = 1 - (elapsedMs / TIME_LIMIT_MS);    // 1.0 (즉시) ~ 0.0 (30초)
  return Math.max(MIN_SCORE, Math.round(ratio * (MAX_SCORE - MIN_SCORE) + MIN_SCORE));
  // 즉시 = 100점, 30초 = 5점
}

// 리더보드 (동점 없음: 밀리초 단위 소수점 총 획득시간으로 2차 정렬)
function getLeaderboard() {
  return Array.from(families.values())
    .filter(f => f.currentQuestion > 0 || f.completed)
    .map(f => ({
      name: f.name,
      score: f.score,
      completed: f.completed,
      progress: f.currentQuestion,
      total: questions.length,
      totalTime: f.totalElapsedMs,       // 총 소요시간 (동점 시 빠른 팀이 상위)
      finishedAt: f.finishedAt || null
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.totalTime - b.totalTime;  // 동점이면 총 소요시간 짧은 팀 우선
    });
}

function broadcastLeaderboard() {
  const msg = `data: ${JSON.stringify({ type: 'leaderboard', data: getLeaderboard() })}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch(e){} });
}

// ==================== API ====================

// SSE 실시간 연결
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'leaderboard', data: getLeaderboard() })}\n\n`);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch(e){} }, 20000);
  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

// 가정 등록
app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '가정 이름을 입력해주세요' });

  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  families.set(id, {
    id, name: name.trim(),
    score: 0,
    currentQuestion: 0,
    answers: {},              // { questionIndex: { answer, correct, score, elapsedMs } }
    completed: false,
    registeredAt: Date.now(),
    finishedAt: null,
    questionStartTimes: {},   // { questionIndex: timestamp }
    totalElapsedMs: 0         // 총 답변 소요시간 합계 (동점 해결용)
  });

  console.log(`👫 등록: ${name.trim()} (총 ${families.size}가정)`);
  res.json({ id, totalQuestions: questions.length, timeLimitMs: TIME_LIMIT_MS });
  broadcastLeaderboard();
});

// 문제 가져오기 (문제 시작 시간 기록)
app.get('/api/question/:familyId/:index', (req, res) => {
  const family = families.get(req.params.familyId);
  if (!family) return res.status(404).json({ error: '등록된 가정이 아닙니다' });

  const idx = parseInt(req.params.index);
  if (idx >= questions.length) return res.json({ done: true, score: family.score });

  // 이 문제의 시작 시간 기록 (처음 요청할 때만)
  if (!family.questionStartTimes[idx]) {
    family.questionStartTimes[idx] = Date.now();
  }

  const q = questions[idx];
  res.json({
    id: q.id,
    question: q.question,
    hint: q.hint || null,       // 힌트 (선택)
    index: idx,
    total: questions.length,
    timeLimitMs: TIME_LIMIT_MS,
    startTime: family.questionStartTimes[idx]  // 클라이언트 타이머 동기화용
  });
});

// 답 제출
app.post('/api/answer', (req, res) => {
  const { familyId, questionIndex, answer } = req.body;
  const family = families.get(familyId);
  if (!family) return res.status(404).json({ error: '등록된 가정이 아닙니다' });

  const idx = parseInt(questionIndex);
  if (idx >= questions.length) return res.status(400).json({ error: '잘못된 문제 번호' });

  const q = questions[idx];

  // 이미 답한 문제인지 체크
  if (family.answers[idx] !== undefined) {
    return res.json({
      correct: family.answers[idx].correct,
      correctAnswer: q.answer,
      explanation: q.explanation || '',
      scoreEarned: family.answers[idx].score,
      totalScore: family.score,
      nextIndex: family.currentQuestion,
      elapsedMs: family.answers[idx].elapsedMs
    });
  }

  // 경과 시간 계산
  const startTime = family.questionStartTimes[idx] || Date.now();
  const elapsedMs = Date.now() - startTime;

  // 정답 여부
  const correct = checkAnswer(answer, q);

  // 점수 계산
  const scoreEarned = correct ? calcScore(elapsedMs) : 0;

  if (correct) {
    family.score += scoreEarned;
    family.totalElapsedMs += elapsedMs;
  }

  family.currentQuestion = idx + 1;
  family.answers[idx] = { answer, correct, score: scoreEarned, elapsedMs };

  if (family.currentQuestion >= questions.length) {
    family.completed = true;
    family.finishedAt = Date.now();
    console.log(`🏁 완료: ${family.name} - ${family.score}점`);
  }

  broadcastLeaderboard();

  res.json({
    correct,
    correctAnswer: q.answer,
    explanation: q.explanation || '',
    scoreEarned,
    totalScore: family.score,
    elapsedMs,
    nextIndex: family.currentQuestion
  });
});

// 리더보드
app.get('/api/leaderboard', (req, res) => res.json(getLeaderboard()));

// 어드민 통계
app.get('/api/admin/stats', (req, res) => {
  const all = Array.from(families.values());
  res.json({
    totalFamilies: all.length,
    completedFamilies: all.filter(f => f.completed).length,
    inProgressFamilies: all.filter(f => !f.completed && f.currentQuestion > 0).length,
    totalQuestions: questions.length,
    timeLimitMs: TIME_LIMIT_MS,
    leaderboard: getLeaderboard()
  });
});

// 어드민 초기화
app.post('/api/admin/reset', (req, res) => {
  const { password } = req.body;
  if (password !== 'oryun2024') return res.status(403).json({ error: '비밀번호가 틀렸습니다' });
  families.clear();
  broadcastLeaderboard();
  console.log('🔄 초기화 완료');
  res.json({ success: true });
});

// ==================== 서버 시작 ====================
const PORT = process.env.PORT || 3000;
const IS_CLOUD = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME;

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(50));
  console.log('🙏  오륜교회 성경 넌센스 퀴즈 서버 시작!');
  console.log('='.repeat(50));

  if (IS_CLOUD) {
    console.log('☁️  클라우드 서버로 실행 중');
    console.log(`📋 총 문제 수: ${questions.length}개`);
    console.log(`⏱️  제한 시간: ${TIME_LIMIT_MS/1000}초`);
    console.log('='.repeat(50));
  } else {
    const localIP = getLocalIP();
    console.log(`📱 QR코드에 입력할 주소:`);
    console.log(`   → http://${localIP}:${PORT}`);
    console.log(`🖥️  어드민 페이지:`);
    console.log(`   → http://${localIP}:${PORT}/admin.html`);
    console.log(`📋 총 문제: ${questions.length}개 | ⏱️ 제한: ${TIME_LIMIT_MS/1000}초`);
    console.log('='.repeat(50));
    console.log('서버 종료: Ctrl+C\n');
  }
});
