const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== Redis Configuration =====
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const MESSAGE_HISTORY_LIMIT = 100;
const REDIS_KEY = 'chat:messages';

const redisClient = createClient({
  url: `redis://${REDIS_HOST}:${REDIS_PORT}`
});

redisClient.on('error', (err) => {
  console.error('❌ Redis connection error:', err.message);
});

redisClient.on('connect', () => {
  console.log(`📦 Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);
});

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('❌ Failed to connect to Redis:', err.message);
    console.log('⚠️  Server will continue without message persistence');
  }
})();

// ===== Helper: Save message to Redis =====
async function saveMessage(message) {
  try {
    if (redisClient.isReady) {
      await redisClient.rPush(REDIS_KEY, JSON.stringify(message));
      // Trim to keep only the last N messages
      await redisClient.lTrim(REDIS_KEY, -MESSAGE_HISTORY_LIMIT, -1);
    }
  } catch (err) {
    console.error('Error saving message to Redis:', err.message);
  }
}

// ===== Helper: Get message history from Redis =====
async function getMessageHistory() {
  try {
    if (redisClient.isReady) {
      const messages = await redisClient.lRange(REDIS_KEY, 0, -1);
      return messages.map(msg => JSON.parse(msg));
    }
  } catch (err) {
    console.error('Error fetching message history from Redis:', err.message);
  }
  return [];
}

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Kubernetes probes
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    redis: redisClient.isReady ? 'connected' : 'disconnected',
    uptime: process.uptime()
  });
});

// Store connected users
const users = new Map();
let userCounter = 0;

// Generate random color for each user
function generateColor() {
  const colors = [
    '#6C5CE7', '#00B894', '#E17055', '#0984E3',
    '#D63031', '#E84393', '#00CEC9', '#FDCB6E',
    '#A29BFE', '#55EFC4', '#FAB1A0', '#74B9FF',
    '#FF7675', '#FD79A8', '#81ECEC', '#FFEAA7'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Broadcast message to all connected clients
function broadcast(data, excludeWs = null) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(message);
    }
  });
}

// Get online users list
function getOnlineUsers() {
  const onlineUsers = [];
  users.forEach((user) => {
    onlineUsers.push({
      username: user.username,
      color: user.color,
      id: user.id
    });
  });
  return onlineUsers;
}

// Broadcast updated user list to everyone
function broadcastUserList() {
  const data = {
    type: 'userList',
    users: getOnlineUsers()
  };
  broadcast(data);
}

wss.on('connection', async (ws) => {
  userCounter++;
  const userId = `user_${userCounter}_${Date.now()}`;
  const userColor = generateColor();

  // Store user with default name
  users.set(ws, {
    id: userId,
    username: `Guest`,
    color: userColor,
    joinedAt: new Date()
  });

  // Fetch message history from Redis
  const history = await getMessageHistory();

  // Send welcome message with user info and chat history
  ws.send(JSON.stringify({
    type: 'welcome',
    userId: userId,
    color: userColor,
    onlineUsers: getOnlineUsers()
  }));

  // Send chat history to the new user
  if (history.length > 0) {
    ws.send(JSON.stringify({
      type: 'chatHistory',
      messages: history
    }));
  }

  // Notify others that a new user connected
  broadcast({
    type: 'system',
    message: 'A new user has connected',
    timestamp: new Date().toISOString()
  }, ws);

  broadcastUserList();

  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage.toString());

      switch (data.type) {
        case 'setUsername': {
          const oldName = users.get(ws).username;
          users.get(ws).username = data.username.trim().slice(0, 20) || 'Guest';
          const newName = users.get(ws).username;

          // Notify everyone about the name change
          const systemMsg = {
            type: 'system',
            message: `${oldName === 'Guest' ? 'A user' : oldName} is now known as ${newName}`,
            timestamp: new Date().toISOString()
          };
          broadcast(systemMsg);
          await saveMessage(systemMsg);

          broadcastUserList();
          break;
        }

        case 'chat': {
          const user = users.get(ws);
          if (!data.message || !data.message.trim()) return;

          const chatMessage = {
            type: 'chat',
            userId: user.id,
            username: user.username,
            color: user.color,
            message: data.message.trim().slice(0, 1000),
            timestamp: new Date().toISOString()
          };

          // Save to Redis before broadcasting
          await saveMessage(chatMessage);

          // Send to all clients including sender
          broadcast(chatMessage);
          break;
        }

        case 'typing': {
          const user = users.get(ws);
          broadcast({
            type: 'typing',
            username: user.username,
            userId: user.id
          }, ws);
          break;
        }

        case 'stopTyping': {
          const user = users.get(ws);
          broadcast({
            type: 'stopTyping',
            userId: user.id
          }, ws);
          break;
        }
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', async () => {
    const user = users.get(ws);
    if (user) {
      const leaveMsg = {
        type: 'system',
        message: `${user.username} has left the chat`,
        timestamp: new Date().toISOString()
      };
      broadcast(leaveMsg);
      await saveMessage(leaveMsg);
      users.delete(ws);
      broadcastUserList();
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    users.delete(ws);
    broadcastUserList();
  });
});

// Graceful shutdown
async function shutdown() {
  console.log('\n🛑 Shutting down gracefully...');
  try {
    if (redisClient.isReady) {
      await redisClient.quit();
      console.log('📦 Redis connection closed');
    }
  } catch (err) {
    console.error('Error closing Redis:', err.message);
  }
  server.close(() => {
    console.log('📡 HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 K8s Chat App is running!`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server ready`);
  console.log(`📦 Redis: ${REDIS_HOST}:${REDIS_PORT}\n`);
});
