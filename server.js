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
const ONLINE_USERS_KEY = 'chat:online_users';
const REDIS_CHANNEL = 'chat:events';

const redisClient = createClient({
  url: `redis://${REDIS_HOST}:${REDIS_PORT}`
});
const redisSubscriber = redisClient.duplicate();

redisClient.on('error', (err) => console.error('❌ Redis client error:', err.message));
redisSubscriber.on('error', (err) => console.error('❌ Redis subscriber error:', err.message));

redisClient.on('connect', () => console.log(`📦 Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`));

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
    await redisSubscriber.connect();
    
    // Subscribe to events channel
    await redisSubscriber.subscribe(REDIS_CHANNEL, (messageStr) => {
      try {
        const { eventType, excludeUserId, payload } = JSON.parse(messageStr);
        // Forward the message to local WebSocket clients
        broadcastLocal(payload, excludeUserId);
      } catch (err) {
        console.error('Error parsing pub/sub message:', err);
      }
    });
  } catch (err) {
    console.error('❌ Failed to connect to Redis:', err.message);
    console.log('⚠️  Server will continue without message persistence and horizontal scaling');
  }
})();

// ===== Helper: Save message to Redis =====
async function saveMessage(message) {
  try {
    if (redisClient.isReady) {
      await redisClient.rPush(REDIS_KEY, JSON.stringify(message));
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
    console.error('Error fetching message history:', err.message);
  }
  return [];
}

// ===== Helper: Online Users =====
async function addOnlineUser(user) {
  if (redisClient.isReady) {
    await redisClient.hSet(ONLINE_USERS_KEY, user.id, JSON.stringify(user));
  }
}

async function removeOnlineUser(userId) {
  if (redisClient.isReady) {
    await redisClient.hDel(ONLINE_USERS_KEY, userId);
  }
}

async function getOnlineUsers() {
  if (!redisClient.isReady) {
    // Fallback to local
    const onlineUsers = [];
    users.forEach(u => onlineUsers.push({ username: u.username, color: u.color, id: u.id }));
    return onlineUsers;
  }
  
  const usersMap = await redisClient.hGetAll(ONLINE_USERS_KEY);
  return Object.values(usersMap).map(u => JSON.parse(u));
}

// ===== Broadcast Helpers =====

// Local broadcast to clients connected to THIS pod
function broadcastLocal(data, excludeUserId = null) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const user = users.get(client);
      if (excludeUserId && user && user.id === excludeUserId) return;
      client.send(message);
    }
  });
}

// Global broadcast via Redis Pub/Sub
async function broadcastGlobal(data, excludeUserId = null) {
  if (redisClient.isReady) {
    const payload = JSON.stringify({
      eventType: data.type,
      excludeUserId,
      payload: data
    });
    await redisClient.publish(REDIS_CHANNEL, payload);
  } else {
    // Fallback if redis is down
    broadcastLocal(data, excludeUserId);
  }
}

// Broadcast updated user list
async function broadcastUserList() {
  const onlineUsers = await getOnlineUsers();
  const data = {
    type: 'userList',
    users: onlineUsers
  };
  await broadcastGlobal(data);
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

// Store connected users (locally for this pod)
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

wss.on('connection', async (ws) => {
  userCounter++;
  const userId = `user_${process.pid}_${userCounter}_${Date.now()}`;
  const userColor = generateColor();

  const newUser = {
    id: userId,
    username: `Guest`,
    color: userColor,
    joinedAt: new Date().toISOString()
  };

  // Store user locally
  users.set(ws, newUser);
  
  // Store user globally
  await addOnlineUser(newUser);

  // Fetch message history from Redis
  const history = await getMessageHistory();
  const currentOnlineUsers = await getOnlineUsers();

  // Send welcome message with user info and chat history
  ws.send(JSON.stringify({
    type: 'welcome',
    userId: userId,
    color: userColor,
    onlineUsers: currentOnlineUsers
  }));

  // Send chat history to the new user
  if (history.length > 0) {
    ws.send(JSON.stringify({
      type: 'chatHistory',
      messages: history
    }));
  }

  // Notify others that a new user connected
  const systemMsg = {
    type: 'system',
    message: 'A new user has connected',
    timestamp: new Date().toISOString()
  };
  await broadcastGlobal(systemMsg, userId);
  await broadcastUserList();

  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage.toString());

      switch (data.type) {
        case 'setUsername': {
          const user = users.get(ws);
          const oldName = user.username;
          user.username = data.username.trim().slice(0, 20) || 'Guest';
          const newName = user.username;

          // Update globally
          await addOnlineUser(user);

          // Notify everyone about the name change
          const nameChangeMsg = {
            type: 'system',
            message: `${oldName === 'Guest' ? 'A user' : oldName} is now known as ${newName}`,
            timestamp: new Date().toISOString()
          };
          
          await saveMessage(nameChangeMsg);
          await broadcastGlobal(nameChangeMsg);
          await broadcastUserList();
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

          // Send to all clients
          await broadcastGlobal(chatMessage);
          break;
        }

        case 'typing': {
          const user = users.get(ws);
          await broadcastGlobal({
            type: 'typing',
            username: user.username,
            userId: user.id
          }, user.id);
          break;
        }

        case 'stopTyping': {
          const user = users.get(ws);
          await broadcastGlobal({
            type: 'stopTyping',
            userId: user.id
          }, user.id);
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
      await removeOnlineUser(user.id);
      
      const leaveMsg = {
        type: 'system',
        message: `${user.username} has left the chat`,
        timestamp: new Date().toISOString()
      };
      
      await saveMessage(leaveMsg);
      await broadcastGlobal(leaveMsg);
      users.delete(ws);
      await broadcastUserList();
    }
  });

  ws.on('error', async (err) => {
    console.error('WebSocket error:', err);
    const user = users.get(ws);
    if (user) {
      await removeOnlineUser(user.id);
      users.delete(ws);
      await broadcastUserList();
    }
  });
});

// Graceful shutdown
async function shutdown() {
  console.log('\n🛑 Shutting down gracefully...');
  
  // Clean up all users connected to this pod from Redis
  for (const [ws, user] of users.entries()) {
    try {
      await removeOnlineUser(user.id);
    } catch (err) {}
  }
  
  try {
    if (redisClient.isReady) {
      await redisSubscriber.quit();
      await redisClient.quit();
      console.log('📦 Redis connections closed');
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
  console.log(`📡 Server: http://localhost:${PORT} (PID: ${process.pid})`);
  console.log(`🔌 WebSocket server ready`);
  console.log(`📦 Redis: ${REDIS_HOST}:${REDIS_PORT}\n`);
});
