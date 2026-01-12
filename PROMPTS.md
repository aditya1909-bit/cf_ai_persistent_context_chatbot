# PROMPTS

1. **Architecture Definition**
   - "Design a Cloudflare Workers + Durable Objects architecture for persistent chat sessions. Specify how each conversation is mapped to a Durable Object instance, what data is stored, and how context is reconstructed for each request."

2. **SQLite Schema and Storage Strategy**
   - "Define a SQLite schema for chat persistence inside a Durable Object. Include message role, content, timestamps, and a summary table or key-value store. Provide SQL DDL statements."

3. **Context Trimming and Summarization**
   - "Implement a context budgeting mechanism that trims conversation history to a target token budget. Provide a heuristic for token estimation (char/token ratio), and describe how to progressively drop older messages while preserving a running summary."

4. **Workers AI Integration (Llama 3.3)**
   - "Wire Cloudflare Workers AI into a Durable Object fetch handler. Use model '@cf/meta/llama-3.3-70b-instruct-fp8-fast' with chat messages and define max output tokens and temperature."

5. **Global Daily Output Quota**
   - "Implement a global daily output-token quota across all conversations using a dedicated Durable Object instance (name-based singleton). Add reserve/commit endpoints to prevent oversubscription, with daily reset based on UTC date."

6. **API Surface Design**
   - "Specify REST endpoints for /chat, /history, and /reset. For /chat, include input schema (message + optional system prompt) and output schema (reply + usage). Define expected status codes for errors (429, 502)."

7. **Client UI for Chat**
   - "Build a single-file HTML/CSS/JS chat UI served from the Worker. Include message list, input box, system prompt field, clear-chat control, and token usage display. Persist conversationId and systemPrompt via localStorage."

8. **CORS and Browser Compatibility**
   - "Add CORS headers for JSON endpoints and implement an OPTIONS handler. Ensure the UI uses same-origin fetch calls for /chat and /history."

9. **Deployment and Migration Guidance**
   - "Provide deployment instructions and Durable Object migration constraints. Include notes about SQLite-backed classes requiring new class names and migration tags."

10. **README Documentation**
    - "Write a README with setup, local dev, API usage, configuration knobs (model + token budget), and troubleshooting notes for common Workers errors."
