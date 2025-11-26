require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const sharp = require('sharp');
const mime = require('mime-types');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@adiwajshing/baileys');

const PORT = process.env.PORT || 3001;
const BOT_NAME = process.env.BOT_DISPLAY_NAME || 'yehazz md';
const AUTH_DIR_ROOT = path.join(__dirname, 'auth');

fs.ensureDirSync(AUTH_DIR_ROOT);

const app = express();
app.use(require('cors')());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let sock = null;
let currentSessionId = 'default';
let currentAuthPath = path.join(AUTH_DIR_ROOT, currentSessionId);

async function startSock() {
  fs.ensureDirSync(currentAuthPath);
  const logger = pino({ level: 'info' });
  const { state, saveCreds } = await useMultiFileAuthState(currentAuthPath);

  const { version } = await fetchLatestBaileysVersion();
  console.log('Using WA version', version);

  sock = makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    version
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      const qr = update.qr;
      const dataUrl = await qrcode.toDataURL(qr);
      io.emit('qr', { qr, dataUrl });
    }

    if (update.connection === 'open') {
      console.log('Connected to WhatsApp as', sock.user && sock.user.id);
      try { await sock.updateProfileName(BOT_NAME); } catch(e){}

      const WELCOME_TARGET = process.env.WELCOME_TARGET || null;
      if (WELCOME_TARGET) {
        const jid = WELCOME_TARGET.includes('@') ? WELCOME_TARGET : `${WELCOME_TARGET}@s.whatsapp.net`;
        try {
          await sock.sendMessage(jid, { text: `${BOT_NAME} WhatsApp Bot Connected Successfully!` });
        } catch(e){}
      }

      io.emit('connected', { status: 'connected', name: BOT_NAME, user: sock.user });
    }

    if (update.connection === 'close') {
      const reason = update.lastDisconnect?.error?.output?.statusCode || update.lastDisconnect?.error?.message || 'unknown';
      console.log('connection closed', reason);
      io.emit('disconnected', { status: 'disconnected', reason });

      if (update.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        try { await fs.remove(currentAuthPath); } catch(e){}
      }

      setTimeout(() => startSock(), 3000);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (!m.messages) return;
      const msg = m.messages[0];
      if (!msg.message) return;
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;
      if (msg.key.fromMe) return;

      const content = msg.message;
      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const sender = (msg.key.participant || msg.key.remoteJid).replace(/:.*$/,'');
      const body = (content.conversation || content.extendedTextMessage?.text || content?.imageMessage?.caption || content?.videoMessage?.caption || '').trim();
      if (!body) return;
      if (!body.startsWith('.')) return;

      const args = body.split(' ').filter(Boolean);
      const command = args[0].slice(1).toLowerCase();

      const replyText = async (text) => {
        await sock.sendMessage(from, { text }, { quoted: msg });
      };

      if (command === 'menu' || command === 'help') {
        const sectionsText = `*Yehazz MD — Commands*\n\n` +
          `*.menu* - Show this menu\n` +
          `*.sticker* - Reply to an image with .sticker to convert image -> sticker\n` +
          `*.download <url>* - Bot downloads file from URL and sends it\n` +
          `*.yt <youtube-url>* - Download audio from YouTube\n` +
          `*.whoami* - Show who invoked the command\n` +
          `*.add <number>* - Add user to group (group only)\n` +
          `*.kick* - Kick mentioned user (group only)\n\n_Prefix: dot (.)_`;

        const templateButtons = [
          { index: 1, urlButton: { displayText: 'Website', url: 'https://your-frontend-domain.com' } },
          { index: 2, quickReplyButton: { displayText: '.menu', id: '.menu' } },
          { index: 3, quickReplyButton: { displayText: '.sticker', id: '.sticker' } },
        ];

        const template = {
          templateMessage: {
            hydratedTemplate: {
              hydratedContentText: sectionsText,
              hydratedFooterText: BOT_NAME,
              hydratedButtons: templateButtons
            }
          }
        };

        await sock.sendMessage(from, template, { quoted: msg });
        return;
      }

      if (command === 'whoami') {
        await replyText(`You: ${sender}\nChat: ${from}\nBot: ${BOT_NAME}`);
        return;
      }

      if (command === 'sticker') {
        let imageMessage = null;
        if (content.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
          imageMessage = content.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
        } else if (content.imageMessage) {
          imageMessage = content.imageMessage;
        }

        if (!imageMessage) {
          await replyText('Reply to an image with `.sticker` or send an image with `.sticker` caption.');
          return;
        }

        const buffer = await sock.downloadMediaMessage(msg, 'buffer');
        try {
          const webpBuffer = await sharp(buffer)
            .resize(512, 512, { fit: 'cover' })
            .webp({ lossless: true })
            .toBuffer();

          await sock.sendMessage(from, { sticker: webpBuffer }, { quoted: msg });
        } catch (e) {
          await replyText('Failed to create sticker: ' + (e.message || e));
        }
        return;
      }

      if (command === 'download') {
        const url = args[1];
        if (!url) {
          await replyText('Usage: .download <url>');
          return;
        }
        await replyText('Downloading, please wait...');
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('fetch error ' + res.status);
          const contentType = res.headers.get('content-type') || 'application/octet-stream';
          const ext = mime.extension(contentType) || 'bin';
          const buffer = await res.buffer();

          if (contentType.startsWith('image/')) {
            await sock.sendMessage(from, { image: buffer, caption: `Downloaded file (${url})` }, { quoted: msg });
          } else if (contentType.startsWith('video/')) {
            await sock.sendMessage(from, { video: buffer, caption: `Downloaded file (${url})` }, { quoted: msg });
          } else {
            await sock.sendMessage(from, { document: buffer, fileName: `file.${ext}`, mimetype: contentType }, { quoted: msg });
          }
        } catch (e) {
          await replyText('Download failed: ' + (e.message || e));
        }
        return;
      }

      if (command === 'sendimg') {
        const url = args[1];
        if (!url) return replyText('Usage: .sendimg <image-url>');
        await replyText('Fetching image...');
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('fetch error ' + res.status);
          const buffer = await res.buffer();
          await sock.sendMessage(from, { image: buffer, caption: `Image from ${url}` }, { quoted: msg });
        } catch (e) {
          await replyText('Failed to send image: ' + (e.message || e));
        }
        return;
      }

      if (command === 'sendvid') {
        const url = args[1];
        if (!url) return replyText('Usage: .sendvid <video-url>');
        await replyText('Fetching video (may be large) ...');
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('fetch error ' + res.status);
          const buffer = await res.buffer();
          await sock.sendMessage(from, { video: buffer, caption: `Video from ${url}` }, { quoted: msg });
        } catch (e) {
          await replyText('Failed to send video: ' + (e.message || e));
        }
        return;
      }

      if (command === 'yt') {
        const url = args[1];
        if (!url) return replyText('Usage: .yt <youtube-url>');
        await replyText('Downloading audio, please wait...');
        try {
          if (!ytdl.validateURL(url)) throw new Error('Not a valid YouTube URL');
          const info = await ytdl.getInfo(url);
          const title = info.videoDetails.title.substring(0, 60);
          const stream = ytdl(url, { quality: 'highestaudio' });
          const chunks = [];
          stream.on('data', c => chunks.push(c));
          await new Promise((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('error', reject);
          });
          const buffer = Buffer.concat(chunks);
          await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg', fileName: `${title}.mp3` }, { quoted: msg });
        } catch (e) {
          await replyText('Failed to download audio: ' + (e.message || e));
        }
        return;
      }

      // Group commands
      if (command === 'kick') {
        if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: 'Group only command' }, { quoted: msg });
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mention) return sock.sendMessage(from, { text: 'Tag the user you want to kick' }, { quoted: msg });
        await sock.groupParticipantsUpdate(from, mention, 'remove');
        return;
      }

      if (command === 'add') {
        if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: 'Group only command' }, { quoted: msg });
        const number = args[1];
        if (!number) return sock.sendMessage(from, { text: 'Example: .add 9477xxxxxxx' }, { quoted: msg });
        await sock.groupParticipantsUpdate(from, [number + '@s.whatsapp.net'], 'add');
        return;
      }

      if (command === 'promote') {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mention) return sock.sendMessage(from, { text: 'Tag a user to promote' }, { quoted: msg });
        await sock.groupParticipantsUpdate(from, mention, 'promote');
        return;
      }

      if (command === 'demote') {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mention) return sock.sendMessage(from, { text: 'Tag a user to demote' }, { quoted: msg });
        await sock.groupParticipantsUpdate(from, mention, 'demote');
        return;
      }

      if (command === 'ginfo') {
        if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: 'Group only command' }, { quoted: msg });
        const metadata = await sock.groupMetadata(from);
        const textMsg = `*Group Info*\nName: ${metadata.subject}\nMembers: ${metadata.participants.length}\nID: ${from}`;
        await sock.sendMessage(from, { text: textMsg }, { quoted: msg });
        return;
      }

      await replyText(`Unknown command: .${command}\nSend .menu to see commands.`);
    } catch (err) {
      console.error('handler error', err);
    }
  });

  app.post('/api/send', async (req, res) => {
    try {
      const { to, text } = req.body;
      if (!sock) return res.status(500).json({ error: 'not connected' });
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err?.message || err });
    }
  });

  app.get('/api/status', (req, res) => {
    res.json({ connected: !!sock?.user, name: BOT_NAME, user: sock?.user || null });
  });

  return sock;
}

io.on('connection', (socket) => {
  socket.emit('hello', { msg: 'welcome' });
  if (sock?.user) socket.emit('connected', { status: 'connected', name: BOT_NAME, user: sock.user });

  socket.on('send', async (d) => {
    try {
      const to = d.to;
      const text = d.text;
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
      socket.emit('sent', { ok: true });
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('command', async (d) => {
    try {
      const payload = d.command;
      const target = d.to;
      if (!sock) return socket.emit('error', { message: 'not connected' });
      if (target) {
        const jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: payload });
        socket.emit('ok', { sent: true });
      } else {
        socket.emit('error', { message: 'target required' });
      }
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });
});

startSock().catch(err => console.error('startSock error', err));
server.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
