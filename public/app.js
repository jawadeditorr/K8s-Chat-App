// ===== K8s Chat App - Client Side =====

class ChatApp {
  constructor() {
    this.ws = null;
    this.userId = null;
    this.username = '';
    this.userColor = '';
    this.typingTimeout = null;
    this.isTyping = false;
    this.typingUsers = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;

    this.init();
  }

  init() {
    // Cache DOM elements
    this.elements = {
      usernameModal: document.getElementById('usernameModal'),
      usernameForm: document.getElementById('usernameForm'),
      usernameInput: document.getElementById('usernameInput'),
      joinBtn: document.getElementById('joinBtn'),
      appContainer: document.getElementById('appContainer'),
      sidebar: document.getElementById('sidebar'),
      sidebarClose: document.getElementById('sidebarClose'),
      menuBtn: document.getElementById('menuBtn'),
      onlineCount: document.getElementById('onlineCount'),
      userList: document.getElementById('userList'),
      connectionStatus: document.getElementById('connectionStatus'),
      messagesContainer: document.getElementById('messagesContainer'),
      messagesList: document.getElementById('messagesList'),
      messageForm: document.getElementById('messageForm'),
      messageInput: document.getElementById('messageInput'),
      sendBtn: document.getElementById('sendBtn'),
      typingIndicator: document.getElementById('typingIndicator')
    };

    this.bindEvents();
    this.showEmptyState();
  }

  bindEvents() {
    // Username form
    this.elements.usernameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.joinChat();
    });

    // Message form
    this.elements.messageForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendMessage();
    });

    // Typing indicator
    this.elements.messageInput.addEventListener('input', () => {
      this.handleTyping();
    });

    // Sidebar toggle (mobile)
    this.elements.menuBtn.addEventListener('click', () => {
      this.toggleSidebar(true);
    });

    this.elements.sidebarClose.addEventListener('click', () => {
      this.toggleSidebar(false);
    });

    // Enter key handling
    this.elements.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
  }

  joinChat() {
    const name = this.elements.usernameInput.value.trim();
    if (!name) {
      this.elements.usernameInput.focus();
      this.elements.usernameInput.style.borderColor = '#e74c3c';
      setTimeout(() => {
        this.elements.usernameInput.style.borderColor = '';
      }, 1500);
      return;
    }

    this.username = name;
    this.elements.usernameModal.style.animation = 'fadeOut 0.3s ease forwards';

    setTimeout(() => {
      this.elements.usernameModal.style.display = 'none';
      this.elements.appContainer.style.display = 'flex';
      this.elements.messageInput.focus();
      this.connectWebSocket();
    }, 300);
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);
    this.updateConnectionStatus('connecting');

    this.ws.onopen = () => {
      console.log('✅ Connected to WebSocket server');
      this.updateConnectionStatus('connected');
      this.reconnectAttempts = 0;

      // Send username
      this.ws.send(JSON.stringify({
        type: 'setUsername',
        username: this.username
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.ws.onclose = () => {
      console.log('❌ Disconnected from server');
      this.updateConnectionStatus('disconnected');
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.updateConnectionStatus('disconnected');
    };
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.addSystemMessage('Unable to reconnect. Please refresh the page.');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);

    setTimeout(() => {
      console.log(`🔄 Reconnect attempt ${this.reconnectAttempts}...`);
      this.connectWebSocket();
    }, delay);
  }

  handleMessage(data) {
    switch (data.type) {
      case 'welcome':
        this.userId = data.userId;
        this.userColor = data.color;
        this.updateUserList(data.onlineUsers);
        break;

      case 'chat':
        this.addChatMessage(data);
        break;

      case 'system':
        this.addSystemMessage(data.message, data.timestamp);
        break;

      case 'userList':
        this.updateUserList(data.users);
        break;

      case 'typing':
        this.showTyping(data.username, data.userId);
        break;

      case 'stopTyping':
        this.hideTyping(data.userId);
        break;
    }
  }

  sendMessage() {
    const message = this.elements.messageInput.value.trim();
    if (!message || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      type: 'chat',
      message: message
    }));

    this.elements.messageInput.value = '';
    this.stopTyping();
    this.elements.messageInput.focus();
  }

  handleTyping() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (!this.isTyping) {
      this.isTyping = true;
      this.ws.send(JSON.stringify({ type: 'typing' }));
    }

    clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      this.stopTyping();
    }, 2000);
  }

  stopTyping() {
    if (this.isTyping && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.isTyping = false;
      this.ws.send(JSON.stringify({ type: 'stopTyping' }));
    }
    clearTimeout(this.typingTimeout);
  }

  addChatMessage(data) {
    // Remove empty state if present
    const emptyState = this.elements.messagesList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const isOwn = data.userId === this.userId;
    const messageEl = document.createElement('div');
    messageEl.className = `message${isOwn ? ' own' : ''}`;

    const initials = data.username.slice(0, 2);
    const time = this.formatTime(data.timestamp);

    messageEl.innerHTML = `
      <div class="message-avatar" style="background: ${data.color}">${initials}</div>
      <div class="message-content">
        <div class="message-header">
          <span class="message-username" style="color: ${data.color}">${this.escapeHtml(data.username)}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-text">${this.escapeHtml(data.message)}</div>
      </div>
    `;

    this.elements.messagesList.appendChild(messageEl);
    this.scrollToBottom();
  }

  addSystemMessage(message, timestamp) {
    // Remove empty state if present
    const emptyState = this.elements.messagesList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `<span class="system-message-text">${this.escapeHtml(message)}</span>`;

    this.elements.messagesList.appendChild(el);
    this.scrollToBottom();
  }

  updateUserList(users) {
    this.elements.onlineCount.textContent = users.length;
    this.elements.userList.innerHTML = '';

    users.forEach(user => {
      const isYou = user.id === this.userId;
      const li = document.createElement('li');
      li.className = `user-item${isYou ? ' is-you' : ''}`;

      const initials = user.username.slice(0, 2);

      li.innerHTML = `
        <div class="user-avatar" style="background: ${user.color}">${initials}</div>
        <span class="user-name">${this.escapeHtml(user.username)}</span>
      `;

      this.elements.userList.appendChild(li);
    });
  }

  showTyping(username, userId) {
    this.typingUsers.set(userId, username);
    this.updateTypingIndicator();

    // Auto-clear after 3 seconds
    setTimeout(() => {
      this.hideTyping(userId);
    }, 3000);
  }

  hideTyping(userId) {
    this.typingUsers.delete(userId);
    this.updateTypingIndicator();
  }

  updateTypingIndicator() {
    const el = this.elements.typingIndicator;

    if (this.typingUsers.size === 0) {
      el.textContent = 'Everyone can see messages here';
      el.classList.remove('typing');
      return;
    }

    el.classList.add('typing');
    const names = Array.from(this.typingUsers.values());

    if (names.length === 1) {
      el.textContent = `${names[0]} is typing...`;
    } else if (names.length === 2) {
      el.textContent = `${names[0]} and ${names[1]} are typing...`;
    } else {
      el.textContent = `${names.length} people are typing...`;
    }
  }

  updateConnectionStatus(status) {
    const el = this.elements.connectionStatus;
    const dot = el.querySelector('.status-dot');
    const text = el.querySelector('span:last-child');

    dot.className = 'status-dot';

    switch (status) {
      case 'connected':
        dot.classList.add('connected');
        text.textContent = 'Connected';
        break;
      case 'connecting':
        text.textContent = 'Connecting...';
        break;
      case 'disconnected':
        text.textContent = 'Disconnected';
        break;
    }
  }

  toggleSidebar(open) {
    let overlay = document.querySelector('.sidebar-overlay');

    if (open) {
      this.elements.sidebar.classList.add('open');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay active';
        overlay.addEventListener('click', () => this.toggleSidebar(false));
        document.body.appendChild(overlay);
      } else {
        overlay.classList.add('active');
      }
    } else {
      this.elements.sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('active');
    }
  }

  showEmptyState() {
    this.elements.messagesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🚀</div>
        <div class="empty-state-title">Welcome to K8s Chat</div>
        <div class="empty-state-text">Send a message to start the conversation. All connected users will see your messages in real time.</div>
      </div>
    `;
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
    });
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Add fadeOut keyframe dynamically
const style = document.createElement('style');
style.textContent = `@keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }`;
document.head.appendChild(style);

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  new ChatApp();
});
