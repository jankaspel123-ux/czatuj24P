const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: false
  },
  maxHttpBufferSize: 1e6,
  pingTimeout: 20000,
  pingInterval: 25000
});

const publicPath = path.join(__dirname, './');

app.use(express.static(publicPath));
app.use(express.json({ limit: '100kb' }));

/* ============================================================
   KONFIGURACJA
============================================================ */

const PORT = process.env.PORT || 3000;

const MAX_MESSAGE_LENGTH = 5000;
const MAX_REPORT_DETAILS = 500;

const MAX_PHOTOS_PER_SESSION = 1;
const MAX_PHOTO_SIZE = 8 * 1024 * 1024;


/* ============================================================
   UPLOADY
============================================================ */

const uploadFolder = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadFolder);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();

    const safeExt = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.avif'
    ].includes(ext)
      ? ext
      : '.img';

    const random = crypto.randomBytes(12).toString('hex');

    cb(
      null,
      `${Date.now()}-${random}${safeExt}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_PHOTO_SIZE,
    files: 1
  },

  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/avif'
    ]);

    if (!allowed.has(file.mimetype)) {
      return cb(
        new Error('Dozwolone są tylko pliki graficzne.')
      );
    }

    cb(null, true);
  }
});

/* ============================================================
   SPRAWDZENIE PRAWDZIWEGO TYPU OBRAZU
============================================================ */

function isLikelyImageFile(filePath, mime) {
  try {
    const b = fs.readFileSync(filePath);

    if (mime === 'image/jpeg') {
      return (
        b.length >= 3 &&
        b[0] === 0xff &&
        b[1] === 0xd8 &&
        b[2] === 0xff
      );
    }

    if (mime === 'image/png') {
      return (
        b.length >= 8 &&
        b.slice(0, 8).toString('hex') ===
          '89504e470d0a1a0a'
      );
    }

    if (mime === 'image/gif') {
      return (
        b.length >= 6 &&
        ['GIF87a', 'GIF89a'].includes(
          b.slice(0, 6).toString('ascii')
        )
      );
    }

    if (mime === 'image/webp') {
      return (
        b.length >= 12 &&
        b.slice(0, 4).toString('ascii') === 'RIFF' &&
        b.slice(8, 12).toString('ascii') === 'WEBP'
      );
    }

    if (mime === 'image/avif') {
      return (
        b.length >= 16 &&
        b.slice(4, 12).toString('ascii') === 'ftyp' &&
        /avif|avis/i.test(
          b.slice(8, 32).toString('ascii')
        )
      );
    }

    return false;
  } catch {
    return false;
  }
}

/* ============================================================
   UPLOAD ZDJĘCIA
============================================================ */

app.post('/upload', (req, res) => {
  upload.single('photo')(req, res, err => {
    if (err) {
      return res.status(400).json({
        error:
          err.message ||
          'Nieprawidłowy plik.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Brak pliku.'
      });
    }

    if (
      !isLikelyImageFile(
        req.file.path,
        req.file.mimetype
      )
    ) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      return res.status(400).json({
        error:
          'Plik nie wygląda na prawidłowy obraz.'
      });
    }

    res.json({
      url:
        '/uploads/' +
        encodeURIComponent(
          req.file.filename
        )
    });
  });
});

app.use(
  '/uploads',
  express.static(uploadFolder, {
    fallthrough: false,
    maxAge: '1h'
  })
);

/* ============================================================
   MATCHMAKING
============================================================ */

let waitingUsers = [];

const pairs = Object.create(null);

const photoCounts = new Map();

const reportedThisSession = new Set();

const lastPartnerForReport = new Map();

/* ============================================================
   OCHRONA PRZED K14
============================================================ */

const blockedTermRegex =
  /(^|[^a-z0-9])k\s*1\s*4([^a-z0-9]|$)/iu;

function containsBlockedTerm(text) {
  return blockedTermRegex.test(
    String(text || '').normalize('NFKC')
  );
}

/* ============================================================
   POMOCNICZE
============================================================ */

function isConnected(socketId) {
  return io.sockets.sockets.has(socketId);
}

function removeFromWaiting(socketId) {
  waitingUsers = waitingUsers.filter(
    id => id !== socketId
  );
}

function getPartner(socketId) {
  const partnerId = pairs[socketId];

  if (
    !partnerId ||
    !isConnected(partnerId)
  ) {
    return null;
  }

  return partnerId;
}

function emitOnlineCount() {
  io.emit(
    'onlineCount',
    io.engine.clientsCount
  );
}

function randomId() {
  return crypto.randomBytes(10).toString('hex');
}

/* ============================================================
   ZGŁOSZENIA
============================================================ */

const reportsFile =
  path.join(__dirname, 'reports.json');

function saveReport(report) {
  let reports = [];

  try {
    if (fs.existsSync(reportsFile)) {
      const raw =
        fs.readFileSync(
          reportsFile,
          'utf8'
        );

      reports = JSON.parse(raw);

      if (!Array.isArray(reports)) {
        reports = [];
      }
    }
  } catch (err) {
    console.error(
      'Nie udało się odczytać reports.json:',
      err.message
    );

    reports = [];
  }

  reports.push(report);

  try {
    fs.writeFileSync(
      reportsFile,
      JSON.stringify(
        reports,
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    console.error(
      'Nie udało się zapisać reports.json:',
      err.message
    );
  }
}

/* ============================================================
   STAN GIER — CZYSTY SILNIK 1:1
   6 lekkich gier: drawguess, ttt, word, reflex, risk, rps
   Jedna sesja = jedna para. Serwer jest źródłem prawdy.
============================================================ */

const gameSessions = new Map();
const pendingInvites = new Map();
const gameRate = new Map();

const GAME_INVITE_TIMEOUT = 30 * 1000;
const GAME_MAX_DURATION = 5 * 60 * 1000;
const GAME_ACTION_COOLDOWN = 120;
const DRAW_ACTION_COOLDOWN = 35;
const GAME_MAX_ROUNDS = 8;

const GAME_NAMES = {
  drawguess: 'Rysuj i zgaduj',
  ttt: 'Kółko i krzyżyk',
  word: 'Łańcuch słów',
  reflex: 'Refleks',
  risk: 'Ryzykant',
  rps: 'Kamień, papier, nożyce'
};
const ALLOWED_GAMES = new Set(Object.keys(GAME_NAMES));

const DRAW_WORDS = [
  'lew','samochód','dom','rower','słońce','rakieta','pizza','kot','pies','drzewo',
  'statek','zamek','telefon','gitara','robot','smok','tęcza','lody','kawa','okulary',
  'piłka','księżyc','gwiazda','dinozaur','samolot','komputer','parasol','zegarek','aparat','motyl',
  'zamek','most','kaktus','tort','balon','mikrofon','gitara','pociąg','latarnia','plecak',
  'kapelusz','rak','sowa','rekin','żaba','małpa','wulkan','chmura','śnieg','deszcz',
  'lampa','krzesło','stół','zegarek','kamera','rakieta','książka','korona','pirat','statek'
];

const WORD_STARTS = ['DOM','KOT','LAS','MORZE','LATO','KAWA','ROBOT','SAMOCHÓD','PIŁKA','ZAMEK'];

function gameError(socket, message) { socket.emit('game:error', { message: String(message || 'Błąd gry.') }); }
function validateGameName(game) { return typeof game === 'string' && ALLOWED_GAMES.has(game); }

function getGameSession(socketId) {
  const s = gameSessions.get(socketId);
  if (!s) return null;
  const expectedPartner = s.a === socketId ? s.b : s.a;
  const actualPartner = getPartner(socketId);
  if (!expectedPartner || actualPartner !== expectedPartner) {
    clearGameForPair(socketId);
    return null;
  }
  return s;
}

function clearGameTimeout(session) {
  if (session?.timeout) {
    clearTimeout(session.timeout);
    session.timeout = null;
  }
  if (session?.timers) {
    for (const t of session.timers) clearTimeout(t);
    session.timers.clear();
  }
}

function clearGameForPair(socketId) {
  const session = gameSessions.get(socketId);
  if (!session) return;
  clearGameTimeout(session);
  gameSessions.delete(session.a);
  gameSessions.delete(session.b);
}

function emitGame(socketId, state) {
  if (isConnected(socketId)) io.to(socketId).emit('game:state', state);
}
function emitPair(session, makeState) {
  if (!session) return;
  emitGame(session.a, typeof makeState === 'function' ? makeState(session.a) : makeState);
  emitGame(session.b, typeof makeState === 'function' ? makeState(session.b) : makeState);
}

function finishGame(session, result = 'Gra zakończona.', extra = {}) {
  if (!session || !gameSessions.has(session.a)) return;
  session.active = false;
  clearGameTimeout(session);
  const state = {
    game: session.game,
    sessionId: session.id,
    active: false,
    finished: true,
    status: result,
    result,
    scores: session.scores,
    ...extra
  };
  emitPair(session, state);
  clearGameForPair(session.a);
}

function createGame(a, game) {
  const b = getPartner(a);
  if (!b || !validateGameName(game)) return null;
  const session = {
    id: randomId(),
    game,
    a,
    b,
    partnerId: b,
    createdAt: Date.now(),
    active: true,
    round: 1,
    scores: { [a]: 0, [b]: 0 },
    data: Object.create(null),
    timeout: null,
    timers: new Set()
  };
  gameSessions.set(a, session);
  gameSessions.set(b, session);
  session.timeout = setTimeout(() => finishGame(session, 'Czas gry minął.'), GAME_MAX_DURATION);
  return session;
}

function allowGameAction(socketId, game, action) {
  const now = Date.now();
  const key = `${socketId}:${game}:${action}`;
  const previous = gameRate.get(key) || 0;
  const cooldown = game === 'drawguess' && action === 'stroke' ? DRAW_ACTION_COOLDOWN : GAME_ACTION_COOLDOWN;
  if (now - previous < cooldown) return false;
  gameRate.set(key, now);
  return true;
}

function clearInviteForPair(socketId) {
  const invite = pendingInvites.get(socketId);
  if (!invite) return;
  if (invite.timer) clearTimeout(invite.timer);
  pendingInvites.delete(invite.from);
  pendingInvites.delete(invite.to);
}

function sendInvite(socket, game) {
  const partnerId = getPartner(socket.id);
  if (!partnerId) return gameError(socket, 'Najpierw połącz się z partnerem.');
  if (!validateGameName(game)) return gameError(socket, 'Nieprawidłowa gra.');
  if (gameSessions.has(socket.id) || gameSessions.has(partnerId)) return gameError(socket, 'Najpierw zakończ aktualną grę.');
  if (pendingInvites.has(socket.id) || pendingInvites.has(partnerId)) return gameError(socket, 'Jedno zaproszenie jest już oczekujące.');
  if (!allowGameAction(socket.id, 'invite', game)) return gameError(socket, 'Odczekaj chwilę przed kolejnym zaproszeniem.');

  const invite = { id: randomId(), game, from: socket.id, to: partnerId, createdAt: Date.now(), timer: null };
  invite.timer = setTimeout(() => {
    const current = pendingInvites.get(invite.to);
    if (!current || current.id !== invite.id) return;
    clearInviteForPair(invite.from);
    if (isConnected(invite.from)) io.to(invite.from).emit('game:inviteExpired', { game });
    if (isConnected(invite.to)) io.to(invite.to).emit('game:inviteExpired', { game });
  }, GAME_INVITE_TIMEOUT);

  pendingInvites.set(invite.from, invite);
  pendingInvites.set(invite.to, invite);
  socket.emit('game:inviteSent', { game, inviteId: invite.id });
  io.to(partnerId).emit('game:invite', { game, inviteId: invite.id });
}

function handleInviteResponse(socket, data) {
  if (!data || typeof data.game !== 'string') return;
  const invite = pendingInvites.get(socket.id);
  if (!invite || invite.id !== data.inviteId || invite.to !== socket.id || invite.game !== data.game) {
    return gameError(socket, 'Zaproszenie wygasło lub nie istnieje.');
  }
  clearInviteForPair(invite.from);
  const accepted = data.accepted === true;
  const inviter = invite.from;
  const partner = invite.to;
  if (!accepted) {
    if (isConnected(inviter)) io.to(inviter).emit('game:inviteResponse', { game: invite.game, accepted: false });
    if (isConnected(partner)) io.to(partner).emit('game:inviteResponse', { game: invite.game, accepted: false });
    return;
  }
  if (getPartner(inviter) !== partner || getPartner(partner) !== inviter) {
    return gameError(socket, 'Połączenie z partnerem zostało zakończone.');
  }
  if (gameSessions.has(inviter) || gameSessions.has(partner)) return gameError(socket, 'Gra została już uruchomiona.');

  const session = createGame(inviter, invite.game);
  if (!session) return gameError(socket, 'Nie udało się rozpocząć gry.');

  io.to(inviter).emit('game:inviteResponse', { game: invite.game, accepted: true, sessionId: session.id });
  io.to(partner).emit('game:inviteResponse', { game: invite.game, accepted: true, sessionId: session.id });
  initializeGame(session);
}

function normalizeAnswer(value) {
  return String(value || '').toLocaleLowerCase('pl-PL').normalize('NFKC').replace(/[^a-z0-9ąćęłńóśźż\s-]/giu, '').trim().slice(0, 100);
}
function normalizeWord(value) {
  return String(value || '').toLocaleLowerCase('pl-PL').normalize('NFKC').replace(/[^a-ząćęłńóśźż]/g, '').slice(0, 40);
}

function checkTTT(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line: [a,b,c] };
  return board.every(Boolean) ? { winner: 'draw', line: [] } : null;
}

function drawStateFor(session, socketId, extra = {}) {
  const role = socketId === session.data.drawer ? 'drawer' : 'guesser';
  return {
    game: 'drawguess', sessionId: session.id, active: session.active,
    round: session.round, role, status: role === 'drawer' ? 'Rysuj hasło.' : 'Zgadnij, co partner rysuje.',
    word: role === 'drawer' ? session.data.word : undefined,
    resetCanvas: !!extra.resetCanvas,
    ...extra
  };
}

function initializeGame(session) {
  const { a, b, game } = session;
  if (game === 'ttt') {
    session.data.board = Array(9).fill('');
    session.data.turn = a;
    session.data.symbols = { [a]: 'X', [b]: 'O' };
    emitPair(session, id => ({ game:'ttt', sessionId:session.id, active:true, board:session.data.board.slice(), turn:session.data.turn, symbol:session.data.symbols[id], status:id===session.data.turn?'Twój ruch':'Czekasz na ruch partnera.' }));
    return;
  }
  if (game === 'drawguess') {
    const drawer = Math.random() < .5 ? a : b;
    const guesser = drawer === a ? b : a;
    session.data.drawer = drawer;
    session.data.guesser = guesser;
    session.data.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
    session.data.finished = false;
    session.round = 1;
    emitGame(drawer, drawStateFor(session, drawer, { resetCanvas:true }));
    emitGame(guesser, drawStateFor(session, guesser, { resetCanvas:true }));
    return;
  }
  if (game === 'word') {
    const start = WORD_STARTS[Math.floor(Math.random()*WORD_STARTS.length)];
    session.data.chain = [start];
    session.data.last = start;
    session.data.turn = Math.random() < .5 ? a : b;
    session.data.used = new Set([start.toLocaleLowerCase('pl-PL')]);
    emitPair(session, id => ({ game:'word', sessionId:session.id, active:true, chain:session.data.chain.slice(), myTurn:id===session.data.turn, status:id===session.data.turn?'Twój ruch':'Czekasz na partnera.' }));
    return;
  }
  if (game === 'reflex') {
    session.data.ready = new Set();
    session.data.clicked = Object.create(null);
    session.data.phase = 'ready';
    emitPair(session, id => ({ game:'reflex', sessionId:session.id, active:true, phase:'ready', ready:session.data.ready.has(id), status:session.data.ready.has(id)?'Gotowość zapisana. Czekamy na partnera.':'Kliknij GOTOWY, aby rozpocząć.' }));
    return;
  }
  if (game === 'risk') {
    session.round = 1;
    session.data.values = [1,3,5,-2,-5];
    session.data.selected = Object.create(null);
    session.data.bank = { [a]:0, [b]:0 };
    session.data.turn = Math.random() < .5 ? a : b;
    emitPair(session, id => ({ game:'risk', sessionId:session.id, active:true, round:1, score:session.data.bank[id], myTurn:id===session.data.turn, status:id===session.data.turn?'Twój ruch — wybierz zakryte pole.':'Czekasz na wybór partnera.' }));
    return;
  }
  if (game === 'rps') {
    session.round = 1;
    session.data.choices = Object.create(null);
    session.data.score = { [a]:0, [b]:0 };
    emitPair(session, id => ({ game:'rps', sessionId:session.id, active:true, round:1, choice:null, score:session.data.score, status:'Wybierz swój ruch. Twój wybór jest ukryty do czasu wyboru obu osób.' }));
  }
}

function handleTTT(socket, session, data) {
  if (data.action !== 'move') return;
  const index = Number(data.index);
  if (!Number.isInteger(index) || index < 0 || index > 8) return;
  const symbol = session.data.symbols[socket.id];
  if (!symbol || session.data.turn !== socket.id || session.data.board[index]) return;
  session.data.board[index] = symbol;
  const result = checkTTT(session.data.board);
  if (result) {
    if (result.winner !== 'draw') session.scores[Object.keys(session.data.symbols).find(id => session.data.symbols[id] === result.winner)]++;
    finishGame(session, result.winner === 'draw' ? 'Remis.' : `Wygrywa ${result.winner}.`, { board:session.data.board.slice(), winning:result.line });
    return;
  }
  session.data.turn = session.data.turn === session.a ? session.b : session.a;
  emitPair(session, id => ({ game:'ttt', sessionId:session.id, active:true, board:session.data.board.slice(), turn:session.data.turn, symbol:session.data.symbols[id], status:id===session.data.turn?'Twój ruch':'Czekasz na ruch partnera.' }));
}

function handleDraw(socket, session, data) {
  if (data.action === 'stroke') {
    if (socket.id !== session.data.drawer) return;
    const from = data.from, to = data.to;
    if (!from || !to) return;
    const clean = (p) => ({ x:Math.max(0,Math.min(1,Number(p.x)||0)), y:Math.max(0,Math.min(1,Number(p.y)||0)) });
    const width = Math.max(1, Math.min(24, Number(data.width)||5));
    const allowedColors = new Set(['#111611','#39ff14','#2878ff','#ff5362','#ffc24c','#fff']);
    const color = allowedColors.has(data.color) ? data.color : '#111611';
    emitGame(session.data.guesser, { game:'drawguess', sessionId:session.id, active:true, action:'stroke', from:clean(from), to:clean(to), width, color });
    return;
  }
  if (data.action === 'clear') {
    if (socket.id !== session.data.drawer) return;
    emitGame(session.data.guesser, { game:'drawguess', sessionId:session.id, active:true, action:'clear' });
    return;
  }
  if (data.action === 'guess') {
    if (socket.id !== session.data.guesser) return;
    const answer = normalizeAnswer(data.answer);
    if (!answer) return;
    const target = normalizeAnswer(session.data.word);
    const correct = answer === target || answer.includes(target) || target.includes(answer);
    if (correct) {
      session.scores[socket.id]++;
      finishGame(session, `Dobra odpowiedź! Hasło: ${session.data.word}.`, { word:session.data.word, scores:session.scores });
    } else {
      emitGame(socket.id, { game:'drawguess', sessionId:session.id, active:true, status:'Nie tym razem — próbuj dalej.', result:'Nie tym razem.' });
    }
  }
}

function handleWord(socket, session, data) {
  if (data.action !== 'add') return;
  if (session.data.turn !== socket.id) return gameError(socket, 'Teraz kolej partnera.');
  const word = normalizeWord(data.word);
  if (word.length < 2) return gameError(socket, 'Podaj poprawne słowo.');
  if (containsBlockedTerm(word)) return gameError(socket, 'To słowo nie może zostać użyte.');
  if (session.data.used.has(word)) return gameError(socket, 'To słowo już było użyte.');
  const required = session.data.last.slice(-1).toLocaleLowerCase('pl-PL');
  if (word[0] !== required) return gameError(socket, `Słowo musi zaczynać się na: ${required.toUpperCase()}`);
  session.data.chain.push(word);
  session.data.used.add(word);
  session.data.last = word;
  session.round = session.data.chain.length;
  if (session.data.chain.length >= GAME_MAX_ROUNDS) {
    finishGame(session, 'Łańcuch zakończony — osiągnięto limit ruchów.', { chain:session.data.chain.slice() });
    return;
  }
  session.data.turn = socket.id === session.a ? session.b : session.a;
  emitPair(session, id => ({ game:'word', sessionId:session.id, active:true, chain:session.data.chain.slice(), myTurn:id===session.data.turn, status:id===session.data.turn?'Twój ruch':'Czekasz na partnera.' }));
}

function handleReflex(socket, session, data) {
  if (data.action === 'ready') {
    if (session.data.phase !== 'ready') return;
    session.data.ready.add(socket.id);
    if (session.data.ready.size < 2) {
      emitGame(socket.id, { game:'reflex', sessionId:session.id, active:true, phase:'ready', ready:true, status:'Gotowość zapisana. Czekamy na partnera.' });
      return;
    }
    session.data.phase = 'countdown';
    emitPair(session, { game:'reflex', sessionId:session.id, active:true, phase:'countdown', status:'Start za chwilę…' });
    for (const n of [3,2,1]) session.timers.add(setTimeout(() => emitPair(session, {game:'reflex',sessionId:session.id,active:true,phase:'countdown',count:n,status:String(n)}), (4-n)*500));
    const delay = 1500 + Math.floor(Math.random()*2500);
    session.timers.add(setTimeout(() => {
      if (!session.active) return;
      session.data.phase = 'signal';
      session.data.signalAt = Date.now();
      session.data.clicked = Object.create(null);
      emitPair(session, { game:'reflex', sessionId:session.id, active:true, phase:'signal', status:'KLIKNIJ!', signalAt:session.data.signalAt });
    }, delay));
    return;
  }
  if (data.action === 'click') {
    if (session.data.phase !== 'signal' || session.data.clicked[socket.id]) return;
    session.data.clicked[socket.id] = Math.max(0, Date.now() - session.data.signalAt);
    if (Object.keys(session.data.clicked).length < 2) {
      emitGame(socket.id, { game:'reflex', sessionId:session.id, active:true, phase:'waiting', reaction:session.data.clicked[socket.id], status:'Twój czas zapisany. Czekamy na partnera.' });
      return;
    }
    const [a,b] = [session.a,session.b];
    const ra = session.data.clicked[a], rb = session.data.clicked[b];
    const winner = ra === rb ? null : (ra < rb ? a : b);
    if (winner) session.scores[winner]++;
    finishGame(session, winner ? 'Wynik gotowy — sprawdź swoje czasy reakcji.' : 'Remis refleksu.', { reactions:{ [a]:ra, [b]:rb }, winner });
  }
}

function handleRisk(socket, session, data) {
  if (data.action === 'pick') {
    if (session.data.turn !== socket.id) return gameError(socket,'Teraz kolej partnera.');
    if (session.data.selected[socket.id] !== undefined) return;
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= session.data.values.length) return;
    const value = session.data.values[index];
    if (value === null || value === undefined) return;
    session.data.selected[socket.id] = index;
    session.data.bank[socket.id] += value;
    session.data.values[index] = null;
    emitGame(socket.id, {game:'risk',sessionId:session.id,active:true,round:session.round,score:session.data.bank[socket.id],revealed:{index,value},status:value>=0?`+${value} punktów.`:`${value} punktów.`});
    emitGame(session.data.turn === session.a ? session.b : session.a, {game:'risk',sessionId:session.id,active:true,round:session.round,score:session.data.bank[session.data.turn === session.a ? session.b : session.a],status:'Partner wybrał pole.'});
    return;
  }
  if (data.action === 'continue' || data.action === 'stop') {
    if (session.data.selected[socket.id] === undefined) return;
    const other = socket.id === session.a ? session.b : session.a;
    session.round++;
    if (session.round > GAME_MAX_ROUNDS) {
      return finishGame(session, 'Ryzykant zakończony — limit rund.', { scores: session.data.bank });
    }
    session.data.selected = Object.create(null);
    session.data.values = [1,3,5,-2,-5].sort(()=>Math.random()-.5);
    if (data.action === 'stop') session.data.turn = other;
    else session.data.turn = socket.id;
    emitPair(session,id=>({game:'risk',sessionId:session.id,active:true,round:session.round,score:session.data.bank[id],myTurn:id===session.data.turn,status:id===session.data.turn?'Twój ruch — wybierz zakryte pole.':'Czekasz na ruch partnera.'}));
  }
}

function handleRps(socket, session, data) {
  if (data.action !== 'choose') return;
  const choice = String(data.choice || '');
  if (!['rock','paper','scissors'].includes(choice)) return;
  if (session.data.choices[socket.id]) return;
  session.data.choices[socket.id] = choice;
  const other = socket.id === session.a ? session.b : session.a;
  if (!session.data.choices[other]) {
    emitGame(socket.id,{game:'rps',sessionId:session.id,active:true,round:session.round,choice:'hidden',score:session.data.score,status:'Twój wybór zapisany. Czekamy na partnera.'});
    return;
  }
  const ca=session.data.choices[session.a], cb=session.data.choices[session.b];
  const win=(x,y)=>x===y?'draw':((x==='rock'&&y==='scissors')||(x==='paper'&&y==='rock')||(x==='scissors'&&y==='paper'))?'a':'b';
  const result=win(ca,cb);
  if(result==='a')session.data.score[session.a]++;
  if(result==='b')session.data.score[session.b]++;
  if(session.round >= 5) return finishGame(session,result==='draw'?'Ostatnia runda: remis.':`Koniec 5 rund. Wygrywa ${result==='a'?'gracz A':'gracz B'}.`,{choices:{[session.a]:ca,[session.b]:cb},score:session.data.score,round:session.round});
  emitPair(session,id=>({game:'rps',sessionId:session.id,active:true,round:session.round,choice:id===session.a?ca:cb,reveal:{[session.a]:ca,[session.b]:cb},roundResult:result,score:session.data.score,status:result==='draw'?'Remis rundy.':'Runda zakończona.'}));
  session.round++;
  session.data.choices=Object.create(null);
  setTimeout(()=>{if(!session.active)return;emitPair(session,id=>({game:'rps',sessionId:session.id,active:true,round:session.round,choice:null,score:session.data.score,status:'Wybierz ruch. Wybory są ukryte do czasu decyzji obu osób.'}));},700);
}

function handleGameAction(socket, data) {
  if (!data || typeof data.game !== 'string') return;
  const session = getGameSession(socket.id);
  if (!session) return gameError(socket,'Nie masz aktywnej gry.');
  if (!session.active) return;
  if (data.game !== session.game || !validateGameName(data.game)) return gameError(socket,'Nieprawidłowy stan gry.');
  const action = typeof data.action === 'string' ? data.action : 'unknown';
  if (!allowGameAction(socket.id, data.game, action)) return;
  switch (session.game) {
    case 'drawguess': handleDraw(socket,session,data); break;
    case 'ttt': handleTTT(socket,session,data); break;
    case 'word': handleWord(socket,session,data); break;
    case 'reflex': handleReflex(socket,session,data); break;
    case 'risk': handleRisk(socket,session,data); break;
    case 'rps': handleRps(socket,session,data); break;
    default: gameError(socket,'Nieznana gra.');
  }
}

function stopGameForSocket(socketId, reason='Partner opuścił grę.') {
  const session = gameSessions.get(socketId);
  if (!session) return;
  const partnerId = session.a === socketId ? session.b : session.a;
  clearGameTimeout(session);
  gameSessions.delete(session.a);
  gameSessions.delete(session.b);
  if (isConnected(partnerId)) io.to(partnerId).emit('game:partnerLeft',{game:session.game,message:reason});
}

function handleGameLeave(socket, data) {
  const session = getGameSession(socket.id);
  if (!session) return;
  stopGameForSocket(socket.id, 'Partner zakończył grę.');
  if (isConnected(socket.id)) socket.emit('game:finished',{game:session.game,result:'Wrócono do katalogu gier.'});
}

function handleGameRematch(socket, data) {
  const session = getGameSession(socket.id);
  if (!session || session.active) return;
  gameError(socket,'Ta gra została już zakończona. Wybierz ją ponownie z katalogu.');
}


/* ============================================================
   SOCKET.IO
============================================================ */

io.on(
  'connection',
  socket => {
    console.log(
      'Nowe połączenie użytkownika:',
      socket.id
    );

    emitOnlineCount();

    /* ========================================================
       START CZATU
    ======================================================== */

    socket.on(
      'startChat',
      () => {
        lastPartnerForReport.delete(
          socket.id
        );

        reportedThisSession.delete(
          socket.id
        );

        photoCounts.set(
          socket.id,
          0
        );

        /*
          Najważniejsze zabezpieczenie:
          jeden socket nie może uruchomić
          drugiego własnego połączenia.
        */

        if (
          pairs[socket.id]
        ) {
          console.log(
            `START zignorowany — ${socket.id} jest już połączony.`
          );

          return;
        }

        if (
          waitingUsers.includes(
            socket.id
          )
        ) {
          console.log(
            `START zignorowany — ${socket.id} już czeka.`
          );

          return;
        }

        waitingUsers =
          waitingUsers.filter(
            id =>
              isConnected(id) &&
              id !== socket.id &&
              !pairs[id]
          );

        let partnerId = null;

        while (
          waitingUsers.length
        ) {
          const candidate =
            waitingUsers.shift();

          if (
            candidate !==
              socket.id &&
            isConnected(
              candidate
            ) &&
            !pairs[candidate]
          ) {
            partnerId =
              candidate;

            break;
          }
        }

        if (!partnerId) {
          waitingUsers.push(
            socket.id
          );

          console.log(
            `${socket.id} czeka na partnera...`
          );

          return;
        }

        if (
          partnerId ===
          socket.id
        ) {
          waitingUsers.unshift(
            socket.id
          );

          return;
        }

        if (
          pairs[partnerId] ||
          pairs[socket.id]
        ) {
          waitingUsers.push(
            socket.id
          );

          return;
        }

        pairs[socket.id] =
          partnerId;

        pairs[partnerId] =
          socket.id;

        photoCounts.set(
          socket.id,
          0
        );

        photoCounts.set(
          partnerId,
          0
        );

        io.to(
          socket.id
        ).emit(
          'partnerFound'
        );

        io.to(
          partnerId
        ).emit(
          'partnerFound'
        );

        console.log(
          `Para utworzona: ${socket.id} <-> ${partnerId}`
        );

        emitOnlineCount();
      }
    );

    /* ========================================================
       WIADOMOŚCI
    ======================================================== */

    socket.on(
      'sendMessage',
      msg => {
        const partnerId =
          getPartner(
            socket.id
          );

        if (!partnerId) {
          return;
        }

        const rawText =
          typeof msg === 'string'
            ? msg
            : (
                msg &&
                msg.type === 'text'
              )
              ? String(
                  msg.content ||
                  ''
                )
              : '';

        if (
          !rawText.trim()
        ) {
          return;
        }

        if (
          containsBlockedTerm(
            rawText
          )
        ) {
          socket.emit(
            'messageBlocked',
            'Wiadomość zawiera zakazane określenie i nie została wysłana.'
          );

          return;
        }

        const payload = {
          type: 'text',
          content:
            rawText.slice(
              0,
              MAX_MESSAGE_LENGTH
            )
        };

        io.to(
          partnerId
        ).emit(
          'receiveMessage',
          payload
        );
      }
    );

    /* ========================================================
       ZDJĘCIE
    ======================================================== */

    socket.on(
      'sendPhoto',
      url => {
        const partnerId =
          getPartner(
            socket.id
          );

        if (!partnerId) {
          return;
        }

        if (
          typeof url !== 'string' ||
          !url.startsWith(
            '/uploads/'
          )
        ) {
          return;
        }

        /*
          Twardy limit:
          1 zdjęcie na użytkownika
          w aktualnej rozmowie.
        */

        const count =
          photoCounts.get(
            socket.id
          ) || 0;

        if (
          count >=
          MAX_PHOTOS_PER_SESSION
        ) {
          socket.emit(
            'photoLimitReached',
            'W tej rozmowie można wysłać maksymalnie 1 zdjęcie.'
          );

          return;
        }

        /*
          Sprawdzamy, czy plik faktycznie
          istnieje na serwerze.
        */

        const encoded =
          url
            .replace(
              '/uploads/',
              ''
            )
            .split('?')[0];

        let filename;

        try {
          filename =
            decodeURIComponent(
              encoded
            );
        } catch {
          return;
        }

        /*
          Ochrona przed path traversal.
        */

        if (
          filename.includes('/') ||
          filename.includes('\\') ||
          filename.includes('..')
        ) {
          return;
        }

        const fullPath =
          path.join(
            uploadFolder,
            filename
          );

        if (
          !fs.existsSync(
            fullPath
          )
        ) {
          return;
        }

        photoCounts.set(
          socket.id,
          count + 1
        );

        io.to(
          partnerId
        ).emit(
          'receiveMessage',
          {
            type: 'photo',
            content:
              '/uploads/' +
              encodeURIComponent(
                filename
              )
          }
        );
      }
    );

    /* ========================================================
       ZGŁOSZENIE PARTNERA
    ======================================================== */

    socket.on(
      'reportUser',
      data => {
        const partnerId =
          getPartner(
            socket.id
          ) ||
          lastPartnerForReport.get(
            socket.id
          );

        if (!partnerId) {
          socket.emit(
            'reportError',
            'Nie ma partnera, którego można teraz zgłosić.'
          );

          return;
        }

        if (
          reportedThisSession.has(
            socket.id
          )
        ) {
          socket.emit(
            'reportError',
            'To zgłoszenie zostało już wysłane.'
          );

          return;
        }

        const allowedReasons =
          new Set([
            'spam',
            'wulgarny',
            'erotyczne',
            'nękanie',
            'grozby',
            'inne'
          ]);

        const reason =
          allowedReasons.has(
            data?.reason
          )
            ? data.reason
            : 'inne';

        const details =
          typeof data?.details ===
          'string'
            ? data.details
                .trim()
                .slice(
                  0,
                  MAX_REPORT_DETAILS
                )
            : '';

        const report = {
          id:
            `${Date.now()}-${randomId()}`,

          createdAt:
            new Date().toISOString(),

          reason,

          details,

          reporterSocketId:
            socket.id,

          reportedSocketId:
            partnerId
        };

        saveReport(
          report
        );

        reportedThisSession.add(
          socket.id
        );

        console.log(
          `Zgłoszenie: ${socket.id} zgłosił ${partnerId} — ${reason}`
        );

        socket.emit(
          'reportAccepted'
        );
      }
    );

    /* ========================================================
       START ZAPROSZENIA DO GRY
    ======================================================== */

    socket.on(
      'game:invite',
      data => {
        if (!data) {
          return;
        }

        sendInvite(
          socket,
          data.game
        );
      }
    );

    /* ========================================================
       AKCEPTACJA / ODRZUCENIE GRY
    ======================================================== */

    socket.on(
      'game:inviteResponse',
      data => {
        handleInviteResponse(
          socket,
          data
        );
      }
    );

    /* ========================================================
       AKCJE GIER
    ======================================================== */

    socket.on(
      'game:action',
      data => {
        handleGameAction(
          socket,
          data
        );
      }
    );

    socket.on(
      'game:leave',
      data => handleGameLeave(socket, data)
    );

    socket.on(
      'game:rematch',
      data => handleGameRematch(socket, data)
    );

    /* ========================================================
       STOP CZATU
    ======================================================== */

    socket.on(
      'stopChat',
      () => {
        if (
          !pairs[socket.id] &&
          !waitingUsers.includes(
            socket.id
          )
        ) {
          return;
        }

        photoCounts.delete(
          socket.id
        );

        console.log(
          `${socket.id} kończy czat.`
        );

        breakPair(
          socket.id,
          true
        );

        emitOnlineCount();
      }
    );

    /* ========================================================
       ROZŁĄCZENIE
    ======================================================== */

    socket.on(
      'disconnect',
      () => {
        console.log(
          'Użytkownik opuścił czat:',
          socket.id
        );

        reportedThisSession.delete(
          socket.id
        );

        photoCounts.delete(
          socket.id
        );

        lastPartnerForReport.delete(
          socket.id
        );

        clearInviteForPair(
          socket.id
        );

        gameRate.delete(
          socket.id
        );

        breakPair(
          socket.id,
          true
        );

        removeFromWaiting(
          socket.id
        );

        emitOnlineCount();
      }
    );
  }
);

/* ============================================================
   AUTOMATYCZNE CZYSZCZENIE MARTWEJ KOLEJKI
============================================================ */

setInterval(
  () => {
    waitingUsers =
      waitingUsers.filter(
        socketId =>
          isConnected(
            socketId
          ) &&
          !pairs[socketId]
      );
  },
  30 * 1000
);

/* ============================================================
   AUTOMATYCZNE CZYSZCZENIE STARYCH INVITE
============================================================ */

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [socketId, invite]
      of pendingInvites.entries()
    ) {
      if (
        now -
          invite.createdAt >
        GAME_INVITE_TIMEOUT + 5000
      ) {
        clearInviteForPair(
          socketId
        );
      }
    }
  },
  10 * 1000
);

/* ============================================================
   START SERWERA
============================================================ */

server.listen(
  PORT,
  () => {
    console.log(
      `Czatuj24 działa na porcie ${PORT}`
    );

    console.log(
      `Limit zdjęć na rozmowę: ${MAX_PHOTOS_PER_SESSION}`
    );

    console.log(
      `Dostępne gry: ${Object.keys(GAME_NAMES).join(', ')}`
    );
  }
);