const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ścieżka do folderu z plikami frontendu
const publicPath = path.join(__dirname, './');
app.use(express.static(publicPath));

let waitingUsers = [];
let pairs = {};

io.on('connection', (socket) => {
  console.log('Nowe połączenie użytkownika:', socket.id);

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

  socket.on('sendMessage', (msg) => {
    const partnerId = pairs[socket.id];
    if (partnerId) io.to(partnerId).emit('receiveMessage', msg);
  });

  socket.on('stopChat', () => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('partnerStopped');
      delete pairs[partnerId];
    }
    delete pairs[socket.id];
    waitingUsers = waitingUsers.filter(id => id !== socket.id);
  });

  socket.on('disconnect', () => {
    console.log('Użytkownik opuścił czat:', socket.id);
    const partnerId = pairs[socket.id];
    if (partnerId) io.to(partnerId).emit('partnerStopped');
    delete pairs[socket.id];
    waitingUsers = waitingUsers.filter(id => id !== socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
