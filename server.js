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
  maxHttpBufferSize: 256 * 1024,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 20000
});

const publicPath = path.join(__dirname, './');

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

app.get('/healthz', (req, res) => {
  res.status(200).json({
    ok: true,
    uptime: Math.round(process.uptime()),
    online: io.engine.clientsCount
  });
});

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
const publicProfiles = new Map();
const chatMessageRegistry = new Map();
const messageReactions = new Map();

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
    io.sockets.sockets.size
  );
}

function randomId() {
  return crypto.randomBytes(10).toString('hex');
}

/* ============================================================
   STABILNE MATCHMAKING / ROZŁĄCZENIA
   Jeden socket = jedna pozycja w kolejce. Jedna para = dwa sockety.
============================================================ */

function sanitizePublicProfile(profile){
  const p = profile && typeof profile === 'object' ? profile : {};
  const allowedPurposes = new Set(['randka','spotkanie','seks','rozmowa']);
  const allowedStatuses = new Set(['dostepny','zaraz']);
  const age = Math.max(15, Math.min(100, Number(p.age) || 25));
  const purpose = allowedPurposes.has(p.purpose) ? p.purpose : 'rozmowa';
  return {
    nick: String(p.nick || 'Partner').trim().slice(0,20) || 'Partner',
    age,
    purpose: age < 18 && purpose === 'seks' ? 'rozmowa' : purpose,
    status: allowedStatuses.has(p.status) ? p.status : 'dostepny',
    bio: String(p.bio || '').trim().slice(0,200)
  };
}

function emitPartnerProfiles(a,b){
  if(isConnected(a)) io.to(a).emit('partnerProfile', publicProfiles.get(b) || sanitizePublicProfile(null));
  if(isConnected(b)) io.to(b).emit('partnerProfile', publicProfiles.get(a) || sanitizePublicProfile(null));
}

function clearChatMessageStateForPair(a,b){
  for(const [id,entry] of chatMessageRegistry){
    if((entry.a===a && entry.b===b)||(entry.a===b && entry.b===a)){
      chatMessageRegistry.delete(id);
      messageReactions.delete(id);
    }
  }
}

function removePairReferences(socketId) {
  const partnerId = pairs[socketId] || null;
  delete pairs[socketId];
  if (partnerId) delete pairs[partnerId];
  return partnerId;
}

function breakPair(socketId, notifyPartner = true) {
  removeFromWaiting(socketId);

  const partnerId = pairs[socketId] || null;

  // Zapamiętaj ostatniego partnera, aby zgłoszenie po zakończeniu
  // rozmowy nadal mogło trafić do właściwego socketu, jeśli istnieje.
  if (partnerId && isConnected(partnerId)) {
    lastPartnerForReport.set(partnerId, socketId);
  }

  // Gry/invity i efemeryczne reakcje zawsze kończymy razem z parą.
  clearGameForPair(socketId);
  clearInviteForPair(socketId);
  if(partnerId) clearChatMessageStateForPair(socketId, partnerId);
  publicProfiles.delete(socketId);

  if (partnerId && notifyPartner && isConnected(partnerId)) {
    io.to(partnerId).emit('partnerStopped');
  }

  removePairReferences(socketId);
  return partnerId;
}

function cleanWaitingQueue() {
  const seen = new Set();
  waitingUsers = waitingUsers.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return isConnected(id) && !pairs[id];
  });
}

function enqueueUser(socketId) {
  cleanWaitingQueue();
  if (!isConnected(socketId) || pairs[socketId]) return false;
  if (waitingUsers.includes(socketId)) return false;
  waitingUsers.push(socketId);
  return true;
}

function matchWaitingUser(socketId) {
  cleanWaitingQueue();
  if (!isConnected(socketId) || pairs[socketId]) return null;

  const ownIndex = waitingUsers.indexOf(socketId);
  if (ownIndex >= 0) waitingUsers.splice(ownIndex, 1);

  let partnerId = null;
  while (waitingUsers.length) {
    const candidate = waitingUsers.shift();
    if (
      candidate &&
      candidate !== socketId &&
      isConnected(candidate) &&
      !pairs[candidate]
    ) {
      partnerId = candidate;
      break;
    }
  }

  if (!partnerId) {
    enqueueUser(socketId);
    return null;
  }

  pairs[socketId] = partnerId;
  pairs[partnerId] = socketId;

  photoCounts.set(socketId, 0);
  photoCounts.set(partnerId, 0);

  io.to(socketId).emit('partnerFound');
  io.to(partnerId).emit('partnerFound');
  emitPartnerProfiles(socketId, partnerId);

  console.log(`Para utworzona: ${socketId} <-> ${partnerId}`);
  emitOnlineCount();
  return partnerId;
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
const messageRate = new Map();
const reportRate = new Map();
const reactionRate = new Map();

const GAME_INVITE_TIMEOUT = 30 * 1000;
const GAME_MAX_DURATION = 10 * 60 * 1000;
const GAME_ACTION_COOLDOWN = 140;
const DRAW_ACTION_COOLDOWN = 45;
const DRAW_MAX_STROKES_PER_SECOND = 24;
const GAME_MAX_ROUNDS = 8;
const DRAW_MAX_ROUNDS = 5;
const RISK_MAX_PICKS_PER_TURN = 2;

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

  const winnerId = extra && Object.prototype.hasOwnProperty.call(extra, 'winner')
    ? extra.winner
    : null;
  const { winner, ...safeExtra } = extra || {};

  emitPair(session, id => {
    const state = {
      game: session.game,
      sessionId: session.id,
      active: false,
      finished: true,
      status: result,
      result,
      scores: safeExtra.scores || session.scores,
      ...safeExtra,
      winnerView: winnerId
        ? (winnerId === id ? 'self' : 'partner')
        : (winnerId === null && Object.prototype.hasOwnProperty.call(extra || {}, 'winner') ? 'draw' : null)
    };
    return state;
  });

  emitPair(session, id => {
    if (isConnected(id)) io.to(id).emit('game:finished', {
      game: session.game,
      sessionId: session.id,
      result,
      winnerView: winnerId ? (winnerId === id ? 'self' : 'partner') : (winnerId === null && Object.prototype.hasOwnProperty.call(extra || {}, 'winner') ? 'draw' : null)
    });
  });

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
  io.to(inviter).emit('game:started', { game: invite.game, sessionId: session.id });
  io.to(partner).emit('game:started', { game: invite.game, sessionId: session.id });
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
  const scores = { ...session.scores };
  return {
    game: 'drawguess',
    sessionId: session.id,
    active: session.active,
    round: session.round,
    maxRounds: DRAW_MAX_ROUNDS,
    role,
    status: role === 'drawer' ? 'Rysuj hasło.' : 'Zgadnij, co partner rysuje.',
    word: role === 'drawer' ? session.data.word : undefined,
    scores,
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
    session.round = 1;
    session.data.drawer = Math.random() < .5 ? a : b;
    session.data.guesser = session.data.drawer === a ? b : a;
    session.data.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
    session.data.guessLocked = false;
    emitGame(a, drawStateFor(session, a, { resetCanvas:true }));
    emitGame(b, drawStateFor(session, b, { resetCanvas:true }));
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
    session.data.values = [1,3,5,-2,-5].sort(()=>Math.random()-.5);
    session.data.selected = Object.create(null);
    session.data.revealed = Object.create(null);
    session.data.picks = { [a]:0, [b]:0 };
    session.data.bank = { [a]:0, [b]:0 };
    session.data.turn = Math.random() < .5 ? a : b;
    emitPair(session, id => ({
      game:'risk', sessionId:session.id, active:true, round:1,
      score:session.data.bank[id],
      opponentScore:session.data.bank[id === a ? b : a],
      scores:{...session.data.bank},
      myTurn:id===session.data.turn,
      picksLeft:RISK_MAX_PICKS_PER_TURN,
      status:id===session.data.turn?'Twój ruch — wybierz zakryte pole.':'Czekasz na wybór partnera.'
    }));
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

function rotateDrawRound(session, winnerId) {
  if (!session.active) return;
  if (winnerId) {
    session.scores[winnerId] += 2; // zgadujący
    const drawer = session.data.drawer;
    session.scores[drawer] += 1;   // rysujący
  }
  if (session.round >= DRAW_MAX_ROUNDS) {
    const winner = session.scores[session.a] === session.scores[session.b]
      ? null
      : (session.scores[session.a] > session.scores[session.b] ? session.a : session.b);
    const result = winner ? 'Rysuj i zgaduj zakończone — mamy zwycięzcę.' : 'Rysuj i zgaduj zakończone — remis.';
    finishGame(session, result, {
      scores:{...session.scores},
      winner,
      round:session.round,
      word: winnerId ? session.data.word : undefined
    });
    return;
  }

  const previousDrawer = session.data.drawer;
  session.data.drawer = previousDrawer === session.a ? session.b : session.a;
  session.data.guesser = session.data.drawer === session.a ? session.b : session.a;
  session.data.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
  session.round += 1;
  session.data.guessLocked = false;

  emitGame(session.a, drawStateFor(session, session.a, { resetCanvas:true, result: winnerId ? 'Punkt za trafienie. Nowa runda.' : 'Nowa runda.' }));
  emitGame(session.b, drawStateFor(session, session.b, { resetCanvas:true, result: winnerId ? 'Punkt za trafienie. Nowa runda.' : 'Nowa runda.' }));
}

function handleDraw(socket, session, data) {
  if (data.action === 'stroke') {
    if (socket.id !== session.data.drawer) return;
    const from = data.from, to = data.to;
    if (!from || !to) return;
    const clean = p => ({
      x: Math.max(0, Math.min(1, Number(p.x) || 0)),
      y: Math.max(0, Math.min(1, Number(p.y) || 0))
    });
    const width = Math.max(1, Math.min(24, Number(data.width)||5));
    const allowedColors = new Set(['#111611','#39ff14','#2878ff','#ff5362','#ffc24c','#fff']);
    const color = allowedColors.has(data.color) ? data.color : '#111611';
    emitGame(session.data.guesser, {
      game:'drawguess', sessionId:session.id, active:true, action:'stroke',
      from:clean(from), to:clean(to), width, color
    });
    return;
  }

  if (data.action === 'clear') {
    if (socket.id !== session.data.drawer) return;
    emitGame(session.data.guesser, { game:'drawguess', sessionId:session.id, active:true, action:'clear' });
    return;
  }

  if (data.action === 'guess') {
    if (socket.id !== session.data.guesser || session.data.guessLocked) return;
    const answer = normalizeAnswer(data.answer);
    if (!answer || answer.length > 60) return;
    const target = normalizeAnswer(session.data.word);
    const correct = answer === target || answer.includes(target) || target.includes(answer);

    if (correct) {
      session.data.guessLocked = true;
      rotateDrawRound(session, socket.id);
    } else {
      emitGame(socket.id, {
        game:'drawguess',
        sessionId:session.id,
        active:true,
        status:'Nie tym razem — próbuj dalej.',
        result:'Nie tym razem.'
      });
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
      emitGame(socket.id, {
        game:'reflex', sessionId:session.id, active:true, phase:'ready',
        ready:true, status:'Gotowość zapisana. Czekamy na partnera.'
      });
      return;
    }

    session.data.phase = 'countdown';
    emitPair(session, { game:'reflex', sessionId:session.id, active:true, phase:'countdown', count:3, status:'3' });

    [2,1].forEach((n, i) => {
      session.timers.add(setTimeout(() => {
        if (!session.active || session.data.phase !== 'countdown') return;
        emitPair(session, {game:'reflex',sessionId:session.id,active:true,phase:'countdown',count:n,status:String(n)});
      }, (i + 1) * 650));
    });

    const delay = 1950 + Math.floor(Math.random()*2600);
    session.timers.add(setTimeout(() => {
      if (!session.active || session.data.phase !== 'countdown') return;
      session.data.phase = 'signal';
      session.data.signalAt = Date.now();
      session.data.clicked = Object.create(null);
      emitPair(session, {
        game:'reflex',
        sessionId:session.id,
        active:true,
        phase:'signal',
        status:'KLIKNIJ!',
        signalAt:session.data.signalAt
      });

      session.timers.add(setTimeout(() => {
        if (!session.active || session.data.phase !== 'signal') return;
        const [a,b] = [session.a,session.b];
        const ra = session.data.clicked[a];
        const rb = session.data.clicked[b];
        if (ra === undefined || rb === undefined) {
          const winner = ra === undefined && rb === undefined ? null : (ra === undefined ? b : a);
          if (winner) session.scores[winner] += 1;
          finishGame(session, 'Refleks zakończony — nie każdy zdążył kliknąć.', {
            reactions:{[a]:ra ?? null,[b]:rb ?? null},
            winner
          });
        }
      }, 6000));
    }, delay));
    return;
  }

  if (data.action === 'click') {
    if (session.data.phase !== 'signal' || session.data.clicked[socket.id] !== undefined) return;
    const reaction = Math.max(0, Date.now() - session.data.signalAt);
    session.data.clicked[socket.id] = reaction;

    emitGame(socket.id, {
      game:'reflex',
      sessionId:session.id,
      active:true,
      phase:'waiting',
      reaction,
      status:`Twój czas: ${reaction} ms. Czekamy na partnera.`
    });

    if (Object.keys(session.data.clicked).length < 2) return;

    const [a,b] = [session.a,session.b];
    const ra = session.data.clicked[a], rb = session.data.clicked[b];
    const winner = ra === rb ? null : (ra < rb ? a : b);
    if (winner) session.scores[winner]++;
    finishGame(session, winner ? 'Refleks zakończony — mamy zwycięzcę.' : 'Refleks zakończony — remis.', {
      reactions:{ [a]:ra, [b]:rb },
      winner,
      scores:{...session.scores}
    });
  }
}

function emitRiskState(session, result = '') {
  emitPair(session, id => {
    const other = id === session.a ? session.b : session.a;
    const picks = session.data.picks[id] || 0;
    return {
      game:'risk',
      sessionId:session.id,
      active:session.active,
      round:session.round,
      score:session.data.bank[id],
      opponentScore:session.data.bank[other],
      scores:{...session.data.bank},
      myTurn:id===session.data.turn,
      picksUsed:picks,
      picksLeft:Math.max(0, RISK_MAX_PICKS_PER_TURN - picks),
      status:id===session.data.turn
        ? (picks >= RISK_MAX_PICKS_PER_TURN ? 'Limit ryzyka wykorzystany — przekazanie tury.' : 'Twój ruch — wybierz zakryte pole.')
        : 'Czekasz na ruch partnera.',
      newRound:true,
      result
    };
  });
}

function resetRiskBoard(session){
  session.data.values = [1,3,5,-2,-5].sort(()=>Math.random()-.5);
  session.data.revealed = Object.create(null);
}

function finishRiskIfNeeded(session){
  if(session.round <= GAME_MAX_ROUNDS) return false;
  const a=session.data.bank[session.a], b=session.data.bank[session.b];
  const winner=a===b?null:(a>b?session.a:session.b);
  finishGame(session, winner ? 'Ryzykant zakończony — mamy zwycięzcę.' : 'Ryzykant zakończony — remis.', {scores:{...session.data.bank},winner});
  return true;
}

function handleRisk(socket, session, data) {
  const other = socket.id === session.a ? session.b : session.a;
  if(data.action === 'pick'){
    if(session.data.turn !== socket.id) return gameError(socket,'To nie Twoja tura.');
    const used=session.data.picks[socket.id]||0;
    if(used>=RISK_MAX_PICKS_PER_TURN) return gameError(socket,'Wykorzystałeś już 2 ryzyka w tej turze.');
    const index=Number(data.index);
    if(!Number.isInteger(index)||index<0||index>=session.data.values.length) return;
    const value=session.data.values[index];
    if(value===null||value===undefined) return gameError(socket,'To pole jest już odkryte.');
    session.data.picks[socket.id]=used+1;
    session.data.bank[socket.id]+=value;
    session.data.values[index]=null;
    session.data.revealed[socket.id]={index,value};
    const picksLeft=Math.max(0,RISK_MAX_PICKS_PER_TURN-session.data.picks[socket.id]);
    emitGame(socket.id,{game:'risk',sessionId:session.id,active:true,round:session.round,score:session.data.bank[socket.id],opponentScore:session.data.bank[other],scores:{...session.data.bank},myTurn:true,picksUsed:session.data.picks[socket.id],picksLeft,revealed:{index,value},status:value>=0?`+${value} punktów.`:`${value} punktów.`});
    emitGame(other,{game:'risk',sessionId:session.id,active:true,round:session.round,score:session.data.bank[other],opponentScore:session.data.bank[socket.id],scores:{...session.data.bank},myTurn:false,picksUsed:session.data.picks[other]||0,picksLeft:Math.max(0,RISK_MAX_PICKS_PER_TURN-(session.data.picks[other]||0)),status:'Partner odkrył pole.'});
    if(session.data.picks[socket.id]>=RISK_MAX_PICKS_PER_TURN){
      session.data.turn=other; session.data.picks[socket.id]=0; session.data.picks[other]=0; session.round++;
      if(finishRiskIfNeeded(session)) return;
      resetRiskBoard(session);
      emitRiskState(session,'Limit 2 ryzyk wykorzystany. Tura partnera.');
    }
    return;
  }
  if(data.action==='continue'||data.action==='stop'){
    if(session.data.turn!==socket.id) return gameError(socket,'To nie Twoja tura.');
    const used=session.data.picks[socket.id]||0;
    if(used<1) return gameError(socket,'Najpierw odkryj pole.');
    if(data.action==='stop'){
      session.data.turn=other; session.data.picks[socket.id]=0; session.data.picks[other]=0; session.round++;
      if(finishRiskIfNeeded(session)) return;
      resetRiskBoard(session); emitRiskState(session,'Zachowujesz punkty. Tura partnera.'); return;
    }
    if(used>=RISK_MAX_PICKS_PER_TURN) return gameError(socket,'Limit ryzyka został wykorzystany.');
    resetRiskBoard(session);
    emitRiskState(session,'Nowe zakryte pola — możesz ryzykować dalej.');
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
  if(session.round >= 5) return finishGame(session,result==='draw'?'Ostatnia runda: remis.':'Koniec 5 rund.',{choices:{[session.a]:ca,[session.b]:cb},score:session.data.score,round:session.round,winner:result==='draw'?null:(result==='a'?session.a:session.b)});
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
   OCHRONA EVENTÓW SOCKET.IO
============================================================ */

function allowBurst(map, socketId, limit, windowMs) {
  const now = Date.now();
  const old = map.get(socketId) || [];
  const fresh = old.filter(t => now - t < windowMs);
  if (fresh.length >= limit) {
    map.set(socketId, fresh);
    return false;
  }
  fresh.push(now);
  map.set(socketId, fresh);
  return true;
}

function cleanupRateState(socketId) {
  messageRate.delete(socketId);
  reportRate.delete(socketId);
  gameRate.delete(socketId);
  reactionRate.delete(socketId);
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
      data => {
        if (!isConnected(socket.id)) return;
        publicProfiles.set(socket.id, sanitizePublicProfile(data?.profile));

        // START jest idempotentny: kliknięcie ponownie nie tworzy
        // drugiego połączenia ani nie pozwala połączyć użytkownika z samym sobą.
        if (pairs[socket.id]) return;
        if (waitingUsers.includes(socket.id)) return;

        lastPartnerForReport.delete(socket.id);
        reportedThisSession.delete(socket.id);
        photoCounts.set(socket.id, 0);

        matchWaitingUser(socket.id);
      }
    );

    /* ========================================================
       WIADOMOŚCI
    ======================================================== */

    socket.on(
      'sendMessage',
      msg => {
        if (!allowBurst(messageRate, socket.id, 20, 10_000)) {
          socket.emit('messageBlocked', 'Wysyłasz wiadomości zbyt szybko. Odczekaj chwilę.');
          return;
        }

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

        const messageId = randomId();
        const payload = {
          type: 'text',
          messageId,
          content: rawText.slice(0, MAX_MESSAGE_LENGTH)
        };
        chatMessageRegistry.set(messageId, {
          a: socket.id,
          b: partnerId,
          createdAt: Date.now()
        });
        io.to(socket.id).emit('receiveMessage', { ...payload, fromSelf:true });
        io.to(partnerId).emit('receiveMessage', { ...payload, fromSelf:false });
      }
    );

    /* ========================================================
       PISANIE NA ŻYWO + REAKCJE
    ======================================================== */

    socket.on('profile:update', data => {
      if(!data?.profile) return;
      publicProfiles.set(socket.id, sanitizePublicProfile(data.profile));
      const partnerId=getPartner(socket.id);
      if(partnerId) io.to(partnerId).emit('partnerProfile', publicProfiles.get(socket.id));
    });

    socket.on('typing', active => {
      const partnerId = getPartner(socket.id);
      if(!partnerId) return;
      io.to(partnerId).emit('typing', active === true);
    });

    socket.on('reactMessage', data => {
      if(!allowBurst(reactionRate, socket.id, 30, 10_000)) return;
      const partnerId = getPartner(socket.id);
      if(!partnerId || !data || typeof data.messageId !== 'string') return;
      const entry = chatMessageRegistry.get(data.messageId);
      if(!entry || !((entry.a===socket.id && entry.b===partnerId)||(entry.b===socket.id && entry.a===partnerId))) return;
      const allowed = new Set(['❤️','😂','😮','👍','🔥']);
      let reaction = allowed.has(data.reaction) ? data.reaction : '';
      let users = messageReactions.get(data.messageId);
      if(!users){ users=new Map(); messageReactions.set(data.messageId, users); }
      if(reaction && users.get(socket.id) === reaction) reaction='';
      if(reaction) users.set(socket.id, reaction); else users.delete(socket.id);
      const counts = new Map();
      for(const r of users.values()) counts.set(r,(counts.get(r)||0)+1);
      const current = users.get(socket.id) || '';
      const payload={messageId:data.messageId,reaction:current,count:current?(counts.get(current)||1):0,counts:Object.fromEntries(counts),fromSelf:false};
      io.to(socket.id).emit('messageReaction',{...payload,fromSelf:true});
      io.to(partnerId).emit('messageReaction',payload);
    });

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
        if (!allowBurst(reportRate, socket.id, 3, 60_000)) {
          socket.emit('reportError', 'Zgłoszenia można wysyłać rzadziej. Spróbuj ponownie za chwilę.');
          return;
        }
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

        cleanupRateState(
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
  5 * 1000
);

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of gameRate) {
    if (now - timestamp > 60_000) gameRate.delete(key);
  }
  for (const [id, times] of messageRate) {
    const fresh = times.filter(t => now - t < 10_000);
    if (fresh.length) messageRate.set(id, fresh); else messageRate.delete(id);
  }
  for (const [id, times] of reportRate) {
    const fresh = times.filter(t => now - t < 60_000);
    if (fresh.length) reportRate.set(id, fresh); else reportRate.delete(id);
  }
  for (const [id, times] of reactionRate) {
    const fresh = times.filter(t => now - t < 10_000);
    if (fresh.length) reactionRate.set(id, fresh); else reactionRate.delete(id);
  }
}, 60_000);

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

setInterval(() => {
  const cutoff=Date.now()-15*60_000;
  for(const [id,e] of chatMessageRegistry){if(e.createdAt<cutoff){chatMessageRegistry.delete(id);messageReactions.delete(id);}}
},60_000);

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
process.on('uncaughtException', err => {
  console.error('Nieobsłużony wyjątek serwera:', err);
});

process.on('unhandledRejection', err => {
  console.error('Nieobsłużone odrzucenie Promise:', err);
});

process.on('unhandledRejection', reason => {
  console.error('Nieobsłużone odrzucenie Promise:', reason);
});