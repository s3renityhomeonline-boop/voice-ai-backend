import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import dotenv from 'dotenv'
import { readFileSync, existsSync } from 'fs'
import { DeepgramService } from './services/deepgram.js'
import { LLMService } from './services/llm.js'
import { CartesiaService } from './services/cartesia.js'
import { SentenceDetector } from './utils/sentence-detector.js'

dotenv.config()

// Load pre-recorded greeting if exists (check for .wav or .mp3)
let prerecordedGreeting = null
const greetingPaths = ['./assets/greeting.wav', './assets/greeting.mp3']
for (const path of greetingPaths) {
  if (existsSync(path)) {
    prerecordedGreeting = readFileSync(path).toString('base64')
    console.log(`✅ Loaded pre-recorded greeting: ${path}`)
    break
  }
}

const app = express()
const httpServer = createServer(app)

// Configure CORS for Socket.io and Express
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://voicecallai.netlify.app',
      'https://voice-ai-backend-production-7a80.up.railway.app',
      'http://localhost:5173',
      'http://localhost:3000'
    ]
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      console.log('CORS blocked origin:', origin)
      callback(null, false)
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400 // 24 hours
}

const io = new Server(httpServer, {
  cors: {
    origin: [
      'https://voicecallai.netlify.app',
      'https://voice-ai-backend-production-7a80.up.railway.app',
      'http://localhost:5173',
      'http://localhost:3000'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
  transports: ['websocket', 'polling'],
  allowEIO3: true
})

const PORT = process.env.PORT || 3001

// Middleware - CORS must be first
app.use(cors(corsOptions))
app.options('*', cors(corsOptions)) // Handle preflight
app.use(express.json())

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Store active sessions
const activeSessions = new Map()

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)

  // Initialize services for this session
  let session
  try {
    session = {
      id: socket.id,
      conversationHistory: [],
      deepgram: null,
      llm: new LLMService(),
      cartesia: new CartesiaService(),
      isCallActive: false,
      lastActivity: Date.now()
    }
    activeSessions.set(socket.id, session)
  } catch (error) {
    console.error(`Error initializing session [${socket.id}]:`, error)
    socket.emit('error', { message: 'Server configuration error. Please contact administrator.' })
    return
  }

  // Handle call start
  socket.on('call-start', async () => {
    console.log(`Call started: ${socket.id}`)
    session.isCallActive = true

    try {
      // Initialize Deepgram
      session.deepgram = new DeepgramService()

      // Setup Deepgram transcript handler
      session.deepgram.onTranscript((text) => {
        console.log(`Transcript [${socket.id}]:`, text)
        socket.emit('transcript', { text })
        handleUserMessage(socket, session, text)
      })

      // Setup Deepgram error handler
      session.deepgram.onError((error) => {
        console.error(`Deepgram error [${socket.id}]:`, error)
        socket.emit('error', { message: 'Speech recognition error' })
      })

      // Start Deepgram connection
      await session.deepgram.connect()

      socket.emit('status', 'Connected - Start speaking!')

      // Send initial greeting
      const greetingText = "Hey there! I'm Tessa from Apex Solutions. I'm here to help you learn about our AI automation platform. What can I help you with today?"
      session.conversationHistory.push({ role: 'assistant', content: greetingText })
      socket.emit('ai-response', { text: greetingText })

      // Use pre-recorded greeting if available, otherwise generate with TTS
      if (prerecordedGreeting) {
        console.log('🎙️ Using pre-recorded greeting')
        socket.emit('audio-response', prerecordedGreeting)
      } else {
        console.log('🤖 Generating greeting with Cartesia')
        const greetingAudio = await session.cartesia.textToSpeech(greetingText)
        socket.emit('audio-response', greetingAudio)
      }

    } catch (error) {
      console.error(`Error starting call [${socket.id}]:`, error)
      socket.emit('error', { message: 'Failed to start call' })
    }
  })

  // Handle audio stream from client
  let audioChunkCount = 0
  socket.on('audio-stream', async (audioData) => {
    audioChunkCount++
    if (audioChunkCount === 1) {
      console.log(`📥 Receiving audio from client [${socket.id}]`)
    }

    if (session.deepgram && session.isCallActive) {
      try {
        // Send audio to Deepgram for transcription
        session.deepgram.send(audioData)
      } catch (error) {
        console.error(`Error processing audio [${socket.id}]:`, error)
      }
    } else {
      if (audioChunkCount === 1) {
        console.warn(`⚠️ Received audio but call not active or Deepgram not ready`)
      }
    }
  })

  // Handle call end
  socket.on('call-end', () => {
    console.log(`Call ended: ${socket.id}`)
    session.isCallActive = false
    session.lastActivity = Date.now()

    if (session.deepgram) {
      session.deepgram.disconnect()
      session.deepgram = null
    }

    socket.emit('status', 'Call ended')
  })

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)

    if (session.deepgram) {
      session.deepgram.disconnect()
    }

    activeSessions.delete(socket.id)
  })
})

// Handle user message and generate AI response with streaming
async function handleUserMessage(socket, session, userMessage) {
  try {
    // Add user message to conversation history
    session.conversationHistory.push({
      role: 'user',
      content: userMessage
    })

    socket.emit('status', 'AI is thinking...')

    // Use sentence detector for streaming
    const detector = new SentenceDetector()
    let fullResponse = ''
    let sentenceQueue = []
    let isProcessingAudio = false

    // Process LLM stream
    for await (const chunk of session.llm.streamResponse(session.conversationHistory)) {
      fullResponse += chunk

      // Detect complete sentences
      const sentences = detector.addChunk(chunk)

      // Queue sentences for TTS processing
      for (const sentence of sentences) {
        console.log(`📝 Complete sentence detected: "${sentence}"`)

        // Send text immediately
        socket.emit('ai-response', { text: sentence, partial: true })

        // Add to sentence queue
        sentenceQueue.push(sentence)

        // Start processing audio queue if not already started
        if (!isProcessingAudio) {
          isProcessingAudio = true
          socket.emit('status', 'AI is speaking...')
          processAudioQueue(socket, session, sentenceQueue).catch(err => {
            console.error('Error processing audio queue:', err)
          })
        }
      }
    }

    // Handle any remaining partial sentence
    if (detector.hasIncomplete()) {
      const remainder = detector.getRemainder()
      if (remainder) {
        console.log(`📝 Final fragment: "${remainder}"`)
        fullResponse += remainder

        socket.emit('ai-response', { text: remainder, partial: true })

        // Add to sentence queue
        sentenceQueue.push(remainder)
      }
    }

    // Mark queue as complete
    sentenceQueue.complete = true

    // Wait for all audio to be processed
    while (sentenceQueue.length > 0 || !sentenceQueue.processed) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Add full response to conversation history
    session.conversationHistory.push({
      role: 'assistant',
      content: fullResponse
    })

    // Send complete response marker
    socket.emit('ai-response', { text: fullResponse, complete: true })

    console.log(`✅ Complete response: "${fullResponse}"`)

  } catch (error) {
    console.error(`Error handling message [${socket.id}]:`, error)
    socket.emit('error', { message: 'Failed to generate response' })
    socket.emit('status', 'Error - Please try again')
  }
}

// Process audio queue sequentially to avoid Cartesia concurrency limits
async function processAudioQueue(socket, session, sentenceQueue) {
  let processedCount = 0

  while (true) {
    // Check if there are sentences to process
    if (sentenceQueue.length > processedCount) {
      const sentence = sentenceQueue[processedCount]
      processedCount++

      try {
        // Generate TTS sequentially (one at a time)
        const audio = await session.cartesia.textToSpeech(sentence)
        console.log(`🔊 Audio ready for: "${sentence.substring(0, 30)}..."`)

        // Send audio immediately
        socket.emit('audio-response', audio)
      } catch (err) {
        console.error('TTS error:', err)
      }
    } else if (sentenceQueue.complete) {
      // All sentences processed
      break
    } else {
      // Wait for more sentences
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  socket.emit('status', 'Listening...')
  sentenceQueue.processed = true
}

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now()
  let cleanedCount = 0

  activeSessions.forEach((session, socketId) => {
    // If session is inactive for more than 30 minutes, clean it up
    if (!session.isCallActive && session.lastActivity && (now - session.lastActivity) > 30 * 60 * 1000) {
      if (session.deepgram) {
        session.deepgram.disconnect()
      }
      activeSessions.delete(socketId)
      cleanedCount++
    }
  })

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} stale sessions`)
  }
}, 5 * 60 * 1000)

// Start server
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📡 WebSocket server ready`)
  console.log(`🤖 LLM Provider: ${process.env.LLM_PROVIDER || 'openai'}`)
  console.log(`🌐 CORS enabled for: https://voicecallai.netlify.app, https://voice-ai-backend-production-7a80.up.railway.app, http://localhost:5173, http://localhost:3000`)
  console.log(`✅ Server ready to accept connections`)
})
