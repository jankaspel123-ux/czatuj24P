const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Frontend
const publicPath = __dirname;
app.use(express.static(publicPath));

// Uploady zdjęć
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
      : '.bin';

    const uniqueName =
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`;

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 8 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(
        new Error('Dozwolone są wyłącznie pliki graficzne.')
      );
    }

    cb(null, true);
  }
});

// ============================================================
// SPRAWDZENIE, CZY PLIK JEST PRAWDOPODOBNIE OBRAZEM
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

// ============================================================
// UPLOAD ZDJĘCIA
// ============================================================

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

// Udostępnianie zdjęć
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
const photoCounts = new Map();

// ============================================================
// BLOKADA ZAKAZANEGO OKREŚLENIA
// ============================================================
//
// Wykrywa również podstawowe warianty z odstępami,
// np. "k 1 4".
//
// Blokada działa po stronie serwera, więc nie można
// jej ominąć przez ręczne wysłanie eventu Socket.IO.
// ============================================================

const blockedTermRegex =
  /(^|[^a-z0-9])k\s*1\s*4([^a-z0-9]|$)/iu;

function containsBlockedTerm(text) {
  return blockedTermRegex.test(
    String(text || '').normalize('NFKC')
  );
}

// ============================================================
// ZGŁOSZENIA
// ============================================================

const reportsFile =
  path.join(__dirname, 'reports.json');

// Użytkownicy, którzy już zgłosili partnera
// w bieżącej sesji.
const reportedThisSession = new Set();

// Ostatni partner zostaje dostępny do zgłoszenia
// do czasu rozpoczęcia nowej sesji.
const lastPartnerForReport = new Map();


// ------------------------------------------------------------
// Zapis zgłoszenia
// ------------------------------------------------------------

function saveReport(report) {
  let reports = [];

  try {
    if (fs.existsSync(reportsFile)) {
      const raw = fs.readFileSync(
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

// ============================================================
// FUNKCJE POMOCNICZE
// ============================================================

function removeFromWaiting(socketId) {
  waitingUsers =
    waitingUsers.filter(
      id => id !== socketId
    );
}


function isConnected(socketId) {
  return io.sockets.sockets.has(
    socketId
  );
}


function emitOnlineCount() {
  io.emit(
    'onlineCount',
    io.engine.clientsCount
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


// ============================================================
// ROZBIJANIE PARY
// ============================================================

function breakPair(
  socketId,
  notifyPartner = true
) {
  const partnerId =
    pairs[socketId];

  removeFromWaiting(socketId);

  if (!partnerId) {
    return;
  }

  // Zachowujemy ostatniego partnera,
  // żeby można było zgłosić go chwilę
  // po zakończeniu rozmowy.

  lastPartnerForReport.set(
    socketId,
    partnerId
  );

  lastPartnerForReport.set(
    partnerId,
    socketId
  );

  delete pairs[socketId];
  delete pairs[partnerId];

  // Reset limitu zdjęć dla obu stron.
  photoCounts.delete(socketId);
  photoCounts.delete(partnerId);

  removeFromWaiting(partnerId);

  if (
    notifyPartner &&
    isConnected(partnerId)
  ) {
    io.to(partnerId).emit(
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

        // Nowa sesja zamyka możliwość
        // zgłoszenia poprzedniego partnera.

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

        // ----------------------------------------------------
        // Jeden socket = jedna aktywna sesja
        // ----------------------------------------------------

        if (pairs[socket.id]) {

          console.log(
            `START zignorowany — ${socket.id} jest już połączony.`
          );

          return;
        }

        // ----------------------------------------------------
        // Nie można wejść do kolejki drugi raz
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

        // ----------------------------------------------------
        // Czyścimy martwe sockety z kolejki
        // ----------------------------------------------------

        waitingUsers =
          waitingUsers.filter(
            id =>
              isConnected(id) &&
              id !== socket.id
          );

        // ----------------------------------------------------
        // Szukanie partnera
        // ----------------------------------------------------

        let partnerId = null;

        while (
          waitingUsers.length
        ) {

          const candidate =
            waitingUsers.shift();

          if (
            candidate !==
              socket.id &&
            isConnected(candidate) &&
            !pairs[candidate]
          ) {

            partnerId =
              candidate;

            break;
          }
        }

        // ----------------------------------------------------
        // Nie ma partnera
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
        // Ochrona przed samoparowaniem
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
        // Ochrona przed wyścigiem
        // ----------------------------------------------------

        if (
          pairs[partnerId] ||
          pairs[socket.id]
        ) {

          waitingUsers.push(
            socket.id
          );

          return;
        }

        // ----------------------------------------------------
        // TWORZENIE PARY
        // ----------------------------------------------------

        pairs[socket.id] =
          partnerId;

        pairs[partnerId] =
          socket.id;

        // Reset zdjęć na początku
        // nowej rozmowy.

        photoCounts.set(
          socket.id,
          0
        );

        photoCounts.set(
          partnerId,
          0
        );

        // ----------------------------------------------------
        // Informujemy obie strony
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // BLOKADA ZAKAZANEGO OKREŚLENIA
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

        let payload;

        if (
          typeof msg ===
          'string'
        ) {

          payload = {
            type: 'text',
            content:
              msg.slice(
                0,
                5000
              )
          };

        } else if (
          msg &&
          msg.type === 'text'
        ) {

          payload = {
            type: 'text',
            content:
              String(
                msg.content ||
                ''
              ).slice(
                0,
                5000
              )
          };

        } else {

          return;
        }

        // ----------------------------------------------------
        // Wysyłamy wyłącznie do partnera
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // Akceptujemy wyłącznie nasze uploady
        // ----------------------------------------------------

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
        // Maksymalnie 3 zdjęcia
        // na jedną rozmowę
        // ----------------------------------------------------

        const count =
          photoCounts.get(
            socket.id
          ) || 0;

        if (count >= 3) {

          socket.emit(
            'photoLimitReached',
            'W tej rozmowie można wysłać maksymalnie 3 zdjęcia.'
          );

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
            content: url
          }
        );
      }
    );


    // ========================================================
    // ZGŁOSZENIE PARTNERA
    // ========================================================

    socket.on(
      'reportUser',
      data => {

        // Można zgłosić:
        //
        // 1. aktywnego partnera
        // 2. ostatniego partnera chwilę po STOP
        //
        // do czasu rozpoczęcia nowej sesji.

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

        // ----------------------------------------------------
        // Jedno zgłoszenie na sesję
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // Dozwolone powody
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // Opis użytkownika
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // Tworzymy zgłoszenie
        // ----------------------------------------------------

        const report = {
          id:
            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,

          createdAt:
            new Date().toISOString(),

          reason,

          details,

          reporterSocketId:
            socket.id,

          reportedSocketId:
            partnerId
        };

        // ----------------------------------------------------
        // Zapis
        // ----------------------------------------------------

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

        console.log(
          `${socket.id} kończy czat.`
        );

        breakPair(
          socket.id,
          true
        );
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

        console.log(
          'Użytkownik opuścił czat:',
          socket.id
        );

        breakPair(
          socket.id,
          true
        );

        emitOnlineCount();
      }
    );

  }
);


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