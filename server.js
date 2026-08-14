const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ============================================================
// FRONTEND
// ============================================================

const publicPath = __dirname;
app.use(express.static(publicPath));

// ============================================================
// UPLOAD ZDJĘĆ
// ============================================================

const uploadFolder = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif'
]);

const allowedExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif'
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadFolder);
  },

  filename: (_req, file, cb) => {
    const ext = path
      .extname(file.originalname || '')
      .toLowerCase();

    const safeExt = allowedExtensions.has(ext)
      ? ext
      : '.bin';

    const uniqueName =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}${safeExt}`;

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 8 * 1024 * 1024
  },

  fileFilter: (_req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(
        new Error(
          'Dozwolone są wyłącznie pliki graficzne.'
        )
      );
    }

    cb(null, true);
  }
});

// ============================================================
// PODSTAWOWA WERYFIKACJA PLIKU OBRAZOWEGO
// ============================================================

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
        b.slice(0, 4).toString('ascii') ===
          'RIFF' &&
        b.slice(8, 12).toString('ascii') ===
          'WEBP'
      );
    }

    if (mime === 'image/avif') {
      return (
        b.length >= 16 &&
        b.slice(4, 12).toString('ascii') ===
          'ftyp' &&
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

// ============================================================
// UPLOAD ZDJĘCIA
// ============================================================

app.post('/upload', (req, res) => {
  upload.single('photo')(
    req,
    res,
    err => {
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
    }
  );
});

// ============================================================
// UDOSTĘPNIANIE UPLOADÓW
// ============================================================

app.use(
  '/uploads',
  express.static(uploadFolder, {
    fallthrough: false,
    maxAge: '1h'
  })
);

// ============================================================
// MATCHMAKING
// ============================================================

let waitingUsers = [];

const pairs = Object.create(null);

// Liczba zdjęć wysłanych przez użytkownika
// w aktualnej rozmowie.
//
// WAŻNE:
// Maksymalnie 1 zdjęcie na użytkownika na rozmowę.
const photoCounts = new Map();

// ============================================================
// BLOKADA ZAKAZANEGO OKREŚLENIA
// ============================================================

const blockedTermRegex =
  /(^|[^a-z0-9])k\s*1\s*4([^a-z0-9]|$)/iu;

function containsBlockedTerm(text) {
  return blockedTermRegex.test(
    String(text || '')
      .normalize('NFKC')
  );
}

// ============================================================
// ZGŁOSZENIA
// ============================================================

const reportsFile =
  path.join(
    __dirname,
    'reports.json'
  );

const reportedThisSession =
  new Set();

const lastPartnerForReport =
  new Map();

const ALLOWED_REPORT_REASONS =
  new Set([
    'spam',
    'wulgarny',
    'erotyczne',
    'nękanie',
    'grozby',
    'inne'
  ]);

// ============================================================
// GRY
// ============================================================

const GAME_NAMES =
  new Set([
    'ab',
    'guess',
    'truth',
    'speed',
    'emoji',
    'compat',
    'ttt',
    'draw',
    'word'
  ]);

const MAX_GAME_INPUT = 500;

const GAME_INVITE_TTL =
  45 * 1000;

// Maksymalna liczba fragmentów
// rysowania na minutę od jednego socketu.
const MAX_DRAW_STROKES_PER_MINUTE =
  900;

// Jeden aktywny system gry na parę.
const gameBySocket =
  new Map();

// Oczekujące zaproszenia:
//
// recipientSocketId -> {
//   from,
//   game,
//   expiresAt
// }
const pendingInvites =
  new Map();

// Ochrona rysowania przed spamem.
const drawRate =
  new Map();

// ============================================================
// BAZA EMOJI
// ============================================================

const EMOJI_PUZZLES = [
  ['🦁 👑', 'król lew'],
  ['🧙 💍 🌋', 'władca pierścieni'],
  ['🚢 ❄️ ❤️', 'titanic'],
  ['🕷️ 🦸', 'spiderman'],
  ['🧊 👑', 'kraina lodu'],
  ['🦖 🏝️', 'jurassic park'],
  ['🧜‍♀️ 🌊', 'mała syrenka'],
  ['🦇 🌃', 'batman'],
  ['🐼 🥋', 'kung fu panda'],
  ['🐠 🔎', 'gdzie jest nemo'],
  ['🧞‍♂️ 🪔', 'aladyn'],
  ['🧙 🏰', 'harry potter'],
  ['🦈 🌊', 'szczęki'],
  ['🤖 🚗', 'transformers'],
  ['🚀 🌌', 'kosmos'],
  ['👽 🚲', 'e.t.'],
  ['🎸 🌟', 'gwiazda rocka'],
  ['🕵️ 🔍', 'detektyw'],
  ['🧛 🏰', 'drakula'],
  ['🐀 👨‍🍳', 'ratatouille'],
  ['🦍 🏙️', 'king kong'],
  ['👻 🏨', 'hotel duchów'],
  ['🐉 🏰', 'smok'],
  ['🚗 💨', 'szybcy i wściekli']
];

const WORD_START = 'DOM';

// ============================================================
// POMOCNICZE
// ============================================================

function safeString(
  value,
  max = MAX_GAME_INPUT
) {
  return String(
    value == null ? '' : value
  )
    .normalize('NFKC')
    .trim()
    .slice(0, max);
}

function isConnected(socketId) {
  return io.sockets.sockets.has(
    socketId
  );
}

function getPartner(socketId) {
  const partnerId =
    pairs[socketId];

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

function removeFromWaiting(
  socketId
) {
  waitingUsers =
    waitingUsers.filter(
      id => id !== socketId
    );
}

// ============================================================
// ZAPIS ZGŁOSZEŃ
// ============================================================

function saveReport(report) {
  let reports = [];

  try {
    if (
      fs.existsSync(
        reportsFile
      )
    ) {
      const raw =
        fs.readFileSync(
          reportsFile,
          'utf8'
        );

      const parsed =
        JSON.parse(raw);

      if (
        Array.isArray(parsed)
      ) {
        reports = parsed;
      }
    }
  } catch (err) {
    console.error(
      'Nie udało się odczytać reports.json:',
      err.message
    );
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

// ============================================================
// POMOCNICZE GRY
// ============================================================

function gameFor(socketId) {
  return (
    gameBySocket.get(
      socketId
    ) || null
  );
}

function gamePartner(socketId) {
  const game =
    gameFor(socketId);

  if (!game) {
    return null;
  }

  return game.a === socketId
    ? game.b
    : game.a;
}

function emitGame(
  game,
  payload
) {
  if (!game) {
    return;
  }

  for (
    const id of [game.a, game.b]
  ) {
    if (
      isConnected(id)
    ) {
      io.to(id).emit(
        'game:state',
        payload
      );
    }
  }
}

function sendGameError(
  socket,
  message
) {
  socket.emit(
    'game:error',
    safeString(
      message,
      220
    )
  );
}

function clearGame(
  game,
  notify = true
) {
  if (!game) {
    return;
  }

  gameBySocket.delete(
    game.a
  );

  gameBySocket.delete(
    game.b
  );

  if (notify) {
    for (
      const id of [game.a, game.b]
    ) {
      if (
        isConnected(id)
      ) {
        io.to(id).emit(
          'game:ended',
          {
            game: game.game,
            reason:
              'Gra zakończona.'
          }
        );
      }
    }
  }
}

// ============================================================
// TWORZENIE STANU GRY
// ============================================================

function createGameState(
  gameName,
  a,
  b
) {
  const game = {
    game: gameName,
    a,
    b,
    createdAt: Date.now(),
    round: 0
  };

  // ----------------------------------------------------------
  // KÓŁKO I KRZYŻYK
  // ----------------------------------------------------------

  if (
    gameName === 'ttt'
  ) {
    game.board =
      Array(9).fill('');

    game.turn = a;

    game.symbol = {
      [a]: 'X',
      [b]: 'O'
    };

    game.active = true;
  }

  // ----------------------------------------------------------
  // RYSOWANIE
  // ----------------------------------------------------------

  if (
    gameName === 'draw'
  ) {
    game.active = true;
    game.strokeCount = 0;
    game.lastStrokeAt =
      Date.now();
  }

  // ----------------------------------------------------------
  // ŁAŃCUCH SŁÓW
  // ----------------------------------------------------------

  if (
    gameName === 'word'
  ) {
    game.chain =
      [WORD_START];

    game.used =
      new Set([
        WORD_START
          .toLocaleLowerCase(
            'pl-PL'
          )
      ]);

    game.turn = a;
    game.active = true;
  }

  // ----------------------------------------------------------
  // POZOSTAŁE GRY
  // ----------------------------------------------------------

  if (
    [
      'ab',
      'guess',
      'truth',
      'speed',
      'emoji',
      'compat'
    ].includes(gameName)
  ) {
    game.active = true;

    game.answers =
      new Map();

    game.submissions =
      new Map();

    game.challenge =
      null;
  }

  return game;
}

// ============================================================
// KÓŁKO I KRZYŻYK
// ============================================================

function tttWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
  ];

  for (
    const [
      x,
      y,
      z
    ] of lines
  ) {
    if (
      board[x] &&
      board[x] === board[y] &&
      board[x] === board[z]
    ) {
      return board[x];
    }
  }

  if (
    board.every(Boolean)
  ) {
    return 'draw';
  }

  return null;
}

function handleTtt(
  game,
  socket,
  data
) {
  const index =
    Number(data?.index);

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > 8
  ) {
    return sendGameError(
      socket,
      'Nieprawidłowe pole.'
    );
  }

  if (
    !game.active ||
    game.turn !== socket.id ||
    game.board[index]
  ) {
    return sendGameError(
      socket,
      'To nie jest teraz Twój ruch.'
    );
  }

  game.board[index] =
    game.symbol[socket.id];

  const result =
    tttWinner(
      game.board
    );

  if (result) {
    game.active = false;

    const text =
      result === 'draw'
        ? 'Remis.'
        : `Wygrywa ${result}.`;

    emitGame(
      game,
      {
        game: 'ttt',
        board: game.board,
        turn:
          result === 'draw'
            ? ''
            : result,
        active: false,
        status:
          'Koniec gry',
        result: text
      }
    );

    return;
  }

  game.turn =
    game.turn === game.a
      ? game.b
      : game.a;

  emitGame(
    game,
    {
      game: 'ttt',
      board: game.board,
      turn:
        game.symbol[
          game.turn
        ],
      active: true,
      status:
        game.turn === socket.id
          ? 'Twój ruch'
          : 'Ruch partnera',
      result: ''
    }
  );
}

// ============================================================
// RYSOWANIE
// ============================================================

function handleDraw(
  game,
  socket,
  data
) {
  if (!game.active) {
    return;
  }

  const now =
    Date.now();

  let rate =
    drawRate.get(
      socket.id
    );

  if (
    !rate ||
    now - rate.start >=
      60 * 1000
  ) {
    rate = {
      start: now,
      count: 0
    };

    drawRate.set(
      socket.id,
      rate
    );
  }

  rate.count += 1;

  if (
    rate.count >
    MAX_DRAW_STROKES_PER_MINUTE
  ) {
    return sendGameError(
      socket,
      'Rysujesz zbyt szybko.'
    );
  }

  const action =
    safeString(
      data?.action,
      20
    );

  if (
    action === 'clear'
  ) {
    emitGame(
      game,
      {
        game: 'draw',
        action: 'clear'
      }
    );

    return;
  }

  if (
    action !== 'stroke'
  ) {
    return;
  }

  const from =
    data?.from;

  const to =
    data?.to;

  if (
    ![
      from?.x,
      from?.y,
      to?.x,
      to?.y
    ].every(
      Number.isFinite
    )
  ) {
    return;
  }

  const color =
    /^#[0-9a-f]{3,8}$/i.test(
      String(
        data?.color || ''
      )
    )
      ? String(
          data.color
        )
      : '#111611';

  const width =
    Math.min(
      20,
      Math.max(
        1,
        Number(
          data?.width
        ) || 5
      )
    );

  emitGame(
    game,
    {
      game: 'draw',
      action: 'stroke',

      from: {
        x: Math.min(
          1,
          Math.max(
            0,
            from.x
          )
        ),
        y: Math.min(
          1,
          Math.max(
            0,
            from.y
          )
        )
      },

      to: {
        x: Math.min(
          1,
          Math.max(
            0,
            to.x
          )
        ),
        y: Math.min(
          1,
          Math.max(
            0,
            to.y
          )
        )
      },

      color,
      width
    }
  );
}

// ============================================================
// ŁAŃCUCH SŁÓW
// ============================================================

function normalizeWord(
  word
) {
  return safeString(
    word,
    40
  )
    .toLocaleLowerCase(
      'pl-PL'
    )
    .replace(
      /[^a-ząćęłńóśźż]/g,
      ''
    );
}

function handleWord(
  game,
  socket,
  data
) {
  if (
    !game.active ||
    game.turn !== socket.id
  ) {
    return sendGameError(
      socket,
      'Teraz ruch ma partner.'
    );
  }

  const word =
    normalizeWord(
      data?.word
    );

  if (
    word.length < 2 ||
    word.length > 40
  ) {
    return sendGameError(
      socket,
      'Nieprawidłowe słowo.'
    );
  }

  const last =
    game.chain[
      game.chain.length - 1
    ];

  const needed =
    last
      .slice(-1)
      .toLocaleLowerCase(
        'pl-PL'
      );

  if (
    word[0] !== needed
  ) {
    return sendGameError(
      socket,
      `Słowo musi zaczynać się na ${needed.toUpperCase()}.`
    );
  }

  if (
    game.used.has(word)
  ) {
    return sendGameError(
      socket,
      'To słowo już było.'
    );
  }

  game.used.add(
    word
  );

  game.chain.push(
    word
  );

  game.turn =
    game.turn === game.a
      ? game.b
      : game.a;

  if (
    game.chain.length > 100
  ) {
    game.chain =
      game.chain.slice(
        -80
      );
  }

  emitGame(
    game,
    {
      game: 'word',
      chain: game.chain,
      turn: game.turn,
      active: true,
      status:
        game.turn === socket.id
          ? 'Twój ruch'
          : 'Ruch partnera'
    }
  );
}

// ============================================================
// GRY RUNDOWE
// ============================================================

function handleRoundChoice(
  game,
  socket,
  data
) {
  const action =
    safeString(
      data?.action,
      30
    );

  const round =
    Number.isInteger(
      Number(data?.round)
    )
      ? Number(
          data.round
        )
      : game.round;

  // ----------------------------------------------------------
  // A/B
  // ZGADNIJ MNIE
  // ZGODNOŚĆ
  // ----------------------------------------------------------

  if (
    game.game === 'ab' ||
    game.game === 'compat' ||
    game.game === 'guess'
  ) {
    const choice =
      Number(
        data?.choice
      );

    if (
      !Number.isInteger(
        choice
      ) ||
      choice < 0 ||
      choice > 1
    ) {
      return sendGameError(
        socket,
        'Nieprawidłowy wybór.'
      );
    }

    const key =
      `${socket.id}:${round}`;

    game.answers.set(
      key,
      choice
    );

    const other =
      gamePartner(
        socket.id
      );

    const otherKey =
      `${other}:${round}`;

    const ready =
      game.answers.has(
        otherKey
      );

    emitGame(
      game,
      {
        game:
          game.game,
        action:
          'choice',
        round,
        player:
          socket.id,
        choice,
        ready
      }
    );

    if (ready) {
      const mine =
        game.answers.get(
          key
        );

      const theirs =
        game.answers.get(
          otherKey
        );

      let result = '';

      if (
        game.game === 'ab' ||
        game.game === 'compat'
      ) {
        result =
          mine === theirs
            ? 'Macie taki sam wybór.'
            : 'Macie różne wybory.';
      }

      if (
        game.game === 'guess'
      ) {
        result =
          mine === theirs
            ? 'Trafione — partner wybrał tak samo.'
            : 'Nie tym razem — partner wybrał inaczej.';
      }

      game.round =
        round + 1;

      emitGame(
        game,
        {
          game:
            game.game,
          action:
            'roundResult',
          round,
          mine,
          theirs,
          result,
          nextRound:
            game.round,
          active: true
        }
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // EMOJI
  // ----------------------------------------------------------

  if (
    game.game === 'emoji'
  ) {
    const index =
      Math.max(
        0,
        Math.min(
          EMOJI_PUZZLES.length - 1,
          Number(
            data?.index
          ) || 0
        )
      );

    const answer =
      safeString(
        data?.answer,
        100
      )
        .toLocaleLowerCase(
          'pl-PL'
        );

    const correct =
      answer ===
      EMOJI_PUZZLES[
        index
      ][1]
        .toLocaleLowerCase(
          'pl-PL'
        );

    emitGame(
      game,
      {
        game: 'emoji',
        action: 'result',
        index,
        correct,
        answer: correct
          ? EMOJI_PUZZLES[
              index
            ][1]
          : null,
        player:
          socket.id
      }
    );

    return;
  }

  // ----------------------------------------------------------
  // 60 SEKUND
  // ----------------------------------------------------------

  if (
    game.game === 'speed'
  ) {
    if (
      action !== 'propose'
    ) {
      return sendGameError(
        socket,
        'Nieprawidłowa akcja.'
      );
    }

    const challenge =
      safeString(
        data?.challenge,
        180
      );

    if (!challenge) {
      return sendGameError(
        socket,
        'Brak wyzwania.'
      );
    }

    game.challenge = {
      text: challenge,
      from:
        socket.id,
      at:
        Date.now()
    };

    emitGame(
      game,
      {
        game: 'speed',
        action:
          'challenge',
        challenge,
        from:
          socket.id,
        seconds: 60,
        active: true
      }
    );

    return;
  }

  // ----------------------------------------------------------
  // 2 PRAWDY / 1 KŁAMSTWO
  // ----------------------------------------------------------

  if (
    game.game === 'truth'
  ) {
    if (
      action !== 'send'
    ) {
      return sendGameError(
        socket,
        'Nieprawidłowa akcja.'
      );
    }

    const items =
      Array.isArray(
        data?.items
      )
        ? data.items
            .slice(0, 3)
            .map(
              item =>
                safeString(
                  item,
                  180
                )
            )
        : [];

    const lie =
      Number(
        data?.lie
      );

    if (
      items.length !== 3 ||
      items.some(
        x => !x
      ) ||
      !Number.isInteger(
        lie
      ) ||
      lie < 0 ||
      lie > 2
    ) {
      return sendGameError(
        socket,
        'Potrzebne są trzy zdania i wskazanie kłamstwa.'
      );
    }

    game.submissions.set(
      socket.id,
      {
        items,
        lie,
        round
      }
    );

    const other =
      gamePartner(
        socket.id
      );

    if (
      !game.submissions.has(
        other
      )
    ) {
      emitGame(
        game,
        {
          game: 'truth',
          action:
            'submitted',
          round,
          player:
            socket.id,
          waiting: true
        }
      );

      return;
    }

    const otherData =
      game.submissions.get(
        other
      );

    emitGame(
      game,
      {
        game: 'truth',
        action:
          'reveal',
        round,
        submissions: [
          game.submissions.get(
            socket.id
          ),
          otherData
        ],
        active: true
      }
    );

    game.submissions.clear();

    game.round =
      round + 1;
  }
}

// ============================================================
// OBSŁUGA game:action
// ============================================================

function handleGameAction(
  socket,
  data
) {
  const game =
    gameFor(
      socket.id
    );

  if (!game) {
    return sendGameError(
      socket,
      'Nie masz aktywnej gry.'
    );
  }

  const partnerId =
    gamePartner(
      socket.id
    );

  if (
    !partnerId ||
    getPartner(
      socket.id
    ) !== partnerId
  ) {
    clearGame(
      game,
      false
    );

    return sendGameError(
      socket,
      'Połączenie z partnerem zostało zakończone.'
    );
  }

  const requestedGame =
    safeString(
      data?.game,
      30
    );

  if (
    requestedGame !==
    game.game
  ) {
    return sendGameError(
      socket,
      'Ta akcja dotyczy innej gry.'
    );
  }

  if (
    game.game === 'ttt'
  ) {
    return handleTtt(
      game,
      socket,
      data
    );
  }

  if (
    game.game === 'draw'
  ) {
    return handleDraw(
      game,
      socket,
      data
    );
  }

  if (
    game.game === 'word'
  ) {
    return handleWord(
      game,
      socket,
      data
    );
  }

  return handleRoundChoice(
    game,
    socket,
    data
  );
}

// ============================================================
// ZAPROSZENIA DO GIER
// ============================================================

function handleGameInvite(
  socket,
  data
) {
  const partnerId =
    getPartner(
      socket.id
    );

  const game =
    safeString(
      data?.game,
      30
    );

  if (!partnerId) {
    return sendGameError(
      socket,
      'Najpierw połącz się z partnerem.'
    );
  }

  if (
    !GAME_NAMES.has(
      game
    )
  ) {
    return sendGameError(
      socket,
      'Nieznana gra.'
    );
  }

  if (
    gameFor(
      socket.id
    ) ||
    gameFor(
      partnerId
    )
  ) {
    return sendGameError(
      socket,
      'W tej rozmowie jest już aktywna gra.'
    );
  }

  const existing =
    pendingInvites.get(
      partnerId
    );

  if (
    existing &&
    existing.expiresAt >
      Date.now()
  ) {
    return sendGameError(
      socket,
      'Partner ma już oczekujące zaproszenie.'
    );
  }

  const expiresAt =
    Date.now() +
    GAME_INVITE_TTL;

  pendingInvites.set(
    partnerId,
    {
      from:
        socket.id,
      game,
      expiresAt
    }
  );

  io.to(
    partnerId
  ).emit(
    'game:invite',
    {
      game,
      from:
        socket.id,
      expiresAt
    }
  );
}

// ============================================================
// ODPOWIEDŹ NA ZAPROSZENIE
// ============================================================

function handleGameInviteResponse(
  socket,
  data
) {
  const invite =
    pendingInvites.get(
      socket.id
    );

  const game =
    safeString(
      data?.game,
      30
    );

  const accepted =
    data?.accepted === true;

  if (
    !invite ||
    invite.expiresAt <
      Date.now() ||
    invite.game !== game ||
    !isConnected(
      invite.from
    )
  ) {
    pendingInvites.delete(
      socket.id
    );

    return sendGameError(
      socket,
      'Zaproszenie wygasło lub jest nieaktualne.'
    );
  }

  pendingInvites.delete(
    socket.id
  );

  const inviter =
    invite.from;

  // ----------------------------------------------------------
  // ODRZUCENIE
  // ----------------------------------------------------------

  if (!accepted) {
    io.to(
      inviter
    ).emit(
      'game:inviteResponse',
      {
        game,
        accepted: false
      }
    );

    return;
  }

  // ----------------------------------------------------------
  // WALIDACJA POŁĄCZENIA
  // ----------------------------------------------------------

  if (
    getPartner(
      socket.id
    ) !== inviter ||
    gameFor(
      socket.id
    ) ||
    gameFor(
      inviter
    )
  ) {
    io.to(
      inviter
    ).emit(
      'game:inviteResponse',
      {
        game,
        accepted: false,
        reason:
          'Gra nie może zostać rozpoczęta.'
      }
    );

    return sendGameError(
      socket,
      'Gra nie może zostać rozpoczęta.'
    );
  }

  // ----------------------------------------------------------
  // UTWORZENIE GRY
  // ----------------------------------------------------------

  const gameState =
    createGameState(
      game,
      inviter,
      socket.id
    );

  gameBySocket.set(
    inviter,
    gameState
  );

  gameBySocket.set(
    socket.id,
    gameState
  );

  io.to(
    inviter
  ).emit(
    'game:inviteResponse',
    {
      game,
      accepted: true
    }
  );

  io.to(
    socket.id
  ).emit(
    'game:inviteResponse',
    {
      game,
      accepted: true
    }
  );

  emitInitialGameState(
    gameState
  );
}

// ============================================================
// POCZĄTKOWY STAN GRY
// ============================================================

function emitInitialGameState(
  game
) {
  if (
    game.game === 'ttt'
  ) {
    emitGame(
      game,
      {
        game: 'ttt',
        board:
          game.board,
        turn:
          game.turn ===
          game.a
            ? 'X'
            : 'O',
        active: true,
        status:
          'Gra rozpoczęta',
        result: ''
      }
    );

    return;
  }

  if (
    game.game === 'word'
  ) {
    emitGame(
      game,
      {
        game: 'word',
        chain:
          game.chain,
        turn:
          game.turn,
        active: true,
        status:
          'Gra rozpoczęta'
      }
    );

    return;
  }

  if (
    game.game === 'draw'
  ) {
    emitGame(
      game,
      {
        game: 'draw',
        action: 'clear',
        active: true
      }
    );

    return;
  }

  emitGame(
    game,
    {
      game:
        game.game,
      action:
        'start',
      round: 0,
      active: true,
      status:
        'Gra rozpoczęta'
    }
  );
}

// ============================================================
// ROZBIJANIE PARY
// ============================================================

function breakPair(
  socketId,
  notifyPartner = true
) {
  const partnerId =
    pairs[socketId];

  removeFromWaiting(
    socketId
  );

  if (!partnerId) {
    return;
  }

  // Partner dostępny do zgłoszenia
  // jeszcze po zakończeniu rozmowy.
  lastPartnerForReport.set(
    socketId,
    partnerId
  );

  lastPartnerForReport.set(
    partnerId,
    socketId
  );

  // Zakończ grę.
  const game =
    gameFor(
      socketId
    );

  if (game) {
    clearGame(
      game,
      false
    );
  }

  pendingInvites.delete(
    socketId
  );

  pendingInvites.delete(
    partnerId
  );

  delete pairs[
    socketId
  ];

  delete pairs[
    partnerId
  ];

  photoCounts.delete(
    socketId
  );

  photoCounts.delete(
    partnerId
  );

  removeFromWaiting(
    partnerId
  );

  if (
    notifyPartner &&
    isConnected(
      partnerId
    )
  ) {
    io.to(
      partnerId
    ).emit(
      'partnerStopped'
    );
  }
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on(
  'connection',
  socket => {
    console.log(
      'Nowe połączenie użytkownika:',
      socket.id
    );

    emitOnlineCount();

    // ========================================================
    // START CZATU
    // ========================================================

    socket.on(
      'startChat',
      () => {
        // Nowy START oznacza nową sesję.
        lastPartnerForReport.delete(
          socket.id
        );

        reportedThisSession.delete(
          socket.id
        );

        // ----------------------------------------------------
        // OCHRONA PRZED PODWÓJNYM STARTEM
        // ----------------------------------------------------

        if (
          pairs[socket.id]
        ) {
          console.log(
            `START zignorowany — ${socket.id} jest już połączony.`
          );

          return;
        }

        // ----------------------------------------------------
        // OCHRONA PRZED DRUGIM OCZEKIWANIEM
        // ----------------------------------------------------

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

        photoCounts.set(
          socket.id,
          0
        );

        // ----------------------------------------------------
        // CZYSZCZENIE KOLEJKI
        // ----------------------------------------------------

        waitingUsers =
          waitingUsers.filter(
            id =>
              isConnected(id) &&
              id !== socket.id &&
              !pairs[id]
          );

        // ----------------------------------------------------
        // SZUKANIE PARTNERA
        // ----------------------------------------------------

        let partnerId =
          null;

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
            !pairs[
              candidate
            ]
          ) {
            partnerId =
              candidate;

            break;
          }
        }

        // ----------------------------------------------------
        // BRAK PARTNERA
        // ----------------------------------------------------

        if (!partnerId) {
          waitingUsers.push(
            socket.id
          );

          console.log(
            `${socket.id} czeka na partnera...`
          );

          return;
        }

        // ----------------------------------------------------
        // OCHRONA PRZED SAMOPOŁĄCZENIEM
        // ----------------------------------------------------

        if (
          partnerId ===
          socket.id
        ) {
          waitingUsers.unshift(
            socket.id
          );

          return;
        }

        // ----------------------------------------------------
        // OCHRONA PRZED WYŚCIGIEM
        // ----------------------------------------------------

        if (
          pairs[
            partnerId
          ] ||
          pairs[
            socket.id
          ]
        ) {
          waitingUsers.push(
            socket.id
          );

          return;
        }

        // ----------------------------------------------------
        // UTWORZENIE PARY
        // ----------------------------------------------------

        pairs[
          socket.id
        ] =
          partnerId;

        pairs[
          partnerId
        ] =
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

        emitOnlineCount();

        console.log(
          `Para utworzona: ${socket.id} <-> ${partnerId}`
        );
      }
    );

    // ========================================================
    // WIADOMOŚCI
    // ========================================================

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
          typeof msg ===
          'string'
            ? msg
            : (
                msg &&
                msg.type ===
                  'text'
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

        // ----------------------------------------------------
        // BLOKADA K14
        // ----------------------------------------------------

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
              5000
            )
        };

        // Tylko partner.
        io.to(
          partnerId
        ).emit(
          'receiveMessage',
          payload
        );
      }
    );

    // ========================================================
    // ZDJĘCIE
    // ========================================================

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

        // Tylko nasze uploady.
        if (
          typeof url !==
            'string' ||
          !url.startsWith(
            '/uploads/'
          )
        ) {
          return;
        }

        // ----------------------------------------------------
        // MAKSYMALNIE 1 ZDJĘCIE
        // ----------------------------------------------------

        const count =
          photoCounts.get(
            socket.id
          ) || 0;

        if (
          count >= 1
        ) {
          socket.emit(
            'photoLimitReached',
            'W tej rozmowie można wysłać maksymalnie 1 zdjęcie.'
          );

          return;
        }

        photoCounts.set(
          socket.id,
          1
        );

        io.to(
          partnerId
        ).emit(
          'receiveMessage',
          {
            type: 'photo',
            content: url
          }
        );
      }
    );

    // ========================================================
    // ZGŁOSZENIE UŻYTKOWNIKA
    // ========================================================

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

        // Jedno zgłoszenie
        // na sesję.
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

        const reason =
          ALLOWED_REPORT_REASONS.has(
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
                  500
                )
            : '';

        const report = {
          id:
            `${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,

          createdAt:
            new Date()
              .toISOString(),

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

    // ========================================================
    // GRY — ZAPROSZENIE
    // ========================================================

    socket.on(
      'game:invite',
      data => {
        handleGameInvite(
          socket,
          data
        );
      }
    );

    // ========================================================
    // GRY — AKCEPTACJA / ODRZUCENIE
    // ========================================================

    socket.on(
      'game:inviteResponse',
      data => {
        handleGameInviteResponse(
          socket,
          data
        );
      }
    );

    // ========================================================
    // GRY — RUCH
    // ========================================================

    socket.on(
      'game:action',
      data => {
        handleGameAction(
          socket,
          data
        );
      }
    );

    // ========================================================
    // GRY — DOBROWOLNE ZAKOŃCZENIE
    // ========================================================

    socket.on(
      'game:leave',
      () => {
        const game =
          gameFor(
            socket.id
          );

        if (game) {
          clearGame(
            game,
            true
          );
        }
      }
    );

    // ========================================================
    // STOP CZATU
    // ========================================================

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

        breakPair(
          socket.id,
          true
        );

        emitOnlineCount();
      }
    );

    // ========================================================
    // ROZŁĄCZENIE
    // ========================================================

    socket.on(
      'disconnect',
      () => {
        reportedThisSession.delete(
          socket.id
        );

        photoCounts.delete(
          socket.id
        );

        lastPartnerForReport.delete(
          socket.id
        );

        drawRate.delete(
          socket.id
        );

        pendingInvites.delete(
          socket.id
        );

        const game =
          gameFor(
            socket.id
          );

        if (game) {
          clearGame(
            game,
            true
          );
        }

        breakPair(
          socket.id,
          true
        );

        emitOnlineCount();

        console.log(
          'Użytkownik opuścił czat:',
          socket.id
        );
      }
    );
  }
);

// ============================================================
// CZYSZCZENIE WYGASŁYCH ZAPROSZEŃ
// ============================================================

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        recipient,
        invite
      ] of pendingInvites
    ) {
      if (
        invite.expiresAt <=
        now
      ) {
        pendingInvites.delete(
          recipient
        );

        if (
          isConnected(
            invite.from
          )
        ) {
          io.to(
            invite.from
          ).emit(
            'game:inviteResponse',
            {
              game:
                invite.game,
              accepted:
                false,
              reason:
                'Zaproszenie wygasło.'
            }
          );
        }
      }
    }
  },
  10 * 1000
).unref();

// ============================================================
// START SERWERA
// ============================================================

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  () => {
    console.log(
      `Serwer działa na porcie ${PORT}`
    );
  }
);