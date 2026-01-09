import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'

export class LLMService {
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'openai'

    if (this.provider === 'openai') {
      this.initOpenAI()
    } else if (this.provider === 'gemini') {
      this.initGemini()
    } else {
      throw new Error(`Unsupported LLM provider: ${this.provider}`)
    }
  }

  initOpenAI() {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set')
    }

    this.client = new OpenAI({ apiKey })
    this.model = process.env.OPENAI_MODEL || 'gpt-5-nano'
  }

  initGemini() {
    const apiKey = process.env.GOOGLE_API_KEY
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY is not set')
    }

    this.client = new GoogleGenerativeAI(apiKey)
    this.model = process.env.GEMINI_MODEL || 'gemini-3-flash'
  }

  async generateResponse(conversationHistory, streaming = false) {
    try {
      if (this.provider === 'openai') {
        return await this.generateOpenAIResponse(conversationHistory, streaming)
      } else if (this.provider === 'gemini') {
        return await this.generateGeminiResponse(conversationHistory)
      }
    } catch (error) {
      console.error('LLM error:', error)
      throw error
    }
  }

  // Stream responses for real-time generation
  async *streamResponse(conversationHistory) {
    if (this.provider === 'openai') {
      yield* this.streamOpenAIResponse(conversationHistory)
    } else if (this.provider === 'gemini') {
      yield* this.streamGeminiResponse(conversationHistory)
    }
  }

  async *streamOpenAIResponse(conversationHistory) {
    const systemPrompt = {
      role: 'system',
      content: `You are Tessa, an AI assistant for Apex Solutions - an AI-powered business automation platform.

Your role:
- Help customers understand our platform features (workflow automation, AI analytics, team collaboration)
- Answer pricing questions (Starter: $29/mo, Pro: $99/mo, Enterprise: custom)
- Qualify leads by understanding their business needs
- Schedule demos with our sales team
- Provide friendly, efficient customer support

Voice conversation rules:
- Keep responses under 2-3 sentences (this is voice, not text)
- Sound natural and conversational like a helpful human
- If you don't know something specific, offer to connect them with the team
- Remember customer details mentioned in the conversation
- Be professional but warm and approachable
- Ask clarifying questions when needed`
    }

    const messages = [systemPrompt, ...conversationHistory]

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages,
      max_completion_tokens: 500,
      reasoning_effort: 'low',
      stream: true
    })

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) {
        yield content
      }
    }
  }

  async generateOpenAIResponse(conversationHistory, streaming = false) {
    const systemPrompt = {
      role: 'system',
      content: `You are Tessa, an AI assistant for Apex Solutions - an AI-powered business automation platform.

Your role:
- Help customers understand our platform features (workflow automation, AI analytics, team collaboration)
- Answer pricing questions (Starter: $29/mo, Pro: $99/mo, Enterprise: custom)
- Qualify leads by understanding their business needs
- Schedule demos with our sales team
- Provide friendly, efficient customer support

Voice conversation rules:
- Keep responses under 2-3 sentences (this is voice, not text)
- Sound natural and conversational like a helpful human
- If you don't know something specific, offer to connect them with the team
- Remember customer details mentioned in the conversation
- Be professional but warm and approachable
- Ask clarifying questions when needed`
    }

    const messages = [systemPrompt, ...conversationHistory]

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: messages,
      max_completion_tokens: 500,
      reasoning_effort: 'low',
      stream: streaming
    })

    if (streaming) {
      return completion // Return stream object
    }

    return completion.choices[0].message.content
  }

  async *streamGeminiResponse(conversationHistory) {
    const systemPrompt = `You are Tessa, an AI assistant for Apex Solutions - an AI-powered business automation platform.

Your role:
- Help customers understand our platform features (workflow automation, AI analytics, team collaboration)
- Answer pricing questions (Starter: $29/mo, Pro: $99/mo, Enterprise: custom)
- Qualify leads by understanding their business needs
- Schedule demos with our sales team
- Provide friendly, efficient customer support

Voice conversation rules:
- Keep responses under 2-3 sentences (this is voice, not text)
- Sound natural and conversational like a helpful human
- If you don't know something specific, offer to connect them with the team
- Remember customer details mentioned in the conversation
- Be professional but warm and approachable
- Ask clarifying questions when needed`

    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt
    })

    // 1. Map 'assistant' to 'model' and ensure correct structure
    const mappedHistory = conversationHistory.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }))

    // 2. Ensure it starts with a 'user' message (Gemini requirement)
    // If the first message is from the model, remove it
    while (mappedHistory.length > 0 && mappedHistory[0].role === 'model') {
      mappedHistory.shift()
    }

    // Convert conversation history to Gemini format
    const chat = model.startChat({
      history: mappedHistory,
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 1.0,
        thinkingLevel: 'minimal' // Fast mode for low latency
      }
    })

    // Get the last user message
    const lastMessage = conversationHistory[conversationHistory.length - 1]

    // Stream the response
    const result = await chat.sendMessageStream(lastMessage.content)

    for await (const chunk of result.stream) {
      const chunkText = chunk.text()
      if (chunkText) {
        yield chunkText
      }
    }
  }

  async generateGeminiResponse(conversationHistory) {
    const systemPrompt = `You are Tessa, an AI assistant for Apex Solutions - an AI-powered business automation platform.

Your role:
- Help customers understand our platform features (workflow automation, AI analytics, team collaboration)
- Answer pricing questions (Starter: $29/mo, Pro: $99/mo, Enterprise: custom)
- Qualify leads by understanding their business needs
- Schedule demos with our sales team
- Provide friendly, efficient customer support

Voice conversation rules:
- Keep responses under 2-3 sentences (this is voice, not text)
- Sound natural and conversational like a helpful human
- If you don't know something specific, offer to connect them with the team
- Remember customer details mentioned in the conversation
- Be professional but warm and approachable
- Ask clarifying questions when needed`

    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt
    })

    // 1. Map 'assistant' to 'model' and ensure correct structure
    const mappedHistory = conversationHistory.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }))

    // 2. Ensure it starts with a 'user' message (Gemini requirement)
    // If the first message is from the model, remove it
    while (mappedHistory.length > 0 && mappedHistory[0].role === 'model') {
      mappedHistory.shift()
    }

    // Convert conversation history to Gemini format
    const chat = model.startChat({
      history: mappedHistory,
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 1.0,
        thinkingLevel: 'minimal' // Fast mode for low latency
      }
    })

    // Get the last user message
    const lastMessage = conversationHistory[conversationHistory.length - 1]

    const result = await chat.sendMessage(lastMessage.content)
    const response = await result.response
    return response.text()
  }
}
