const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

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

wss.on('connection', (ws) => {
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

  // Send welcome message with user info
  ws.send(JSON.stringify({
    type: 'welcome',
    userId: userId,
    color: userColor,
    onlineUsers: getOnlineUsers()
  }));

  // Notify others that a new user connected
  broadcast({
    type: 'system',
    message: 'A new user has connected',
    timestamp: new Date().toISOString()
  }, ws);

  broadcastUserList();

  ws.on('message', (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage.toString());

      switch (data.type) {
        case 'setUsername': {
          const oldName = users.get(ws).username;
          users.get(ws).username = data.username.trim().slice(0, 20) || 'Guest';
          const newName = users.get(ws).username;

          // Notify everyone about the name change
          broadcast({
            type: 'system',
            message: `${oldName === 'Guest' ? 'A user' : oldName} is now known as ${newName}`,
            timestamp: new Date().toISOString()
          });

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

  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      broadcast({
        type: 'system',
        message: `${user.username} has left the chat`,
        timestamp: new Date().toISOString()
      });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 K8s Chat App is running!`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server ready\n`);
});
