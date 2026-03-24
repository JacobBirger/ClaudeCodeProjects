'use strict';

const { v4: uuidv4 } = require('uuid');

// In-memory session store: sessionId -> AppState
const sessions = new Map();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function createSession() {
  const sessionId = uuidv4();
  const session = {
    sessionId,
    phase: 'OVERVIEW',
    messages: [],
    pendingTransition: null,
    storyData: {
      overview: '',
      characters: [],
      currentCharacterIndex: 0,
      structure: {
        acts: { one: '', two: '', three: '' },
        ending: '',
        themes: [],
        moods: [],
        genre: '',
        messages: []
      },
      scenes: [],
      writingStyle: {
        notes: '',
        examples: []
      }
    },
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivityAt = Date.now();
  }
  return session || null;
}

function saveSession(session) {
  session.lastActivityAt = Date.now();
  sessions.set(session.sessionId, session);
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

// Clean up expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

module.exports = { createSession, getSession, saveSession, deleteSession };
