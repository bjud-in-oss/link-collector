export const MasterDevelopmentPlan = `
# Master Development Plan - Gemini Live Acoustic Priming & Steering

## Target Architecture

We are aligning our Gemini Live implementation with the highly robust, multi-step acoustic steering pattern verified in the 'Acoustic Priming' test project. This design guarantees precise control, zero truncation, and extreme stability under both AI Studio preview and Netlify static hosting environments.

## Core Architectural Changes

### 1. Model Realignment
- **Problem**: Our current server uses \`gemini-2.0-flash-exp\` which fails to connect/upgrade correctly on the Multimodal Live API under the newer \`@google/genai\` SDK. This causes immediate WebSocket connection drops (connecting -> listening -> idle).
- **Solution**: Realign to \`gemini-3.1-flash-live-preview\` as the single source of truth for the Multimodal Live API, ensuring perfect connection stability.

### 2. Push-To-Talk (PTT) Boundaries with Explicit Events
- **Problem**: In our current implementation, the microphone is streaming constantly when unmuted. This floods the model with background noise, causing unexpected responses, barge-ins, or connection drops.
- **Solution**: Implement the explicit PTT boundary protocol:
  - **Client-Side**:
    - Manage a \`pushingRef\` state on the client.
    - Only send audio binary chunks over WebSocket when \`pushingRef.current\` is \`true\`.
    - Hold the spacebar or mouse-down on a redesigned "Tala med Handboken" button to stream.
    - Send \`{ event: "activityStart" }\` on start of talking.
    - Send \`{ event: "activityEnd" }\` on end of talking.
  - **Server-Side**:
    - When receiving \`activityStart\`, forward \`session.sendRealtimeInput({ activityStart: {} })\` to Gemini.
    - When receiving \`activityEnd\`, forward \`session.sendRealtimeInput({ activityEnd: {} })\` to Gemini.
    - Forward audio data only when received.

### 3. Netlify & External Deploy Resiliency
- Ensure the API key and WebSocket connection routing are fully robust.
- Provide a clean WebSocket fallback to the active dev Cloud Run container, appending the user's local API key correctly if the backend is hosted externally.

## Next Steps
- **Cycle 3**: Sync & Impact Analysis of operational files (\`server.ts\` and \`src/App.tsx\`).
- **Cycle 4**: Execution of the implementation.
`;
