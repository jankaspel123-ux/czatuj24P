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

    const allowedExtensions = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.avif'
    ];

    const safeExt = allowedExtensions.includes(ext)
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
// UPLOAD ZDJĘCIA
// ============================================================

app.post('/upload', (req, res) => {
  upload.single('photo')(req, res, err => {
    if (err) {
      return res.status(400).json({
        error: err.message || 'Nieprawidłowy plik.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Brak pliku.'
      });
    }

    res.json({
      url: '/uploads/' + encodeURIComponent(req.file.filename)
    });
  });
});

// Udostępnianie przesłanych zdjęć
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

// Para wygląda tak:
//
// pairs[userA] = userB
// pairs[userB] = userA
//
const pairs = Object.create(null);


// ------------------------------------------------------------
// Usuwa użytkownika z kolejki oczekujących
// ------------------------------------------------------------

function removeFromWaiting(socketId) {
  waitingUsers = waitingUsers.filter(
    id => id !== socketId
  );
}


// ------------------------------------------------------------
// Sprawdza, czy socket nadal istnieje
// ------------------------------------------------------------

function isConnected(socketId) {
  return io.sockets.sockets.has(socketId);
}


// ------------------------------------------------------------
// Wysyła aktualną liczbę połączonych użytkowników
// ------------------------------------------------------------

function emitOnlineCount() {
  io.emit(
    'onlineCount',
    io.engine.clientsCount
  );
}


// ------------------------------------------------------------
// Pobiera partnera danego użytkownika
// ------------------------------------------------------------

function getPartner(socketId) {
  const partnerId = pairs[socketId];

  if (!partnerId) {
    return null;
  }

  if (!isConnected(partnerId)) {
    return null;
  }

  return partnerId;
}


// ------------------------------------------------------------
// Rozłączenie pary
// ------------------------------------------------------------

function breakPair(socketId, notifyPartner = true) {
  const partnerId = pairs[socketId];

  // Zawsze usuwamy użytkownika z kolejki
  removeFromWaiting(socketId);

  // Usuwamy jego parę
  delete pairs[socketId];

  // Jeśli miał partnera
  if (partnerId) {
    // Usuwamy również parę partnera
    delete pairs[partnerId];

    // Partner nie może pozostać przypadkiem w kolejce
    removeFromWaiting(partnerId);

    // Informujemy partnera
    if (
      notifyPartner &&
      isConnected(partnerId)
    ) {
      io.to(partnerId).emit('partnerStopped');
    }
  }
}


// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', socket => {

  console.log(
    'Nowe połączenie użytkownika:',
    socket.id
  );

  // Aktualizujemy licznik online
  emitOnlineCount();


  // ==========================================================
  // START CZATU
  // ==========================================================

  socket.on('startChat', () => {

    // --------------------------------------------------------
    // OCHRONA 1:
    // Użytkownik jest już w aktywnej parze.
    // Nie wolno tworzyć kolejnej.
    // --------------------------------------------------------

    if (pairs[socket.id]) {

      console.log(
        `START zignorowany — ${socket.id} jest już połączony.`
      );

      return;
    }


    // --------------------------------------------------------
    // OCHRONA 2:
    // Użytkownik już znajduje się w kolejce.
    // Nie dodajemy go drugi raz.
    // --------------------------------------------------------

    if (waitingUsers.includes(socket.id)) {

      console.log(
        `START zignorowany — ${socket.id} już czeka.`
      );

      return;
    }


    // --------------------------------------------------------
    // Czyszczenie kolejki ze starych socketów.
    //
    // Dodatkowo pilnujemy, żeby użytkownik nie znalazł się
    // sam dla siebie.
    // --------------------------------------------------------

    waitingUsers = waitingUsers.filter(id => {
      return (
        isConnected(id) &&
        id !== socket.id
      );
    });


    // --------------------------------------------------------
    // Szukanie partnera
    // --------------------------------------------------------

    let partnerId = null;

    while (waitingUsers.length) {

      const candidate = waitingUsers.shift();


      // Kandydat musi:
      //
      // 1. nie być tym samym socketem
      // 2. nadal być połączony
      // 3. nie mieć już partnera
      //

      if (
        candidate !== socket.id &&
        isConnected(candidate) &&
        !pairs[candidate]
      ) {

        partnerId = candidate;
        break;
      }
    }


    // --------------------------------------------------------
    // Nie znaleziono partnera
    // --------------------------------------------------------

    if (!partnerId) {

      waitingUsers.push(socket.id);

      console.log(
        `${socket.id} czeka na partnera...`
      );

      return;
    }


    // --------------------------------------------------------
    // OSTATECZNA ochrona przed połączeniem z samym sobą
    // --------------------------------------------------------

    if (partnerId === socket.id) {

      waitingUsers.unshift(socket.id);

      console.log(
        `Samoparowanie zablokowane dla ${socket.id}.`
      );

      return;
    }


    // --------------------------------------------------------
    // Ochrona przed wyścigiem dwóch STARTów
    // --------------------------------------------------------

    if (
      pairs[partnerId] ||
      pairs[socket.id]
    ) {

      // Jeśli coś jest nie tak,
      // przywracamy użytkownika do kolejki.

      if (!waitingUsers.includes(socket.id)) {
        waitingUsers.push(socket.id);
      }

      return;
    }


    // --------------------------------------------------------
    // TWORZENIE PARY
    // --------------------------------------------------------

    pairs[socket.id] = partnerId;
    pairs[partnerId] = socket.id;


    // --------------------------------------------------------
    // Informujemy obie strony
    // --------------------------------------------------------

    io.to(socket.id).emit(
      'partnerFound'
    );

    io.to(partnerId).emit(
      'partnerFound'
    );


    console.log(
      `Para utworzona: ${socket.id} <-> ${partnerId}`
    );
  });


  // ==========================================================
  // WIADOMOŚCI TEKSTOWE
  // ==========================================================

  socket.on('sendMessage', msg => {

    const partnerId = getPartner(socket.id);

    // Brak partnera = nic nie wysyłamy
    if (!partnerId) {
      return;
    }


    let payload;


    // --------------------------------------------------------
    // Stara wersja frontendu wysyła zwykły string
    // --------------------------------------------------------

    if (typeof msg === 'string') {

      payload = {
        type: 'text',
        content: msg.slice(0, 5000)
      };

    }

    // --------------------------------------------------------
    // Obsługa wiadomości jako obiektu
    // --------------------------------------------------------

    else if (
      msg &&
      msg.type === 'text'
    ) {

      payload = {
        type: 'text',
        content: String(
          msg.content || ''
        ).slice(0, 5000)
      };

    }

    // --------------------------------------------------------
    // Nieznany typ wiadomości
    // --------------------------------------------------------

    else {

      return;
    }


    // --------------------------------------------------------
    // Wysyłamy wiadomość WYŁĄCZNIE do partnera
    // --------------------------------------------------------

    io.to(partnerId).emit(
      'receiveMessage',
      payload
    );
  });


  // ==========================================================
  // ZDJĘCIA
  // ==========================================================

  socket.on('sendPhoto', url => {

    const partnerId = getPartner(socket.id);

    if (!partnerId) {
      return;
    }


    // Przyjmujemy wyłącznie nasze lokalne uploady
    if (
      typeof url !== 'string' ||
      !url.startsWith('/uploads/')
    ) {

      return;
    }


    io.to(partnerId).emit(
      'receiveMessage',
      {
        type: 'photo',
        content: url
      }
    );
  });


  // ==========================================================
  // STOP CZATU
  // ==========================================================

  socket.on('stopChat', () => {

    // Jeśli użytkownik nie jest ani w parze,
    // ani w kolejce — nic nie robimy.

    if (
      !pairs[socket.id] &&
      !waitingUsers.includes(socket.id)
    ) {

      return;
    }


    console.log(
      `${socket.id} kończy czat.`
    );


    // Rozbijamy parę i informujemy partnera
    breakPair(
      socket.id,
      true
    );
  });


  // ==========================================================
  // DISCONNECT
  // ==========================================================

  socket.on('disconnect', () => {

    console.log(
      'Użytkownik opuścił czat:',
      socket.id
    );


    // Rozłączamy ewentualnego partnera
    breakPair(
      socket.id,
      true
    );


    // Aktualizujemy licznik online
    emitOnlineCount();
  });

});


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