'use strict';

const express = require('express');
const router = express.Router();

const { createSession, getSession, saveSession } = require('../lib/sessionStore');
const { streamChat, extractCharacters, inferWritingStyle } = require('../lib/claude');
const { generatePDF } = require('../lib/pdfGenerator');
const { PHASES, PHASE_ORDER, getNextPhase } = require('../lib/phases');

// POST /api/session — create a new session
router.post('/session', (req, res) => {
  const session = createSession();
  res.json({ sessionId: session.sessionId });
});

// GET /api/state/:sessionId — get current session state for UI restoration
router.get('/state/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    phase: session.phase,
    pendingTransition: session.pendingTransition,
    storyData: {
      overview: session.storyData.overview,
      characterCount: session.storyData.characters.length,
      currentCharacterIndex: session.storyData.currentCharacterIndex,
      currentCharacterName: session.storyData.characters[session.storyData.currentCharacterIndex]?.name || null,
      sceneCount: session.storyData.scenes.length,
      hasStructure: !!(session.storyData.structure?.acts?.one)
    },
    pdfReady: PHASE_ORDER.indexOf(session.phase) >= PHASE_ORDER.indexOf(PHASES.STORY_STRUCTURE)
  });
});

// POST /api/chat — stream a chat response
router.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Set up streaming response
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { signalDetected, signalData } = await streamChat(
      session,
      message,
      (chunk) => sendEvent({ type: 'chunk', text: chunk })
    );

    // If overview phase just got a user message, try to capture the overview text
    if (session.phase === PHASES.OVERVIEW && !session.storyData.overview && message.length > 20) {
      session.storyData.overview = message;
    }

    // Periodically infer writing style (every 4 user messages)
    const userMsgCount = session.messages.filter(m => m.role === 'user').length;
    if (userMsgCount > 0 && userMsgCount % 4 === 0) {
      const userMessages = session.messages
        .filter(m => m.role === 'user')
        .map(m => m.content);
      inferWritingStyle(userMessages).then(notes => {
        if (notes) {
          session.storyData.writingStyle.notes = notes;
          saveSession(session);
        }
      }).catch(() => {});
    }

    // Handle phase completion signal
    if (signalDetected && signalData?.signal === 'phase_complete') {
      const transition = getNextPhase(session.phase, session);
      session.pendingTransition = transition;

      sendEvent({
        type: 'phase_signal',
        currentPhase: session.phase,
        nextPhase: transition.phase,
        characterIndex: transition.characterIndex,
        nextCharacterName: transition.characterIndex !== null
          ? session.storyData.characters[transition.characterIndex]?.name
          : null
      });
    }

    saveSession(session);
    sendEvent({ type: 'done' });
    res.end();

  } catch (err) {
    console.error('Chat error:', err);
    sendEvent({ type: 'error', message: 'An error occurred. Please try again.' });
    res.end();
  }
});

// POST /api/transition/:sessionId — confirm a phase transition
router.post('/transition/:sessionId', async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { confirm } = req.body;
  if (!confirm) {
    session.pendingTransition = null;
    saveSession(session);
    return res.json({ cancelled: true });
  }

  const transition = session.pendingTransition;
  if (!transition) return res.status(400).json({ error: 'No pending transition' });

  const prevPhase = session.phase;
  session.phase = transition.phase;

  // If moving into CHARACTER_DEEP_DIVE from OVERVIEW, extract characters first
  if (prevPhase === PHASES.OVERVIEW && transition.phase === PHASES.CHARACTER_DEEP_DIVE) {
    try {
      const result = await extractCharacters(session.storyData.overview ||
        session.messages.filter(m => m.role === 'user').map(m => m.content).join(' '));
      session.storyData.characters = (result.characters || []).map(name => ({
        name,
        traits: '',
        backstory: '',
        fears: '',
        desires: '',
        voice: '',
        arc: '',
        scenarios: [],
        suggestions: [],
        notes: '',
        deepDiveComplete: false
      }));
      session.storyData.currentCharacterIndex = 0;
    } catch (err) {
      console.error('Character extraction failed:', err);
    }
  }

  // If advancing to next character within CHARACTER_DEEP_DIVE
  if (transition.characterIndex !== null) {
    // Mark current character as done
    if (session.storyData.characters[session.storyData.currentCharacterIndex]) {
      session.storyData.characters[session.storyData.currentCharacterIndex].deepDiveComplete = true;
    }
    session.storyData.currentCharacterIndex = transition.characterIndex;
  }

  session.pendingTransition = null;
  saveSession(session);

  const currentChar = session.storyData.characters[session.storyData.currentCharacterIndex];
  res.json({
    newPhase: session.phase,
    characters: session.storyData.characters.map(c => c.name),
    currentCharacterName: currentChar?.name || null,
    pdfReady: PHASE_ORDER.indexOf(session.phase) >= PHASE_ORDER.indexOf(PHASES.STORY_STRUCTURE)
  });
});

// GET /api/pdf/:sessionId — download the story structure PDF
router.get('/pdf/:sessionId', async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const phaseIndex = PHASE_ORDER.indexOf(session.phase);
  if (phaseIndex < PHASE_ORDER.indexOf(PHASES.STORY_STRUCTURE)) {
    return res.status(400).json({ error: 'PDF not available yet. Complete the Story Structure phase first.' });
  }

  try {
    const pdfBuffer = await generatePDF(session.storyData);
    const filename = `story-structure-${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

module.exports = router;
