const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let isConnected = false;
let latestQr = null;
let isStarting = false;

const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');

function resetSessionFiles() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Error clearing session files:', err.message);
  }
  isConnected = false;
  latestQr = null;
}

async function startBaileys() {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQr = await QRCode.toDataURL(qr);
        io.emit('qr', latestQr);
        io.emit('status', { type: 'qr', msg: 'Scan the QR code or request a Pairing Code.' });
      }

      if (connection === 'open') {
        isConnected = true;
        latestQr = null;
        io.emit('status', { type: 'connected', msg: 'Connected to WhatsApp.' });
      } else if (connection === 'close') {
        isConnected = false;
        latestQr = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          io.emit('status', { type: 'reconnecting', msg: 'Connection lost. Reconnecting...' });
          isStarting = false;
          setTimeout(startBaileys, 3000);
        } else {
          io.emit('status', { type: 'disconnected', msg: 'Session logged out. Ready to relink.' });
          resetSessionFiles();
          isStarting = false;
          setTimeout(startBaileys, 3000);
        }
      }
    });
  } catch (err) {
    console.error('Baileys startup error:', err.message);
  } finally {
    isStarting = false;
  }
}

io.on('connection', (socket) => {
  if (isConnected) {
    socket.emit('status', { type: 'connected', msg: 'Connected to WhatsApp.' });
  } else if (latestQr) {
    socket.emit('status', { type: 'qr', msg: 'Scan QR code or use Pairing Code below.' });
    socket.emit('qr', latestQr);
  } else {
    socket.emit('status', { type: 'loading', msg: 'Starting WhatsApp connection engine...' });
  }

  socket.on('request_pairing_code', async (phoneNumber) => {
    try {
      if (!sock) {
        socket.emit('log', '⚠️ Engine not initialized yet. Wait a moment...');
        return;
      }
      if (sock.authState?.creds?.registered) {
        socket.emit('log', '⚠️ Client is already paired and registered.');
        return;
      }

      const cleanNumber = phoneNumber.replace(/\D/g, '');
      socket.emit('log', `⏳ Requesting pairing code for ${cleanNumber}...`);

      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(cleanNumber);
          socket.emit('pairing_code', code);
          socket.emit('log', '✅ Pairing code generated! Check WhatsApp notifications on your phone.');
        } catch (err) {
          socket.emit('log', `⚠️ Failed to fetch code: ${err.message}`);
        }
      }, 2000);
    } catch (err) {
      socket.emit('log', `⚠️ Request error: ${err.message}`);
    }
  });

  socket.on('reset_session', () => {
    socket.emit('log', '⚠️ Securely logging out and resetting session...');
    
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (err) {}
      sock = null;
    }

    setTimeout(() => {
      resetSessionFiles();
      socket.emit('status', { type: 'loading', msg: 'Generating fresh session parameters...' });
      setTimeout(startBaileys, 1500);
    }, 1000);
  });

  socket.on('check_numbers', async (numbers) => {
    if (!isConnected || !sock) {
      socket.emit('log', '⚠️ Engine not ready. Pair a device first.');
      return;
    }

    socket.emit('log', `\n🚀 Initiating batch verification for ${numbers.length} targets...`);
    
    for (let i = 0; i < numbers.length; i++) {
      let num = numbers[i].replace(/\D/g, '');
      if (num.length === 10) num = `91${num}`; // Auto-add India code if missing

      try {
        const targetJid = `${num}@s.whatsapp.net`;
        const result = await sock.onWhatsApp(targetJid);
        
        if (result && result.length > 0 && result[0].exists) {
          socket.emit('log', `✅ [VALID]   ${num}`);
        } else {
          socket.emit('log', `❌ [INVALID] ${num}`);
        }
      } catch (err) {
        socket.emit('log', `⚠️ [ERROR]   ${num} - ${err.message}`);
      }

      // Randomized anti-ban delay (3 to 7 seconds)
      if (i < numbers.length - 1) {
        const delay = Math.floor(Math.random() * (7000 - 3000 + 1)) + 3000;
        await new Promise(res => setTimeout(res, delay));
      }
    }
    socket.emit('log', '🏁 Batch verification complete.');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web server active on port ${PORT}`);
  startBaileys();
});
