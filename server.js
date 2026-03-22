const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 데이터 ====================
let questions = [];
try {
  questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  console.log(`✅ 문제 ${questions.length}개 로드 완료`);
} catch (e) {
  console.error('⚠️  questions.json 파일을 찾을 수 없습니다. 샘플 문제로 시작합니다.');
  questions = [
    { id: 1, question: "노아 방주에서 가장 먼저 내린 동물은?", options: ["비둘기", "까마귀", "노아", "노새"], answer: 1, explanation: "창8:7 노아가 까마귀를 먼저 내보냈습니다" },
    { id: 2, question: "삼손의 힘의 비결은?", options: ["기도", "머리카락", "근육", "칼"], answer: 1, explanation: "사사기 16장 - 삼손의 힘은 머리카락에 있었습니다" }
  ];
}

// 가정 데이터 (메모리 저장)
const families = new Map();

// SSE 클라이언트
const sseClients = new Set();

// ==================== 유틸 ====================
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function getLeaderboard() {
  return Array.from(families.values())
    .filter(f => f.currentQuestion > 0 || f.completed)
    .map(f => ({
      name: f.name,
      score: f.score,
      completed: f.completed,
      progress: f.currentQuestion,
      total: questions.length,
      finishedAt: f.finishedAt || null
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // 동점이면 먼저 끝낸 사람 우선
      if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
      if (a.finishedAt) return -1;
      if (b.finishedAt) return 1;
      return 0;
    });
}

function broadcastLeaderboard() {
  const data = JSON.stringify({ type: 'leaderboard', data: getLeaderboard() });
  const msg = `data: ${data}\n\n`;
  sseClients.forEach(client => {
    try { client.write(msg); } catch (e) {}
  });
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

  // 최초 연결 시 현재 순위 전송
  const data = JSON.stringify({ type: 'leaderboard', data: getLeaderboard() });
  res.write(`data: ${data}\n\n`);

  // Heartbeat (연결 유지)
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) {}
  }, 20000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// 가정 등록
app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '가정 이름을 입력해주세요' });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  families.set(id, {
    id,
    name: name.trim(),
    score: 0,
    currentQuestion: 0,
    answers: [],
    completed: false,
    registeredAt: Date.now(),
    finishedAt: null
  });

  console.log(`👨‍👩‍ 등록: ${name.trim()} (총 ${families.size}가정)`);

  res.json({ id, totalQuestions: questions.length });
  broadcastLeaderboard();
});

// 문제 가져오기 (답 제외)
app.get('/api/question/:familyId/:index', (req, res) => {
  const family = families.get(req.params.familyId);
  if (!family) return res.status(404).json({ error: '등록된 가정이 아닙니다' });

  const idx = parseInt(req.params.index);

  if (idx >= questions.length) {
    return res.json({ done: true, score: family.score });
  }

  const q = questions[idx];
  res.json({
    id: q.id,
    question: q.question,
    options: q.options,
    index: idx,
    total: questions.length
  });
});

// 답 제출
app.post('/api/answer', (req, res) => {
  const { familyId, questionIndex, answer } = req.body;
  const family = families.get(familyId);
  if (!family) return res.status(404).json({ error: '등록된 가정이 아닙니다' });

  const idx = parseInt(questionIndex);
  if (idx >= questions.length) {
    return res.status(400).json({ error: '잘못된 문제 번호입니다' });
  }

  // 이미 답한 문제인지 체크
  if (family.answers[idx] !== undefined) {
    const q = questions[idx];
    return res.json({
      correct: family.answers[idx] === q.answer,
      correctAnswer: q.answer,
      explanation: q.explanation || '',
      score: family.score,
      nextIndex: family.currentQuestion
    });
  }

  const q = questions[idx];
  const correct = parseInt(answer) === q.answer;

  if (correct) family.score += 10;
  family.currentQuestion = idx + 1;
  family.answers[idx] = parseInt(answer);

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
    score: family.score,
    nextIndex: family.currentQuestion
  });
});

// 리더보드 조회
app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// 어드민: 통계
app.get('/api/admin/stats', (req, res) => {
  const all = Array.from(families.values());
  res.json({
    totalFamilies: all.length,
    completedFamilies: all.filter(f => f.completed).length,
    inProgressFamilies: all.filter(f => !f.completed && f.currentQuestion > 0).length,
    totalQuestions: questions.length,
    leaderboard: getLeaderboard()
  });
});

// 어드민: 초기화 (비밀번호 보호)
app.post('/api/admin/reset', (req, res) => {
  const { password } = req.body;
  if (password !== 'oryun2024') {
    return res.status(403).json({ error: '비밀번호가 틀렸습니다' });
  }
  families.clear();
  broadcastLeaderboard();
  console.log('🔄 점수 초기화 완료');
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
    console.log('='.repeat(50));
  } else {
    const localIP = getLocalIP();
    console.log(`📱 QR코드에 입력할 주소:`);
    console.log(`   → http://${localIP}:${PORT}`);
    console.log('');
    console.log(`🖥️  어드민 페이지 (강사용):`);
    console.log(`   → http://${localIP}:${PORT}/admin.html`);
    console.log('');
    console.log(`📋 총 문제 수: ${questions.length}개`);
    console.log('='.repeat(50));
    console.log('서버를 종료하려면 Ctrl+C 를 누르세요\n');
  }
});
