const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const multer = require('multer'); // do uploadu zdjęć
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ścieżka do folderu z plikami frontendu
const publicPath = path.join(__dirname, './');
app.use(express.static(publicPath));

// Folder do uploadu zdjęć
const uploadFolder = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadFolder),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// --- ROUTE DO UPLOADU ZDJĘCIA ---
app.post('/upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).send({ error: 'Brak pliku' });
  res.send({ url: '/uploads/' + req.file.filename });
});
app.use('/uploads', express.static(uploadFolder));

let waitingUsers = [];
let pairs = {};

io.on('connection', (socket) => {
  console.log('Nowe połączenie użytkownika:', socket.id);

  // START CZATU
  socket.on('startChat', () => {
    console.log(`${socket.id} szuka partnera...`);
    if (waitingUsers.length > 0) {
      const partnerId = waitingUsers.shift();
      pairs[socket.id] = partnerId;
      pairs[partnerId] = socket.id;
      io.to(socket.id).emit('partnerFound');
      io.to(partnerId).emit('partnerFound');
      console.log(`Para utworzona: ${socket.id} <-> ${partnerId}`);
    } else {
      waitingUsers.push(socket.id);
    }
  });

  // WIADOMOŚCI
  socket.on('sendMessage', (msg) => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      // jeśli msg jest string, traktujemy jako tekst, jeśli obiekt z type: photo, wysyłamy photo
      let payload;
      if (typeof msg === 'string') payload = { type: 'text', content: msg };
      else payload = msg; 
      io.to(partnerId).emit('receiveMessage', payload);
    }
  });

  // WYŚLIJ ZDJĘCIE
  socket.on('sendPhoto', (url) => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('receiveMessage', { type: 'photo', content: url });
    }
  });

  // STOP CZATU
  socket.on('stopChat', () => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('partnerStopped');
      delete pairs[partnerId];
    }
    delete pairs[socket.id];
    waitingUsers = waitingUsers.filter(id => id !== socket.id);
  });

  // ROZŁĄCZENIE
  socket.on('disconnect', () => {
    console.log('Użytkownik opuścił czat:', socket.id);
    const partnerId = pairs[socket.id];
    if (partnerId) io.to(partnerId).emit('partnerStopped');
    delete pairs[socket.id];
    waitingUsers = waitingUsers.filter(id => id !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
